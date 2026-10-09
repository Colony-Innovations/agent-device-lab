import { formatChanges, formatClose, formatControlChange, formatHuman, formatSettle } from './format.js';
import type { ControlState } from './control.js';
import type { LabEvent } from './lab.js';
import { basename } from 'node:path';
import type {
  ActionName, ActionRequest, ActionResult, DeviceProfile, ExploreDecision, Finding, FindingGroup, LabErrorJSON, ScanState, ScanVerdict,
  ScenarioDeviceRun, SettleReport, SuppressionStatus,
} from './schema.js';

// The dashboard's typed event stream. It is derived only from the Lab's own events (the same data the
// CLI and MCP return), so there is no second observation or finding engine. Pure apart from a
// coalescing timer for high-frequency counters; unit-tested without a browser.

export type SessionState = 'idle' | 'starting' | 'active' | 'ended' | 'failed';

export interface StatusView {
  state: SessionState;
  sessionId?: string;
  project?: string;
  device?: DeviceProfile;
  headed?: boolean;
  browser?: string;
  environment?: string;
  /** Current page, origin + path only (query and hash can carry secrets). */
  url?: string;
  route?: string;
  title?: string;
  gen: number;
  consoleErrors: number;
  failedRequests: number;
  findings: number;
  server?: { url: string; owned: boolean; pid?: number; command?: string; readyMs: number };
  /** Every declared service as it became ready: owned (started by the lab) or reused. */
  services?: { name: string; url?: string; owned: boolean; pid?: number; readyMs: number; readiness: string }[];
  /** Whether the session started from saved sign-in state. The state itself never reaches the feed. */
  auth?: 'saved-state' | 'fresh';
  /** The tab being watched, when more than one is open. */
  tab?: string;
  startedAt?: string;
  endedReason?: string;
  startError?: LabErrorJSON;
  /** Who is in control: the agent, a pause, a person, or a stop in progress. */
  control?: ControlState;
}

export interface SweepDeviceView {
  id: string;
  width: number;
  height: number;
  state: 'pending' | 'running' | 'done' | 'error';
  ms?: number;
  error?: string;
  findings: string[];
  confirmed: number;
  hasFrame: boolean;
}

export interface SweepView {
  id: string;
  route: string;
  state: 'running' | 'done';
  devices: SweepDeviceView[];
  ms?: number;
}

/** A scan state as the page sees it: no frame path (only whether a frame exists) and a redacted error message. */
export type ScanStateView = Omit<ScanState, 'frame' | 'error'> & { error?: string; hasFrame: boolean };

export interface ScanRunView {
  /** Position in the scan's plan; the frame route uses it. */
  index: number;
  scenario: string;
  route: string;
  device: string;
  width: number;
  height: number;
  state: 'pending' | 'running' | 'ok' | 'failed';
  failedAt?: NonNullable<ScenarioDeviceRun['failedAt']>;
  error?: string;
  ms?: number;
  states: ScanStateView[];
  decisions: ExploreDecision[];
  decisionsOmitted: number;
  limits: string[];
  findings: string[];
}

export interface ScanView {
  id: string;
  state: 'running' | 'done';
  explore: boolean;
  runs: ScanRunView[];
  /** The scenario, device and state label being measured right now. */
  current?: { scenario: string; device: string; state?: string };
  groups?: FindingGroup[];
  verdict?: ScanVerdict;
  suppressions?: SuppressionStatus[];
  ms?: number;
}

export interface TimelineEntry {
  seq: number;
  at: string;
  /** control: a person paused, resumed, took over, returned or stopped; human: what they did in the page; refused: an agent command that did not run. */
  kind: 'start' | 'observe' | ActionName | 'sweep' | 'scan' | 'stop' | 'start-failed' | 'auth' | 'control' | 'human' | 'refused';
  target?: { ref?: string; role?: string; name?: string };
  /** fill: the typed text only when the page displays it back, otherwise its length. */
  value?: string;
  /** What else the action was asked to do: a key, options, a direction, file names, a tab. */
  detail?: string;
  outcome: 'success' | 'error';
  durationMs?: number;
  summary: string;
  method?: string;
  settle?: SettleReport;
  /** One line when settle timed out, e.g. "settle timed out after 1201ms (request still open: …)". */
  settleText?: string;
  changes: string[];
  notes: string[];
  error?: { code: string; message: string; hint?: string };
  /** Ids of findings first recorded by this step. */
  findings: string[];
  route?: string;
  navigated?: boolean;
  newConsoleErrors?: number;
  newFailedRequests?: number;
}

