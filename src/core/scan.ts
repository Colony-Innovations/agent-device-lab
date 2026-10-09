import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { redactUrlSecrets } from './url-redact.js';
import { join } from 'node:path';
import type { Browser, BrowserContextOptions } from 'playwright';
import { checkFilter, measureState, shot } from './checks.js';
import { getDevice } from './devices.js';
import { wrapHits, type DetectorOptions, type WrapSample } from './detectors.js';
import { blockedRequest, classifyControl, orderCandidates, stateSignature } from './explore-safety.js';
import { controlTraits, installShiftObserver, takeLayoutShifts } from './extract.js';
import type { FindingStore } from './findings.js';
import { Lab, type LabEvent, type WatchPage } from './lab.js';
import { evaluatePolicy, groupFindings, matchSuppressions } from './scan-policy.js';
import { scanReportHtml } from './scan-report.js';
import { check, stepRequest, type FlowStep } from './steps.js';
import {
  LabError, SCHEMA_VERSION,
  type DeviceProfile, type ExploreDecision, type Finding, type Observation, type ProjectProfile, type ScanResult, type ScanScenario, type ScanState,
  type ScenarioDeviceRun, type ScenarioStep, type Interruption, type ScanVerdict,
} from './schema.js';

// Stateful responsive scan. Each scenario runs on each of its devices in its own isolated browser
// context (a child Lab on the session's browser): open the route, run the setup steps through the
// same act() as the CLI and MCP, then measure the state with the one detector engine (checks.ts).
// Optional exploration activates only controls explore-safety.ts judges safe, one at a time, with
// requests that could change data blocked, and returns to the parent state between activations.

export interface ScanEnv {
  browser: Browser;
  profile: ProjectProfile;
  headed: boolean;
  sessionId: string;
  /** The session's cookies and storage (a scenario with auth "session" starts from a copy). */
  sessionState: () => Promise<BrowserContextOptions['storageState']>;
  /** The saved sign-in state (auth "saved"); loaded by auth.ts, never returned or logged. */
  savedState: () => BrowserContextOptions['storageState'];
  /** Session steps so far, the start of reproduction for scenarios that start from the session. */
  sessionHistory: readonly string[];
  gen: () => number;
  store: FindingStore;
  runDir: string;
  emit: (e: LabEvent) => void;
  /** Asked before each scenario × device run: a person paused, took over or stopped the session. */
  checkpoint?: () => Interruption | undefined;
  /** Shows each scenario's page in the session's live viewport while it runs. */
  watch?: WatchPage;
}

export interface ScanOptions {
  id: string;
  /** Scenario names to run (default: all declared). */
  scenarios?: readonly string[];
  /** Overrides the devices of every scenario. */
  devices?: readonly string[];
  /** Overrides whether to explore (default: the profile's scan.explore.enabled, or a scenario's own). */
  explore?: boolean;
  /** Scan this route as loaded instead of the declared scenarios. */
  route?: string;
  /** The day suppressions are checked against (YYYY-MM-DD, default today). */
  today?: string;
}

interface Candidate { role: string; name: string; context?: string; kind: string; label: string }
interface Node { label: string; path: Candidate[]; depth: number; sig: string; candidates: Candidate[]; keys: Set<string>; selectedTabs: Set<string> }
/** The scenario's context, and which explored state it is known to be in (undefined: unknown). */
interface Run { lab?: Lab; at?: Node }

