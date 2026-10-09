// Versioned, JSON-serialisable contract shared by the CLI, the daemon and (later) the MCP adapter.
// Anything returned to an agent must be expressible with these types.

import { redactUrlSecrets } from './url-redact.js';

export const SCHEMA_VERSION = 1 as const;

// ---------- project profile ----------

export interface ReadinessCheck {
  /** Path appended to web.url, e.g. "/" or "/health". */
  path: string;
  /** Expected HTTP status after following redirects. */
  status: number;
  timeoutMs: number;
  intervalMs: number;
}

export interface WebServerSpec {
  /** Shell command run from `cwd`. Only commands declared in an approved profile are executed. */
  command: string;
  /** Absolute working directory (resolved against the profile's directory). */
  cwd: string;
  /** Base URL of the app, e.g. http://127.0.0.1:5173 */
  url: string;
  env: Record<string, string>;
  readiness: ReadinessCheck;
  /** Reuse an already healthy server at `url` instead of starting another. */
  reuseExisting: boolean;
}

/**
 * How a service shows it is ready. `http`: GET url+path returns `status` (following redirects).
 * `tcp`: the port accepts a connection. `log`: a line of the service's output matches `pattern`.
 * `alive`: the process is still running after `ms`. `exit`: a one-shot command exited 0 (nothing else
 * to wait for). Only http and tcp can detect an instance that is already running.
 */
export type ReadinessSpec =
  | { kind: 'http'; url: string; path: string; status: number; timeoutMs: number; intervalMs: number }
  | { kind: 'tcp'; host: string; port: number; timeoutMs: number; intervalMs: number }
  | { kind: 'log'; pattern: string; timeoutMs: number }
  | { kind: 'alive'; ms: number }
  | { kind: 'exit'; timeoutMs: number };

export type ShutdownSignal = 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGQUIT';

/** One process (or one-shot command) the project needs, declared in agentlab.json. */
export interface ServiceSpec {
  name: string;
  /** Shell command run from `cwd` in its own process group. Only declared commands are ever run. */
  command: string;
  cwd: string;
  /** Base URL, when the service serves HTTP. */
  url?: string;
  /** Literal, non-secret values added to the inherited environment. */
  env: Record<string, string>;
  /** Names that must be set in the caller's environment. Only names are ever reported, never values. */
  requiredEnv: string[];
  readiness: ReadinessSpec;
  /** Names of services that must be ready before this one starts. */
  dependsOn: string[];
  /** Reuse an instance that already passes an http/tcp readiness check, and never stop it. */
  reuseExisting: boolean;
  /** A failed optional service is reported; services that depend on it are skipped. */
  required: boolean;
  /** `process`: long-running, owned as a process group. `oneshot`: must exit 0 (e.g. `docker compose up -d`). */
  mode: 'process' | 'oneshot';
  shutdown: { signal: ShutdownSignal; graceMs: number; command?: string };
}

export interface DeviceOverride {
  extends?: string;
  label?: string;
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  userAgent?: string;
}

/** Saved browser state (cookies, localStorage) for signed-in sessions. Never returned or logged. */
export interface AuthPolicy {
  /** Absolute path; written owner-only (0600) under a 0700 directory. */
  file: string;
  /** auto: load the file at start when it exists; never: only an explicit start option loads it. */
  use: 'auto' | 'never';
  /** A session started from saved state that lands on a route starting with this is signed out: the state is invalid. */
  loginPath?: string;
}

/**
 * How long to wait for the UI to settle after an action or navigation. A timeout is reported on the
 * action, never turned into a failure.
 */
export interface SettlePolicy {
  /** DOM must be free of mutations for this long. */
  quietMs: number;
  /** Upper bound for the whole wait. */
  maxMs: number;
  /**
   * Substrings of request URLs (path or full URL) that are long-lived by design (long-polling,
   * streaming, analytics beacons). They are never awaited. EventSource and WebSocket connections and
   * requests already in flight when the action began are ignored automatically.
   */
  backgroundRequests: string[];
  /**
   * Also wait for pending one-shot setTimeout timers up to this delay (in-memory mock APIs, debounces,
   * delayed transitions). Intervals and deep timer chains are never awaited. 0 disables tracking.
   */
  timerMaxMs: number;
}

