import { readFileSync } from 'node:fs';
import { routePath } from './action-log.js';
import { loadBundle, sha256 } from './bundle.js';
import { Lab } from './lab.js';
import { loadProfile } from './profile.js';
import {
  LabError, SCHEMA_VERSION,
  type ActionName, type ActionRequest, type BundleFailure, type Direction, type Observation, type RecordedAction, type RecordedAgentAction, type RecordedTarget,
} from './schema.js';

// Replay: re-run the agent actions of a failure bundle against the live project and say whether the failure
// happens again. Security: nothing that runs comes from the bundle. Commands, environment and paths always
// come from the agentlab.json in --project (its hash is compared and a difference is only a warning); the
// bundle supplies role/name targets and typed values, which go through the same `act()` (and so the same
// uploads.allow check) an agent's would. A replay never continues past a divergence: it stops there and reports.

const ACTIONS: readonly ActionName[] = [
  'click', 'fill', 'press', 'select', 'check', 'uncheck', 'scroll', 'swipe', 'back', 'forward', 'hover', 'upload', 'drag', 'open_tab', 'switch_tab', 'close_tab',
];
const NEEDS_TARGET: readonly ActionName[] = ['click', 'fill', 'select', 'check', 'uncheck', 'hover', 'upload', 'drag'];
const DIRECTIONS: readonly string[] = ['up', 'down', 'left', 'right'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ReplayOptions {
  /** A bundle directory or its bundle.json. */
  bundle: string;
  /** Project directory or agentlab.json (default: the current directory). Always the live one. */
  project?: string;
  stateDir: string;
  headed?: boolean;
  allowConsequential?: boolean;
  /** Step index → name of the environment variable holding the value the recording masked. */
  secrets?: Record<number, string>;
  /** Stop after this step. The outcome is then `not-reproduced` unless the failure step was reached. */
  until?: number;
  env?: NodeJS.ProcessEnv;
  onStep?: (step: ReplayStep) => void;
  /** Called with the replay's lab once it exists, so a signal handler can close it. */
  onLab?: (lab: Lab) => void;
}

export interface ReplayStep {
  index: number;
  description: string;
  status: 'ok' | 'error-as-recorded' | 'reproduced' | 'not-reproduced' | 'diverged' | 'blocked';
  detail?: string;
}

export interface ReplayResult {
  schemaVersion: typeof SCHEMA_VERSION;
  outcome: 'reproduced' | 'not-reproduced' | 'diverged' | 'blocked';
  reason: string;
  bundle: { id: string; createdAt: string; reason: string; failure: BundleFailure };
  warnings: string[];
  session?: { id: string; device: string };
  steps: ReplayStep[];
  divergence?: { step: number; what: string; expected: string; actual: string };
  blocked?: { step: number; reason: string };
  /** Findings failures: the recorded fingerprints and which were found again. */
  findings?: { expected: string[]; missing: string[] };
}

/** 0 reproduced, 1 not reproduced, 3 diverged or blocked (2, could not run, is an error thrown before a result exists). */
export function replayExitCode(r: ReplayResult): number {
  return r.outcome === 'reproduced' ? 0 : r.outcome === 'not-reproduced' ? 1 : 3;
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The bundle is untrusted input: check every field the replay uses before it drives a browser. */
function checkActions(raw: readonly RecordedAction[]): RecordedAction[] {
  const bad = (i: number, why: string): never => { throw new LabError('bundle_invalid', `Not a usable failure bundle: action ${i + 1} ${why}`); };
  const optStr = (v: unknown) => v === undefined || typeof v === 'string';
  const target = (v: unknown, i: number, what: string) => {
    if (v === undefined) return;
    if (!isRec(v) || typeof v.role !== 'string' || typeof v.name !== 'string' || !optStr(v.context)) bad(i, `has a malformed ${what}`);
  };
  raw.forEach((a, i) => {
    if (!isRec(a) || !Number.isInteger(a.index) || (a.index as number) < 1 || typeof a.at !== 'string') return bad(i, 'is malformed');
    if (a.actor === 'person') { if (typeof a.description !== 'string') bad(i, 'has no description'); return; }
    if (a.actor !== 'agent' || !ACTIONS.includes(a.action)) return bad(i, 'has an unknown actor or action');
    target(a.target, i, 'target');
    target(a.toTarget, i, 'toTarget');
    const args = a.args as Record<string, unknown>;
    if (!isRec(args)) return bad(i, 'has no args');
    for (const k of ['value', 'key', 'tab', 'path']) if (!optStr(args[k])) bad(i, `has a non-text ${k}`);
    for (const k of ['amount', 'dx', 'dy']) if (args[k] !== undefined && (typeof args[k] !== 'number' || !Number.isFinite(args[k]))) bad(i, `has a non-numeric ${k}`);
    for (const k of ['values', 'files']) if (args[k] !== undefined && (!Array.isArray(args[k]) || !(args[k] as unknown[]).every((x) => typeof x === 'string'))) bad(i, `has a malformed ${k}`);
    if (args.direction !== undefined && !DIRECTIONS.includes(args.direction as string)) bad(i, 'has an unknown direction');
    for (const k of ['routeBefore', 'routeAfter', 'dialogBefore', 'dialogAfter']) if (!optStr(a[k])) bad(i, `has a malformed ${k}`);
    if (a.outcome !== 'success' && a.outcome !== 'error') bad(i, 'has no outcome');
    if (a.error !== undefined && (!isRec(a.error) || typeof a.error.code !== 'string')) bad(i, 'has a malformed error');
  });
  return [...raw].sort((a, b) => a.index - b.index);
}

function describe(a: RecordedAgentAction): string {
  const t = a.target ? ` ${a.target.role} ${JSON.stringify(a.target.name)}${a.target.context ? ` (in ${JSON.stringify(a.target.context)})` : ''}` : '';
  const args = a.args;
  switch (a.action) {
    case 'fill': return `fill${t} ${a.secret ? 'with ‹secret›' : `(${(args.value ?? '').length} chars)`}`;
    case 'press': return `press ${a.secret ? '‹secret›' : args.key}${t ? ` in${t}` : ''}`;
    case 'select': return `select ${args.values?.length ?? 0} option(s) in${t}`;
    case 'scroll': case 'swipe': return `${a.action} ${args.direction ?? 'to'}${t}`;
    case 'upload': return `upload ${args.files?.length ?? 0} file(s) to${t}`;
    case 'drag': return `drag${t} ${a.toTarget ? `onto ${a.toTarget.role} ${JSON.stringify(a.toTarget.name)}` : `by (${args.dx ?? 0}, ${args.dy ?? 0})`}`;
    case 'open_tab': return `open a tab at ${args.path}`;
    case 'switch_tab': case 'close_tab': return `${a.action} ${args.tab ?? ''}`.trim();
    default: return `${a.action}${t}`;
  }
}

const matchesTarget = (o: Observation, t: RecordedTarget) => o.controls.filter((c) => c.role === t.role && c.name === t.name);

/** The ref of the one control matching role, name and (to pick among duplicates) context; otherwise why not. Never guesses. */
async function resolveTarget(lab: Lab, t: RecordedTarget): Promise<{ ref: string } | { problem: string }> {
  const find = (o: Observation) => {
    let m = matchesTarget(o, t);
    if (m.length > 1 && t.context !== undefined) m = m.filter((c) => c.context === t.context);
    return m;
  };
  let obs = lab.lastObservation!;
  let m = find(obs);
  if (!m.length && obs.omitted > 0) { obs = await lab.observe({ limit: 500 }); m = find(obs); }
  const what = `${t.role} ${JSON.stringify(t.name)}${t.context ? ` in ${JSON.stringify(t.context)}` : ''}`;
  if (m.length === 1) return { ref: m[0]!.ref };
  if (m.length > 1) return { problem: `${m.length} controls match ${what}; not guessing` };
  const sameRole = obs.controls.filter((c) => c.role === t.role).slice(0, 6).map((c) => JSON.stringify(c.name));
  return { problem: `no ${what}${sameRole.length ? ` (${t.role}s here: ${sameRole.join(', ')})` : ''}` };
}

export async function replayBundle(o: ReplayOptions): Promise<ReplayResult> {
  const env = o.env ?? process.env;
  const bundle = loadBundle(o.bundle);
  const actions = checkActions(bundle.actions);
  const failure = bundle.failure;
  const failStep = failure.kind === 'action-error' ? failure.step : undefined;
  for (const [step, name] of Object.entries(o.secrets ?? {})) {
    const a = actions.find((x) => x.index === Number(step));
    if (!ENV_NAME.test(name)) throw new LabError('invalid_request', `--secret ${step}=${name.slice(0, 40)}: "${name.slice(0, 40)}" is not an environment variable name`);
    if (!a || a.actor !== 'agent' || !a.secret) throw new LabError('invalid_request', `--secret: step ${step} has no masked value`, { hint: 'Steps with a masked value are marked ‹secret› in `agentlab bundles show`.' });
  }

  const profile = await loadProfile(o.project ?? process.cwd());
  const warnings: string[] = [];
  if (sha256(readFileSync(profile.profilePath)) !== bundle.project.profileSha256) {
    warnings.push('agentlab.json differs from the one the bundle was recorded with; replaying against the current one');
  }
  const result: ReplayResult = {
    schemaVersion: SCHEMA_VERSION, outcome: 'blocked', reason: '', warnings, steps: [],
    bundle: { id: bundle.id, createdAt: bundle.retention?.createdAt ?? '', reason: bundle.reason, failure },
  };
  const finish = (outcome: ReplayResult['outcome'], reason: string): ReplayResult => Object.assign(result, { outcome, reason });
  const step = (s: ReplayStep) => { result.steps.push(s); o.onStep?.(s); };
  const block = (index: number, description: string, reason: string) => {
    step({ index, description, status: 'blocked', detail: reason });
    result.blocked = { step: index, reason };
    return finish('blocked', `step ${index}: ${reason}`);
  };

  if (bundle.actionsOmitted > 0) {
    return block(1, 'the recorded start', `the bundle's log dropped its first ${bundle.actionsOmitted} action(s), so the session cannot be rebuilt from the start`);
  }

  const lab = new Lab({ stateDir: o.stateDir });
  o.onLab?.(lab);
  try {
    const started = await lab.start({
      project: profile.profilePath, device: bundle.session.device, headed: o.headed === true, auth: bundle.session.auth === 'saved-state' ? 'saved' : 'fresh',
    });
    result.session = { id: started.session.id, device: started.session.device.id };
    const now = () => ({ route: routePath(lab.lastObservation?.route), dialog: lab.lastObservation?.dialog });
    const last = Math.min(o.until ?? Infinity, failStep ?? Infinity);

    for (const a of actions) {
      if (a.index > last) break;
      if (a.actor === 'person') return block(a.index, `a person: ${a.description}`, `a person's interaction is recorded only as a description ("${a.description}"), so it cannot be replayed`);
      const description = describe(a);
      const diverge = (what: string, expected: string, actual: string) => {
        step({ index: a.index, description, status: 'diverged', detail: `${what}: expected ${expected}, got ${actual}` });
        result.divergence = { step: a.index, what, expected, actual };
        return finish('diverged', `step ${a.index}: ${what}: expected ${expected}, got ${actual}`);
      };

      const cur = now();
      if (a.routeBefore !== undefined && cur.route !== a.routeBefore) return diverge('route before the step', a.routeBefore, cur.route ?? 'none');
      if ((a.dialogBefore ?? null) !== (cur.dialog ?? null)) return diverge('dialog before the step', a.dialogBefore ? JSON.stringify(a.dialogBefore) : 'none', cur.dialog ? JSON.stringify(cur.dialog) : 'none');

      if (NEEDS_TARGET.includes(a.action) && !a.target) return block(a.index, description, 'the recorded action has no role/name target (its ref was not in the last observation), so it cannot be found again');
      let ref: string | undefined;
      let toRef: string | undefined;
      if (a.target) {
        const r = await resolveTarget(lab, a.target);
        if ('problem' in r) return diverge('target', `${a.target.role} ${JSON.stringify(a.target.name)}`, r.problem);
        ref = r.ref;
      }
      if (a.toTarget) {
        const r = await resolveTarget(lab, a.toTarget);
        if ('problem' in r) return diverge('drop target', `${a.toTarget.role} ${JSON.stringify(a.toTarget.name)}`, r.problem);
        toRef = r.ref;
      }

      if (a.consequential && !o.allowConsequential) {
        return block(a.index, description, `its target's name suggests a consequential action (${JSON.stringify(a.target?.name ?? a.toTarget?.name)}); pass --allow-consequential to run it`);
      }
      if (a.truncated) return block(a.index, description, 'the typed value was longer than the log keeps');
      const typed: { value?: string; key?: string } = {};
      if (a.secret) {
        const name = o.secrets?.[a.index];
        if (!name) return block(a.index, description, `the recorded value is masked; supply it with --secret ${a.index}=<ENV_NAME>`);
        const value = env[name];
        if (!value) return block(a.index, description, `environment variable ${name} (for --secret ${a.index}) is not set`);
        if (a.action === 'fill') typed.value = value; else typed.key = value;
      }

      const args = a.args;
      const request: ActionRequest = {
        action: a.action, ...(ref ? { ref } : {}), ...(toRef ? { toRef } : {}),
        ...(args.value !== undefined ? { value: args.value } : {}), ...(args.key !== undefined ? { key: args.key } : {}), ...typed,
        ...(args.values ? { values: args.values } : {}), ...(args.direction ? { direction: args.direction as Direction } : {}),
        ...(args.amount !== undefined ? { amount: args.amount } : {}), ...(args.dx !== undefined ? { dx: args.dx } : {}), ...(args.dy !== undefined ? { dy: args.dy } : {}),
        ...(args.files ? { files: args.files } : {}), ...(args.tab !== undefined ? { tab: args.tab } : {}), ...(args.path !== undefined ? { path: args.path } : {}),
      };
      const r = await lab.act(request);
      const after = now();
      const code = r.error?.code;

      if (a.index === failStep) {
        const want = (failure as Extract<BundleFailure, { kind: 'action-error' }>).code;
        if (r.outcome === 'error' && code === want) {
          step({ index: a.index, description, status: 'reproduced', detail: `failed with ${code}, as recorded` });
          return finish('reproduced', `step ${a.index} failed with ${code} again`);
        }
        const got = r.outcome === 'error' ? `failed with ${code}` : 'succeeded';
        step({ index: a.index, description, status: 'not-reproduced', detail: `expected ${want}, ${got}` });
        return finish('not-reproduced', `step ${a.index} ${got}; the recording failed with ${want}`);
      }
      if (r.outcome !== a.outcome || code !== a.error?.code) {
        return diverge('outcome', a.outcome === 'error' ? `error ${a.error?.code}` : 'success', r.outcome === 'error' ? `error ${code}` : 'success');
      }
      if (a.routeAfter !== undefined && after.route !== a.routeAfter) return diverge('route after the step', a.routeAfter, after.route ?? 'none');
      if ((a.dialogAfter ?? null) !== (after.dialog ?? null)) return diverge('dialog after the step', a.dialogAfter ? JSON.stringify(a.dialogAfter) : 'none', after.dialog ? JSON.stringify(after.dialog) : 'none');
      step({ index: a.index, description, status: a.outcome === 'error' ? 'error-as-recorded' : 'ok', ...(a.outcome === 'error' ? { detail: `failed with ${code}, as recorded` } : {}) });
    }

    // Every step that was asked for has run without divergence.
    const stoppedEarly = o.until !== undefined && actions.some((a) => a.index > o.until! && (failStep === undefined || a.index <= failStep));
    if (stoppedEarly) return finish('not-reproduced', `stopped after step ${o.until} (--until) before the failure could be checked`);
    return await verify(lab, bundle, failure, result, finish);
  } finally {
    await lab.close('replay finished').catch(() => undefined);
  }
}

/** After the recorded actions: decide from the kind of failure. */
async function verify(
  lab: Lab, bundle: ReturnType<typeof loadBundle>, failure: BundleFailure, result: ReplayResult,
  finish: (outcome: ReplayResult['outcome'], reason: string) => ReplayResult,
): Promise<ReplayResult> {
  const scenario = bundle.scenario;
  switch (failure.kind) {
    case 'action-error':
      return finish('blocked', `step ${failure.step} is not in the bundle's action log`);
    case 'findings': {
      let found: string[];
      if (scenario) {
        try {
          found = (await lab.scan({ scenarios: [scenario.name], devices: [scenario.device] })).findings.map((f) => f.fingerprint);
        } catch (err) {
          return finish('blocked', `scenario "${scenario.name}" could not be run: ${LabError.from(err).message}`);
        }
      } else found = lab.inspect().findings.map((f) => f.fingerprint);
      const missing = failure.fingerprints.filter((f) => !found.includes(f));
      result.findings = { expected: failure.fingerprints, missing };
      return missing.length
        ? finish('not-reproduced', `${failure.fingerprints.length - missing.length} of ${failure.fingerprints.length} recorded finding(s) appeared again`)
        : finish('reproduced', `all ${failure.fingerprints.length} recorded finding(s) appeared again`);
    }
    case 'scenario-error': {
      let run;
      try {
        run = (await lab.scan({ scenarios: [failure.scenario], devices: [failure.device] })).runs.find((r) => r.scenario === failure.scenario && r.device === failure.device);
      } catch (err) {
        return finish('blocked', `scenario "${failure.scenario}" could not be run: ${LabError.from(err).message}`);
      }
      const at = run?.failedAt;
      const code = run?.error?.code;
      const same = run?.status === 'failed' && at === failure.failedAt && (failure.code === undefined || code === failure.code);
      return same
        ? finish('reproduced', `scenario "${failure.scenario}" on ${failure.device} failed at ${at}${code ? ` with ${code}` : ''} again`)
        : finish('not-reproduced', `scenario "${failure.scenario}" on ${failure.device}: ${run?.status === 'failed' ? `failed at ${at}${code ? ` with ${code}` : ''}` : 'passed'}; the recording failed at ${failure.failedAt}${failure.code ? ` with ${failure.code}` : ''}`);
    }
    case 'expectation':
    case 'manual': {
      // The expectation itself is not in the bundle, so the check is that the recorded end state was reached.
      const end = bundle.observations.at(-1);
      const cur = { route: routePath(lab.lastObservation?.route), dialog: lab.lastObservation?.dialog };
      if (!end) return finish('reproduced', 'every recorded step ran; the bundle has no end state to compare');
      if (cur.route !== end.route || (cur.dialog ?? null) !== (end.dialog ?? null)) {
        return finish('not-reproduced', `the recorded end state (route ${end.route}${end.dialog ? `, dialog ${JSON.stringify(end.dialog)}` : ''}) was not reached: route ${cur.route}${cur.dialog ? `, dialog ${JSON.stringify(cur.dialog)}` : ''}`);
      }
      return finish('reproduced', `every recorded step ran and the recorded end state (route ${end.route}) was reached`);
    }
  }
}

/** Text mode: one line per step and the outcome. */
export function formatReplay(r: ReplayResult): string {
  const mark: Record<ReplayStep['status'], string> = { ok: 'ok', 'error-as-recorded': 'ok (error, as recorded)', reproduced: 'REPRODUCED', 'not-reproduced': 'NOT REPRODUCED', diverged: 'DIVERGED', blocked: 'BLOCKED' };
  return [
    `replay of ${r.bundle.id}: ${r.bundle.reason}`,
    ...r.warnings.map((w) => `warning: ${w}`),
    ...r.steps.map((s) => `  step ${s.index}  ${mark[s.status].padEnd(8)} ${s.description}${s.detail ? `  (${s.detail})` : ''}`),
    `${r.outcome}: ${r.reason}`,
  ].join('\n');
}