const DECISIONS_MAX = 60;
const controlKey = (c: { role: string; name: string; context?: string }) => `${c.role}\u0000${c.name}\u0000${c.context ?? ''}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'scenario';

export async function runScan(env: ScanEnv, opts: ScanOptions): Promise<ScanResult> {
  const cfg = env.profile.scan;
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const scenarios = selectScenarios(env.profile, opts);
  const plan = scenarios.map((sc) => {
    const ids = opts.devices ? (sc.devices ? sc.devices.filter((d) => opts.devices!.includes(d)) : [...opts.devices]) : (sc.devices ?? cfg.devices);
    return { sc, devices: ids.map((d) => getDevice(d, env.profile.devices)) };
  });
  const dir = join(env.runDir, 'scans', opts.id);
  mkdirSync(dir, { recursive: true });
  const exploring = (sc: ScanScenario) => opts.explore ?? sc.explore ?? cfg.explore.enabled;
  env.emit({
    kind: 'scan', phase: 'start', id: opts.id, explore: scenarios.some(exploring),
    runs: plan.flatMap(({ sc, devices }) => devices.map((d) => ({ scenario: sc.name, route: redactUrlSecrets(sc.route), device: d.id, width: d.viewport.width, height: d.viewport.height }))),
  });

  const runs: ScenarioDeviceRun[] = [];
  const budget = { exploreMs: 0 };
  let interrupted: ScanResult['interrupted'];
  for (const [i, { sc, devices }] of plan.entries()) {
    if (interrupted) break;
    // Per state label, what each device measured: compared across nearby widths when all have run.
    const samples = new Map<string, (WrapSample & { route: string; repro: readonly string[]; stateId: string; run: ScenarioDeviceRun })[]>();
    const scRuns: ScenarioDeviceRun[] = [];
    for (const [j, device] of devices.entries()) {
      const stop = env.checkpoint?.();
      if (stop) {
        // Everything not yet run is listed, never silently dropped; runs already done keep their results.
        const skipped = [...devices.slice(j).map((d) => ({ scenario: sc.name, device: d.id })),
          ...plan.slice(i + 1).flatMap((p) => p.devices.map((d) => ({ scenario: p.sc.name, device: d.id })))];
        interrupted = { ...stop, skipped };
        break;
      }
      env.emit({ kind: 'scan', phase: 'run-start', id: opts.id, scenario: sc.name, device: device.id });
      const run = await runScenario(env, opts, sc, device, join(dir, 'frames', `${i + 1}-${slug(sc.name)}`, device.id), exploring(sc), budget, samples);
      runs.push(run);
      scRuns.push(run);
      env.emit({ kind: 'scan', phase: 'run-done', id: opts.id, run });
    }
    // Label wrapping only shows by comparing widths, so it is checked once every device has run.
    if (checkFilter(cfg.checks, sc.checks)('text-wrap-change')) {
      for (const [label, list] of samples) {
        for (const { device, hit } of wrapHits(list, { ratio: cfg.wrapNearbyRatio, noWrap: cfg.noWrap, route: redactUrlSecrets(sc.route) })) {
          const s = list.find((x) => x.device === device)!;
          const r = env.store.recordHit(hit, { route: s.route, viewport: { width: s.width }, gen: env.gen() }, s.repro,
            { device, keepRefs: false, scenario: sc.name, state: label, ...(s.frame ? { frame: s.frame } : {}) });
          const state = s.run.states.find((st) => st.id === s.stateId);
          if (state && !state.findings.includes(r.finding.id)) state.findings.push(r.finding.id);
          if (!s.run.findings.includes(r.finding.id)) s.run.findings.push(r.finding.id);
          if (r.fresh) env.emit({ kind: 'findings', findings: [r.finding], ...(s.frame ? { frame: s.frame } : {}) });
        }
      }
    }
  }

  const ids = new Set(runs.flatMap((r) => r.findings));
  const findings = env.store.list().filter((f) => ids.has(f.id));
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const { statuses, applied } = matchSuppressions(findings, cfg.suppressions, { today, scenarios: scenarios.map((s) => s.name), devices: [...new Set(runs.map((r) => r.device))] });
  for (const f of findings) env.store.suppress(f.id, applied.get(f.id));
  const result: ScanResult = {
    schemaVersion: SCHEMA_VERSION, id: opts.id, startedAt, ms: Date.now() - t0,
    devices: [...new Set(plan.flatMap((p) => p.devices.map((d) => d.id)))], explore: scenarios.some(exploring),
    runs, findings: structuredClone(findings), groups: groupFindings(findings), suppressions: statuses,
    verdict: interruptedVerdict(evaluatePolicy(findings, runs, cfg.policy), interrupted),
    reports: { html: join(dir, 'report.html'), json: join(dir, 'result.json') }, exploreMs: budget.exploreMs,
    ...(interrupted ? { interrupted } : {}),
  };
  writeFileSync(result.reports.json, JSON.stringify(result, null, 2));
  writeFileSync(result.reports.html, scanReportHtml(result, dir));
  env.emit({ kind: 'scan', phase: 'done', id: opts.id, result });
  return result;
}

/** An interrupted scan never claims pass or fail: only part of its plan ran. */
function interruptedVerdict(v: ScanVerdict, i: ScanResult['interrupted']): ScanVerdict {
  if (!i) return v;
  const why = i.reason === 'takeover' ? 'a person took over the browser' : i.reason === 'paused' ? 'a person paused the session' : 'a person stopped the session';
  return { ...v, result: 'incomplete', reasons: [`interrupted: ${why}; ${i.skipped.length} scenario run(s) did not run`, ...v.reasons] };
}

function selectScenarios(profile: ProjectProfile, opts: ScanOptions): ScanScenario[] {
  if (opts.route) {
    if (!opts.route.startsWith('/')) throw new LabError('invalid_request', `scan route must be a path starting with "/", got "${opts.route}"`);
    return [{ name: `${redactUrlSecrets(opts.route)} as loaded`, route: opts.route, auth: 'session', steps: [], cleanup: [] }];
  }
  const declared = profile.scan.scenarios;
  if (!declared.length) return [{ name: `${profile.startPath} as loaded`, route: profile.startPath, auth: 'session', steps: [], cleanup: [] }];
  if (!opts.scenarios?.length) return declared;
  const unknown = opts.scenarios.filter((n) => !declared.some((s) => s.name === n));
  if (unknown.length) {
    throw new LabError('not_found', `No scenario ${unknown.map((n) => `"${n}"`).join(', ')} in ${profile.profilePath}`, { hint: `Scenarios: ${declared.map((s) => s.name).join(', ')}` });
  }
  return declared.filter((s) => opts.scenarios!.includes(s.name));
}

async function runScenario(
  env: ScanEnv, opts: ScanOptions, sc: ScanScenario, device: DeviceProfile, dir: string, explore: boolean, budget: { exploreMs: number },
  samples: Map<string, (WrapSample & { route: string; repro: readonly string[]; stateId: string; run: ScenarioDeviceRun })[]>,
): Promise<ScenarioDeviceRun> {
  const cfg = env.profile.scan;
  const t0 = Date.now();
  mkdirSync(dir, { recursive: true });
  const run: ScenarioDeviceRun = {
    scenario: sc.name, device: device.id, width: device.viewport.width, height: device.viewport.height, status: 'ok', ms: 0,
    states: [], decisions: [], decisionsOmitted: 0, limits: [], findings: [],
  };
  const enabled = checkFilter(cfg.checks, sc.checks);
  const detectors: DetectorOptions = { tapTargets: cfg.tapTargets, layoutShiftMin: cfg.layoutShiftMin, enabled };
  const url = env.profile.app.url.replace(/\/+$/, '') + sc.route;
  let phase: NonNullable<ScenarioDeviceRun['failedAt']> = 'context';
  const r: Run = {};
  // Exploration guard: while a candidate is activated, requests that could change data and
  // navigations off the origin are blocked (and reported), whatever the control claimed to be.
  const guard = { on: false, blocked: [] as string[] };
  const origin = new URL(env.profile.app.url).origin;
  let storage: BrowserContextOptions['storageState'];
  let prefix: string[];
  let beforeFrame: string | undefined;

  const open = async () => {
    const lab = await Lab.isolated({
      browser: env.browser, profile: env.profile, device, storageState: storage, headed: env.headed, watch: env.watch,
      sessionId: `${env.sessionId}/${opts.id}/${slug(sc.name)}/${device.id}`, runDir: dir,
      init: {
        scripts: enabled('layout-shift') ? [installShiftObserver] : [],
        ...(explore ? { guard: (method: string, u: string, nav: boolean) => {
          if (!guard.on) return undefined;
          const label = blockedRequest(method, u, nav, origin);
          if (label) guard.blocked.push(label);
          return label;
        } } : {}),
      },
    });
    if (enabled('layout-shift')) {
      lab.onActed = async () => { beforeFrame = await shot(lab.activePage!, join(dir, 'before.jpg')); };
    }
    return lab;
  };
  const describeOpen = `scan ${opts.id}: open ${redactUrlSecrets(url)} in a new ${device.id} context (${device.viewport.width}x${device.viewport.height}) ` +
    (sc.auth === 'session' ? 'with the session\'s cookies and storage' : sc.auth === 'saved' ? 'with the saved sign-in state' : 'signed out (fresh)');
  const setup = async (lab: Lab, adopt: boolean) => {
    const loaded = await lab.load(sc.route, describeOpen);
    if (!adopt) return loaded.observation;
    phase = 'setup';
    for (const [i, step] of sc.steps.entries()) await runStep(lab, step, `setup step ${i + 1}`, adopt ? (f) => adoptFindings(f, 'setup') : undefined);
    return lab.lastObservation!;
  };
  const adoptFindings = (fs: readonly Finding[], state: string) => {
    for (const f of fs) {
      const a = env.store.adopt(f, [...prefix, ...f.reproduction], { device: device.id, keepRefs: false, scenario: sc.name, state });
      if (!run.findings.includes(a.finding.id)) run.findings.push(a.finding.id);
      if (a.fresh) env.emit({ kind: 'findings', findings: [a.finding], ...(a.finding.frame ? { frame: a.finding.frame } : {}) });
    }
  };
  const measure = async (st: ScanState, when: string) => {
    const lab = r.lab!;
    // What the state looked like right after the last input, before it settled: kept only as the
    // "before" frame of a layout-shift finding.
    const before = beforeFrame ? join(dir, `${st.id}-before.jpg`) : undefined;
    if (before) copyFileSync(beforeFrame!, before);
    beforeFrame = undefined;
    const m = await measureState(lab.activePage!, {
      store: env.store, sessionId: env.sessionId, gen: env.gen(), ctx: { device: device.id, scenario: sc.name, state: st.label },
      reproduction: [...prefix, ...lab.steps], detectors, reachLimit: 40, frameFile: (suffix) => join(dir, `${st.id}-${suffix}.jpg`),
      observation: lab.lastObservation, shift: { when, ...(before ? { before } : {}) },
      onFindings: (findings, frame) => env.emit({ kind: 'findings', findings, ...(frame ? { frame } : {}) }),
    });
    if (before && !m.findings.some((id) => env.store.get(id)?.frames?.some((f) => f.path === before))) rmSync(before, { force: true });
    const o = m.observation;
    Object.assign(st, {
      status: 'measured', route: o.route, ...(o.dialog ? { dialog: o.dialog } : {}), controls: o.controls.length, ...(m.frame ? { frame: m.frame } : {}), findings: m.findings,
      budget: { controlsOmitted: o.omitted, elementsOmitted: m.omitted, reachChecked: m.reachChecked },
    });
    for (const id of m.findings) if (!run.findings.includes(id)) run.findings.push(id);
    const list = samples.get(st.label) ?? [];
    list.push({ device: device.id, width: device.viewport.width, labels: m.labels, hiddenLabels: m.hiddenLabels, ...(m.frame ? { frame: m.frame } : {}),
      route: o.route, repro: [...prefix, ...lab.steps], stateId: st.id, run });
    samples.set(st.label, list);
    env.emit({ kind: 'scan', phase: 'state', id: opts.id, scenario: sc.name, device: device.id, state: st });
    return o;
  };

  try {
    storage = sc.auth === 'session' ? await env.sessionState() : sc.auth === 'saved' ? env.savedState() : undefined;
    prefix = sc.auth === 'session' ? [...env.sessionHistory] : [];
    r.lab = await open();
    phase = 'load';
    await setup(r.lab, true);
    phase = 'checks';
    const s0: ScanState = { id: 's0', label: sc.steps.length ? 'after setup' : 'as loaded', path: [...sc.steps.map((s, i) => s.label ?? `setup step ${i + 1}`)], depth: 0, status: 'measured', findings: [] };
    run.states.push(s0);
    const o0 = await measure(s0, sc.steps.length ? 'while the page loaded and the scenario was set up' : 'while the page loaded');
    if (explore) {
      const t = Date.now();
      try {
        await exploreFrom(o0);
      } finally {
        budget.exploreMs += Date.now() - t;
      }
    }
    if (sc.cleanup.length) {
      // Cleanup starts from the scenario's state. When exploration left the context elsewhere and it
      // cannot be closed back, cleanup runs in a fresh context on the route as loaded (setup is not
      // replayed: it may create data).
      phase = 'cleanup';
      if (r.at && r.at.depth === 0 && !(await isAt(r.at))) {
        await r.lab?.close('fresh context for cleanup').catch(() => undefined);
        r.lab = await open();
        await setup(r.lab, false);
      }
      for (const [i, step] of sc.cleanup.entries()) await runStep(r.lab!, step, `cleanup step ${i + 1}`);
    }
  } catch (err) {
    run.status = 'failed';
    run.failedAt = phase;
    run.error = LabError.from(err).toJSON();
  } finally {
    await r.lab?.close('scenario finished').catch(() => undefined);
    rmSync(join(dir, 'before.jpg'), { force: true });
  }
  run.ms = Date.now() - t0;
  return run;

  async function runStep(lab: Lab, step: ScenarioStep, label: string, onFindings?: (f: readonly Finding[]) => void): Promise<void> {
    let result;
    try {
      result = await lab.act(stepRequest(lab, step as FlowStep));
    } catch (err) {
      const e = LabError.from(err);
      throw new LabError(e.code, `${label} (${step.label ?? `${step.do}${step.name ? ` "${step.name}"` : ''}`}): ${e.message}`, { ...(e.hint ? { hint: e.hint } : {}) });
    }
    if (result.outcome === 'error') {
      throw new LabError(result.error!.code, `${label} (${step.label ?? `${step.do}${step.name ? ` "${step.name}"` : ''}`}): ${result.error!.message}`, { ...(result.error!.hint ? { hint: result.error!.hint } : {}) });
    }
    onFindings?.(result.newFindings);
    if (step.expect) {
      const failed = check(step.expect, lab.lastObservation!, result).filter((c) => !c.ok);
      if (failed.length) throw new LabError('action_failed', `${label}: expectation failed: ${failed.map((c) => c.text).join('; ')}`, { hint: 'The scenario did not reach its state, so its checks did not run.' });
    }
  }

  /** Breadth-first from the scenario's state, one safe activation at a time, within the limits. */
  async function exploreFrom(o0: Observation): Promise<void> {
    const ex = cfg.explore;
    const decided = new Map<string, ExploreDecision>();
    const activated = new Set<string>();
    const exploreStart = Date.now();
    const root = nodeFor('', [], 0, o0);
    root.candidates = await candidatesAt(o0, undefined);
    r.at = root;
    const queue: Node[] = [root];
    let explored = 0;
    const stop = (why: string) => { if (!run.limits.includes(why)) run.limits.push(why); };
    for (let node = queue.shift(); node; node = queue.shift()) {
      const pending = node.candidates.filter((c) => !activated.has(controlKey(c)));
      if (pending.length > ex.maxActionsPerState) stop(`maxActionsPerState (${ex.maxActionsPerState}): ${pending.length - ex.maxActionsPerState} candidate(s) in ${node.label || 'the scenario state'} not tried`);
      for (const [ci, cand] of pending.slice(0, ex.maxActionsPerState).entries()) {
        const remaining = () => pending.length - ci + queue.reduce((n, q) => n + q.candidates.length, 0);
        if (explored >= ex.maxStates) return stop(`maxStates (${ex.maxStates}): ${remaining()} candidate(s) not explored`);
        if (budget.exploreMs + (Date.now() - exploreStart) >= ex.maxMs) return stop(`maxMs (${ex.maxMs} ms, whole scan): ${remaining()} candidate(s) not explored`);
        activated.add(controlKey(cand));
        explored++;
        const label = node.label ? `${node.label} → ${cand.label}` : cand.label;
        const st: ScanState = { id: `s${explored}`, label, path: [...run.states[0]!.path, ...node.path.map((p) => p.label), cand.label], depth: node.depth + 1, status: 'measured', findings: [] };
        run.states.push(st);
        try {
          await reach(node);
          await r.lab!.activePage!.evaluate(takeLayoutShifts).catch(() => undefined);
          guard.blocked = [];
          guard.on = true;
          let result;
          try {
            result = await r.lab!.act({ action: 'click', ref: refFor(r.lab!, cand) });
          } finally {
            guard.on = false;
          }
          r.at = undefined;
          if (guard.blocked.length) {
            // It tried to change data or leave: not a state to measure, and never activated again.
            Object.assign(st, { status: 'blocked', blocked: [...guard.blocked] });
            decided.set(controlKey(cand), { role: cand.role, name: cand.name, ...(cand.context ? { context: cand.context } : {}), verdict: 'skip',
              reason: `sent ${guard.blocked[0]} when activated; the request was blocked and the state was not measured` });
            env.emit({ kind: 'scan', phase: 'state', id: opts.id, scenario: sc.name, device: device.id, state: st });
            continue;
          }
          if (result.outcome === 'error') throw new LabError(result.error!.code, result.error!.message);
          adoptFindings(result.newFindings, label);
          const o = await measure(st, `after activating ${cand.label}`);
          // A state on another route was reached by navigating: measured, but not explored further.
          if (node.depth + 1 < ex.maxDepth && o.route === o0.route) {
            const child = nodeFor(label, [...node.path, cand], node.depth + 1, o);
            // Deeper states explore only what the activation revealed, not the page around it again.
            child.candidates = await candidatesAt(o, node.keys);
            if (child.candidates.length) queue.push(child);
          }
          st.restore = await restore(node, cand);
        } catch (err) {
          Object.assign(st, { status: 'failed', error: LabError.from(err).toJSON() });
          r.at = undefined;
          env.emit({ kind: 'scan', phase: 'state', id: opts.id, scenario: sc.name, device: device.id, state: st });
        }
      }
    }
    const all = [...decided.values()];
    run.decisions = all.slice(0, DECISIONS_MAX);
    run.decisionsOmitted = Math.max(0, all.length - DECISIONS_MAX);

    async function candidatesAt(o: Observation, parentKeys: Set<string> | undefined): Promise<Candidate[]> {
      const fresh = o.controls.filter((c) => !parentKeys || !parentKeys.has(controlKey(c)));
      const traits = await r.lab!.activePage!.evaluate(controlTraits, fresh.map((c) => c.ref)).catch(() => []);
      const byRef = new Map(traits.map((t) => [t.ref, t]));
      const out: (Candidate & { order: number })[] = [];
      const counts = new Map<string, number>();
      for (const c of fresh) counts.set(controlKey(c), (counts.get(controlKey(c)) ?? 0) + 1);
      for (const [i, c] of fresh.entries()) {
        const d = classifyControl(c, byRef.get(c.ref), ex, o.route);
        if (!d) continue;
        if (d.verdict === 'explore' && (counts.get(controlKey(c)) ?? 0) > 1) {
          d.verdict = 'skip';
          d.reason = 'more than one control has this role, name and context, so it cannot be targeted without guessing';
        }
        if (!decided.has(controlKey(c)) || d.verdict === 'skip') decided.set(controlKey(c), d);
        if (d.verdict === 'explore') out.push({ role: c.role, name: c.name, ...(c.context ? { context: c.context } : {}), kind: d.kind!, label: `${c.role} "${c.name}"`, order: i });
      }
      return orderCandidates(out).map(({ order: _, ...c }) => c);
    }
  }

  function nodeFor(label: string, path: Candidate[], depth: number, o: Observation): Node {
    return {
      label, path, depth, sig: stateSignature(o), candidates: [], keys: new Set(o.controls.map(controlKey)),
      selectedTabs: new Set(o.controls.filter((c) => c.role === 'tab' && c.selected).map(controlKey)),
    };
  }

  /** Whether the context is in `node`'s state now (observing it if unsure). */
  async function isAt(node: Node): Promise<boolean> {
    if (r.at === node) return true;
    const o = await r.lab!.observe().catch(() => undefined);
    if (o && stateSignature(o) === node.sig) { r.at = node; return true; }
    return false;
  }

  /** Be in `node`'s state: already there, or a fresh context with the setup and the path replayed. */
  async function reach(node: Node): Promise<void> {
    if (await isAt(node)) return;
    await r.lab?.close('fresh context for the next state').catch(() => undefined);
    r.lab = await open();
    await setup(r.lab, false);
    for (const [i, s] of sc.steps.entries()) await runStep(r.lab, s, `setup step ${i + 1} (replayed)`);
    for (const p of node.path) {
      const res = await r.lab.act({ action: 'click', ref: refFor(r.lab, p) });
      if (res.outcome === 'error') throw new LabError(res.error!.code, `replaying ${p.label}: ${res.error!.message}`);
    }
    r.at = node;
  }

  /** Return to `node` after measuring a state: close what was opened, or press Escape, else start over. */
  async function restore(node: Node, cand: Candidate): Promise<ScanState['restore']> {
    const lab = r.lab!;
    const back = async (req: Parameters<Lab['act']>[0]) => {
      const res = await lab.act(req).catch(() => undefined);
      return !!res && res.outcome === 'success' && stateSignature(lab.lastObservation!) === node.sig;
    };
    const now = lab.lastObservation!;
    const opener = now.controls.filter((c) => controlKey(c) === controlKey(cand));
    let how: ScanState['restore'] = 'fresh-context';
    if (opener.length === 1 && (opener[0]!.expanded || opener[0]!.pressed) && await back({ action: 'click', ref: opener[0]!.ref })) how = 'toggle';
    else if (cand.kind === 'tab') {
      // Switch back to the tab that was selected before (exactly one match, or not at all).
      const was = now.controls.filter((c) => c.role === 'tab' && !c.selected && node.selectedTabs.has(controlKey(c)));
      if (was.length === 1 && await back({ action: 'click', ref: was[0]!.ref })) how = 'toggle';
    }
    if (how === 'fresh-context' && await back({ action: 'press', key: 'Escape' })) how = 'escape';
    r.at = how === 'fresh-context' ? undefined : node;
    return how;
  }
}

/** A ref for a candidate in the latest observation: exactly one control with its role, name and context, never a guess. */
function refFor(lab: Lab, c: { role: string; name: string; context?: string; label: string }): string {
  const matches = (lab.lastObservation?.controls ?? []).filter((x) => controlKey(x) === controlKey(c));
  if (matches.length === 1) return matches[0]!.ref;
  throw new LabError(matches.length ? 'ambiguous_target' : 'not_found', `${c.label}${c.context ? ` in "${c.context}"` : ''}: ${matches.length ? `${matches.length} matching controls` : 'not in the latest observation'}`);
}

/**
 * What a command returns for a scan: the verdict, each run's outcome and the problem groups, bounded.
 * Findings are ids (details through inspect); frames and full evidence stay in the report files.
 */
export function scanSummary(r: ScanResult, maxGroups = 30) {
  return {
    schemaVersion: r.schemaVersion, id: r.id, ms: r.ms, explore: r.explore, exploreMs: r.exploreMs, verdict: r.verdict, reports: r.reports,
    ...(r.interrupted ? { interrupted: r.interrupted } : {}),
    runs: r.runs.map((x) => ({
      scenario: x.scenario, device: x.device, status: x.status, ...(x.failedAt ? { failedAt: x.failedAt, error: x.error?.message } : {}),
      states: x.states.length, findings: x.findings,
      ...(x.limits.length ? { limits: x.limits } : {}),
      ...(x.decisions.some((d) => d.verdict === 'skip') ? { skipped: x.decisions.filter((d) => d.verdict === 'skip').length } : {}),
    })),
    groups: r.groups.slice(0, maxGroups).map((g) => ({
      id: g.id, title: g.title, kind: g.kind, severity: g.severity, confidence: g.confidence, route: g.route, scenarios: g.scenarios, devices: g.devices,
      findings: g.findings, ...(g.suppressed ? { suppressed: true } : {}),
    })),
    groupsOmitted: Math.max(0, r.groups.length - maxGroups),
    suppressions: r.suppressions.filter((x) => x.status !== 'applied'),
  };
}