export interface ProjectProfile {
  /** 1: a single `web` section (still accepted). 2: named `services`. */
  schemaVersion: 1 | 2;
  name: string;
  /** Absolute path to the directory containing agentlab.json. */
  root: string;
  profilePath: string;
  /** Services in declaration order; a schemaVersion 1 profile has one, named "web". */
  services: ServiceSpec[];
  /** The primary application: its base URL and, when a declared service serves it, that service. */
  app: { url: string; service?: string };
  /** The schemaVersion 1 `web` section, kept for callers of the single-server API. */
  web?: WebServerSpec;
  /** Path opened after readiness, relative to app.url. */
  startPath: string;
  device: string;
  /** Project-defined device profiles, by id. */
  devices: Record<string, DeviceOverride>;
  /** Allow non-local, non-private hosts. Off by default. */
  allowExternalUrl: boolean;
  settle: SettlePolicy;
  auth: AuthPolicy;
  /** Absolute files or directories that `upload` may read. Empty: uploads are refused. */
  uploads: { allow: string[] };
  /** Responsive scan: devices, checks, scenarios, exploration, suppressions and result policy. */
  scan: ScanConfig;
  /** `agentlab test` defaults (see docs/ci.md); every field is optional and flags override it. */
  ci: CiConfig;
  /** Set for a schemaVersion 1 profile: how to rewrite it as the current version. */
  migration?: string;
}

export interface ServerInfo {
  url: string;
  /** true when the lab started the process and is responsible for stopping it. */
  owned: boolean;
  reused: boolean;
  pid?: number;
  command?: string;
  readyMs: number;
  logFile?: string;
}

export interface ServiceInfo {
  name: string;
  url?: string;
  mode: 'process' | 'oneshot';
  /** started: the lab ran the command and will stop it; reused: already running, left alone. */
  status: 'started' | 'reused';
  owned: boolean;
  pid?: number;
  command: string;
  readyMs: number;
  /** What proved readiness, e.g. "GET /health 200", "tcp 127.0.0.1:5349", "log /worker ready/". */
  readiness: string;
  logFile?: string;
}

/** Per-service outcome when a start fails: which failed, which were started and cleaned up, which never ran. */
export interface ServiceStartReport {
  name: string;
  status: 'ready' | 'reused' | 'failed' | 'skipped' | 'aborted' | 'pending';
  detail?: string;
  stopped?: string;
}

export interface ServiceStopResult { name: string; owned: boolean; stopped: boolean; detail: string }

// ---------- devices / session ----------

export interface DeviceProfile {
  id: string;
  label: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  userAgent?: string;
}

export interface SessionInfo {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  device: DeviceProfile;
  browser: { engine: 'chromium'; version: string; headed: boolean };
  /** What this environment is, stated plainly so reports are not over-trusted. */
  environment: string;
  limitations: string[];
  runDir: string;
  /** Whether the session started from saved sign-in state (the state itself is never returned). */
  auth?: 'saved-state' | 'fresh';
}

// ---------- observation ----------

export interface Rect { x: number; y: number; w: number; h: number }

export interface Control {
  ref: string;
  role: string;
  name: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  /** Toggle buttons (aria-pressed). */
  pressed?: boolean;
  expanded?: boolean;
  /** Tabs and options (aria-selected). */
  selected?: boolean;
  required?: boolean;
  invalid?: boolean;
  focused?: boolean;
  /** Only when another control has the same role and name: the heading of this one's card or section. */
  context?: string;
  /** Vertically outside the current viewport; normal for scrollable pages. */
  offscreen?: 'above' | 'below';
  /** Extends horizontally past the layout viewport (document coordinates). */
  clip?: { side: 'left' | 'right'; px: number };
  /**
   * Inside a horizontally scrollable region (overflow-x auto/scroll) that itself fits the viewport,
   * e.g. a carousel: reachable by scrolling that region, so it is not flagged as clipped.
   */
  scrollRegion?: boolean;
  /** Document coordinates, CSS px. */
  rect: Rect;
}

export type LayoutFlagKind = 'horizontal-overflow' | 'control-clipped';

export interface LayoutFlag {
  kind: LayoutFlagKind;
  severity: 'high' | 'medium' | 'low';
  /** Stable within a document: "overflow" or "clipped:<ref>". */
  key: string;
  message: string;
  ref?: string;
  evidence: Record<string, number | string>;
}

export interface PageMessage { role: string; text: string }

