import { isAbsolute, join } from 'node:path';
import { getDevice } from './devices.js';
import { esc, CSS, groupHtml, findingsTable } from './scan-report.js';
import { evaluatePolicy, groupFindings, matchSuppressions } from './scan-policy.js';
import type { scanSummary } from './scan.js';
import { LabError, type Finding, type FindingGroup, type ProjectProfile, type ScanResult, type SuppressionStatus, type SweepResult } from './schema.js';
import { CONTRACT_VERSIONS, productVersion } from './versions.js';

// Pure parts of CI mode (`agentlab test`, `sweep --project`, `scenario --project`, `report`): resolving what to
// run from the profile's `ci` section and the flags, the pass/fail policy, the result document and its text,
// JUnit and HTML renderings. Everything here is browser-free and deterministic in its input, so `agentlab
// report` reproduces the files of a run from ci-result.json alone. The orchestration is in src/cli/ci.ts.

export const CI_SCHEMA = 'agentlab.ci-result';
export const CI_FORMATS = ['text', 'json', 'html', 'junit'] as const;
export type CiFormat = (typeof CI_FORMATS)[number];
export type CiCommand = 'test' | 'sweep' | 'scenario';
export type CiSeverity = 'high' | 'medium' | 'low' | 'none';
export type CiWhen = 'off' | 'on-failure' | 'always';
export type CiAuthMode = 'fresh' | 'saved' | 'env';

/** Exit codes: the process exits with `verdict.exitCode` (signals: 130, 143, 129 by the signal handler). */
export const EXIT = { pass: 0, failed: 1, couldNotRun: 2, timedOut: 3 } as const;
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export interface CiFlagInput {
  command: CiCommand;
  /** `sweep`: routes; `scenario`: scenario names. */
  positionals: string[];
  devices?: string; flows?: string; routes?: string; scenarios?: string;
  failOn?: string; failOnHeuristic?: boolean; scenarioErrors?: string;
  out?: string; format?: string; trace?: string; evidence?: string; timeout?: string; auth?: string;
}

export interface CiSelections {
  flows: string[];
  routes: string[];
  scenarios: string[];
  /** The devices given by flag or profile; undefined: each scenario's own. */
  devices?: string[];
  /** Devices every route is swept at. */
  sweepDevices: string[];
  failOn: CiSeverity;
  failOnHeuristic: boolean;
  scenarioErrors: 'fail' | 'report';
  trace: CiWhen;
  evidence: CiWhen;
  timeoutMs: number;
  auth: CiAuthMode;
  formats: CiFormat[];
  out: string;
}

const list = (v: string | undefined): string[] | undefined => v === undefined ? undefined : v.split(',').map((x) => x.trim()).filter(Boolean);

