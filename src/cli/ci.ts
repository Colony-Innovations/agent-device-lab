import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { AUTH_STATE_ENV, authStateFromEnv, authStateSecrets, savedStateProblem, type StoredState } from '../core/auth.js';
import { envSecrets, leakedSecrets, redactTree } from '../core/bundle.js';
import {
  CI_FILES, CI_SCHEMA, EXIT, applySuppressions, collectFindings, evaluateCi, formatCiText, frameRefs, groupForCi, parseCiResult, renderCi, resolveCi, withFrames,
  type CiBundleEntry, type CiFlagInput, type CiFlowResult, type CiFormat, type CiResult, type CiSelections, type CiSweepEntry, type CiVerdict,
} from '../core/ci.js';
import { redactSecrets } from '../core/feed.js';
import { formatError } from '../core/format.js';
import { Lab } from '../core/lab.js';
import { loadProfile } from '../core/profile.js';
import { evaluatePolicy, groupFindings } from '../core/scan-policy.js';
import { scanReportHtml } from '../core/scan-report.js';
import { scanSummary } from '../core/scan.js';
import { isSecretStep, type FlowStep } from '../core/steps.js';
import { LabError, type ProjectProfile, type ScanResult, type SweepResult } from '../core/schema.js';
import { CONTRACT_VERSIONS, productVersion } from '../core/versions.js';
import { runFlowDetailed } from './flow.js';
import { holdIfTerminating, onTermination } from './signals.js';

// CI mode orchestration: validate, run flows, sweeps and the scan, decide, and write artifacts that never hold a
// secret. The pure parts (selection, policy, result, renderings) are in src/core/ci.ts.

export interface CiInvocation extends CiFlagInput {
  /** The project directory (or agentlab.json). */
  project: string;
  stateDir: string;
  validateOnly: boolean;
  headed: boolean;
  /** Print the result JSON instead of the text report. */
  json: boolean;
}

interface Check { name: string; ok: boolean; detail: string }

const MAX_FRAMES = 200;
const never = () => new Promise<never>(() => undefined);

/** Every problem with what was asked for, before anything starts. Read-only: no project command runs. */
async function validate(inv: CiInvocation): Promise<{ profile?: ProjectProfile; sel?: CiSelections; authState?: StoredState; checks: Check[]; problems: string[] }> {
  const checks: Check[] = [];
  const problems: string[] = [];
  const check = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); if (!ok) problems.push(`${name}: ${detail}`); };

  let profile: ProjectProfile;
  try {
    profile = await loadProfile(inv.project);
  } catch (err) {
    const e = LabError.from(err);
    // A JSON parser's own message quotes the file's text; say only what is wrong.
    const message = e.code === 'invalid_profile' ? e.message.replace(/^(Cannot read [^:]+): [\s\S]*$/, '$1: the file is missing or not valid JSON') : e.message;
    check('profile', false, redactSecrets(message));
    return { checks, problems };
  }
  check('profile', true, `${profile.name}: ${profile.profilePath} (schemaVersion ${profile.schemaVersion}, ${profile.services.length} service${profile.services.length === 1 ? '' : 's'})`);

  const { selections: sel, problems: selection } = resolveCi(profile, inv);
  for (const p of selection) check('selection', false, p);
  if (!selection.length) check('selection', true, `${sel.flows.length} flow(s), ${sel.routes.length} route(s), ${sel.scenarios.length} scenario(s)`);

  const exe = chromium.executablePath();
  check('browser', existsSync(exe), existsSync(exe) ? 'Chromium is installed' : 'Chromium is not installed (run `agentlab install-browser`, with --with-deps on a bare CI image)');

  for (const s of profile.services) {
    const missing = s.requiredEnv.filter((n) => !process.env[n]);
    check(`environment for service "${s.name}"`, !missing.length, missing.length ? `required variable${missing.length === 1 ? '' : 's'} not set: ${missing.join(', ')}` : s.requiredEnv.length ? `${s.requiredEnv.join(', ')} set` : 'nothing required');
  }

  for (const f of sel.flows) {
    const file = resolve(profile.root, f);
    let detail: string | undefined;
    if (!existsSync(file)) detail = 'the file does not exist';
    else {
      try {
        const flow = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown; steps?: unknown };
        if (typeof flow.name !== 'string' || !Array.isArray(flow.steps)) detail = 'needs a "name" and a "steps" list';
      } catch { detail = 'is not valid JSON'; }
    }
    check(`flow ${f}`, !detail, detail ?? 'found and parsed');
  }

  let authState: StoredState | undefined;
  if (sel.auth === 'saved') {
    const problem = savedStateProblem(profile.auth, profile.root);
    check('auth (saved)', !problem, problem ?? 'a usable saved sign-in state exists');
  } else if (sel.auth === 'env') {
    const value = process.env[AUTH_STATE_ENV];
    if (!value) check('auth (env)', false, `${AUTH_STATE_ENV} is not set`);
    else {
      try {
        authState = authStateFromEnv(value);
        check('auth (env)', true, `${AUTH_STATE_ENV} holds ${authState.cookies.length} cookie(s) and ${authState.origins.length} origin(s) of storage`);
      } catch (err) { check('auth (env)', false, LabError.from(err).message); }
    }
  }
  return { profile, sel, ...(authState ? { authState } : {}), checks, problems };
}