export interface Observation {
  schemaVersion: typeof SCHEMA_VERSION;
  sessionId: string;
  /** Increments on every observation in the session. */
  gen: number;
  /** Changes whenever the browser loads a new document; refs never survive a docId change. */
  docId: string;
  url: string;
  route: string;
  title: string;
  /** The tab observed, when more than one is open (t1, t2, …). */
  tab?: string;
  /** Device-width CSS viewport the page is laid out for. */
  viewport: { width: number; height: number };
  /** How far the visible area is panned/scrolled from the document origin (layout scroll + visual pan). */
  scroll: { x: number; y: number };
  documentWidth: number;
  /** Width the mobile browser widened the layout viewport to (equals viewport.width unless content overflows). */
  layoutViewportWidth: number;
  headings: string[];
  /** Name of the open modal dialog, if any. Controls are then scoped to it. */
  dialog?: string;
  controls: Control[];
  /** Controls that matched but were cut by the result budget. Never silently dropped. */
  omitted: number;
  /** Known controls currently covered by a modal dialog (still attached, not actionable). */
  inert: ControlSummary[];
  messages: PageMessage[];
  focused?: string;
  layout: LayoutFlag[];
  console: { errors: number };
  network: { failed: number };
  /** Total findings recorded in this session so far (details via inspect). */
  findings: number;
}

// ---------- findings ----------

export type FindingKind =
  | 'horizontal-overflow' | 'control-clipped' | 'horizontal-pan-required' | 'control-obstructed'
  | 'container-clipped' | 'text-clipped' | 'text-truncated' | 'fixed-collision' | 'content-under-fixed'
  | 'modal-overflow' | 'unreachable-content' | 'outside-container' | 'content-scroll-x' | 'tap-target'
  | 'layout-shift' | 'text-wrap-change';

/**
 * What a finding rests on. A heuristic may be high severity only when its basis includes a
 * deterministic measurement (everything except `geometry` and `comparison`).
 */
export type EvidenceBasis = 'geometry' | 'clipping' | 'hit-test' | 'interaction' | 'standard' | 'browser-metric' | 'comparison';

/** The element a finding is about. Controls carry role and name; other content a short text or tag. */
export interface FindingTarget {
  role: string;
  name: string;
  /** Session ref; only for findings on the session's own page (scan contexts are thrown away). */
  ref?: string;
  /** The card or section heading, when the name repeats. */
  context?: string;
  /** A short CSS path to find it in the page, e.g. `div.drawer > footer > button:nth-of-type(2)`. */
  selector?: string;
}

/** An extra evidence frame: the other width of a comparison, or before and after a layout shift. */
export interface EvidenceFrame { label: string; path: string; device?: string }

/**
 * A usability defect recorded for the whole session. Findings outlive the observation or action that
 * raised them, so a later successful automated click cannot erase what a person would have hit.
 */
export interface Finding {
  /** Stable within a session: F1, F2, … */
  id: string;
  kind: FindingKind;
  /** The check that raised it, and its version (see detectors.ts). */
  detector: { name: string; version: number };
  severity: 'high' | 'medium' | 'low';
  /**
   * measured-layout: geometry of an observation. interaction: how an action had to reach a control.
   * sweep-reachability: the sweep's or scan's reach check. scan: a scan detector on a scenario state.
   */
  source: 'measured-layout' | 'interaction' | 'sweep-reachability' | 'scan';
  /**
   * confirmed: a deterministic measurement shows a person is affected (a sideways pan was needed, a hit
   * test lands elsewhere, content is measured as cut off or unreachable, a standard's rule fails).
   * heuristic: geometry that often, but not always, hurts a person.
   */
  confidence: 'confirmed' | 'heuristic';
  /** 0–1: how likely the finding is a real problem for a person, by the rules in docs/web-v1-m2.md. */
  confidenceScore: number;
  basis: EvidenceBasis[];
  route: string;
  device: string;
  viewportWidth: number;
  /** Scan findings: the scenario and the UI state they were measured in (the first state seen). */
  scenario?: string;
  state?: string;
  /** Every state of the scenario where the same problem was seen (deduplicated into this finding). */
  states?: string[];
  target?: FindingTarget;
  message: string;
  evidence: Record<string, number | string>;
  /** Same underlying problem across devices, scenarios and states: stable across runs (a hash). */
  fingerprint: string;
  /** Evidence frame (a JPEG in the run directory), when one was captured. */
  frame?: string;
  frames?: EvidenceFrame[];
  firstSeen: { gen: number; at: string };
  lastSeenGen: number;
  occurrences: number;
  /** Steps from session start that reproduce the finding. */
  reproduction: string[];
  /** Set by a scan when a documented suppression matches; the finding is still reported. */
  suppressed?: { rule: number; reason: string; expires?: string };
}