/** "90s", "15m", "2h", "1500ms" or a bare number of seconds → milliseconds; undefined when malformed. */
export function parseDuration(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const ms = n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? 's'] as number);
  return ms >= 1 ? Math.round(ms) : undefined;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s % 60)}s`;
}

/**
 * What to run and how to decide, from flags over the profile's `ci` section over the defaults. Returns every
 * problem found (unknown scenarios and devices, malformed options), never just the first.
 */
export function resolveCi(profile: ProjectProfile, input: CiFlagInput, env: NodeJS.ProcessEnv = process.env): { selections: CiSelections; problems: string[] } {
  const problems: string[] = [];
  const ci = profile.ci;
  const declared = profile.scan.scenarios.map((s) => s.name);
  const oneOf = <T extends string>(name: string, value: string | undefined, fallback: T | undefined, allowed: readonly T[], last: T): T => {
    if (value === undefined) return fallback ?? last;
    if (!(allowed as readonly string[]).includes(value)) { problems.push(`--${name} must be one of ${allowed.join(', ')}`); return fallback ?? last; }
    return value as T;
  };

  const flows = input.command === 'test' ? list(input.flows) ?? ci.flows ?? [] : [];
  const flagScenarios = list(input.scenarios);
  let scenarios: string[] = [];
  if (input.command === 'scenario') {
    const named = input.positionals.length ? input.positionals : flagScenarios;
    scenarios = named ?? (Array.isArray(ci.scenarios) ? ci.scenarios : declared);
    if (!declared.length) problems.push('the profile declares no scan.scenarios to run');
  } else if (input.command === 'test') {
    const chosen: string[] | 'all' | undefined = flagScenarios ?? ci.scenarios ?? (declared.length ? 'all' : undefined);
    scenarios = chosen === 'all' ? declared : chosen ?? [];
  }
  for (const name of scenarios) {
    if (!declared.includes(name)) problems.push(`unknown scenario "${name}"${declared.length ? ` (declared: ${declared.join(', ')})` : ' (the profile declares none)'}`);
  }

  let routes: string[] = [];
  if (input.command === 'sweep') routes = input.positionals.length ? input.positionals : list(input.routes) ?? ci.routes ?? [profile.startPath];
  else if (input.command === 'test') routes = list(input.routes) ?? ci.routes ?? (!flows.length && !scenarios.length ? [profile.startPath] : []);
  for (const r of routes) if (!r.startsWith('/')) problems.push(`route "${r}" must start with "/"`);

  const devices = list(input.devices) ?? ci.devices;
  const sweepDevices = devices ?? profile.scan.devices;
  for (const d of new Set([...(devices ?? []), ...(routes.length ? sweepDevices : [])])) {
    try { getDevice(d, profile.devices); } catch (err) { problems.push(LabError.from(err).message); }
  }

  let timeoutMs = ci.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (input.timeout !== undefined) {
    const t = parseDuration(input.timeout);
    if (t === undefined) problems.push('--timeout must be a duration such as 90s, 15m or 1h');
    else timeoutMs = t;
  }
  const formats: CiFormat[] = [];
  for (const f of list(input.format) ?? [...CI_FORMATS]) {
    if (!(CI_FORMATS as readonly string[]).includes(f)) problems.push(`--format takes ${CI_FORMATS.join(', ')}, not "${f}"`);
    else if (!formats.includes(f as CiFormat)) formats.push(f as CiFormat);
  }
  const failOnHeuristic = input.failOnHeuristic ?? ci.failOnHeuristic ?? profile.scan.policy.failOnHeuristic;
  const selections: CiSelections = {
    flows, routes, scenarios, ...(devices ? { devices } : {}), sweepDevices,
    failOn: oneOf('fail-on', input.failOn as CiSeverity | undefined, ci.failOn ?? profile.scan.policy.failOn, ['high', 'medium', 'low', 'none'], 'high'),
    failOnHeuristic,
    scenarioErrors: oneOf('scenario-errors', input.scenarioErrors as 'fail' | 'report' | undefined, ci.scenarioErrors, ['fail', 'report'], 'fail'),
    trace: oneOf('trace', input.trace as CiWhen | undefined, ci.trace, ['off', 'on-failure', 'always'], 'off'),
    evidence: oneOf('evidence', input.evidence as CiWhen | undefined, ci.evidence, ['off', 'on-failure', 'always'], 'on-failure'),
    timeoutMs,
    auth: oneOf('auth', input.auth as CiAuthMode | undefined, ci.auth ?? (env.AGENTLAB_AUTH_STATE ? 'env' : 'fresh'), ['fresh', 'saved', 'env'], 'fresh'),
    formats,
    out: input.out ?? ci.out ?? './agentlab-results',
  };
  return { selections, problems };
}

// ---------- the result ----------

export interface CiFlowResult {
  name: string;
  /** Relative to the profile. */
  file: string;
  passed: boolean;
  steps: number;
  completed: number;
  ms: number;
  failedStep?: { index: number; label: string; kind: string; text: string };
  /** Bundle directory relative to the artifacts, when one was written. */
  bundle?: string;
}
export interface CiSweepEntry {
  id: string;
  route: string;
  ms: number;
  devices: { device: string; width: number; status: 'ok' | 'error'; error?: string; findings: string[]; ms: number }[];
}
export type CiScanSummary = Omit<ReturnType<typeof scanSummary>, 'reports'> & { reports: { html: string; json: string } };
export interface CiBundleEntry { id: string; dir: string; for: string; trace: string }
export interface CiVerdict {
  result: 'pass' | 'fail' | 'error';
  exitCode: number;
  reasons: string[];
  /** Finding ids and group ids that failed the policy. */
  failingFindings: string[];
  failingGroups: string[];
}
export interface CiResult {
  schema: typeof CI_SCHEMA;
  version: number;
  product: { name: 'agentlab'; version: string };
  startedAt: string;
  ms: number;
  command: CiCommand;
  project: { name: string };
  selections: CiSelections;
  environment: { node: string; platform: string; arch: string; chromium?: string; ci: boolean; auth: 'fresh' | 'saved-state' };
  flows: CiFlowResult[];
  sweeps: CiSweepEntry[];
  scan?: CiScanSummary;
  findings: Finding[];
  groups: FindingGroup[];
  suppressions: SuppressionStatus[];
  verdict: CiVerdict;
  /** Set when a signal ended the run: the result is partial. */
  cancelled?: string;
  timedOut?: boolean;
  bundles: CiBundleEntry[];
  /** Traces: a path relative to the artifacts, or why it was dropped. */
  traces: { name: string; file?: string; dropped?: string }[];
  artifacts: { path: string; kind: string }[];
}

const RANK = { high: 3, medium: 2, low: 1 } as const;

/** Unsuppressed findings that fail the policy: confirmed (or any with failOnHeuristic) at or above `failOn`. */
export function failingFindings(findings: readonly Finding[], p: { failOn: CiSeverity; failOnHeuristic: boolean }): Finding[] {
  if (p.failOn === 'none') return [];
  const min = RANK[p.failOn];
  return findings.filter((f) => !f.suppressed && (p.failOnHeuristic || f.confidence === 'confirmed') && RANK[f.severity] >= min);
}

/** The project's scan suppressions applied to every finding of the run (sweeps and scans alike), on copies. */
export function applySuppressions(findings: readonly Finding[], profile: ProjectProfile, ctx: { scenarios: readonly string[]; devices: readonly string[]; today?: string }): { findings: Finding[]; statuses: SuppressionStatus[] } {
  const copies = structuredClone(findings) as Finding[];
  const { statuses, applied } = matchSuppressions(copies, profile.scan.suppressions, { today: ctx.today ?? new Date().toISOString().slice(0, 10), scenarios: ctx.scenarios, devices: ctx.devices });
  for (const f of copies) { const a = applied.get(f.id); if (a) f.suppressed = a; }
  return { findings: copies, statuses };
}

/** Every finding the sweeps and the scan reported, once each, in first-seen order. */
export function collectFindings(sweeps: readonly SweepResult[], scan: ScanResult | undefined): Finding[] {
  const byId = new Map<string, Finding>();
  for (const f of [...sweeps.flatMap((s) => s.findings), ...(scan?.findings ?? [])]) if (!byId.has(f.id)) byId.set(f.id, f);
  return [...byId.values()];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function evaluateCi(input: {
  flows: readonly CiFlowResult[];
  sweeps: readonly CiSweepEntry[];
  scanRuns: ScanResult['runs'];
  findings: readonly Finding[];
  groups: readonly FindingGroup[];
  sel: Pick<CiSelections, 'failOn' | 'failOnHeuristic' | 'scenarioErrors'>;
}): CiVerdict {
  const { flows, sweeps, scanRuns, findings, groups, sel } = input;
  const failing = failingFindings(findings, sel);
  const failingIds = failing.map((f) => f.id);
  const reasons: string[] = [];
  const failedFlows = flows.filter((f) => !f.passed);
  for (const f of failedFlows) reasons.push(`flow "${f.name}" failed${f.failedStep ? ` at step ${f.failedStep.index} (${f.failedStep.label}): ${f.failedStep.text}` : ''}`);
  // The scan's own policy text says what was and was not counted; a flow or a sweep adds its own facts.
  const policy = evaluatePolicy(findings, scanRuns, { failOn: sel.failOn, failOnErrors: sel.scenarioErrors === 'fail', failOnHeuristic: sel.failOnHeuristic });
  const idle = 'no findings and no failed scenario runs';
  for (const r of policy.reasons) if (r !== idle) reasons.push(r);
  const failedWidths = sweeps.flatMap((s) => s.devices.filter((d) => d.status === 'error').map((d) => `${s.route} at ${d.device}`));
  if (failedWidths.length) {
    reasons.push(`${plural(failedWidths.length, 'sweep width', 'sweep widths')} could not be measured${sel.scenarioErrors === 'fail' ? '' : ' but scenarioErrors is report'}: ${failedWidths.join(', ')}`);
  }
  const failed = failedFlows.length > 0 || policy.result === 'fail' || (sel.scenarioErrors === 'fail' && failedWidths.length > 0);
  if (!reasons.length) {
    const runs = sweeps.reduce((n, s) => n + s.devices.length, 0) + scanRuns.length;
    reasons.push(`no findings, no failed flows and no failed runs (${plural(flows.length, 'flow', 'flows')}, ${plural(runs, 'sweep or scenario run', 'sweep and scenario runs')})`);
  }
  const failingGroups = groups.filter((g) => g.findings.some((id) => failingIds.includes(id))).map((g) => g.id);
  return { result: failed ? 'fail' : 'pass', exitCode: failed ? EXIT.failed : EXIT.pass, reasons, failingFindings: failingIds, failingGroups };
}

/** Group findings for the result: the shared fingerprint grouping of scans. */
export const groupForCi = (findings: readonly Finding[]): FindingGroup[] => groupFindings(findings);

/** Paths of the evidence frames the findings point at (absolute, as the Lab wrote them). */
export function frameRefs(findings: readonly Finding[]): string[] {
  return [...new Set(findings.flatMap((f) => [...(f.frame ? [f.frame] : []), ...(f.frames ?? []).map((x) => x.path)]))];
}

/** Findings with frame paths replaced by `map` (source → relative path); a frame without an entry is dropped. */
export function withFrames(findings: readonly Finding[], map: ReadonlyMap<string, string>): Finding[] {
  return findings.map((f) => {
    const { frame, frames, ...rest } = structuredClone(f);
    const own = frame ? map.get(frame) : undefined;
    const more = (frames ?? []).flatMap((x) => { const p = map.get(x.path); return p ? [{ ...x, path: p }] : []; });
    return { ...rest, ...(own ? { frame: own } : {}), ...(more.length ? { frames: more } : {}) };
  });
}

// ---------- text ----------

const verdictWord = (v: CiVerdict) => v.result === 'pass' ? 'PASS' : v.result === 'fail' ? 'FAIL' : 'ERROR';

export function formatCiText(r: CiResult): string {
  const v = r.verdict;
  const out: string[] = [];
  out.push(`agentlab ${r.command}: ${verdictWord(v)} (exit ${v.exitCode})  ${r.project.name}  ${formatDuration(r.ms)}`);
  out.push('reasons:', ...v.reasons.map((x) => `  - ${x}`));
  const sel = r.selections;
  out.push(`policy: failOn=${sel.failOn}${sel.failOnHeuristic ? ' (heuristics count)' : ''}, scenarioErrors=${sel.scenarioErrors}; auth ${r.environment.auth}`);
  if (r.flows.length) {
    out.push(`flows: ${r.flows.length}, ${r.flows.filter((f) => !f.passed).length} failed`);
    for (const f of r.flows) out.push(f.passed ? `  PASS ${f.name} (${f.completed}/${f.steps} steps)` : `  FAIL ${f.name}${f.failedStep ? `: step ${f.failedStep.index} "${f.failedStep.label}": ${f.failedStep.text}` : ''}`);
  }
  if (r.sweeps.length) {
    out.push(`sweeps: ${r.sweeps.length} route${r.sweeps.length === 1 ? '' : 's'}`);
    for (const s of r.sweeps) {
      const ok = s.devices.filter((d) => d.status === 'ok').length;
      const ids = new Set(s.devices.flatMap((d) => d.findings));
      out.push(`  ${s.route}: ${ok}/${s.devices.length} widths measured, ${plural(ids.size, 'finding', 'findings')}${s.devices.filter((d) => d.status === 'error').map((d) => `; ${d.device} failed: ${d.error ?? 'error'}`).join('')}`);
    }
  }
  if (r.scan) {
    const failedRuns = r.scan.runs.filter((x) => x.status === 'failed');
    out.push(`scenarios: ${r.scan.runs.length} runs, ${failedRuns.length} failed`);
    for (const x of failedRuns) out.push(`  FAIL "${x.scenario}" @ ${x.device}${x.failedAt ? ` (${x.failedAt})` : ''}${'error' in x && x.error ? `: ${x.error}` : ''}`);
  }
  const live = r.groups.filter((g) => !g.suppressed);
  const counts = `${live.filter((g) => g.confidence === 'confirmed').length} confirmed, ${live.filter((g) => g.confidence === 'heuristic').length} heuristic, ${r.groups.length - live.length} suppressed`;
  out.push(`findings: ${plural(r.groups.length, 'group', 'groups')} (${counts})`);
  const failing = r.groups.filter((g) => v.failingGroups.includes(g.id));
  if (failing.length) {
    out.push('failing groups:');
    for (const g of failing.slice(0, 10)) out.push(`  ${g.id} [${g.severity}, ${g.confidence}] ${g.title}  devices: ${g.devices.join(', ')}  findings: ${g.findings.join(', ')}`);
    if (failing.length > 10) out.push(`  … and ${failing.length - 10} more (see report.html)`);
  }
  const unused = r.suppressions.filter((s) => s.status !== 'applied');
  if (unused.length) out.push(`suppressions: ${unused.map((s) => `rule ${s.rule} ${s.status}`).join(', ')}`);
  for (const t of r.traces) out.push(t.file ? `trace: ${t.name} → ${t.file}` : `trace: ${t.name} dropped (${t.dropped})`);
  for (const b of r.bundles) out.push(`bundle: ${b.for} → ${b.dir}${b.trace === 'included' ? ' (with trace)' : ''}`);
  if (r.artifacts.length) out.push(`artifacts: ${r.artifacts.map((a) => a.path).join(', ')}`);
  return out.join('\n') + '\n';
}

// ---------- JUnit ----------

/** Escape for XML 1.0 text and attributes; characters XML cannot carry are dropped. */
export function xml(v: unknown): string {
  let out = '';
  for (const ch of String(v)) {
    const c = ch.codePointAt(0)!;
    const ok = c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff);
    if (ok) out += ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' } as Record<string, string>)[ch] ?? ch;
  }
  return out;
}

interface Case { name: string; time: number; failure?: string; error?: string; skipped?: string; note?: string }

export function ciJunit(r: CiResult): string {
  const byId = new Map(r.findings.map((f) => [f.id, f]));
  const failing = new Set(r.verdict.failingFindings);
  const describe = (ids: readonly string[]) => [...new Set(ids)].map((id) => byId.get(id)).filter((f): f is Finding => !!f).map((f) => `${f.id} [${f.severity}, ${f.confidence}${f.suppressed ? ', suppressed' : ''}] ${f.kind}: ${f.message}`);
  const forFindings = (name: string, ms: number, ids: readonly string[]): Case => {
    const bad = ids.filter((id) => failing.has(id));
    const rest = ids.filter((id) => !failing.has(id));
    return { name, time: ms / 1000, ...(bad.length ? { failure: describe(bad).join('\n') } : {}), ...(rest.length ? { note: `not counted:\n${describe(rest).join('\n')}` } : {}) };
  };
  const errorsFail = r.selections.scenarioErrors === 'fail';
  const flows: Case[] = r.flows.map((f) => ({
    name: f.name, time: f.ms / 1000,
    ...(f.passed ? {} : { failure: f.failedStep ? `step ${f.failedStep.index} (${f.failedStep.label}): ${f.failedStep.text}` : 'the flow did not finish' }),
  }));
  const sweeps: Case[] = r.sweeps.flatMap((s) => s.devices.map((d): Case => {
    const c = forFindings(`${s.route} @ ${d.device}`, d.ms, d.findings);
    return d.status === 'error' ? { name: c.name, time: c.time, ...(errorsFail ? { error: d.error ?? 'could not be measured' } : { skipped: d.error ?? 'could not be measured' }) } : c;
  }));
  const scenarios: Case[] = (r.scan?.runs ?? []).map((x): Case => {
    const name = `${x.scenario} @ ${x.device}`;
    if (x.status === 'failed') {
      const why = `${x.failedAt ? `failed at ${x.failedAt}` : 'failed'}${'error' in x && x.error ? `: ${x.error}` : ''}`;
      return { name, time: 0, ...(errorsFail ? { error: why } : { skipped: why }) };
    }
    return forFindings(name, 0, x.findings);
  });
  const suites = [{ name: 'agentlab.flows', cases: flows }, { name: 'agentlab.sweeps', cases: sweeps }, { name: 'agentlab.scenarios', cases: scenarios }]
    .filter((s) => s.cases.length);
  if (r.verdict.result === 'error') {
    suites.push({ name: 'agentlab.run', cases: [{ name: r.timedOut ? 'timed out' : r.cancelled ? 'cancelled' : 'run', time: 0, error: r.verdict.reasons.join('; ') }] });
  }
  const n = (cs: Case[], k: 'failure' | 'error' | 'skipped') => cs.filter((c) => c[k] !== undefined).length;
  const total = suites.flatMap((s) => s.cases);
  const body = suites.map((s) => {
    const time = s.cases.reduce((t, c) => t + c.time, 0).toFixed(3);
    const cases = s.cases.map((c) => {
      const inner = (c.failure !== undefined ? `<failure message="${xml(c.failure.split('\n')[0])}" type="agentlab">${xml(c.failure)}</failure>` : '')
        + (c.error !== undefined ? `<error message="${xml(c.error.split('\n')[0])}" type="agentlab">${xml(c.error)}</error>` : '')
        + (c.skipped !== undefined ? `<skipped message="${xml(c.skipped)}"/>` : '')
        + (c.note ? `<system-out>${xml(c.note)}</system-out>` : '');
      return `    <testcase classname="${xml(s.name)}" name="${xml(c.name)}" time="${c.time.toFixed(3)}"${inner ? `>${inner}</testcase>` : '/>'}`;
    }).join('\n');
    return `  <testsuite name="${xml(s.name)}" tests="${s.cases.length}" failures="${n(s.cases, 'failure')}" errors="${n(s.cases, 'error')}" skipped="${n(s.cases, 'skipped')}" time="${time}" timestamp="${xml(r.startedAt)}">\n${cases}\n  </testsuite>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="agentlab" tests="${total.length}" failures="${n(total, 'failure')}" errors="${n(total, 'error')}" skipped="${n(total, 'skipped')}" time="${(r.ms / 1000).toFixed(3)}">\n${body}\n</testsuites>\n`;
}

// ---------- HTML ----------

/** `dir` is the artifacts directory: the relative `frames/…` paths of the findings resolve against it. */
export function ciHtml(r: CiResult, dir: string): string {
  const findings = r.findings.map((f) => {
    const abs = (p: string) => isAbsolute(p) ? p : join(dir, p);
    return { ...f, ...(f.frame ? { frame: abs(f.frame) } : {}), ...(f.frames ? { frames: f.frames.map((x) => ({ ...x, path: abs(x.path) })) } : {}) };
  });
  const byId = new Map(findings.map((f) => [f.id, f]));
  const v = r.verdict;
  const sel = r.selections;
  const cls = v.result === 'pass' ? 'pass' : v.result === 'fail' ? 'fail' : 'error';
  const live = r.groups.filter((g) => !g.suppressed);
  const confirmed = live.filter((g) => g.confidence === 'confirmed');
  const heuristic = live.filter((g) => g.confidence === 'heuristic');
  const suppressed = r.groups.filter((g) => g.suppressed);
  // A partly suppressed group is listed with its live members above; its suppressed findings are listed here too.
  const partial = findings.filter((f) => f.suppressed && !suppressed.some((g) => g.findings.includes(f.id)));
  const groups = (gs: FindingGroup[], quiet: boolean, none: string) => gs.length ? gs.map((g) => groupHtml(dir, g, byId, quiet)).join('') : `<p class="muted">${esc(none)}</p>`;
  const row = (cells: unknown[], klass = '') => `<tr>${cells.map((c, i) => `<td${i === 0 && klass ? ` class="${klass}"` : ''}>${esc(c)}</td>`).join('')}</tr>`;
  const table = (head: string[], rows: string[]) => `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;

  const flows = r.flows.length ? table(['Flow', 'Result', 'Steps', 'Time', 'Detail'], r.flows.map((f) =>
    `<tr><td>${esc(f.name)}</td><td class="${f.passed ? 'ok' : 'failed'}">${f.passed ? 'pass' : 'FAIL'}</td><td>${esc(f.completed)}/${esc(f.steps)}</td><td>${esc(formatDuration(f.ms))}</td>` +
    `<td>${f.failedStep ? esc(`step ${f.failedStep.index} (${f.failedStep.label}): ${f.failedStep.text}`) : ''}${f.bundle ? ` <code>${esc(f.bundle)}</code>` : ''}</td></tr>`)) : '<p class="muted">No flows were selected.</p>';
  const sweeps = r.sweeps.length ? r.sweeps.map((s) => `<h3>${esc(s.route)} <span class="muted">${esc(s.id)} · ${esc(formatDuration(s.ms))}</span></h3>` + table(['Device', 'Width', 'Status', 'Findings'],
    s.devices.map((d) => `<tr><td>${esc(d.device)}</td><td>${esc(d.width)}</td><td class="${d.status === 'ok' ? 'ok' : 'failed'}">${esc(d.status === 'ok' ? 'ok' : `error: ${d.error ?? ''}`)}</td><td>${esc(d.findings.join(', '))}</td></tr>`))).join('') : '<p class="muted">No routes were swept.</p>';
  const scan = r.scan ? (() => {
    const scenarios = [...new Set(r.scan.runs.map((x) => x.scenario))];
    const devices = [...new Set(r.scan.runs.map((x) => x.device))];
    const cell = (x: (typeof r.scan.runs)[number] | undefined) => !x ? '<td class="muted">not run</td>'
      : x.status === 'ok' ? `<td class="ok">ok · ${esc(x.states)} states · ${esc(x.findings.length)} findings</td>`
        : `<td class="failed"><strong>failed at ${esc(x.failedAt ?? 'unknown')}</strong>${'error' in x && x.error ? `: ${esc(x.error)}` : ''}</td>`;
    return `<table><thead><tr><th>Scenario</th>${devices.map((d) => `<th>${esc(d)}</th>`).join('')}</tr></thead><tbody>${scenarios.map((s) => `<tr><th>${esc(s)}</th>${devices.map((d) => cell(r.scan!.runs.find((x) => x.scenario === s && x.device === d))).join('')}</tr>`).join('')}</tbody></table>` +
      `<p class="muted">The scan's own report: <code>${esc(r.scan.reports.html)}</code></p>`;
  })() : '<p class="muted">No scenarios were scanned.</p>';
  const supRows = r.suppressions.map((s) => {
    const label = s.status === 'applied' ? `applied to ${s.matched.length} findings (${s.matched.join(', ')})` : s.status === 'unmatched' ? 'stale: matched nothing in this run'
      : s.status === 'expired' ? `expired on ${s.expires ?? 'an earlier date'}` : 'not evaluated (scope not in this run)';
    return `<tr><td>${esc(s.rule)}</td><td>${esc(s.reason)}</td><td>${esc(label)}</td><td>${esc(s.expires ?? '')}</td></tr>`;
  });

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>agentlab ${esc(r.command)}: ${esc(r.project.name)}</title><style>${CSS}.verdict.error{background:var(--med)}</style></head><body><main>
<h1>${esc(r.project.name)} <span class="verdict ${cls}">${esc(verdictWord(v))}</span></h1>
<p class="muted">agentlab ${esc(r.command)} · exit ${esc(v.exitCode)} · started ${esc(r.startedAt)} · ${esc(formatDuration(r.ms))}${r.timedOut ? ' · timed out' : ''}${r.cancelled ? ` · cancelled (${esc(r.cancelled)})` : ''}</p>
<ul>${v.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
<h2>Selections and environment</h2>
${table(['Setting', 'Value'], [
    row(['flows', sel.flows.join(', ') || 'none']), row(['routes', sel.routes.join(', ') || 'none']), row(['scenarios', sel.scenarios.join(', ') || 'none']),
    row(['devices', (sel.devices ?? ['each scenario\'s own']).join(', ')]), row(['sweep devices', sel.sweepDevices.join(', ')]),
    row(['failOn', `${sel.failOn}${sel.failOnHeuristic ? ' (heuristics count)' : ''}`]), row(['scenarioErrors', sel.scenarioErrors]),
    row(['trace / evidence', `${sel.trace} / ${sel.evidence}`]), row(['timeout', formatDuration(sel.timeoutMs)]),
    row(['sign-in', r.environment.auth]), row(['agentlab', r.product.version]),
    row(['node / platform', `${r.environment.node} on ${r.environment.platform}/${r.environment.arch}`]), row(['chromium', r.environment.chromium ?? 'not started']),
  ])}
<h2>Flows</h2>${flows}
<h2>Sweeps</h2>${sweeps}
<h2>Scenario matrix</h2>${scan}
<h2>Confirmed problems</h2>${groups(confirmed, false, 'None.')}
<h2>Heuristic warnings</h2>${groups(heuristic, true, 'None.')}
<h2>Suppressed findings</h2>${groups(suppressed, true, 'No group is fully suppressed.')}${partial.length ? `<h3>Suppressed findings in groups that are still reported</h3>${findingsTable(partial)}` : ''}
<h2>Suppressions</h2>${r.suppressions.length ? table(['Rule', 'Reason', 'Status', 'Expires'], supRows) : '<p class="muted">No suppressions configured.</p>'}
<h2>Artifacts</h2>
<ul>${r.artifacts.map((a) => `<li><code>${esc(a.path)}</code> <span class="muted">${esc(a.kind)}</span></li>`).join('')}${r.bundles.map((b) => `<li><code>${esc(b.dir)}</code> <span class="muted">failure bundle for ${esc(b.for)}${b.trace === 'included' ? ', with trace' : ''}</span></li>`).join('')}${r.traces.map((t) => `<li>${t.file ? `<code>${esc(t.file)}</code>` : esc(t.name)} <span class="muted">${t.file ? 'trace' : `trace dropped: ${esc(t.dropped ?? '')}`}</span></li>`).join('')}</ul>
<p class="muted">Full data: <code>ci-result.json</code>. No environment values, request bodies, headers or sign-in state are ever written here.</p>
</main></body></html>
`;
}

// ---------- reading a saved result ----------

/** Parse and check a saved ci-result.json. A newer version is refused with a clear message. */
export function parseCiResult(raw: unknown): CiResult {
  const bad = (why: string): never => { throw new LabError('invalid_request', `Not a usable agentlab CI result: ${why}`); };
  if (!raw || typeof raw !== 'object') return bad('not a JSON object');
  const o = raw as Record<string, unknown>;
  if (o.schema !== CI_SCHEMA) return bad(`"schema" must be "${CI_SCHEMA}"`);
  if (typeof o.version !== 'number' || !Number.isInteger(o.version) || o.version < 1) return bad('"version" must be a positive integer');
  if (o.version > CONTRACT_VERSIONS.report) {
    throw new LabError('invalid_request', `This CI result is version ${o.version}; this agentlab ${productVersion()} reads up to ${CONTRACT_VERSIONS.report}`, { hint: 'Upgrade agentlab to render it.' });
  }
  for (const k of ['flows', 'sweeps', 'findings', 'groups', 'suppressions', 'bundles', 'traces', 'artifacts']) if (!Array.isArray(o[k])) bad(`"${k}" must be a list`);
  if (!o.verdict || typeof o.verdict !== 'object' || !o.selections || typeof o.selections !== 'object' || !o.environment || !o.project) bad('"verdict", "selections", "environment" and "project" are required');
  return raw as CiResult;
}

export function renderCi(r: CiResult, format: CiFormat, dir: string): string {
  switch (format) {
    case 'text': return formatCiText(r);
    case 'json': return JSON.stringify(r, null, 2) + '\n';
    case 'junit': return ciJunit(r);
    case 'html': return ciHtml(r, dir);
  }
}

export const CI_FILES: Record<CiFormat, string> = { text: 'summary.txt', json: 'ci-result.json', html: 'report.html', junit: 'junit.xml' };