/** A finding as the page sees it: frame paths stay on the server; `frames` carries only the captions. */
export type FindingView = Omit<Finding, 'frame' | 'frames'> & { hasFrame: boolean; frames: { label: string; device?: string }[] };

export type FeedEvent =
  /** A new session replaced the previous one; clients drop what they hold. */
  | { type: 'reset' }
  | { type: 'status'; status: StatusView }
  | { type: 'timeline'; entry: TimelineEntry }
  | { type: 'finding'; finding: FindingView }
  | { type: 'server-log'; line: string }
  | { type: 'sweep'; sweep: SweepView }
  | { type: 'scan'; scan: ScanView };

export interface FeedMessage { seq: number; at: string; event: FeedEvent }

export interface FeedSnapshot {
  seq: number;
  status: StatusView;
  timeline: TimelineEntry[];
  findings: FindingView[];
  serverLog: string[];
  /** Most recent sweeps, oldest first. */
  sweeps: SweepView[];
  /** Most recent scans, oldest first. */
  scans: ScanView[];
}

export interface FeedLimits { buffer: number; timeline: number; serverLog: number; countsIntervalMs: number }
const DEFAULT_LIMITS: FeedLimits = { buffer: 1000, timeline: 200, serverLog: 200, countsIntervalMs: 250 };