// ---------- responsive sweep ----------

export interface SweepDeviceResult {
  device: string;
  label: string;
  width: number;
  height: number;
  route: string;
  status: 'ok' | 'error';
  error?: LabErrorJSON;
  ms: number;
  /** How the page settled before measuring (quiet, or timeout with its cause). */
  settled: 'quiet' | 'timeout' | 'busy' | 'timers' | 'route' | 'empty';
  /** When it did not settle quietly: what was still busy (`dom`: the DOM kept changing). Same vocabulary as an action's settle report. */
  settleCause?: NonNullable<SettleReport['cause']>;
  /** Status of the route's main document at this width. 400 and above is an `http_status` error: the page was not measured. */
  httpStatus?: number;
  documentWidth: number;
  controls: number;
  /** Controls given the reach check (scroll into view, measure any sideways pan, hit-test the centre). */
  reachChecked: number;
  /** Ids of findings recorded at this width (new or already known). */
  findings: string[];
  /** Viewport JPEG after load, in the run directory. */
  frame?: string;
}

export interface SweepResult {
  schemaVersion: typeof SCHEMA_VERSION;
  /** S1, S2, … within the session. */
  id: string;
  route: string;
  startedAt: string;
  ms: number;
  devices: SweepDeviceResult[];
  /** Every finding referenced by `devices[].findings`. */
  findings: Finding[];
  /** Markdown report with device, route, finding, measurements, reproduction and evidence frame. */
  report: string;
  /** A person paused, took over or stopped the session: these widths never ran. */
  interrupted?: Interruption & { skipped: string[] };
}

// ---------- stateful scan ----------

/** A setup step: the flow step format (see src/core/steps.ts), resolved against the latest observation. */
export interface ScenarioStep {
  do: ActionName;
  role?: string;
  name?: string;
  nameContains?: string;
  value?: string;
  key?: string;
  values?: string[];
  direction?: Direction;
  amount?: number;
  to?: { role?: string; name?: string; nameContains?: string };
  dx?: number;
  dy?: number;
  files?: string[];
  tab?: string;
  path?: string;
  label?: string;
  /** Checked after the step; a failed expectation fails the scenario before its checks run. */
  expect?: { route?: string; dialog?: string | null; heading?: string; message?: string; control?: { role?: string; name?: string; nameContains?: string } };
}

/** Enable or disable checks by kind. `enable` limits the scan to those kinds. */
export interface ChecksConfig { enable?: FindingKind[]; disable?: FindingKind[] }

export interface TapTargetPolicy {
  /** wcag22-aa: SC 2.5.8, 24 CSS px with the spacing, inline and user-agent exceptions. wcag22-aaa: SC 2.5.5, 44 px, no spacing exception. */
  standard: 'wcag22-aa' | 'wcag22-aaa';
}

export interface ScanScenario {
  name: string;
  route: string;
  /** session: the running session's cookies and storage; saved: the saved sign-in file; fresh: none. */
  auth: 'session' | 'saved' | 'fresh';
  /** Device ids; default: the scan's devices. */
  devices?: string[];
  steps: ScenarioStep[];
  checks?: ChecksConfig;
  /** Explore from this scenario's state (overrides the scan's explore.enabled). */
  explore?: boolean;
  /** Steps run after the checks, before the scenario's context is discarded (e.g. to undo server data). */
  cleanup: ScenarioStep[];
}

export interface ControlMatcher { role?: string; name?: string; route?: string }

export interface ExploreConfig {
  enabled: boolean;
  /** How many state-opening activations deep from the scenario's state (1: one control at a time). */
  maxDepth: number;
  /** Explored states per scenario and device, the base state excluded. */
  maxStates: number;
  /** Candidate controls tried per state. */
  maxActionsPerState: number;
  /** Total exploration time for the whole scan. */
  maxMs: number;
  /** Controls known to be safe to activate, even without state-opening attributes. */
  allow: ControlMatcher[];
  /** Controls never activated automatically, whatever their attributes. */
  deny: ControlMatcher[];
}