function printChecks(checks: Check[], problems: string[], json: boolean): void {
  if (json) process.stdout.write(JSON.stringify({ ok: !problems.length, checks, problems }, null, 2) + '\n');
  else {
    for (const c of checks) process.stdout.write(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}\n`);
    process.stdout.write(problems.length ? `${problems.length} problem${problems.length === 1 ? '' : 's'}: the run would not start (exit 2)\n` : 'valid: `agentlab test` can run\n');
  }
}

// ---------- files ----------

function ensureDir(dir: string): void {
  const fresh = !existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fresh) chmodSync(dir, 0o700);
}
function put(file: string, data: string | Buffer): void {
  ensureDir(dirname(file));
  writeFileSync(file, data, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Copy the evidence frames (JPEGs inside the lab's run directories only) into `<out>/<sub>/`; returns source → relative path. */
function copyFrames(sources: readonly string[], out: string, sub: string, roots: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  const real = roots.flatMap((r) => { try { return [realpathSync(r)]; } catch { return []; } });
  for (const src of sources) {
    if (map.size >= MAX_FRAMES) break;
    try {
      const file = realpathSync(src);
      if (!/\.jpe?g$/i.test(file) || !real.some((r) => file.startsWith(r + sep)) || !statSync(file).isFile()) continue;
      const name = `${String(map.size + 1).padStart(3, '0')}-${basename(file)}`;
      ensureDir(join(out, sub));
      copyFileSync(file, join(out, sub, name));
      chmodSync(join(out, sub, name), 0o600);
      map.set(src, `${sub}/${name}`);
    } catch { /* a frame that cannot be copied is left out */ }
  }
  return map;
}

// ---------- the run ----------

interface RunState {
  flows: CiFlowResult[];
  sweeps: SweepResult[];
  scan?: ScanResult;
  labs: Lab[];
  bundles: CiBundleEntry[];
  traces: CiResult['traces'];
  chromium?: string;
  auth: 'fresh' | 'saved-state';
  /** The run could not be carried out: a start failure, an unusable flow. */
  problem?: string;
  aborted?: { kind: 'timeout' | 'cancelled'; text: string };
}

interface Override { exitCode: number; reason: string }

export async function runCi(inv: CiInvocation): Promise<never> {
  // Registered first: a signal during validation must exit with its own code, not die with the default action.
  let onSignal: (signal: NodeJS.Signals) => Promise<void> = async () => undefined;
  const removeSignals = onTermination((signal) => onSignal(signal), { stateDir: inv.stateDir });
  const t0 = Date.now();
  const startedAt = new Date(t0).toISOString();
  const v = await validate(inv);
  if (inv.validateOnly) {
    printChecks(v.checks, v.problems, inv.json);
    process.exit(v.problems.length ? EXIT.couldNotRun : 0);
  }
  const { profile, sel } = v;
  const out = resolve(sel?.out ?? './agentlab-results');
  const state: RunState = { flows: [], sweeps: [], labs: [], bundles: [], traces: [], auth: 'fresh' };

  // Redaction set: the project's secret environment, the sign-in state's values and every lab's own secrets.
  const base = new Set<string>(profile ? envSecrets(profile) : []);
  if (v.authState) for (const s of authStateSecrets(v.authState)) base.add(s);
  // Values a flow or scenario types into secret-looking fields are known before the browser is: they never print.
  const seeded = [
    ...(profile?.scan.scenarios.flatMap((sc) => [...sc.steps, ...sc.cleanup]) ?? []),
    ...(sel?.flows ?? []).flatMap((f) => { try { return (JSON.parse(readFileSync(resolve(profile!.root, f), 'utf8')) as { steps?: FlowStep[] }).steps ?? []; } catch { return []; } }),
  ];
  for (const st of seeded) if (typeof st.value === 'string' && st.value.length >= 4 && isSecretStep(st)) base.add(st.value);
  const envState = process.env[AUTH_STATE_ENV]?.trim();
  if (envState && envState.length >= 6) base.add(envState);
  const secretsNow = () => [...new Set([...base, ...state.labs.flatMap((l) => l.secretValues())])].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  const say = (text: string) => { (inv.json ? process.stderr : process.stdout).write(redactTree(text, secretsNow())); };
  const note = (text: string) => { process.stderr.write(redactTree(`agentlab: ${text}\n`, secretsNow())); };

  if (!profile || !sel || v.problems.length) {
    const reasons = v.problems.map((p) => redactTree(p, secretsNow()));
    process.stderr.write(`agentlab: cannot run:\n${reasons.map((r) => `  - ${r}`).join('\n')}\n`);
    if (profile && sel) {
      try { await writeOutputs({ inv, profile, sel, state, out, t0, startedAt, secretsNow, override: { exitCode: EXIT.couldNotRun, reason: `could not run: ${reasons.join('; ')}` }, quiet: true }); } catch { /* the message above is the result */ }
    }
    process.exit(EXIT.couldNotRun);
  }

  // Start from a clean artifacts directory: only the names this command writes are removed.
  for (const name of ['ci-result.json', 'summary.txt', 'report.html', 'junit.xml', 'frames', 'scan', 'bundles', 'traces']) rmSync(join(out, name), { recursive: true, force: true });
  ensureDir(out);

  const finish = (override?: Override) => writeOutputs({ inv, profile, sel, state, out, t0, startedAt, secretsNow, ...(override ? { override } : {}) });
  const abort = async (kind: 'timeout' | 'cancelled', text: string, exitCode: number): Promise<void> => {
    if (state.aborted) return;
    state.aborted = { kind, text };
    await Promise.allSettled(state.labs.map((l) => l.close(text)));
    try {
      await finish({ exitCode, reason: text });
    } catch (err) { process.stderr.write(`agentlab: ${LabError.from(err).message}\n`); }
  };
  onSignal = (signal) => abort('cancelled', `cancelled by ${signal}`, { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }[signal as string] ?? 1);
  const seconds = Math.round(sel.timeoutMs / 100) / 10;
  const timer = setTimeout(() => { void abort('timeout', `timed out after ${seconds}s`, EXIT.timedOut).finally(() => process.exit(EXIT.timedOut)); }, sel.timeoutMs);
  const bundlesDir = join(out, 'bundles');
  const traceOn = sel.trace !== 'off';
  const startAuth = { auth: sel.auth === 'saved' ? 'saved' as const : 'fresh' as const, ...(v.authState ? { authState: v.authState } : {}) };
  const failWith = (err: unknown): void => {
    const e = LabError.from(err).toJSON();
    const tail = Array.isArray(e.details?.logTail) ? `\nserver log tail:\n${(e.details!.logTail as unknown[]).slice(-10).map((l) => `  ${redactSecrets(String(l))}`).join('\n')}` : '';
    state.problem = `${formatError({ ...e, details: undefined }).split('\n').slice(0, 2).join(' ')}${tail}`;
  };
  const bundleTrace = (t: { dropped: string } | string): string => typeof t === 'string' ? t : `dropped: ${t.dropped}`;

  note('starting');
  try {
    // 1. Flows, each in its own session.
    for (const file of sel.flows) {
      if (state.aborted) await never();
      note(`flow ${file}`);
      let bundleDir: string | undefined;
      const outcome = await runFlowDetailed(resolve(profile.root, file), {
        headed: inv.headed, json: false, stateDir: inv.stateDir, write: say, project: profile.root, ...startAuth, trace: traceOn,
        onLab: (l) => { state.labs.push(l); },
        beforeClose: async (l, o) => {
          state.auth = l.status().session?.auth ?? state.auth;
          if (o.failure) {
            const b = await l.bundle({ reason: o.reason ?? 'flow failed', failure: o.failure, dir: bundlesDir });
            bundleDir = `bundles/${b.id}`;
            state.bundles.push({ id: b.id, dir: bundleDir, for: `flow ${basename(file)}`, trace: bundleTrace(b.trace) });
          } else if (sel.trace === 'always') {
            const dest = join(out, 'traces', `flow-${state.flows.length + 1}.zip`);
            const saved = await l.saveTrace(dest);
            state.traces.push('path' in saved ? { name: `flow ${basename(file)}`, file: relative(out, dest) } : { name: `flow ${basename(file)}`, dropped: saved.dropped });
          }
        },
      });
      if (state.aborted) await never();
      if (outcome.startError) {
        const e = outcome.startError;
        failWith(new LabError(e.code, e.message, { ...(e.hint ? { hint: e.hint } : {}), ...(e.details ? { details: e.details } : {}) }));
        state.problem = `flow ${file} could not start: ${state.problem}`;
        state.flows.push({ name: outcome.name, file, passed: false, steps: outcome.steps, completed: 0, ms: outcome.elapsedMs, failedStep: { index: 0, label: 'start', kind: 'start', text: 'the session could not start' } });
        break;
      }
      state.flows.push({
        name: outcome.name, file, passed: outcome.passed, steps: outcome.steps, completed: outcome.completed, ms: outcome.elapsedMs,
        ...(outcome.failedStep ? { failedStep: outcome.failedStep } : {}), ...(bundleDir ? { bundle: bundleDir } : {}),
      });
    }

    // 2. One session for the sweeps and the scan.
    if (!state.problem && (sel.routes.length || sel.scenarios.length)) {
      const lab = new Lab({ stateDir: inv.stateDir });
      state.labs.push(lab);
      try {
        const started = await lab.start({ project: profile.root, headed: inv.headed, ...startAuth, ...(traceOn ? { trace: true } : {}) });
        state.chromium = started.session.browser.version;
        state.auth = started.session.auth ?? 'fresh';
        for (const route of sel.routes) {
          if (state.aborted) await never();
          note(`sweep ${route}`);
          state.sweeps.push(await lab.sweep({ route, devices: sel.sweepDevices }));
        }
        if (sel.scenarios.length) {
          if (state.aborted) await never();
          note(`scan ${sel.scenarios.length} scenario(s)`);
          state.scan = await lab.scan({ scenarios: sel.scenarios, ...(sel.devices ? { devices: sel.devices } : {}) });
        }
        if (state.aborted) await never();
        const now = assemble(profile, sel, state);
        if (now.verdict.failingFindings.length) {
          const failing = now.findings.filter((f) => now.verdict.failingFindings.includes(f.id));
          const b = await lab.bundle({
            reason: `${failing.length} finding(s) failed the CI policy: ${failing.map((f) => f.id).join(', ')}`,
            failure: { kind: 'findings', fingerprints: [...new Set(failing.map((f) => f.fingerprint))] }, dir: bundlesDir,
          });
          state.bundles.push({ id: b.id, dir: `bundles/${b.id}`, for: 'findings of the sweeps and scan', trace: bundleTrace(b.trace) });
        } else if (sel.trace === 'always') {
          const dest = join(out, 'traces', 'session.zip');
          const saved = await lab.saveTrace(dest);
          state.traces.push('path' in saved ? { name: 'sweeps and scan', file: relative(out, dest) } : { name: 'sweeps and scan', dropped: saved.dropped });
        }
      } catch (err) {
        if (state.aborted) await never();
        failWith(err);
      } finally {
        if (!state.aborted) await lab.close('ci finished');
      }
    }
  } catch (err) {
    if (state.aborted) await never();
    failWith(err);
  } finally {
    // Whatever happened, no lab is left holding a browser or a service (an abort closes them itself).
    if (!state.aborted) await Promise.allSettled(state.labs.map((l) => l.close('ci finished')));
  }
  if (state.aborted) await never();
  clearTimeout(timer);
  removeSignals();

  let code: number;
  try {
    code = await finish(state.problem ? { exitCode: EXIT.couldNotRun, reason: `could not run: ${state.problem}` } : undefined);
  } catch (err) {
    process.stderr.write(`agentlab: ${redactTree(LabError.from(err).message, secretsNow())}\n`);
    code = EXIT.couldNotRun;
  }
  await holdIfTerminating();
  process.exit(code);
}

/** The findings of the sweeps and the scan with the project's suppressions applied, their groups and the verdict. */
function assemble(profile: ProjectProfile, sel: CiSelections, state: RunState) {
  const sweeps: CiSweepEntry[] = state.sweeps.map((s) => ({
    id: s.id, route: s.route, ms: s.ms,
    devices: s.devices.map((d) => ({ device: d.device, width: d.width, status: d.status, ...(d.error ? { error: d.error.message } : {}), findings: d.findings, ms: d.ms })),
  }));
  const raw = collectFindings(state.sweeps, state.scan);
  const devices = [...new Set([...state.sweeps.flatMap((s) => s.devices.map((d) => d.device)), ...(state.scan?.runs.map((r) => r.device) ?? [])])];
  const { findings, statuses } = applySuppressions(raw, profile, { scenarios: sel.scenarios, devices });
  const groups = groupForCi(findings);
  const verdict = evaluateCi({ flows: state.flows, sweeps, scanRuns: state.scan?.runs ?? [], findings, groups, sel });
  return { sweeps, findings, statuses, groups, verdict };
}

/**
 * Build the result, copy evidence per policy, redact every output, verify that no secret survived, and only then
 * write. Returns the exit code. Throws (writing no result files) when a secret would remain.
 */
async function writeOutputs(o: {
  inv: CiInvocation; profile: ProjectProfile; sel: CiSelections; state: RunState; out: string; t0: number; startedAt: string;
  secretsNow: () => string[]; override?: Override; quiet?: boolean;
}): Promise<number> {
  const { inv, profile, sel, state, out } = o;
  const a = assemble(profile, sel, state);
  const aborted = state.aborted;
  let verdict: CiVerdict = a.verdict;
  if (o.override) {
    verdict = { ...a.verdict, result: 'error', exitCode: o.override.exitCode, reasons: [o.override.reason, ...(a.verdict.result === 'fail' ? a.verdict.reasons : [])] };
  }
  const roots = state.labs.flatMap((l) => { const d = l.status().session?.runDir; return d ? [d] : []; });
  const wantFrames = sel.evidence === 'always' || (sel.evidence === 'on-failure' && verdict.result !== 'pass');

  // Evidence frames, then the scan's own report with its frames beside it.
  const frames = wantFrames ? copyFrames(frameRefs(a.findings), out, 'frames', roots) : new Map<string, string>();
  let scanForFiles: ScanResult | undefined;
  if (state.scan) {
    const ids = new Set(state.scan.findings.map((f) => f.id));
    const scanFindings = a.findings.filter((f) => ids.has(f.id));
    const ciPolicy = evaluatePolicy(scanFindings, state.scan.runs, { failOn: sel.failOn, failOnErrors: sel.scenarioErrors === 'fail', failOnHeuristic: sel.failOnHeuristic });
    scanForFiles = {
      ...state.scan, findings: scanFindings, groups: groupFindings(scanFindings), suppressions: a.statuses,
      verdict: { ...ciPolicy, result: state.scan.interrupted ? 'incomplete' : ciPolicy.result },
    };
  }
  const scanFrames = wantFrames && scanForFiles ? copyFrames(frameRefs(scanForFiles.findings), out, 'scan/frames', roots) : new Map<string, string>();

  const artifacts: CiResult['artifacts'] = [{ path: CI_FILES.json, kind: 'result (JSON)' }];
  if (sel.formats.includes('text')) artifacts.push({ path: CI_FILES.text, kind: 'summary' });
  if (sel.formats.includes('html')) artifacts.push({ path: CI_FILES.html, kind: 'report' });
  if (sel.formats.includes('junit')) artifacts.push({ path: CI_FILES.junit, kind: 'JUnit XML' });
  if (scanForFiles) artifacts.push({ path: 'scan/report.html', kind: 'the scan\'s own report' }, { path: 'scan/result.json', kind: 'the scan\'s full result' });
  if (frames.size) artifacts.push({ path: 'frames/', kind: `${frames.size} evidence frame(s)` });

  const scanSummaryJson = scanForFiles ? { ...scanSummary(scanForFiles, 200), reports: { html: 'scan/report.html', json: 'scan/result.json' } } : undefined;
  const result: CiResult = {
    schema: CI_SCHEMA, version: CONTRACT_VERSIONS.report, product: { name: 'agentlab', version: productVersion() }, startedAt: o.startedAt, ms: Date.now() - o.t0,
    command: inv.command, project: { name: profile.name }, selections: sel,
    environment: { node: process.version, platform: process.platform, arch: process.arch, ...(state.chromium ? { chromium: state.chromium } : {}), ci: Boolean(process.env.CI), auth: state.auth },
    flows: state.flows, sweeps: a.sweeps, ...(scanSummaryJson ? { scan: scanSummaryJson as unknown as CiResult['scan'] } : {}),
    findings: withFrames(a.findings, frames), groups: a.groups, suppressions: a.statuses, verdict,
    ...(aborted?.kind === 'timeout' ? { timedOut: true } : {}), ...(aborted?.kind === 'cancelled' ? { cancelled: aborted.text } : {}),
    bundles: state.bundles, traces: state.traces, artifacts,
  };

  const secrets = o.secretsNow();
  const safe = redactTree(result, secrets);
  const outputs = new Map<string, string>();
  outputs.set(CI_FILES.json, renderCi(safe, 'json', out));
  for (const f of sel.formats) if (f !== 'json') outputs.set(CI_FILES[f], renderCi(safe, f as CiFormat, out));
  if (scanForFiles) {
    const rel = new Map([...scanFrames].map(([k, v]) => [k, v.replace(/^scan\//, '')]));
    const abs = new Map([...scanFrames].map(([k, v]) => [k, join(out, v)]));
    const stripStateFrames = (r: ScanResult): ScanResult => ({ ...r, runs: r.runs.map((run) => ({ ...run, states: run.states.map(({ frame: _frame, ...s }) => s) })) });
    const forHtml = redactTree({ ...stripStateFrames(scanForFiles), findings: withFrames(scanForFiles.findings, abs), reports: { html: join(out, 'scan', 'report.html'), json: join(out, 'scan', 'result.json') } }, secrets);
    const forJson = redactTree({ ...stripStateFrames(scanForFiles), findings: withFrames(scanForFiles.findings, rel), reports: { html: 'report.html', json: 'result.json' } }, secrets);
    outputs.set('scan/report.html', scanReportHtml(forHtml, join(out, 'scan')));
    outputs.set('scan/result.json', JSON.stringify(forJson, null, 2) + '\n');
  }
  // Fail closed: nothing is written when a known secret value is still in any output.
  const text = formatCiText(safe);
  const leaked = Math.max(leakedSecrets(text, secrets), ...[...outputs.values()].map((t) => leakedSecrets(t, secrets)));
  if (leaked) {
    throw new LabError('bundle_unsafe', `An output still contained ${leaked} secret value(s) after redaction; no result files were written`, { hint: 'This is a bug in agentlab: report it without attaching the run.' });
  }
  for (const [name, content] of outputs) put(join(out, name), content);
  if (!o.quiet) {
    process.stdout.write(inv.json ? JSON.stringify(safe, null, 2) + '\n' : `${text}results: ${shownPath(out)}${sep}\n`);
  }
  return verdict.exitCode;
}

const shownPath = (p: string): string => { const r = relative(process.cwd(), p); return r.startsWith('..') ? p : r || '.'; };

// ---------- report ----------

/** `agentlab report <out-dir|ci-result.json> [--format text|json|html|junit] [--out <file>]`: re-render a saved result. No browser. */
export function runReport(target: string | undefined, format: string | undefined, outFile: string | undefined): never {
  const fail = (message: string): never => { process.stderr.write(`agentlab: ${message}\n`); process.exit(EXIT.couldNotRun); };
  if (!target) return fail('report needs a results directory or a ci-result.json');
  const f = format ?? 'text';
  if (!['text', 'json', 'html', 'junit'].includes(f)) return fail('--format must be text, json, html or junit');
  const path = resolve(target);
  const file = existsSync(path) && statSync(path).isDirectory() ? join(path, CI_FILES.json) : path;
  if (!existsSync(file)) return fail(`no CI result at ${file}`);
  let result: CiResult;
  try {
    result = parseCiResult(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    return fail(err instanceof SyntaxError ? `${file} is not valid JSON` : LabError.from(err).message);
  }
  const text = renderCi(result, f as CiFormat, dirname(file));
  if (outFile) put(resolve(outFile), text);
  else process.stdout.write(text);
  process.exit(0);
}