const SECRET = /\b([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|api[_-]?key|auth(?:orization)?|cookie|session[_-]?id|private[_-]?key)[A-Za-z0-9_.-]*)(\s*[=:]\s*|\s+)("[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

/** What an action was asked to do beyond its target. Secret keys arrive already masked; files show names only. */
function actionDetail(r: ActionRequest): string {
  switch (r.action) {
    case 'press': return `key ${r.key}`;
    case 'select': return `→ ${(r.values ?? []).map((v) => JSON.stringify(v.slice(0, 40))).join(', ')}`;
    case 'scroll': return r.direction ? `${r.direction}${r.amount ? ` ${r.amount}px` : ''}` : 'into view';
    case 'swipe': return `${r.direction}${r.amount ? ` ${r.amount}px` : ''}`;
    case 'upload': return `files ${(r.files ?? []).map((f) => basename(f)).join(', ')}`;
    case 'drag': return r.toRef ? `onto ${r.toRef}` : `by (${r.dx ?? 0}, ${r.dy ?? 0})`;
    case 'open_tab': return `at ${r.path}`;
    case 'switch_tab': case 'close_tab': return r.tab ? `tab ${r.tab}` : '';
    default: return '';
  }
}

/** Mask things that look like credentials in free text (server output, commands). */
export function redactSecrets(text: string): string {
  return text
    .replace(URL_CREDENTIALS, '$1‹redacted›@')
    .replace(BEARER, '$1 ‹redacted›')
    .replace(SECRET, (_m, key: string, sep: string) => `${key}${sep}‹redacted›`);
}

/** origin + path: query strings and fragments are dropped because they often carry tokens. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

function errorText(e: LabErrorJSON): string {
  return redactSecrets(`${e.code}: ${e.message}${e.hint ? ` Hint: ${e.hint}` : ''}`);
}

function stateView(s: ScanState): ScanStateView {
  const { frame, error, ...rest } = s;
  return structuredClone({ ...rest, ...(error ? { error: errorText(error) } : {}), hasFrame: !!frame });
}

function redactError(e: LabErrorJSON): LabErrorJSON {
  const details = e.details ? { ...e.details } : undefined;
  if (details && Array.isArray(details.logTail)) details.logTail = details.logTail.map((l) => redactSecrets(String(l)));
  return { ...e, message: redactSecrets(e.message), ...(e.hint ? { hint: redactSecrets(e.hint) } : {}), ...(details ? { details } : {}) };
}

/**
 * Show a typed value only when the page itself displays it back in the control (so it is already on
 * screen); password fields read back as a mask. Otherwise report only its length.
 */
function fillValue(result: ActionResult, value: string): string {
  const shown = result.observation?.controls.find((c) => c.ref === result.ref)?.value;
  if (shown !== undefined && shown === value) return value.length > 60 ? `${value.slice(0, 57)}…` : value;
  if (shown === '••••') return '••••';
  return `‹${value.length} chars›`;
}

export class SessionFeed {
  private readonly limits: FeedLimits;
  private seq = 0;
  private buffer: FeedMessage[] = [];
  private status: StatusView = SessionFeed.idle();
  private timeline: TimelineEntry[] = [];
  private readonly findings = new Map<string, FindingView>();
  private readonly frames = new Map<string, string>();
  private serverLog: string[] = [];
  private sweeps: SweepView[] = [];
  private readonly sweepFrames = new Map<string, string>();
  private scans: ScanView[] = [];
  private readonly scanFrames = new Map<string, string>();
  private readonly extraFrames = new Map<string, string>();
  private readonly listeners = new Set<(m: FeedMessage) => void>();
  private startingAt = 0;
  private countsTimer?: ReturnType<typeof setTimeout>;
  private lastCountsAt = 0;

  constructor(limits: Partial<FeedLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  private static idle(): StatusView {
    return { state: 'idle', gen: 0, consoleErrors: 0, failedRequests: 0, findings: 0 };
  }

  /** Subscribe to live messages. Returns an unsubscribe function. */
  subscribe(fn: (m: FeedMessage) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  get state(): SessionState {
    return this.status.state;
  }

  get lastSeq(): number {
    return this.seq;
  }

  snapshot(): FeedSnapshot {
    return {
      seq: this.seq,
      status: structuredClone(this.status),
      timeline: this.timeline.slice(-this.limits.timeline),
      findings: [...this.findings.values()],
      serverLog: [...this.serverLog],
      sweeps: structuredClone(this.sweeps),
      scans: structuredClone(this.scans),
    };
  }

  /** Messages after `seq`, or undefined when they are no longer buffered (the client needs a snapshot). */
  since(seq: number): FeedMessage[] | undefined {
    if (seq === this.seq) return [];
    if (seq > this.seq) return undefined;
    const first = this.buffer[0];
    if (!first || first.seq > seq + 1) return undefined;
    return this.buffer.filter((m) => m.seq > seq);
  }

  /** Viewport frame captured for one width of a sweep. */
  sweepFrameFile(sweepId: string, device: string): string | undefined {
    return this.sweepFrames.get(`${sweepId}/${device}`);
  }

  /** State frame of a scan run (`runIndex` is the run's position in the plan). */
  scanFrameFile(scanId: string, runIndex: number, stateId: string): string | undefined {
    return this.scanFrames.get(`${scanId}/${runIndex}/${stateId}`);
  }

  /** The i-th extra evidence frame of a finding (the other width, or before/after a shift). */
  extraFrameFile(id: string, index: number): string | undefined {
    return this.extraFrames.get(`${id}-${index}`);
  }

  /** Evidence frame file for a finding id, if one was captured. */
  frameFile(id: string): string | undefined {
    return this.frames.get(id);
  }

  apply(e: LabEvent): void {
    switch (e.kind) {
      case 'starting': {
        if (this.status.state !== 'idle') this.reset();
        this.startingAt = Date.now();
        this.status = {
          ...SessionFeed.idle(), state: 'starting', project: e.project, device: e.device, headed: e.headed,
          url: displayUrl(e.url), startedAt: new Date().toISOString(),
        };
        this.emitStatus();
        break;
      }
      case 'service': {
        const i = e.info;
        const services = (this.status.services ??= []).filter((s) => s.name !== i.name);
        services.push({ name: i.name, ...(i.url ? { url: i.url } : {}), owned: i.owned, ...(i.pid !== undefined ? { pid: i.pid } : {}), readyMs: i.readyMs, readiness: i.readiness });
        this.status.services = services;
        this.emitStatus();
        break;
      }
      case 'auth': {
        if (e.action === 'saved') {
          this.entry({ kind: 'auth', outcome: 'success', summary: `saved sign-in state (${e.cookies} cookies, ${e.origins} origins with storage)`, changes: [], notes: [], findings: [] });
        } else if (e.action === 'invalidated') {
          this.entry({ kind: 'auth', outcome: 'error', summary: 'saved sign-in state was unusable and has been removed', changes: [], notes: [], findings: [] });
        }
        break;
      }
      case 'start': {
        const { session, server, observation: o } = e.result;
        Object.assign(this.status, {
          state: 'active', sessionId: session.id, device: session.device, headed: session.browser.headed,
          browser: `Chromium ${session.browser.version}`, environment: session.environment, auth: session.auth ?? 'fresh',
          server: {
            url: server.url, owned: server.owned, readyMs: server.readyMs,
            ...(server.pid !== undefined ? { pid: server.pid } : {}),
            ...(server.command ? { command: redactSecrets(server.command) } : {}),
          },
        } satisfies Partial<StatusView>);
        this.observed(o);
        this.emitStatus();
        this.entry({
          kind: 'start', outcome: 'success', durationMs: this.startingAt ? Date.now() - this.startingAt : undefined,
          summary: `session ${session.id} on ${o.route}; server ${server.owned ? `started (pid ${server.pid}, ready in ${server.readyMs}ms)` : 'reused (not owned)'}`,
          changes: [], notes: [], findings: this.firstSeenIn(o.gen), route: o.route,
        });
        break;
      }
      case 'start-failed': {
        const error = redactError(e.error);
        if (this.status.state === 'idle') this.status = { ...SessionFeed.idle(), startedAt: new Date().toISOString() };
        this.entry({
          kind: 'start-failed', outcome: 'error', durationMs: this.startingAt ? Date.now() - this.startingAt : undefined,
          summary: `start failed: ${error.code}`, changes: [], notes: [], findings: [],
          error: { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) },
        });
        Object.assign(this.status, { state: 'failed', startError: error, endedReason: 'start failed' });
        this.emitStatus();
        break;
      }
      case 'server-log': {
        const line = redactSecrets(e.line).slice(0, 500);
        this.serverLog.push(line);
        if (this.serverLog.length > this.limits.serverLog) this.serverLog.splice(0, this.serverLog.length - this.limits.serverLog);
        this.publish({ type: 'server-log', line });
        break;
      }
      case 'observe': {
        this.observed(e.observation);
        this.emitStatus();
        const o = e.observation;
        this.entry({
          kind: 'observe', outcome: 'success', summary: `observe gen ${o.gen}: ${o.controls.length} controls${o.omitted ? ` (+${o.omitted} omitted)` : ''}, ${o.layout.length} layout flags`,
          changes: [], notes: [], findings: this.firstSeenIn(o.gen), route: o.route,
        });
        break;
      }
      case 'act': {
        const r = e.result;
        if (r.observation) this.observed(r.observation);
        this.emitStatus();
        const target = r.target ?? (r.ref ? { ref: r.ref } : undefined);
        const detail = actionDetail(e.request);
        const what = [r.target ? `${r.target.role} "${r.target.name}"` : r.ref, detail].filter(Boolean).join(' ');
        if (r.observation) this.status.tab = r.observation.tab;
        const changes = !r.changes ? []
          : r.changes.reset ? [`${r.changes.route ? `route ${r.changes.route.from} → ${r.changes.route.to}; ` : ''}new document, baseline reset`]
          : r.changes.none ? ['no visible change'] : formatChanges(r.changes).map((l) => l.replace(' (use --json for all)', ''));
        this.entry({
          kind: r.action, ...(target ? { target } : {}), ...(detail ? { detail } : {}), outcome: r.outcome, durationMs: r.elapsedMs,
          ...(r.action === 'fill' && e.request.value !== undefined ? { value: fillValue(r, e.request.value) } : {}),
          summary: `${r.action}${r.ref ? ` ${r.ref}` : ''}${what ? ` ${what}` : ''}`, ...(r.method ? { method: r.method } : {}),
          ...(r.settle ? { settle: r.settle, ...(r.settle.reason === 'timeout' ? { settleText: formatSettle(r.settle) } : {}) } : {}),
          changes, notes: r.notes, findings: r.newFindings.map((f) => f.id),
          ...(r.error ? { error: { code: r.error.code, message: r.error.message, ...(r.error.hint ? { hint: r.error.hint } : {}) } } : {}),
          ...(r.observation ? { route: r.observation.route } : {}), navigated: r.navigated,
          newConsoleErrors: r.newConsoleErrors.length, newFailedRequests: r.newFailedRequests.length,
        });
        break;
      }
      case 'control': {
        this.status.control = structuredClone(e.change.state);
        this.emitStatus();
        this.entry({ kind: 'control', outcome: 'success', summary: formatControlChange(e.change), changes: [], notes: [], findings: [] });
        break;
      }
      case 'human': {
        const a = e.action;
        this.entry({
          kind: 'human', outcome: 'success', summary: a.type === 'input-dropped' ? `person: ${formatHuman(a)}` : `person ${formatHuman(a)}`,
          ...(a.target ? { target: { role: a.target.role, name: a.target.name } } : {}), changes: [], notes: [], findings: [],
        });
        break;
      }
      case 'refused': {
        const error = redactError(e.error);
        this.entry({
          kind: 'refused', outcome: 'error', summary: `agent's ${e.command} refused (${error.code}); nothing ran`, changes: [], notes: [], findings: [],
          error: { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) },
        });
        break;
      }
      case 'findings': {
        for (const f of e.findings) {
          const main = e.frame ?? f.frame;
          if (main) this.frames.set(f.id, main);
          (f.frames ?? []).forEach((x, i) => this.extraFrames.set(`${f.id}-${i}`, x.path));
          const { frame: _frame, frames, ...rest } = structuredClone(f);
          const view: FindingView = { ...rest, hasFrame: !!main, frames: (frames ?? []).map((x) => ({ label: x.label, ...(x.device ? { device: x.device } : {}) })) };
          this.findings.set(f.id, view);
          this.publish({ type: 'finding', finding: view });
        }
        this.status.findings = this.findings.size;
        this.emitStatus();
        break;
      }
      case 'page': {
        this.status.url = displayUrl(e.url);
        try { this.status.route = new URL(e.url).pathname; } catch { /* keep the last route */ }
        this.emitStatus();
        break;
      }
      case 'counts': {
        this.status.consoleErrors = e.consoleErrors;
        this.status.failedRequests = e.failedRequests;
        this.emitCounts();
        break;
      }
      case 'sweep': {
        if (e.phase === 'start') {
          this.sweeps.push({ id: e.id, route: e.route, state: 'running', devices: e.devices.map((d) => ({ ...d, state: 'pending', findings: [], confirmed: 0, hasFrame: false })) });
          if (this.sweeps.length > 10) this.sweeps.shift();
        }
        const sweep = this.sweeps.find((s) => s.id === e.id);
        if (!sweep) break;
        if (e.phase === 'device-start') {
          const d = sweep.devices.find((x) => x.id === e.device);
          if (d) d.state = 'running';
        } else if (e.phase === 'device-done') {
          const r = e.result;
          const d = sweep.devices.find((x) => x.id === r.device);
          if (d) {
            Object.assign(d, {
              state: r.status === 'ok' ? 'done' : 'error', ms: r.ms, findings: r.findings, hasFrame: !!r.frame,
              confirmed: r.findings.filter((id) => this.findings.get(id)?.confidence === 'confirmed').length,
              ...(r.error ? { error: redactSecrets(r.error.message) } : {}),
            } satisfies Partial<SweepDeviceView>);
          }
          if (r.frame) this.sweepFrames.set(`${e.id}/${r.device}`, r.frame);
        } else if (e.phase === 'done') {
          sweep.state = 'done';
          sweep.ms = e.result.ms;
          const ids = e.result.findings.map((f) => f.id);
          const confirmed = e.result.findings.filter((f) => f.confidence === 'confirmed').length;
          this.entry({
            kind: 'sweep', outcome: e.result.devices.some((d) => d.status === 'error') ? 'error' : 'success', durationMs: e.result.ms,
            summary: `sweep ${e.id} of ${e.result.route} at ${e.result.devices.map((d) => d.width).join(', ')} px`,
            changes: e.result.devices.map((d) => `${d.device}: ${d.status === 'error' ? `error ${d.error?.code ?? ''}` : d.findings.length ? `${d.findings.length} finding(s)` : 'clean'}`),
            notes: ids.length ? [`${confirmed} confirmed, ${ids.length - confirmed} heuristic`] : [], findings: ids, route: e.result.route,
          });
        }
        this.publish({ type: 'sweep', sweep: structuredClone(sweep) });
        break;
      }
      case 'scan': {
        this.applyScan(e);
        break;
      }
      case 'closed': {
        if (this.status.state === 'failed') break; // start failure already reported, with its cause
        // The entry goes first: viewers stop listening once they see the final status.
        this.entry({ kind: 'stop', outcome: 'success', summary: formatClose(e.result), changes: [], notes: [], findings: [] });
        if (this.status.state === 'starting') break; // cleanup after a failed start; start-failed follows with the cause
        Object.assign(this.status, { state: 'ended', endedReason: e.result.reason });
        this.emitStatus();
        break;
      }
    }
  }

  private applyScan(e: Extract<LabEvent, { kind: 'scan' }>): void {
    if (e.phase === 'start') {
      this.scans.push({
        id: e.id, state: 'running', explore: e.explore,
        runs: e.runs.map((r, index) => ({ index, ...r, state: 'pending', states: [], decisions: [], decisionsOmitted: 0, limits: [], findings: [] })),
      });
      while (this.scans.length > 5) {
        const old = this.scans.shift()!;
        for (const key of [...this.scanFrames.keys()]) if (key.startsWith(`${old.id}/`)) this.scanFrames.delete(key);
      }
    }
    const scan = this.scans.find((s) => s.id === e.id);
    if (!scan) return;
    const find = (scenario: string, device: string, state: ScanRunView['state']) =>
      scan.runs.find((r) => r.scenario === scenario && r.device === device && r.state === state)
      ?? scan.runs.find((r) => r.scenario === scenario && r.device === device);
    if (e.phase === 'run-start') {
      const run = find(e.scenario, e.device, 'pending');
      if (run) run.state = 'running';
      scan.current = { scenario: e.scenario, device: e.device };
    } else if (e.phase === 'state') {
      const run = find(e.scenario, e.device, 'running');
      if (run) {
        const view = stateView(e.state);
        const i = run.states.findIndex((s) => s.id === view.id);
        if (i >= 0) run.states[i] = view; else run.states.push(view);
        if (e.state.frame) this.scanFrames.set(`${scan.id}/${run.index}/${e.state.id}`, e.state.frame);
      }
      scan.current = { scenario: e.scenario, device: e.device, state: e.state.label };
    } else if (e.phase === 'run-done') {
      const r = e.run;
      const run = find(r.scenario, r.device, 'running');
      if (run) {
        Object.assign(run, {
          state: r.status === 'ok' ? 'ok' : 'failed', ms: r.ms, states: r.states.map(stateView), decisions: structuredClone(r.decisions),
          decisionsOmitted: r.decisionsOmitted, limits: [...r.limits], findings: [...r.findings],
          ...(r.failedAt ? { failedAt: r.failedAt } : {}), ...(r.error ? { error: errorText(r.error) } : {}),
        } satisfies Partial<ScanRunView>);
        for (const s of r.states) if (s.frame) this.scanFrames.set(`${scan.id}/${run.index}/${s.id}`, s.frame);
      }
      if (scan.current?.scenario === r.scenario && scan.current.device === r.device) delete scan.current;
    } else if (e.phase === 'done') {
      const r = e.result;
      Object.assign(scan, { state: 'done', groups: structuredClone(r.groups), verdict: structuredClone(r.verdict), suppressions: structuredClone(r.suppressions), ms: r.ms } satisfies Partial<ScanView>);
      delete scan.current;
      // Suppression is decided when the scan finishes: tell viewers about findings that changed.
      for (const f of r.findings) {
        const known = this.findings.get(f.id);
        if (!known || JSON.stringify(known.suppressed) === JSON.stringify(f.suppressed)) continue;
        const { suppressed: _old, ...rest } = known;
        const view: FindingView = { ...rest, ...(f.suppressed ? { suppressed: structuredClone(f.suppressed) } : {}) };
        this.findings.set(f.id, view);
        this.publish({ type: 'finding', finding: view });
      }
      const failed = r.runs.filter((x) => x.status === 'failed');
      this.entry({
        kind: 'scan', outcome: r.verdict.result === 'pass' ? 'success' : 'error', durationMs: r.ms,
        summary: `scan ${e.id}: ${r.verdict.result.toUpperCase()} · ${r.runs.length} runs (${failed.length} failed) · ${r.groups.length} problems`,
        changes: failed.map((x) => `${x.scenario} @ ${x.device}: failed at ${x.failedAt ?? 'unknown'}`),
        notes: [], findings: r.findings.map((f) => f.id),
      });
    }
    this.publish({ type: 'scan', scan: structuredClone(scan) });
  }

  private observed(o: { gen: number; url: string; route: string; title: string; console: { errors: number }; network: { failed: number } }): void {
    Object.assign(this.status, {
      gen: o.gen, url: displayUrl(o.url), route: o.route, title: o.title.slice(0, 120),
      consoleErrors: o.console.errors, failedRequests: o.network.failed,
    } satisfies Partial<StatusView>);
  }

  private firstSeenIn(gen: number): string[] {
    return [...this.findings.values()].filter((f) => f.firstSeen.gen === gen).map((f) => f.id);
  }

  private reset(): void {
    this.buffer = [];
    this.timeline = [];
    this.findings.clear();
    this.frames.clear();
    this.serverLog = [];
    this.sweeps = [];
    this.sweepFrames.clear();
    this.scans = [];
    this.scanFrames.clear();
    this.extraFrames.clear();
    if (this.countsTimer) clearTimeout(this.countsTimer);
    this.countsTimer = undefined;
    this.publish({ type: 'reset' });
  }

  private entry(e: Omit<TimelineEntry, 'seq' | 'at'>): void {
    const entry = { seq: this.seq + 1, at: new Date().toISOString(), ...e } as TimelineEntry;
    this.timeline.push(entry);
    if (this.timeline.length > this.limits.timeline) this.timeline.splice(0, this.timeline.length - this.limits.timeline);
    this.publish({ type: 'timeline', entry });
  }

  private emitStatus(): void {
    if (this.countsTimer) { clearTimeout(this.countsTimer); this.countsTimer = undefined; }
    this.lastCountsAt = Date.now();
    this.publish({ type: 'status', status: structuredClone(this.status) });
  }

  /** Counters can change many times a second on a noisy page; publish at most once per interval. */
  private emitCounts(): void {
    const wait = this.limits.countsIntervalMs - (Date.now() - this.lastCountsAt);
    if (wait <= 0) return this.emitStatus();
    this.countsTimer ??= setTimeout(() => { this.countsTimer = undefined; this.emitStatus(); }, wait);
    this.countsTimer.unref?.();
  }

  private publish(event: FeedEvent): void {
    const message: FeedMessage = { seq: ++this.seq, at: new Date().toISOString(), event };
    this.buffer.push(message);
    if (this.buffer.length > this.limits.buffer) this.buffer.splice(0, this.buffer.length - this.limits.buffer);
    for (const fn of this.listeners) {
      try { fn(message); } catch { /* a viewer must never break the session */ }
    }
  }
}