export interface Suppression {
  kind?: FindingKind | FindingKind[];
  fingerprint?: string;
  /** Exact route, or a glob with `*`. */
  route?: string;
  target?: { role?: string; name?: string };
  scenario?: string;
  device?: string;
  /** Required: why this is accepted. */
  reason: string;
  /** YYYY-MM-DD; the suppression stops applying after this day and is reported as expired. */
  expires?: string;
}

export interface ScanPolicy {
  /** Fail when an unsuppressed confirmed finding has at least this severity. `none` never fails on findings. */
  failOn: 'high' | 'medium' | 'low' | 'none';
  /** Also fail when a scenario could not complete its checks. */
  failOnErrors: boolean;
  /** Also count heuristic findings toward failOn. Off by default. */
  failOnHeuristic: boolean;
}

/** The profile's `ci` section: what `agentlab test` runs and how it decides. */
export interface CiConfig {
  /** Flow files, relative to the profile. */
  flows?: string[];
  routes?: string[];
  /** Scenario names, or "all" declared ones. */
  scenarios?: string[] | 'all';
  devices?: string[];
  failOn?: 'high' | 'medium' | 'low' | 'none';
  failOnHeuristic?: boolean;
  scenarioErrors?: 'fail' | 'report';
  /** Output directory, relative to the working directory. */
  out?: string;
  trace?: 'off' | 'on-failure' | 'always';
  evidence?: 'off' | 'on-failure' | 'always';
  timeoutMs?: number;
  auth?: 'fresh' | 'saved' | 'env';
}

export interface ScanConfig {
  devices: string[];
  checks: ChecksConfig;
  tapTargets: TapTargetPolicy;
  /** Controls that must never wrap onto a second line (an explicit project expectation). */
  noWrap: ControlMatcher[];
  /** Two widths are "nearby" for wrap comparison when the wider is at most this many times the narrower. */
  wrapNearbyRatio: number;
  /** Layout-shift score (sum of unexpected shifts while a state settles) that is reported. */
  layoutShiftMin: number;
  explore: ExploreConfig;
  scenarios: ScanScenario[];
  suppressions: Suppression[];
  policy: ScanPolicy;
}

/** Why automatic exploration did or did not activate a control. */
export interface ExploreDecision {
  role: string;
  name: string;
  context?: string;
  verdict: 'explore' | 'skip';
  /** For explore: what it opens (menu, dialog, disclosure, tab, accordion, toggle, allow-listed). */
  kind?: string;
  reason: string;
}

export interface ScanState {
  /** s0 is the scenario's state after setup; s1… were explored from it. */
  id: string;
  label: string;
  /** Steps from the scenario's route to this state (setup, then explored activations). */
  path: string[];
  depth: number;
  status: 'measured' | 'failed' | 'blocked';
  error?: LabErrorJSON;
  route?: string;
  dialog?: string;
  controls?: number;
  frame?: string;
  /** Ids of findings seen in this state (new or already known). */
  findings: string[];
  /** How the scan returned to the parent state afterwards. */
  restore?: 'toggle' | 'escape' | 'fresh-context' | 'none';
  /** Requests the exploration guard blocked (method and path), which also stops exploring that control. */
  blocked?: string[];
  /**
   * What the budgets left out, never dropped silently: controls beyond the observation's limit,
   * elements beyond the layout detectors' budget, and how many controls were reach-checked.
   */
  budget?: { controlsOmitted: number; elementsOmitted: number; reachChecked: number };
}

export interface ScenarioDeviceRun {
  scenario: string;
  device: string;
  width: number;
  height: number;
  status: 'ok' | 'failed';
  /** Where a failed scenario stopped: before any check ran, or part way through. */
  failedAt?: 'context' | 'load' | 'setup' | 'checks' | 'cleanup';
  error?: LabErrorJSON;
  ms: number;
  states: ScanState[];
  /** Exploration decisions for controls seen in the explored states (bounded, with an omitted count). */
  decisions: ExploreDecision[];
  decisionsOmitted: number;
  /** Exploration limits that cut it short, e.g. "maxStates (12): 4 candidates not explored". */
  limits: string[];
  findings: string[];
}

export interface FindingGroup {
  /** G1, G2, … within the scan. */
  id: string;
  fingerprint: string;
  kind: FindingKind;
  title: string;
  severity: 'high' | 'medium' | 'low';
  confidence: 'confirmed' | 'heuristic';
  route: string;
  target?: FindingTarget;
  scenarios: string[];
  devices: string[];
  findings: string[];
  /** Every finding in the group is suppressed. */
  suppressed: boolean;
}

export interface SuppressionStatus {
  rule: number;
  reason: string;
  status: 'applied' | 'unmatched' | 'expired' | 'not-evaluated';
  matched: string[];
  expires?: string;
}

export interface ScanVerdict {
  /** incomplete: a person paused, took over or stopped the session before every run finished. */
  result: 'pass' | 'fail' | 'incomplete';
  reasons: string[];
  policy: ScanPolicy;
}

export interface ScanResult {
  schemaVersion: typeof SCHEMA_VERSION;
  /** R1, R2, … within the session. */
  id: string;
  startedAt: string;
  ms: number;
  devices: string[];
  explore: boolean;
  runs: ScenarioDeviceRun[];
  findings: Finding[];
  groups: FindingGroup[];
  suppressions: SuppressionStatus[];
  verdict: ScanVerdict;
  reports: { html: string; json: string };
  /** Time spent exploring, and whether the scan-wide exploration budget ran out. */
  exploreMs: number;
  /** A person paused, took over or stopped the session: the scan ended after `runs`; these never ran. */
  interrupted?: Interruption & { skipped: { scenario: string; device: string }[] };
}

/** Why a long command (scan, sweep) ended before finishing its plan. */
export interface Interruption {
  reason: 'paused' | 'takeover' | 'stopped';
  by?: string;
}

// ---------- actions ----------

export type ActionName =
  | 'click' | 'fill' | 'press' | 'select' | 'check' | 'uncheck' | 'scroll' | 'swipe'
  | 'back' | 'forward' | 'hover' | 'upload' | 'drag' | 'open_tab' | 'switch_tab' | 'close_tab';

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface ActionRequest {
  action: ActionName;
  /** The control acted on. Optional for press (focused element), scroll/swipe (the page), back, forward and tabs. */
  ref?: string;
  /** fill: the text. */
  value?: string;
  /** press: a key or chord in Playwright syntax, e.g. Enter, Escape, Shift+Tab, Control+a. */
  key?: string;
  /** select: option values or labels. */
  values?: string[];
  /** scroll / swipe direction; the direction the content moves into view (scroll down = see what is below). */
  direction?: Direction;
  /** scroll / swipe distance in CSS px. */
  amount?: number;
  /** drag: the control to drop on. */
  toRef?: string;
  /** drag: offset from the source's centre, when there is no toRef (sliders, free placement). */
  dx?: number;
  dy?: number;
  /** upload: files relative to the project root; must be inside uploads.allow. */
  files?: string[];
  /** switch_tab / close_tab: tab id (t1, t2, …). open_tab: path on the app's origin. */
  tab?: string;
  path?: string;
}

export interface ControlSummary { ref: string; role: string; name: string }

export interface FieldChange { field: string; from: unknown; to: unknown }

export interface Changes {
  /** Present when the baseline was reset; controls are then not diffed. */
  reset?: { reason: 'navigation' | 'no-baseline' | 'tab' };
  /** Tabs opened or closed by the action, and a change of the tab being observed. */
  tabs?: { opened: string[]; closed: string[]; active?: { from: string; to: string } };
  route?: { from: string; to: string };
  title?: { from: string; to: string };
  dialog?: { from?: string; to?: string };
  added: ControlSummary[];
  removed: ControlSummary[];
  changed: (ControlSummary & { fields: FieldChange[] })[];
  /** Same role and name, new element (e.g. a list re-render). The old ref is stale; use `to`. */
  rerendered: (ControlSummary & { from: string; to: string })[];
  /** Controls that became covered by / uncovered from a modal dialog. */
  covered: number;
  uncovered: number;
  messagesAdded: PageMessage[];
  messagesRemoved: PageMessage[];
  headingsAdded: string[];
  headingsRemoved: string[];
  focus?: { from?: string; to?: string };
  layoutAdded: LayoutFlag[];
  layoutResolved: LayoutFlag[];
  /** True when nothing an agent would care about changed. */
  none: boolean;
}

export interface SettleReport {
  ms: number;
  reason: 'quiet' | 'timeout';
  /**
   * On timeout: what was still busy. `busy`: a visible element kept aria-busy="true"; `timers`: short
   * one-shot timers kept being scheduled (a re-arming loop; lower or disable settle.timerMaxMs);
   * `empty`: the document has scripts but nothing was ever drawn.
   */
  cause?: 'dom' | 'network' | 'busy' | 'timers' | 'route' | 'empty';
  /** On timeout with network cause: method + path of requests still open (max 5). */
  pending?: string[];
  /** Long-lived/background requests that were deliberately not awaited. */
  ignored: number;
}

export interface ConsoleEntry { type: string; text: string; at: number }
export interface FailedRequest { method: string; url: string; status?: number; failure?: string; at: number }

export interface TabInfo { id: string; url: string; title: string; active: boolean; opener?: string }

export interface ActionResult {
  schemaVersion: typeof SCHEMA_VERSION;
  action: ActionName;
  ref?: string;
  target?: ControlSummary;
  outcome: 'success' | 'error';
  error?: LabErrorJSON;
  /** click/check/uncheck → "click" or "tap" (touch profiles); otherwise how input was delivered, e.g. "fill", "keyboard", "wheel", "touch", "mouse-drag", "history". */
  method?: string;
  elapsedMs: number;
  settle?: SettleReport;
  navigated: boolean;
  /** Human-relevant facts about how the action was achieved (e.g. forced horizontal scroll). */
  notes: string[];
  changes?: Changes;
  newConsoleErrors: ConsoleEntry[];
  newFailedRequests: FailedRequest[];
  /** Findings first recorded by this action (layout on the resulting page, or how the target was reached). */
  newFindings: Finding[];
  observation?: Observation;
}

// ---------- errors ----------

export type LabErrorCode =
  | 'invalid_profile'
  | 'profile_too_new'
  | 'url_not_allowed'
  | 'startup_failed'
  | 'readiness_timeout'
  | 'port_conflict'
  | 'no_display'
  | 'no_session'
  | 'session_exists'
  | 'browser_closed'
  | 'unknown_device'
  | 'unknown_ref'
  | 'stale_ref'
  | 'not_found'
  | 'ambiguous_target'
  | 'not_visible'
  | 'disabled'
  | 'obstructed'
  | 'not_fillable'
  | 'action_failed'
  /** A sweep's route answered HTTP 400 or above. */
  | 'http_status'
  | 'not_selectable'
  | 'not_checkable'
  | 'not_uploadable'
  | 'upload_not_allowed'
  | 'no_history'
  | 'unknown_tab'
  | 'missing_env'
  | 'auth_missing'
  | 'auth_invalid'
  | 'auth_not_ignored'
  | 'invalid_request'
  /** Supervision: a person paused the session, holds the browser, or stopped it (see control.ts). */
  | 'session_paused'
  | 'human_control'
  | 'observation_required'
  | 'session_stopped'
  | 'invalid_control'
  /** A Playwright trace could not be proven free of secrets, so it was dropped. */
  | 'trace_unsanitizable'
  /** A failure bundle is malformed, was written by a newer agentlab, or still held a secret when checked. */
  | 'bundle_invalid'
  | 'bundle_too_new'
  | 'bundle_unsafe';

export interface LabErrorJSON {
  code: LabErrorCode;
  message: string;
  hint?: string;
  /** Whether an agent can recover within the same session (e.g. re-observe). */
  recoverable: boolean;
  details?: Record<string, unknown>;
}

const RECOVERABLE: ReadonlySet<LabErrorCode> = new Set([
  'unknown_ref', 'stale_ref', 'not_found', 'ambiguous_target', 'not_visible', 'disabled',
  'obstructed', 'not_fillable', 'action_failed', 'invalid_request',
  'not_selectable', 'not_checkable', 'not_uploadable', 'upload_not_allowed', 'no_history', 'unknown_tab',
  'session_paused', 'human_control', 'observation_required', 'invalid_control',
]);

export class LabError extends Error {
  readonly code: LabErrorCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: LabErrorCode, message: string, opts: { hint?: string; details?: Record<string, unknown> } = {}) {
    // A message can quote a URL (a failed navigation, a refused route): its secrets never go out.
    super(redactUrlSecrets(message));
    this.name = 'LabError';
    this.code = code;
    this.hint = opts.hint === undefined ? undefined : redactUrlSecrets(opts.hint);
    this.details = opts.details;
  }

  toJSON(): LabErrorJSON {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      recoverable: RECOVERABLE.has(this.code),
      ...(this.details ? { details: this.details } : {}),
    };
  }

  static from(err: unknown): LabError {
    if (err instanceof LabError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new LabError('action_failed', message.split('\n')[0] ?? message);
  }
}

// ---------- failure bundles and replay ----------

/** A control as a person or a replay finds it again: role and name, plus the section heading when the name repeats. Refs are never replayable. */
export interface RecordedTarget { role: string; name: string; context?: string }

/** What an action carried besides its target. A password-like field's `value` or `key` is replaced by ‹secret›. */
export interface RecordedArgs {
  value?: string; key?: string; values?: string[]; direction?: Direction; amount?: number; dx?: number; dy?: number;
  files?: string[]; tab?: string; path?: string;
}

/** One agent action in the structured log. */
export interface RecordedAgentAction {
  /** 1-based position in the session's log (person entries count too). */
  index: number;
  at: string;
  actor: 'agent';
  action: ActionName;
  target?: RecordedTarget;
  /** drag: the drop target. */
  toTarget?: RecordedTarget;
  args: RecordedArgs;
  /** The typed value went into a password-like field: it is masked and a replay needs it supplied. */
  secret?: true;
  /** The value was longer than the log keeps: a replay cannot retype it. */
  truncated?: true;
  /** Paths only (no query or hash). */
  routeBefore?: string;
  routeAfter?: string;
  dialogBefore?: string;
  dialogAfter?: string;
  outcome: 'success' | 'error';
  error?: { code: LabErrorCode; message: string };
  /** Up to 10 lines of what changed, as `formatChanges` words them. */
  changes: string[];
  newFindings: string[];
  /** The target's name suggests the action changes data, spends money, signs out or leaves (explore-safety.ts). */
  consequential: boolean;
}

/** A person's interaction is recorded only as a description: it cannot be replayed. */
export interface RecordedPersonAction { index: number; at: string; actor: 'person'; description: string }

export type RecordedAction = RecordedAgentAction | RecordedPersonAction;

/** A compact copy of one observation: enough to see what the agent saw. Password-like values are already masked. */
export interface RecordedObservation {
  gen: number;
  route: string;
  title: string;
  dialog?: string;
  headings: string[];
  controls: { role: string; name: string; context?: string; value?: string }[];
  /** Controls beyond the 40 kept. */
  omitted: number;
}

export type BundleFailure =
  | { kind: 'action-error'; step: number; code: string }
  | { kind: 'findings'; fingerprints: string[] }
  | { kind: 'expectation'; step: number; text: string }
  | { kind: 'scenario-error'; scenario: string; device: string; failedAt: string; code?: string }
  | { kind: 'manual' };

export interface BundleConsoleError { type: string; text: string; count: number }
export interface BundleFailedRequest { method: string; url: string; status?: number; failure?: string }

/** `bundle.json`: everything needed to understand and replay a failure, with secrets removed. */
export interface FailureBundle {
  kind: 'agentlab-failure-bundle';
  bundleVersion: number;
  id: string;
  product: { version: string; contracts: Record<string, unknown> };
  environment: { node: string; platform: string; arch: string; osRelease: string; playwright: string; chromium: string; headed: boolean; ci: boolean };
  reason: string;
  failure: BundleFailure;
  project: {
    name: string;
    /** SHA-256 of the agentlab.json bytes the session ran with. */
    profileSha256: string;
    /** agentlab.json with env values, credentials in commands and URLs, and the auth file's location details removed. */
    profile: Record<string, unknown>;
  };
  session: { id: string; device: string; auth: 'saved-state' | 'fresh'; startRoute: string };
  scenario?: { name: string; device: string; route: string; steps: Record<string, unknown>[] };
  route: string;
  actions: RecordedAction[];
  /** Oldest actions dropped from the log (it keeps the last 500). A replay needs them, so it stops as blocked. */
  actionsOmitted: number;
  observations: RecordedObservation[];
  findings: Finding[];
  consoleErrors: BundleConsoleError[];
  failedRequests: BundleFailedRequest[];
  /** Paths inside the bundle, e.g. frames/g3.jpg. */
  frames: string[];
  framesOmitted: number;
  /** The sanitized Playwright trace, when one was recorded and could be proven clean. */
  trace?: string;
  /** Why a recorded trace was left out. */
  traceDropped?: string;
  retention: { createdAt: string; expiresAt: string; policy: string };
}
