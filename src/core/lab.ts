import { appendFileSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { redactUrlSecrets } from './url-redact.js';
import { basename, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type CDPSession, type ElementHandle, type Page, type Request } from 'playwright';
import { ActionLog } from './action-log.js';
import { authStateSecrets, invalidate, loadAuthState, saveAuthState, type StoredState } from './auth.js';
import { envSecrets, writeBundle, type BundleResult } from './bundle.js';
import { sanitizeTrace } from './trace-sanitize.js';
import { EMULATION_LIMITATIONS, SWEEP_DEVICES, getDevice } from './devices.js';
import {
  armHitCapture, centreInView, checkability, currentDocId, extractPage, fillability, focusedIsSecret, installHumanRecorder, installNavTracking, installTimerTracking, lookupRef,
  needsHorizontalPan, panIntoView, scrollByAmount, scrollPositions, selectInfo, targetPoint, uploadInfo, waitForDomQuiet, type TargetPoint,
} from './extract.js';
import { FindingStore } from './findings.js';
import { formatHuman } from './format.js';
import { CONTROL_OPS, Supervisor, stopReason, type CommandKind, type ControlChange, type ControlOp } from './control.js';
import { runSweep } from './sweep.js';
import { runScan } from './scan.js';
import { checkFilter } from './checks.js';
import { buildObservation, diffObservations } from './observation.js';
import { DEFAULT_SETTLE, assertUrlAllowed, loadProfile } from './profile.js';
import { serverInfo } from './project-runner.js';
import { ServiceGroup } from './services.js';
import { keepRuns, liveSessionIds, pruneRuns, reapOrphans, recordOwnership, releaseOwnership } from './ownership.js';
import { appendStep, pushCapped, since } from './reproduction.js';
import type { UnexpectedExit } from './project-runner.js';
import { readState } from '../daemon/state.js';
import {
  LabError, SCHEMA_VERSION,
  type ActionRequest, type ActionResult, type BundleFailure, type ConsoleEntry, type Control, type ControlSummary, type FailedRequest, type ProjectProfile,
  type DeviceProfile, type Finding, type LabErrorJSON, type SweepDeviceResult, type SweepResult, type Observation, type ServerInfo, type ServiceInfo,
  type ScanResult, type ScanState, type ScenarioDeviceRun,
  type ServiceStopResult, type SessionInfo, type SettlePolicy, type SettleReport, type TabInfo, type Interruption,
} from './schema.js';
import type { GroupMember } from './process-group.js';
import type { ProcessIdentity } from './process-identity.js';

export interface StartOptions {
  /** Project directory or path to agentlab.json. */
  project: string;
  /** Overrides the profile's device. */
  device?: string;
  headed?: boolean;
  /** Slow every browser operation down so a person can follow along. */
  slowMoMs?: number;
  /**
   * Saved sign-in state: auto (default) loads it when the profile allows and the file exists; saved
   * requires it; fresh never loads it (a clean, signed-out session).
   */
  auth?: 'auto' | 'saved' | 'fresh';
  /** Record a Playwright trace (screenshots and snapshots) so a failure bundle can carry a sanitized copy. */
  trace?: boolean;
  /**
   * A sign-in state held in memory (CI: from `AGENTLAB_AUTH_STATE`, checked by `authStateFromEnv`), used instead of
   * the saved file. It is never written to disk, and a rejection never removes the project's saved file.
   */
  authState?: StoredState;
}

export interface StartResult {
  session: SessionInfo;
  /** The application's service (or its URL when no declared service serves it). */
  server: ServerInfo;
  /** Every declared service, in the order it became ready. */
  services: ServiceInfo[];
  observation: Observation;
}
export interface CloseResult {
  reason: string;
  browserClosed: boolean;
  /** The application's service. */
  server: { owned: boolean; stopped: boolean; detail: string };
  /** Every service, in the order it was stopped (dependents first). */
  services: ServiceStopResult[];
}
/** What the daemon records per service so `agentlab stop` can clean up after a crash. */
export interface ServiceRecord { name: string; url?: string; owned: boolean; mode: 'process' | 'oneshot'; pid?: number; identity?: ProcessIdentity; /** Other processes of the leader's group, recorded while it was alive. */ members?: GroupMember[]; stopCommand?: string; cwd?: string }
export interface AuthSaveResult { saved: true; cookies: number; origins: number; file: string }
export interface TargetQuery { role?: string; name?: string; nameContains?: string }
export interface InspectQuery { id?: string; ref?: string }
export interface InspectResult {
  /** All session findings (no query), the one requested (id), or those about the control (ref). */
  findings: Finding[];
  /** The control from the latest observation, when inspecting a ref. */
  control?: Control;
  /** New findings beyond the session's cap that were counted but not kept (all-findings query only). */
  omitted?: number;
}

export type LabEvent =
  | { kind: 'starting'; project: string; url: string; device: DeviceProfile; headed: boolean }
  | { kind: 'start'; result: StartResult }
  | { kind: 'start-failed'; error: LabErrorJSON }
  | { kind: 'server-log'; line: string }
  | { kind: 'observe'; observation: Observation }
  | { kind: 'act'; request: ActionRequest; result: ActionResult }
  /** Findings recorded for the first time, with the evidence frame (a JPEG in the run dir) when captured. */
  | { kind: 'findings'; findings: Finding[]; frame?: string }
  /** The main frame navigated (including navigations the app makes on its own). Query and hash removed. */
  | { kind: 'page'; url: string }
  | { kind: 'counts'; consoleErrors: number; failedRequests: number }
  /** A service became ready during start (started or reused). */
  | { kind: 'service'; info: ServiceInfo }
  /** Saved sign-in state was loaded, saved or invalidated. Never carries the state itself. */
  | { kind: 'auth'; action: 'loaded' | 'saved' | 'invalidated'; cookies?: number; origins?: number }
  | { kind: 'sweep'; phase: 'start'; id: string; route: string; devices: { id: string; width: number; height: number }[] }
  | { kind: 'sweep'; phase: 'device-start'; id: string; device: string }
  | { kind: 'sweep'; phase: 'device-done'; id: string; result: SweepDeviceResult }
  | { kind: 'sweep'; phase: 'done'; id: string; result: SweepResult }
  | { kind: 'scan'; phase: 'start'; id: string; explore: boolean; runs: { scenario: string; route: string; device: string; width: number; height: number }[] }
  | { kind: 'scan'; phase: 'run-start'; id: string; scenario: string; device: string }
  /** A state was measured (or failed, or was blocked) in a scenario run: progress and exploration. */
  | { kind: 'scan'; phase: 'state'; id: string; scenario: string; device: string; state: ScanState }
  | { kind: 'scan'; phase: 'run-done'; id: string; run: ScenarioDeviceRun }
  | { kind: 'scan'; phase: 'done'; id: string; result: ScanResult }
  /** A person paused, resumed, took over, returned control or stopped the session (or a pending change took effect). */
  | { kind: 'control'; change: ControlChange }
  /** What a person did in the page while it was paused or under their control. Never carries typed text. */
  | { kind: 'human'; action: HumanAction }
  /** An agent command refused because the session was not under agent control. Nothing ran. */
  | { kind: 'refused'; command: string; error: LabErrorJSON }
  | { kind: 'closed'; result: CloseResult };

/** A person's interaction, as the in-page recorder reports it: role and short name, no values. */
export interface HumanAction {
  type: 'tap' | 'type' | 'key' | 'select' | 'check' | 'upload' | 'submit' | 'navigate' | 'input-dropped';
  target?: { role: string; name: string };
  /** Characters now in a text field (never for password-like fields). */
  chars?: number;
  /** The field is password-like: nothing about its value is reported. */
  secret?: boolean;
  /** Key name, option count, checked state, file count, or where the page went. */
  detail?: string;
  /** Typing that was still pending when control went back to the agent; it belongs to the person's turn. */
  late?: boolean;
}

/** Input a person sends from the dashboard while they have taken control. Coordinates are 0–1 of the viewport frame. */
export type HumanInput =
  | { type: 'tap'; x: number; y: number }
  | { type: 'key'; key: string }
  | { type: 'text'; text: string }
  | { type: 'scroll'; dy: number };

/** Keys the dashboard may send. Printable text goes through `text`. */
export const HUMAN_KEYS: readonly string[] = [
  'Enter', 'Tab', 'Shift+Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Space',
];
const HUMAN_TEXT_MAX = 500;
const HUMAN_SCROLL_MAX = 5000;
/** A person can produce many events; beyond this rate they are counted, not recorded one by one. */
const HUMAN_EVENTS_PER_SECOND = 10;

export interface LabOptions {
  /** Where run artifacts go: <stateDir>/runs/<sessionId>/ */
  stateDir: string;
  onEvent?: (event: LabEvent) => void;
  /**
   * Save a viewport JPEG as evidence whenever findings are first recorded (for a sideways pan, the
   * view before panning). Costs one screenshot per new batch of findings; off unless a viewer can use it.
   */
  evidenceFrames?: boolean;
}

/**
 * Point the live viewport at another page (a sweep width, a scan scenario) while it is measured. The
 * returned function hands the viewport back to the session's page. Does nothing without a viewer.
 */
export type WatchPage = (page: Page, viewport: { width: number; height: number }) => Promise<() => Promise<void>>;

/** How long a watched sweep or scan page stays in the live viewport at least. */
const WATCH_MIN_MS = 1200;
/** How long after a watched page closes the live viewport returns to the session's page. */
const WATCH_RETURN_MS = 600;

/** An isolated scenario context on an existing browser (see Lab.isolated). */
export interface IsolatedOptions {
  browser: Browser;
  profile: ProjectProfile;
  device: DeviceProfile;
  /** Cookies and storage copied in (the session's, or the saved sign-in state); never written back. */
  storageState?: BrowserContextOptions['storageState'];
  sessionId: string;
  runDir: string;
  headed: boolean;
  init?: {
    /** Extra init scripts, e.g. the layout-shift observer. */
    scripts?: (() => void)[];
    /** Called for every request; a returned label blocks it (the exploration guard). */
    guard?: (method: string, url: string, navigation: boolean) => string | undefined;
  };
  /** Shows this context's page in the session's live viewport until the returned function is called. */
  watch?: WatchPage;
}

export interface ScreencastOptions {
  /** Frames are delivered at most this often; the browser produces the next one only after the wait. */
  maxFps: number;
  /** Maximum frame width in pixels; height follows the device aspect ratio. */
  maxWidth: number;
  /** JPEG quality, 0–100. */
  quality: number;
}

const OBSERVE_LIMIT = 40;
const BODY_IDLE_MS = 500;
/** How long to wait for a tab the page asked to open (a link with a target, window.open) to reach the lab. */
const NEW_TAB_WAIT_MS = 2000;
const ACTION_TIMEOUT_MS = 5000;

/**
 * One session: an owned-or-reused web server, one Chromium context and page, observation history
 * and an action log. This class is the typed core behind the CLI, the daemon and the future MCP adapter.
 */
export class Lab {
  private readonly opts: LabOptions;
  private browser?: Browser;
  private context?: BrowserContext;
  /** The tab being observed and acted on. */
  private page?: Page;
  private profile?: ProjectProfile;
  private services?: ServiceGroup;
  private session?: SessionInfo;
  private last?: Observation;
  private gen = 0;
  private nextRef = 1;
  private readonly refDocs = new Map<string, string>();
  /** Tab each ref was issued in. */
  private readonly refTabs = new Map<string, string>();
  /** old ref → new ref for controls the diff engine judged to be re-rendered. */
  private readonly replacedBy = new Map<string, string>();
  /** The latest EVENTS_KEEP of each; the totals below stay exact and feed the observation counters. */
  private readonly consoleErrors: ConsoleEntry[] = [];
  private readonly failedRequests: FailedRequest[] = [];
  private consoleTotal = 0;
  private failedTotal = 0;
  /** In-flight requests, for the settle policy. */
  private readonly requests = new Map<Request, { started: number; label: string; key: string; background: boolean; responded?: boolean }>();
  /**
   * Last response or body data time of unfinished requests, by "METHOD url". A response whose body
   * nobody reads (a POST result the page ignores, sent chunked) never finishes in Chromium; once its
   * body has been silent for BODY_IDLE_MS it no longer holds settling. Streams keep sending, so they do.
   */
  private readonly bodyActivity = new Map<string, number>();
  private settlePolicy: SettlePolicy = { ...DEFAULT_SETTLE };
  private findings = new FindingStore('');
  /** Human-readable steps from session start; copied into each finding as its reproduction. */
  private readonly history: string[] = [];
  private actionPanX = 0;
  private lastFreshFindings: Finding[] = [];
  private hits: { token: string; type: string; onTarget: boolean; target: string }[] = [];
  /** Viewport captured just before an action panned sideways, kept as the pan finding's evidence. */
  private prePanFrame?: Buffer;
  /** The field being filled or typed into is a password or similar; its value is kept out of history and logs. */
  private fillSecret = false;
  private closing?: Promise<CloseResult>;
  /** Session id under which this Lab recorded ownership of its services, until they are stopped. */
  private ownedId?: string;
  /** Aborted by close() so services still starting are abandoned; `starting` is the start in flight. */
  private readonly startAbort = new AbortController();
  private starting?: Promise<StartResult>;
  /** What the agent did, replay-ready, and the values it typed into password-like fields (memory only). */
  private readonly log = new ActionLog();
  private tracing = false;
  /** A sign-in state supplied in memory (see StartOptions.authState); scenarios with auth "saved" use it too. */
  private memoryAuth?: StoredState;
  private sweeps = 0;
  private scans = 0;
  /** An isolated scenario context: shares the session's browser, owns only its own context. */
  private child = false;
  /**
   * Called after an action's input (or a load) and before settling: a scan uses it to capture what the
   * state looked like before it settled, as evidence for layout shifts.
   */
  onActed?: () => Promise<void>;
  private origin = '';
  private endedReason?: string;
  /** Pause, takeover and stop requests from a person watching the dashboard. */
  readonly control = new Supervisor();
  /** Refs numbered below this were issued before a person used the browser: stale. */
  private refFloor = 0;
  /** Refs below the floor that an observation since has listed again: the control is still there, so the ref is fresh. */
  private refsSinceFloor = new Set<string>();
  private humanWindow = { start: 0, count: 0, dropped: 0 };
  /** Until when typing flushed at the hand-back is still accepted as the person's (see flushHumanTyping). */
  private humanGraceUntil = 0;
  // ---------- tabs ----------
  private readonly tabs = new Map<string, Page>();
  private readonly tabIds = new WeakMap<Page, string>();
  private readonly openers = new Map<string, string>();
  private readonly cdp = new WeakMap<Page, CDPSession>();
  private nextTab = 1;
  private activeTab = '';
  /** Tabs opened and closed since the current action began. */
  private tabEvents: { opened: string[]; closed: string[] } = { opened: [], closed: [] };
  /** The live viewport stream, moved to whichever tab becomes active. */
  /** An isolated context shown in the session's live viewport: hands the viewport back on close. */
  private unwatch?: () => Promise<void>;
  private unwatchTimer?: ReturnType<typeof setTimeout>;
  /** The current page's route as the browser has it, secrets included; never output. */
  private rawRoute?: string;
  private cast?: { onFrame: (jpeg: Buffer) => void; opts: ScreencastOptions; stop?: () => Promise<void>; stopped: boolean; lastFrameAt?: number };

  constructor(opts: LabOptions) {
    this.opts = { ...opts, stateDir: resolve(opts.stateDir) };
    this.control.onChange((change) => this.onControl(change));
  }

  get active(): boolean {
    return !!this.session && !this.endedReason;
  }

  async start(opts: StartOptions): Promise<StartResult> {
    if (this.session) throw new LabError('session_exists', `Session ${this.session.id} is already running`, { hint: 'Close it first.' });
    this.control.begin('start');
    try {
      this.starting = this.startSession(opts);
      return await this.starting;
    } catch (err) {
      const error = LabError.from(err);
      this.emit({ kind: 'start-failed', error: error.toJSON() });
      throw error;
    } finally {
      this.control.end();
    }
  }

  private async startSession(opts: StartOptions): Promise<StartResult> {
    const profile = await loadProfile(opts.project);
    this.profile = profile;
    const device = getDevice(opts.device ?? profile.device, profile.devices);
    this.settlePolicy = profile.settle;
    this.findings = new FindingStore(device.id);
    const headed = opts.headed ?? false;
    const appUrl = profile.app.url;
    this.emit({ kind: 'starting', project: profile.name, url: appUrl + profile.startPath, device, headed });
    if (headed && process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      throw new LabError('no_display', 'Headed mode needs a display but neither DISPLAY nor WAYLAND_DISPLAY is set', {
        hint: 'Use --headless, or run under xvfb-run.',
      });
    }
    // Checked before any service starts, so a bad auth request never leaves processes behind.
    const authMode = opts.auth ?? 'auto';
    let storageState: StoredState | undefined;
    if (opts.authState) {
      storageState = opts.authState;
      this.memoryAuth = opts.authState;
    } else if (authMode === 'saved' || (authMode === 'auto' && profile.auth.use === 'auto' && existsFile(profile.auth.file))) {
      storageState = loadAuthState(profile.auth);
    }

    const id = `s-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${randomBytes(2).toString('hex')}`;
    await this.housekeeping(id);
    const runDir = join(this.opts.stateDir, 'runs', id);
    // Service logs can hold secrets the app prints: owner-only.
    mkdirSync(runDir, { recursive: true, mode: 0o700 });

    const multi = profile.services.length > 1;
    this.services = await ServiceGroup.start(profile.services, {
      runDir,
      onLog: (name, line) => this.emit({ kind: 'server-log', line: multi ? `[${name}] ${line}` : line }),
      onReady: (info) => this.emit({ kind: 'service', info }),
      onUnexpectedExit: (exit) => this.onServiceExit(exit, multi),
      signal: this.startAbort.signal,
    });
    try {
      recordOwnership(this.opts.stateDir, id, this.serviceRecords());
      this.ownedId = id;
    } catch (err) {
      this.emit({ kind: 'server-log', line: `[agentlab] could not record ownership of the started services (${firstLine(err)}); a crash of this process would leave them running` });
    }

    try {
      // Playwright's own signal handlers close the browser and then exit the process, cutting off the lab's
      // cleanup (services, ownership records, results). Every entry point handles signals itself.
      this.browser = await chromium.launch({ headless: !headed, slowMo: opts.slowMoMs, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
      try {
        await this.openContext(device, storageState as BrowserContextOptions['storageState']);
      } catch (err) {
        if (!storageState) throw err;
        if (this.memoryAuth) throw new LabError('auth_invalid', 'The browser rejected the sign-in state supplied in memory', { hint: 'Check the state you exported (a Playwright storageState).' });
        invalidate(profile.auth);
        this.emit({ kind: 'auth', action: 'invalidated' });
        throw new LabError('auth_invalid', `The browser rejected the saved sign-in state (${firstLine(err)}); it has been removed`, {
          hint: 'Start a fresh session, sign in, then save the state again.',
        });
      }
      if (storageState) this.emit({ kind: 'auth', action: 'loaded', cookies: storageState.cookies.length, origins: storageState.origins.length });

      this.session = {
        schemaVersion: SCHEMA_VERSION,
        id,
        device,
        browser: { engine: 'chromium', version: this.browser.version(), headed },
        environment: `Chromium ${this.browser.version()} with ${device.isMobile ? 'mobile ' : ''}device emulation on ${process.platform}`,
        limitations: EMULATION_LIMITATIONS,
        runDir,
        auth: storageState ? 'saved-state' : 'fresh',
      };
      this.browser.on('disconnected', () => void this.ended('browser disconnected or crashed'));
      if (opts.trace) await this.startTrace();

      this.origin = new URL(appUrl).origin;
      const since = Date.now();
      appendStep(this.history, `open ${redactUrlSecrets(appUrl + profile.startPath)} in Chromium with device ${device.id} (${device.viewport.width}x${device.viewport.height})${storageState ? ' with the saved sign-in state' : ''}`);
      await this.page!.goto(appUrl + profile.startPath, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this.settle(since);
      const observation = await this.snapshot();
      this.log.startRoute = observation.route;
      if (storageState && profile.auth.loginPath && observation.route.startsWith(profile.auth.loginPath)) {
        if (this.memoryAuth) {
          throw new LabError('auth_invalid', `The sign-in state supplied in memory no longer signs in: the app redirected to ${observation.route}`, {
            hint: 'Export a fresh state (`agentlab auth save` after signing in) and update the CI secret.',
          });
        }
        invalidate(profile.auth);
        this.emit({ kind: 'auth', action: 'invalidated' });
        throw new LabError('auth_invalid', `The saved sign-in state no longer signs in: the app redirected to ${observation.route}. It has been removed`, {
          hint: 'Start again (a fresh session), sign in, then save the state again.',
        });
      }
      const primary = this.services.get(profile.app.service);
      const server = primary ? serverInfo(primary.info) : { url: appUrl, owned: false, reused: true, readyMs: 0 };
      const result: StartResult = { session: this.session, server, services: this.services.infos(), observation };
      this.record('start', { session: this.session, server, services: result.services, route: observation.route });
      this.emit({ kind: 'start', result });
      return result;
    } catch (err) {
      // A close already under way (a signal, a service exit) is waiting for this start to settle.
      if (!this.closing) await this.close('start failed');
      throw LabError.from(err);
    }
  }

  /**
   * Before a session starts: stop what a crashed earlier session left running (see ownership.ts) and prune
   * old runs. Both are reported as `server-log` lines; neither can fail the start.
   */
  private async housekeeping(currentId: string): Promise<void> {
    const line = (text: string) => this.emit({ kind: 'server-log', line: `[agentlab] ${text}` });
    try {
      for (const note of await reapOrphans(this.opts.stateDir)) line(note);
    } catch (err) {
      line(`could not check for services left by an earlier session: ${firstLine(err)}`);
    }
    try {
      const protect = liveSessionIds(this.opts.stateDir).add(currentId);
      const daemonSession = readState(this.opts.stateDir)?.sessionId;
      if (daemonSession) protect.add(daemonSession);
      const removed = pruneRuns(this.opts.stateDir, keepRuns(), protect);
      if (removed.length) line(`pruned ${removed.length} old run${removed.length > 1 ? 's' : ''} (keeping the latest ${keepRuns()}; AGENTLAB_KEEP_RUNS changes this)`);
    } catch { /* retention must never break a start */ }
  }

  /** A started service exited by itself after it was ready: a required one ends the session. */
  private onServiceExit(exit: UnexpectedExit & { required: boolean }, multi: boolean): void {
    if (this.closing) return;
    // The other services' leaders are still alive: snapshot their groups again for the ownership record.
    if (this.ownedId) { try { recordOwnership(this.opts.stateDir, this.ownedId, this.serviceRecords()); } catch { /* the record from start stays */ } }
    const how = exit.code !== null ? `code ${exit.code}` : `signal ${exit.signal}`;
    this.emit({ kind: 'server-log', line: `[agentlab] service "${exit.name}" exited unexpectedly (${how})${exit.required ? '' : '; it is optional, so the session continues'}` });
    for (const l of exit.logTail) this.emit({ kind: 'server-log', line: multi ? `[${exit.name}] ${l}` : l });
    if (exit.required) void this.ended(`service "${exit.name}" exited unexpectedly (${how})`);
  }

  /**
   * One browser context for a device: the timer tracker, the hit-capture binding, tabs for pop-ups, and
   * the first page. Used by the session and by isolated scenario contexts alike.
   */
  private async openContext(device: DeviceProfile, storageState?: BrowserContextOptions['storageState'], extra: IsolatedOptions['init'] = {}): Promise<void> {
    this.context = await this.browser!.newContext({
      viewport: device.viewport,
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
      userAgent: device.userAgent,
      ...(storageState ? { storageState } : {}),
    });
    if (this.settlePolicy.timerMaxMs > 0) await this.context.addInitScript(installTimerTracking);
    await this.context.addInitScript(installNavTracking);
    if (!this.child) {
      await this.context.addInitScript(installHumanRecorder);
      await this.context.exposeBinding('__agentDeviceLabHuman', (_source, info: unknown) => this.onHuman(info));
    }
    for (const script of extra.scripts ?? []) await this.context.addInitScript(script);
    if (extra.guard) {
      const guard = extra.guard;
      await this.context.route('**/*', (route) => {
        const req = route.request();
        const label = guard(req.method(), req.url(), req.isNavigationRequest());
        return label ? route.abort('blockedbyclient') : route.fallback();
      });
    }
    await this.context.exposeBinding('__agentDeviceLabHit', (_source, info: unknown) => {
      // Page-supplied data: only accept the expected shape; it never drives decisions beyond this action.
      const h = info as Record<string, unknown>;
      if (typeof h?.token === 'string' && typeof h.type === 'string') {
        this.hits.push({ token: h.token, type: h.type, onTarget: h.onTarget === true, target: String(h.target).slice(0, 80) });
      }
    });
    // Pop-ups and target=_blank links become tabs the session can switch to.
    this.context.on('page', (p) => {
      if (this.tabIds.has(p)) return;
      const id = this.registerTab(p, this.activeTab);
      this.tabEvents.opened.push(id);
      void p.opener().then((o) => { const by = o && this.tabIds.get(o); if (by) this.openers.set(id, by); }).catch(() => undefined);
    });
    this.page = await this.context.newPage();
    if (!this.tabIds.has(this.page)) this.registerTab(this.page);
    this.activeTab = this.tabIds.get(this.page)!;
    this.tabEvents = { opened: [], closed: [] };
  }

  /**
   * A Lab on its own isolated browser context in an existing browser: a scenario's device. It shares
   * nothing with the session's context (cookies and storage are copied in, never written back), runs
   * actions through the same act(), and closing it closes only its context: never the browser, never a
   * service. It writes no artifacts of its own.
   */
  static async isolated(o: IsolatedOptions): Promise<Lab> {
    const lab = new Lab({ stateDir: o.runDir });
    lab.child = true;
    lab.browser = o.browser;
    lab.profile = o.profile;
    lab.settlePolicy = o.profile.settle;
    lab.findings = new FindingStore(o.device.id);
    lab.origin = new URL(o.profile.app.url).origin;
    lab.session = {
      schemaVersion: SCHEMA_VERSION, id: o.sessionId, device: o.device,
      browser: { engine: 'chromium', version: o.browser.version(), headed: o.headed },
      environment: `Chromium ${o.browser.version()} with ${o.device.isMobile ? 'mobile ' : ''}device emulation on ${process.platform}`,
      limitations: EMULATION_LIMITATIONS, runDir: o.runDir, auth: o.storageState ? 'saved-state' : 'fresh',
    };
    try {
      await lab.openContext(o.device, o.storageState, o.init);
      lab.unwatch = await o.watch?.(lab.page!, o.device.viewport);
    } catch (err) {
      await lab.close('context failed');
      throw LabError.from(err);
    }
    return lab;
  }

  /** Isolated contexts: open a path on the app's origin, wait for it to settle, and observe it. */
  async load(path: string, describe: string): Promise<{ observation: Observation; settle: SettleReport }> {
    this.requireActive();
    const url = this.origin + path;
    assertUrlAllowed(url, this.profile!.allowExternalUrl);
    const since = Date.now();
    appendStep(this.history, describe);
    const response = await this.page!.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (response && response.status() >= 400) throw new LabError('action_failed', `GET ${path} returned HTTP ${response.status()}`, { hint: 'Check the scenario\'s route.' });
    await this.onActed?.();
    const settle = await this.settle(since);
    return { observation: await this.snapshot(), settle };
  }

  /** The page being observed, for the checks engine (never exposed to agents). */
  get activePage(): Page | undefined {
    return this.page;
  }

  /** Steps from the start of this Lab's history, as recorded for reproduction. */
  get steps(): readonly string[] {
    return this.history;
  }

  async observe(opts: { limit?: number } = {}): Promise<Observation> {
    this.requireActive();
    this.admit('observe', 'observe');
    return this.busy('observe', async () => {
      const observation = await this.snapshot(opts.limit);
      this.control.observed();
      this.record('observe', { gen: observation.gen, route: observation.route, controls: observation.controls.length });
      this.emit({ kind: 'observe', observation });
      return observation;
    });
  }

  /** Run a session operation as the one in flight, so a pause or takeover takes effect when it ends. */
  private async busy<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.child) return fn();
    this.control.begin(label);
    try {
      return await fn();
    } finally {
      this.control.end();
    }
  }

  /** For scans and sweeps between units of work: why to stop now, if a person asked. */
  private interruption(): Interruption | undefined {
    if (!this.control.shouldInterrupt()) return undefined;
    const s = this.control.state;
    const reason = s.mode === 'stopping' || s.mode === 'stopped' ? 'stopped' : s.pending === 'human' ? 'takeover' : 'paused';
    return { reason, ...(s.by ? { by: s.by } : {}) };
  }

  async act(request: ActionRequest): Promise<ActionResult> {
    this.requireActive();
    if (!this.child) this.admit(request.action, 'act');
    return this.busy(request.action, () => this.actNow(request));
  }

  private async actNow(request: ActionRequest): Promise<ActionResult> {
    const t0 = Date.now();
    const consoleMark = this.consoleTotal;
    const failedMark = this.failedTotal;
    const before = this.last;
    const target: ControlSummary | undefined = request.ref ? before?.controls.find((c) => c.ref === request.ref) : undefined;
    const notes: string[] = [];
    let method: string | undefined;
    let result: ActionResult;
    this.actionPanX = 0;
    this.prePanFrame = undefined;
    this.fillSecret = false;
    this.tabEvents = { opened: [], closed: [] };
    const tabBefore = this.activeTab;
    const head = { schemaVersion: SCHEMA_VERSION, action: request.action, ...(request.ref ? { ref: request.ref } : {}),
      ...(target ? { target: { ref: target.ref, role: target.role, name: target.name } } : {}) } as const;

    try {
      validateAction(request);
      method = await this.perform(request, notes);
      // The active tab closed itself: wait for the switch to its opener before settling.
      for (let i = 0; i < 40 && this.page?.isClosed() && this.tabs.size; i++) await new Promise((r) => setTimeout(r, 25));
      appendStep(this.history, describeAction(request, target, before, this.fillSecret));
      await this.onActed?.().catch(() => undefined);
      let settle = await this.settle(t0, before ? pathOf(before.url) : undefined);
      await this.awaitRequestedTab(t0);
      if (await this.followNewTab(notes)) settle = await this.settle(Date.now());
      const observation = await this.snapshot();
      const changes = diffObservations(before, observation);
      if (this.activeTab !== tabBefore) {
        changes.reset = { reason: 'tab' };
        changes.route = before ? { from: before.route, to: observation.route } : undefined;
      }
      if (this.tabEvents.opened.length || this.tabEvents.closed.length || this.activeTab !== tabBefore) {
        changes.tabs = { opened: [...this.tabEvents.opened], closed: [...this.tabEvents.closed],
          ...(this.activeTab !== tabBefore ? { active: { from: tabBefore, to: this.activeTab } } : {}) };
        changes.none = false;
      }
      for (const r of changes.rerendered) this.replacedBy.set(r.from, r.to);
      const newFindings = [...this.lastFreshFindings];
      if (this.actionPanX && request.ref) {
        // Recorded against the page the control was on, even if the action then navigated away.
        const where = before ?? observation;
        const control = where.controls.find((c) => c.ref === request.ref);
        const pan = this.findings.recordHorizontalPan(where, control, {
          role: target?.role ?? control?.role ?? 'control', name: target?.name ?? control?.name ?? request.ref, ref: request.ref,
        }, Math.abs(this.actionPanX), this.history);
        if (pan) {
          newFindings.push(pan);
          const frame = this.saveFrame(this.prePanFrame, `g${observation.gen}-before-pan`);
          if (frame) pan.frame = frame;
          this.emit({ kind: 'findings', findings: [pan], frame });
        }
        observation.findings = this.findings.size;
        this.saveFindings();
      }
      result = {
        ...head, outcome: 'success', method, elapsedMs: Date.now() - t0, settle,
        navigated: changes.reset?.reason === 'navigation', notes, changes,
        newConsoleErrors: since(this.consoleErrors, this.consoleTotal, consoleMark),
        newFailedRequests: since(this.failedRequests, this.failedTotal, failedMark),
        newFindings,
        observation,
      };
    } catch (err) {
      // Stopped underneath the action (an emergency stop, or the browser went away): say so plainly.
      const error = this.endedReason ? new LabError('browser_closed', `Session ended during the action: ${this.endedReason}`, { hint: 'Nothing more can run in this session.' }) : LabError.from(err);
      result = {
        ...head, outcome: 'error', error: error.toJSON(), ...(method ? { method } : {}), elapsedMs: Date.now() - t0,
        navigated: false, notes,
        newConsoleErrors: since(this.consoleErrors, this.consoleTotal, consoleMark),
        newFailedRequests: since(this.failedRequests, this.failedTotal, failedMark),
        newFindings: [],
      };
    }
    if (!this.child) this.log.agent({ request, before, result, secret: this.fillSecret });
    this.record('act', {
      request: loggedRequest(request, this.fillSecret),
      outcome: result.outcome, error: result.error?.code, elapsedMs: result.elapsedMs, notes: result.notes,
      route: result.observation?.route, settle: result.settle, newFindings: result.newFindings.map((f) => f.id),
    });
    this.emit({ kind: 'act', request: this.fillSecret && request.key ? { ...request, key: SECRET_MASK } : request, result });
    return result;
  }

  /** Resolve a role/name query to a ref in the latest observation. Never guesses between candidates. */
  findRef(query: TargetQuery): string {
    this.requireActive();
    const controls = this.last?.controls ?? [];
    const byRole = controls.filter((c) => !query.role || c.role === query.role);
    let matches = byRole.filter((c) =>
      (query.name === undefined || c.name === query.name) &&
      (query.nameContains === undefined || c.name.includes(query.nameContains)));
    if (!matches.length && query.name !== undefined) {
      matches = byRole.filter((c) => c.name.toLowerCase() === query.name!.toLowerCase());
    }
    const describe = `${query.role ?? 'control'} ${query.name !== undefined ? `"${query.name}"` : `containing "${query.nameContains}"`}`;
    if (matches.length === 1) return matches[0]!.ref;
    if (matches.length > 1) {
      throw new LabError('ambiguous_target', `${matches.length} controls match ${describe}`, {
        details: { candidates: matches.map((c) => ({ ref: c.ref, role: c.role, name: c.name })) },
        hint: 'Use a ref, or a more specific name.',
      });
    }
    throw new LabError('not_found', `No visible ${describe} in observation gen ${this.last?.gen ?? 0}`, {
      details: { sameRole: byRole.slice(0, 8).map((c) => `${c.ref} ${c.role} "${c.name}"`) },
      hint: this.last?.dialog ? `A dialog ("${this.last.dialog}") is open; only its controls are actionable.` : 'Observe again after the UI changes.',
    });
  }

  /** Session findings: all of them, one by id, or those concerning a control ref. */
  inspect(query: InspectQuery = {}): InspectResult {
    this.requireSession();
    const all = this.findings.list();
    if (query.id !== undefined) {
      const finding = this.findings.get(query.id);
      if (!finding) {
        throw new LabError('not_found', `No finding ${query.id} in this session`, { hint: all.length ? `Known: ${all.map((f) => f.id).join(', ')}` : 'No findings recorded yet.' });
      }
      return { findings: [finding] };
    }
    if (query.ref !== undefined) {
      const control = this.last?.controls.find((c) => c.ref === query.ref);
      if (!control) {
        throw new LabError(this.refDocs.has(query.ref) ? 'stale_ref' : 'unknown_ref', `${query.ref} is not in the latest observation`, { hint: 'Observe again and use a current ref.' });
      }
      const route = this.last!.route;
      const device = this.session!.device.id;
      return { control, findings: all.filter((f) => f.device === device && f.route === route && f.target?.role === control.role && f.target.name === control.name) };
    }
    return { findings: all, ...(this.findings.omitted ? { omitted: this.findings.omitted } : {}) };
  }

  /** Open tabs, in the order they were opened. */
  listTabs(): TabInfo[] {
    this.requireActive();
    return [...this.tabs].map(([id, page]) => ({
      id, url: stripQuery(page.url()), title: '', active: id === this.activeTab,
      ...(this.openers.has(id) ? { opener: this.openers.get(id)! } : {}),
    }));
  }

  /** Tabs with their titles (reads each page, so async). */
  async tabList(): Promise<TabInfo[]> {
    const tabs = this.listTabs();
    for (const t of tabs) t.title = (await this.tabs.get(t.id)!.title().catch(() => '')).slice(0, 80);
    return tabs;
  }

  /**
   * Save the session's cookies and localStorage so later sessions can start signed in. The state is
   * written owner-only and never returned; the result only counts what was saved.
   */
  async saveAuth(): Promise<AuthSaveResult> {
    this.requireActive();
    this.admit('auth_save', 'act');
    const state = await this.context!.storageState() as StoredState;
    const saved = saveAuthState(this.profile!.auth, this.profile!.root, state);
    this.record('auth-save', { cookies: saved.cookies, origins: saved.origins });
    this.emit({ kind: 'auth', action: 'saved', cookies: saved.cookies, origins: saved.origins });
    return { saved: true, cookies: saved.cookies, origins: saved.origins, file: relative(this.profile!.root, saved.file) || saved.file };
  }

  /**
   * Stream JPEG frames of the visible viewport of the active tab until the returned stop function is
   * called or the session ends. At most maxFps frames are delivered, and acknowledgements are delayed
   * so Chromium also captures fewer. Frames go only to `onFrame`, never into command results.
   */
  async screencast(onFrame: (jpeg: Buffer) => void, opts: ScreencastOptions): Promise<() => Promise<void>> {
    this.requireActive();
    const cast: NonNullable<Lab['cast']> = { onFrame, opts, stopped: false };
    const previous = this.cast;
    this.cast = cast;
    await previous?.stop?.();
    cast.stop = await this.castPage(this.page!, cast);
    return async () => {
      if (cast.stopped) return;
      cast.stopped = true;
      if (this.cast === cast) this.cast = undefined;
      await cast.stop?.();
    };
  }

  /**
   * The live viewport follows a sweep's or scan's page while it is measured, so a person watching sees
   * each width, then returns to the session's page. Frames still go only to the viewer. A page measured
   * faster than a person can take in stays on screen for WATCH_MIN_MS after its last change; nothing waits without a viewer.
   */
  private readonly watchPage: WatchPage = async (page, viewport) => {
    const cast = this.cast;
    if (!cast || cast.stopped) return async () => undefined;
    clearTimeout(this.unwatchTimer);
    // The previous picture stays until this page has loaded: a blank page tells a person nothing.
    let loaded = false;
    page.once('load', () => { loaded = true; });
    await cast.stop?.();
    cast.stop = await this.castPage(page, cast, viewport, () => loaded).catch(() => undefined);
    cast.lastFrameAt = Date.now();
    return async () => {
      if (this.cast !== cast || cast.stopped) return;
      // Counted from the last change on screen, so a page that rendered late is still seen.
      await new Promise((r) => setTimeout(r, 1000 / cast.opts.maxFps));
      const hold = WATCH_MIN_MS - (Date.now() - (cast.lastFrameAt ?? 0));
      if (hold > 0) await new Promise((r) => setTimeout(r, hold));
      if (this.cast !== cast || cast.stopped) return;
      await cast.stop?.();
      cast.stop = undefined;
      // The next width usually follows at once; going back to the session's page in between would flicker.
      clearTimeout(this.unwatchTimer);
      this.unwatchTimer = setTimeout(() => {
        if (this.cast !== cast || cast.stopped || cast.stop || !this.active || !this.page) return;
        void this.castPage(this.page, cast).then((stop) => { if (cast.stop || cast.stopped) void stop(); else cast.stop = stop; }).catch(() => undefined);
      }, WATCH_RETURN_MS);
    };
  };

  private async castPage(page: Page, cast: NonNullable<Lab['cast']>, vp = this.session!.device.viewport, ready: () => boolean = () => true): Promise<() => Promise<void>> {
    const { opts } = cast;
    const scale = Math.min(1, opts.maxWidth / vp.width);
    const size = { width: Math.round(vp.width * scale), height: Math.round(vp.height * scale) };
    const interval = 1000 / opts.maxFps;
    let stopped = false;
    let wake: (() => void) | undefined;
    let lastSent = 0;
    let latest: Buffer | undefined;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      trailing = undefined;
      if (stopped || cast.stopped || !latest) return;
      const frame = latest;
      latest = undefined;
      lastSent = Date.now();
      cast.lastFrameAt = lastSent;
      cast.onFrame(frame);
    };
    await page.screencast.start({
      size, quality: opts.quality,
      onFrame: async ({ data }) => {
        // A page that has not loaded anything yet (a sweep width just opened) has nothing to show.
        if (stopped || page.url() === 'about:blank' || !ready()) return;
        // Hard cap: at most one frame per interval. A frame arriving early replaces the pending one and
        // goes out when the interval allows, so the last state after a change is always shown.
        latest = data;
        const wait = lastSent + interval - Date.now();
        if (wait <= 0 && !trailing) send();
        else trailing ??= setTimeout(send, Math.max(0, wait));
        // Back-pressure: Playwright acknowledges the frame, and Chromium captures more, only when this
        // resolves. Chromium keeps a few frames in flight, so this slows capture but is not the cap.
        await new Promise<void>((r) => { wake = r; setTimeout(r, interval); });
      },
    });
    return async () => {
      if (stopped) return;
      // The last state is always shown, even when the stream moves on within the frame interval.
      if (trailing) clearTimeout(trailing);
      send();
      stopped = true;
      wake?.();
      await page.screencast.stop().catch(() => undefined);
    };
  }

  /**
   * Responsive sweep of one route (default: the current one) across device widths, serially, each in
   * its own browser context carrying the session's cookies and storage. The session's page is untouched.
   */
  async sweep(opts: { route?: string; devices?: readonly string[] } = {}): Promise<SweepResult> {
    this.requireActive();
    this.admit('sweep', 'act');
    return this.busy('sweep', () => this.sweepNow(opts));
  }

  private async sweepNow(opts: { route?: string; devices?: readonly string[] }): Promise<SweepResult> {
    const route = opts.route ?? this.rawRoute ?? this.last?.route ?? '/';
    for (const d of opts.devices ?? []) getDevice(d, this.profile?.devices);
    const result = await runSweep({
      browser: this.browser!, storageState: await this.context!.storageState(), origin: this.origin,
      sessionId: this.session!.id, gen: this.gen, settle: this.settlePolicy, store: this.findings,
      history: this.history, runDir: this.session!.runDir, emit: (e) => this.emit(e), devices: this.profile?.devices,
      detectors: { tapTargets: this.profile!.scan.tapTargets, layoutShiftMin: this.profile!.scan.layoutShiftMin, enabled: checkFilter(this.profile!.scan.checks) },
      checkpoint: () => this.interruption(), watch: this.watchPage,
    }, { id: `S${++this.sweeps}`, route, devices: opts.devices ?? SWEEP_DEVICES });
    this.saveFindings();
    this.record('sweep', { id: result.id, route: result.route, ms: result.ms, devices: result.devices.map((d) => ({ device: d.device, status: d.status, findings: d.findings })), report: result.report });
    return result;
  }

  /**
   * Stateful responsive scan: each declared scenario (or one route as loaded) on each of its devices,
   * in its own isolated context on this session's browser, with optional safe exploration. The
   * session's page is untouched. Writes result.json and report.html under runs/<session>/scans/<id>/.
   */
  async scan(opts: { scenarios?: readonly string[]; devices?: readonly string[]; explore?: boolean; route?: string; today?: string } = {}): Promise<ScanResult> {
    this.requireActive();
    this.admit('scan', 'act');
    return this.busy('scan', () => this.scanNow(opts));
  }

  private async scanNow(opts: { scenarios?: readonly string[]; devices?: readonly string[]; explore?: boolean; route?: string; today?: string }): Promise<ScanResult> {
    for (const d of opts.devices ?? []) getDevice(d, this.profile?.devices);
    const profile = this.profile!;
    const result = await runScan({
      browser: this.browser!, profile, headed: this.session!.browser.headed, sessionId: this.session!.id,
      sessionState: () => this.context!.storageState(),
      savedState: () => (this.memoryAuth ?? loadAuthState(profile.auth)) as BrowserContextOptions['storageState'],
      sessionHistory: this.history, gen: () => this.gen, store: this.findings, runDir: this.session!.runDir, emit: (e) => this.emit(e),
      checkpoint: () => this.interruption(), watch: this.watchPage,
    }, { id: `R${++this.scans}`, ...opts });
    this.saveFindings();
    this.record('scan', {
      id: result.id, ms: result.ms, verdict: result.verdict.result,
      runs: result.runs.map((r) => ({ scenario: r.scenario, device: r.device, status: r.status, failedAt: r.failedAt, states: r.states.length, findings: r.findings })),
      report: result.reports.html,
    });
    return result;
  }

  /**
   * Every value this session must never write: what was typed into password-like fields, the project's
   * required and secret-named environment values, and the values of an in-memory sign-in state. For redaction
   * sets only; nothing returns it to a command result.
   */
  secretValues(): string[] {
    return [...new Set([...this.log.secretValues(), ...(this.profile ? envSecrets(this.profile) : []), ...(this.memoryAuth ? authStateSecrets(this.memoryAuth) : [])])];
  }

  /** Identity of the application's owned server process group, for crash-recovery records. */
  serverIdentity(): ProcessIdentity | undefined {
    const primary = this.services?.get(this.profile?.app.service);
    return primary?.info.owned ? primary.identity : undefined;
  }

  /** Per-service ownership and identity, so `agentlab stop` can clean up after the daemon dies. */
  serviceRecords(): ServiceRecord[] {
    this.services?.refreshMembers();
    return (this.services?.services ?? []).map((s) => ({
      name: s.spec.name, ...(s.info.url ? { url: s.info.url } : {}), owned: s.info.owned, mode: s.spec.mode,
      ...(s.info.pid !== undefined ? { pid: s.info.pid } : {}), ...(s.identity ? { identity: s.identity } : {}),
      ...(s.members.length ? { members: [...s.members] } : {}),
      ...(s.info.owned && s.spec.shutdown.command ? { stopCommand: s.spec.shutdown.command, cwd: s.spec.cwd } : {}),
    }));
  }

  get lastObservation(): Observation | undefined {
    return this.last;
  }

  status() {
    const primary = this.services?.get(this.profile?.app.service);
    return {
      active: this.active,
      ...(this.endedReason ? { endedReason: this.endedReason } : {}),
      session: this.session,
      server: primary ? serverInfo(primary.info) : this.profile && this.session ? { url: this.profile.app.url, owned: false, reused: true, readyMs: 0 } : undefined,
      services: this.services?.infos() ?? [],
      tabs: this.active ? this.listTabs() : [],
      gen: this.last?.gen ?? 0,
      route: this.last?.route,
    };
  }

  /** Close the browser and stop the services the lab started (dependents first). Idempotent. */
  close(reason = 'requested'): Promise<CloseResult> {
    this.closing ??= (async () => {
      let browserClosed = false;
      clearTimeout(this.unwatchTimer);
      await this.cast?.stop?.().catch(() => undefined);
      // A trace that was never saved is discarded, never written.
      if (this.tracing) { this.tracing = false; await this.context?.tracing.stop().catch(() => undefined); }
      if (this.child) {
        // An isolated context: the browser and every service belong to the session.
        await this.unwatch?.().catch(() => undefined);
        await this.context?.close().catch(() => undefined);
        this.endedReason ??= reason;
        return { reason, browserClosed: false, server: { owned: false, stopped: false, detail: 'isolated context; the session owns the server' }, services: [] };
      }
      this.startAbort.abort();
      if (this.starting && reason !== 'start failed') await this.starting.catch(() => undefined);
      try {
        await this.context?.close();
        await this.browser?.close();
        browserClosed = !!this.browser;
      } catch { /* browser already gone */ }
      const services = this.services ? await this.services.stop() : [];
      if (this.ownedId) {
        releaseOwnership(this.opts.stateDir, this.ownedId);
        this.ownedId = undefined;
      }
      const primary = services.find((s) => s.name === this.profile?.app.service);
      const server = primary
        ? { owned: primary.owned, stopped: primary.stopped, detail: primary.detail }
        : { owned: false, stopped: false, detail: this.services ? 'the app URL is not a declared service; left running' : 'no server' };
      const result: CloseResult = { reason, browserClosed, server, services };
      this.endedReason ??= reason;
      this.record('close', result);
      this.emit({ kind: 'closed', result });
      return result;
    })();
    return this.closing;
  }

  // ---------- failure bundles ----------

  private async startTrace(): Promise<void> {
    await this.context!.tracing.start({ screenshots: true, snapshots: true });
    this.tracing = true;
  }

  /**
   * Stop the trace, write a sanitized copy to `dest` and delete the raw one, always. When the sanitizer cannot
   * prove the trace clean (`trace_unsanitizable`) nothing is written and the reason is returned instead.
   * Tracing then starts again, so each saved trace covers the time since the previous one.
   */
  async saveTrace(dest: string): Promise<{ path: string } | { dropped: string }> {
    this.requireActive();
    if (!this.tracing) throw new LabError('invalid_request', 'This session is not recording a trace', { hint: 'Start it with trace: true.' });
    const raw = join(this.session!.runDir, `.trace-raw-${randomBytes(4).toString('hex')}.zip`);
    try {
      await this.context!.tracing.stop({ path: raw });
      this.tracing = false;
      await sanitizeTrace(raw, dest, { secrets: this.secretValues() });
      return { path: dest };
    } catch (err) {
      const error = LabError.from(err);
      if (error.code === 'trace_unsanitizable') return { dropped: error.message };
      throw error;
    } finally {
      rmSync(raw, { force: true });
      if (this.active && !this.tracing) await this.startTrace().catch(() => undefined);
    }
  }

  /**
   * Collect a failure bundle: the structured action log, recent observations, findings, console and network
   * failures, evidence frames and (when recording) a sanitized trace, written owner-only under
   * `<stateDir>/bundles` (or `dir`). Returns where it is and what it holds, never its contents.
   */
  async bundle(opts: { reason: string; failure?: BundleFailure; dir?: string; trace?: boolean; scenario?: { name: string; device: string } }): Promise<BundleResult> {
    this.requireSession();
    if (this.child) throw new LabError('invalid_request', 'A bundle is written from the session, not from a scenario context');
    const session = this.session!;
    const dir = resolve(opts.dir ?? join(this.opts.stateDir, 'bundles'));
    if (this.active) this.saveFrame(await this.captureFrame(), `bundle-g${this.gen}`);
    let trace: { file: string } | { dropped: string } | undefined;
    const staged = join(session.runDir, `.trace-${randomBytes(4).toString('hex')}.zip`);
    try {
      if (this.tracing && this.active && opts.trace !== false) {
        const saved = await this.saveTrace(staged);
        trace = 'path' in saved ? { file: saved.path } : saved;
      }
      const failure = opts.failure ?? { kind: 'manual' as const };
      const scenario = opts.scenario ?? (failure.kind === 'scenario-error' ? { name: failure.scenario, device: failure.device } : undefined);
      return writeBundle({
        reason: opts.reason, failure, profile: this.profile!, session, startRoute: this.log.startRoute, ...(scenario ? { scenario } : {}),
        route: this.last?.route ?? '/', actions: this.log.actions, actionsOmitted: this.log.actionsOmitted, observations: this.log.observations,
        findings: this.findings.list(), consoleErrors: this.consoleErrors, failedRequests: this.failedRequests, runDir: session.runDir,
        secrets: this.secretValues(), ...(trace ? { trace } : {}),
      }, dir);
    } finally {
      rmSync(staged, { force: true });
    }
  }

  // ---------- supervision ----------

  /**
   * Refuse an agent command that may not run now (paused, a person in control, stopped, or a fresh
   * observe needed). The refusal is shown on the dashboard's timeline; nothing is queued.
   */
  admit(command: string, kind: CommandKind): void {
    if (this.child || !this.session) return;
    try {
      this.control.admit(command, kind);
    } catch (err) {
      const error = LabError.from(err);
      this.record('refused', { command, code: error.code });
      this.emit({ kind: 'refused', command, error: error.toJSON() });
      throw error;
    }
  }

  /**
   * A person's request from the dashboard: pause, resume, take over, return control, stop, or emergency
   * stop. Stop closes the session once the operation in flight finishes; emergency stop closes it at once
   * (the operation in flight fails with browser_closed). Both stop only services the lab started.
   */
  supervise(op: ControlOp, by = 'dashboard'): ReturnType<Supervisor['request']> {
    if (!CONTROL_OPS.includes(op)) throw new LabError('invalid_request', `Unknown control request "${String(op).slice(0, 40)}"`, { hint: `One of: ${CONTROL_OPS.join(', ')}` });
    this.requireActive();
    return this.control.request(op, by);
  }

  private onControl(change: ControlChange): void {
    if (this.child) return;
    const s = change.state;
    // Control is back with the agent after a person used the page: every earlier ref is stale.
    if (s.mode === 'agent' && s.observeRequired && (change.op === 'return' || change.op === 'resume')) { this.refFloor = this.nextRef; this.refsSinceFloor.clear(); }
    this.emit({ kind: 'control', change });
    if (s.mode === 'agent' && (change.op === 'return' || change.op === 'resume')) this.flushHumanTyping();
    if (s.mode === 'stopped' && this.active) {
      const reason = stopReason(change.op === 'emergency-stop' ? 'emergency-stop' : 'stop', s.by);
      // Marked ended before the browser goes, so the operation in flight reports browser_closed (not a generic failure).
      this.endedReason = reason;
      void this.close(reason);
    }
  }

  /**
   * Control is going back to the agent: ask every page to report typing it still holds (it would otherwise
   * be described only after a 700 ms pause, and be lost). Those reports arrive after the mode changed, so
   * for one second a report that carries the flush marker is still accepted, labelled as late.
   */
  private flushHumanTyping(): void {
    this.humanGraceUntil = Date.now() + 1000;
    for (const page of this.context?.pages() ?? []) {
      void page.evaluate(() => (window as unknown as { __agentDeviceLabHumanFlush?: () => void }).__agentDeviceLabHumanFlush?.()).catch(() => undefined);
    }
  }

  /** A report from the in-page recorder (page-supplied, so only the expected shape is kept). */
  private onHuman(info: unknown): void {
    if (!this.active) return;
    const h = (info ?? {}) as Record<string, unknown>;
    // Typing flushed at the hand-back arrives just after the mode changed; nothing else is accepted then.
    const late = !this.control.recordingHuman && h.type === 'type' && h.flushed === true && Date.now() <= this.humanGraceUntil;
    if (!this.control.recordingHuman && !late) return;
    const types: HumanAction['type'][] = ['tap', 'type', 'key', 'select', 'check', 'upload', 'submit', 'navigate'];
    if (!types.includes(h.type as HumanAction['type'])) return;
    const str = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : undefined);
    const t = h.target as Record<string, unknown> | undefined;
    const action: HumanAction = {
      type: h.type as HumanAction['type'],
      ...(t && typeof t === 'object' ? { target: { role: str(t.role, 30) ?? 'element', name: str(t.name, 60) ?? '' } } : {}),
      ...(h.secret === true ? { secret: true } : typeof h.chars === 'number' && Number.isFinite(h.chars) ? { chars: Math.max(0, Math.floor(h.chars)) } : {}),
      ...(str(h.detail, 80) ? { detail: str(h.detail, 80) } : {}),
      ...(late ? { late: true } : {}),
    };
    this.control.humanInteraction();
    const now = Date.now();
    const w = this.humanWindow;
    if (now - w.start >= 1000) {
      if (w.dropped) this.emit({ kind: 'human', action: { type: 'input-dropped', detail: `${w.dropped} more interaction(s) not listed` } });
      this.humanWindow = { start: now, count: 0, dropped: 0 };
    }
    if (++this.humanWindow.count > HUMAN_EVENTS_PER_SECOND) { this.humanWindow.dropped++; return; }
    appendStep(this.history, `a person ${formatHuman(action)}`);
    this.record('human', action);
    this.log.person(formatHuman(action));
    this.emit({ kind: 'human', action });
  }

  /**
   * Input a person sends from the dashboard while they have taken control: a tap at a point of the
   * viewport frame, a named key, text typed into the focused field, or a scroll. The recorder reports
   * what it did; the text itself is never recorded.
   */
  async humanInput(input: HumanInput): Promise<void> {
    this.requireActive();
    if (this.control.mode !== 'human') {
      throw new LabError('invalid_control', 'Dashboard input is accepted only while a person has taken control', { hint: 'Take over first.' });
    }
    const page = this.page!;
    const i = (input ?? {}) as Record<string, unknown>;
    const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    switch (i.type) {
      case 'tap': {
        if (!finite(i.x) || !finite(i.y) || i.x < 0 || i.x > 1 || i.y < 0 || i.y > 1) throw new LabError('invalid_request', 'tap needs x and y between 0 and 1');
        // The frame is the visual viewport; input coordinates are visual-viewport CSS px times its scale.
        const vv = await page.evaluate(() => {
          const v = window.visualViewport;
          return v ? { w: v.width * v.scale, h: v.height * v.scale } : { w: window.innerWidth, h: window.innerHeight };
        });
        const x = i.x * vv.w;
        const y = i.y * vv.h;
        if (this.session!.device.hasTouch) await page.touchscreen.tap(x, y);
        else await page.mouse.click(x, y);
        return;
      }
      case 'key':
        if (typeof i.key !== 'string' || !HUMAN_KEYS.includes(i.key)) throw new LabError('invalid_request', `key must be one of ${HUMAN_KEYS.join(', ')}`);
        await page.keyboard.press(i.key === 'Space' ? ' ' : i.key);
        return;
      case 'text':
        if (typeof i.text !== 'string' || !i.text.length || i.text.length > HUMAN_TEXT_MAX) throw new LabError('invalid_request', `text must be 1–${HUMAN_TEXT_MAX} characters`);
        await page.keyboard.insertText(i.text);
        return;
      case 'scroll':
        if (!finite(i.dy) || Math.abs(i.dy) > HUMAN_SCROLL_MAX) throw new LabError('invalid_request', `scroll needs dy within ±${HUMAN_SCROLL_MAX}`);
        await page.mouse.wheel(0, i.dy);
        return;
      default:
        throw new LabError('invalid_request', 'input type must be tap, key, text or scroll');
    }
  }

  // ---------- internals ----------

  private async ended(reason: string): Promise<void> {
    if (this.closing) return;
    this.endedReason = reason;
    await this.close(reason);
  }

  private requireSession(): void {
    if (!this.session) throw new LabError('no_session', 'No session is running', { hint: 'Start one first.' });
  }

  private requireActive(): void {
    if (!this.session) throw new LabError('no_session', 'No session is running', { hint: 'Start one first.' });
    if (this.endedReason) throw new LabError('browser_closed', `Session ended: ${this.endedReason}`, { hint: 'Start a new session.' });
  }

  private registerTab(page: Page, opener?: string): string {
    const id = `t${this.nextTab++}`;
    this.tabs.set(id, page);
    this.tabIds.set(page, id);
    if (opener) this.openers.set(id, opener);
    this.attachListeners(page);
    void this.watchBodies(page);
    page.on('close', () => void this.tabClosed(id));
    return id;
  }

  /** Body activity per request from CDP, which Playwright does not expose (see bodyActivity). */
  private async watchBodies(page: Page): Promise<void> {
    const cdp = await this.cdpFor(page).catch(() => undefined);
    if (!cdp) return;
    const open = new Map<string, string>();
    const touch = (e: { requestId: string }) => { const k = open.get(e.requestId); if (k) this.bodyActivity.set(k, Date.now()); };
    const done = (e: { requestId: string }) => {
      const k = open.get(e.requestId);
      open.delete(e.requestId);
      if (k && ![...open.values()].includes(k)) this.bodyActivity.delete(k);
    };
    cdp.on('Network.requestWillBeSent', (e) => open.set(e.requestId, `${e.request.method} ${e.request.url}`));
    cdp.on('Network.responseReceived', touch);
    cdp.on('Network.dataReceived', touch);
    cdp.on('Network.loadingFinished', done);
    cdp.on('Network.loadingFailed', done);
    await cdp.send('Network.enable').catch(() => undefined);
  }

  /** A tab closed (by the app, the person, or close_tab). The session ends only when the last one goes. */
  private async tabClosed(id: string): Promise<void> {
    if (!this.tabs.has(id) || this.closing) return;
    this.tabs.delete(id);
    this.tabEvents.closed.push(id);
    if (!this.tabs.size) {
      // A killed or crashed browser closes its pages before it reports the disconnect: tell the two apart.
      for (let i = 0; i < 20 && this.browser?.isConnected(); i++) await new Promise((r) => setTimeout(r, 25));
      return this.ended(this.browser?.isConnected() === false ? 'browser disconnected or crashed' : 'browser page was closed');
    }
    if (id === this.activeTab) {
      const opener = this.openers.get(id);
      const next = opener && this.tabs.has(opener) ? opener : [...this.tabs.keys()].at(-1)!;
      await this.activate(next);
    }
  }

  private async activate(id: string): Promise<void> {
    const page = this.tabs.get(id);
    if (!page) throw new LabError('unknown_tab', `No open tab ${id}`, { hint: `Open tabs: ${[...this.tabs.keys()].join(', ')}` });
    this.activeTab = id;
    this.page = page;
    if (this.session?.browser.headed) await page.bringToFront().catch(() => undefined);
    this.emit({ kind: 'page', url: stripQuery(page.url()) });
    const cast = this.cast;
    if (cast && !cast.stopped) {
      await cast.stop?.();
      cast.stop = await this.castPage(page, cast).catch(() => undefined);
    }
  }

  /**
   * The page asked for a new window during the action (a link or form with a target, `window.open`) but the
   * browser has not delivered the tab yet: wait for it, bounded, so the result reports the tab it opened.
   */
  private async awaitRequestedTab(since: number): Promise<void> {
    if (this.tabEvents.opened.length || !this.page || this.page.isClosed()) return;
    const at = await this.page.evaluate(() => (window as unknown as { __agentDeviceLab_nav?: { windowAt: number } }).__agentDeviceLab_nav?.windowAt ?? 0).catch(() => 0);
    if (at < since) return;
    const deadline = Date.now() + Math.min(NEW_TAB_WAIT_MS, this.settlePolicy.maxMs);
    while (!this.tabEvents.opened.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  }

  /** A tab opened by the action becomes the active one, as a mobile browser switches to it. */
  private async followNewTab(notes: string[]): Promise<boolean> {
    const opened = this.tabEvents.opened.filter((id) => this.tabs.has(id));
    const id = opened.at(-1);
    if (!id || id === this.activeTab) return false;
    const page = this.tabs.get(id)!;
    await page.waitForLoadState('domcontentloaded', { timeout: this.settlePolicy.maxMs }).catch(() => undefined);
    await this.activate(id);
    notes.push(`opened tab ${id} (${stripQuery(page.url())}) and switched to it; switch_tab ${this.openers.get(id) ?? 't1'} returns`);
    return true;
  }

  private attachListeners(page: Page): void {
    const counts = () => this.emit({ kind: 'counts', consoleErrors: this.consoleTotal, failedRequests: this.failedTotal });
    page.on('crash', () => { if (page === this.page) void this.ended('browser tab crashed'); });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame() || page !== this.page) return;
      this.emit({ kind: 'page', url: stripQuery(frame.url()) });
      if (this.control.recordingHuman) this.onHuman({ type: 'navigate', detail: pathOf(frame.url()) });
    });
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      this.consoleTotal++;
      pushCapped(this.consoleErrors, { type: 'console.error', text: msg.text().slice(0, 300), at: Date.now() });
      counts();
    });
    page.on('pageerror', (err) => {
      this.consoleTotal++;
      pushCapped(this.consoleErrors, { type: 'pageerror', text: err.message.slice(0, 300), at: Date.now() });
      counts();
    });
    page.on('request', (req) => {
      const type = req.resourceType();
      const url = req.url();
      const background = type === 'eventsource' || type === 'websocket' || this.settlePolicy.backgroundRequests.some((p) => url.includes(p));
      this.requests.set(req, { started: Date.now(), label: `${req.method()} ${pathOf(url)}`, key: `${req.method()} ${url}`, background });
    });
    page.on('requestfinished', (req) => { this.requests.delete(req); });
    page.on('requestfailed', (req) => {
      this.requests.delete(req);
      const failure = req.failure()?.errorText ?? 'failed';
      // Requests cancelled by a navigation are routine, not failures.
      if (failure.includes('ERR_ABORTED')) return;
      this.failedTotal++;
      pushCapped(this.failedRequests, { method: req.method(), url: stripQuery(req.url()), failure, at: Date.now() });
      counts();
    });
    page.on('response', (res) => {
      const entry = this.requests.get(res.request());
      if (entry) entry.responded = true;
      if (res.status() >= 400) {
        this.failedTotal++;
        pushCapped(this.failedRequests, { method: res.request().method(), url: stripQuery(res.url()), status: res.status(), at: Date.now() });
        counts();
      }
    });
  }

  private async snapshot(limit = OBSERVE_LIMIT): Promise<Observation> {
    const page = this.page!;
    let raw;
    for (let attempt = 0; ; attempt++) {
      try {
        raw = await page.evaluate(extractPage, { nextRef: this.nextRef, limit });
        break;
      } catch (err) {
        // A navigation can destroy the execution context mid-evaluate; wait for the new document once.
        if (attempt >= 2) throw err;
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      }
    }
    this.nextRef = raw.nextRef;
    // Kept only in memory, for a sweep of "this route": the observation carries the redacted one.
    try { const u = new URL(raw.url); this.rawRoute = u.pathname + u.search + u.hash; } catch { this.rawRoute = undefined; }
    const observation = buildObservation(raw, {
      sessionId: this.session!.id, gen: ++this.gen,
      consoleErrors: this.consoleTotal, failedRequests: this.failedTotal,
    });
    if (this.tabs.size > 1) observation.tab = this.activeTab;
    for (const c of observation.controls) {
      this.refDocs.set(c.ref, observation.docId);
      this.refTabs.set(c.ref, this.activeTab);
      if (this.refFloor) this.refsSinceFloor.add(c.ref);
    }
    this.lastFreshFindings = this.findings.recordObservation(observation, this.history);
    if (this.lastFreshFindings.length) {
      this.saveFindings();
      const frame = this.opts.evidenceFrames ? this.saveFrame(await this.captureFrame(), `g${observation.gen}`) : undefined;
      if (frame) for (const f of this.lastFreshFindings) f.frame = frame;
      this.emit({ kind: 'findings', findings: this.lastFreshFindings, frame });
    }
    observation.findings = this.findings.size;
    this.last = observation;
    if (!this.child) this.log.observation(observation);
    return observation;
  }

  private async resolveRef(ref: string): Promise<ElementHandle<Element>> {
    if (!/^e\d+$/.test(ref)) throw new LabError('invalid_request', `"${ref}" is not a ref (expected e.g. e12)`);
    const issuedIn = this.refDocs.get(ref);
    if (!issuedIn) {
      throw new LabError('unknown_ref', `${ref} was never issued in session ${this.session!.id}`, { hint: 'Use a ref from the latest observation.' });
    }
    if (Number(ref.slice(1)) < this.refFloor && !this.refsSinceFloor.has(ref)) {
      throw new LabError('stale_ref', `${ref} was issued before a person used the browser`, { hint: 'Run observe and use a fresh ref.' });
    }
    const tab = this.refTabs.get(ref);
    if (tab && tab !== this.activeTab) {
      throw new LabError('stale_ref', `${ref} belongs to tab ${tab}, not the active tab ${this.activeTab}`, {
        hint: this.tabs.has(tab) ? `switch_tab ${tab} first, or observe this tab for fresh refs.` : `Tab ${tab} has closed; observe for fresh refs.`,
      });
    }
    const page = this.page!;
    const handle = await page.evaluateHandle(lookupRef, ref);
    const el = handle.asElement();
    if (el) return el;
    await handle.dispose();
    const doc = await page.evaluate(currentDocId);
    const successor = this.replacedBy.get(ref);
    throw new LabError('stale_ref', doc !== issuedIn
      ? `${ref} belonged to a previous page; the browser has navigated since it was issued`
      : `${ref} is no longer attached to the page`, {
      hint: successor && doc === issuedIn ? `The same control was re-rendered as ${successor}.` : 'Run observe and use a fresh ref.',
      ...(successor && doc === issuedIn ? { details: { replacedBy: successor } } : {}),
    });
  }

  private async withRef<T>(ref: string, fn: (handle: ElementHandle<Element>) => Promise<T>): Promise<T> {
    const handle = await this.resolveRef(ref);
    try {
      return await fn(handle);
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  /** Run one action. Returns the input method; throws LabError for recoverable failures. */
  private async perform(r: ActionRequest, notes: string[]): Promise<string> {
    const ref = r.ref!;
    switch (r.action) {
      case 'click': return this.withRef(ref, (h) => this.click(h, notes));
      case 'fill': return this.withRef(ref, (h) => this.fill(h, r.value!, notes));
      case 'press': return this.press(r, notes);
      case 'select': return this.withRef(ref, (h) => this.select(h, r.values!, notes));
      case 'check': case 'uncheck': return this.withRef(ref, (h) => this.setChecked(h, r.action === 'check', notes));
      case 'scroll': return this.scroll(r, notes);
      case 'swipe': return this.swipe(r, notes);
      case 'back': case 'forward': return this.history_(r.action, notes);
      case 'hover': return this.withRef(ref, (h) => this.hover(h, notes));
      case 'upload': return this.upload(ref, r.files!, notes);
      case 'drag': return this.withRef(ref, (h) => this.drag(h, r, notes));
      case 'open_tab': return this.openTab(r.path!, notes);
      case 'switch_tab': return this.switchTab(r.tab!, notes);
      case 'close_tab': return this.closeTab(r.tab, notes);
    }
  }

  /** Visible and enabled, scrolled into view as a person would, and not covered: where input should land. */
  private async reach(handle: ElementHandle<Element>, notes: string[]): Promise<TargetPoint> {
    const state = await handle.evaluate((el) => ({
      visible: el.getBoundingClientRect().width > 0 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
      disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
    }));
    if (!state.visible) throw new LabError('not_visible', 'Target is attached but not visible', { hint: 'Observe again; it may have been hidden.' });
    if (state.disabled) throw new LabError('disabled', 'Target is disabled');

    await this.bringIntoView(handle, notes);
    let point = await this.stablePoint(handle);
    if (!point.hitOk && point.hitFixed) {
      // Partly visible but its centre is under a fixed/sticky bar: scroll on, as a person would.
      const { dx, dy } = await handle.evaluate(centreInView);
      this.actionPanX += dx;
      if (dy) notes.push(`scrolled ${Math.abs(dy)}px more so the target is not under a fixed bar (${point.hit})`);
      point = await this.stablePoint(handle);
    }
    if (!point.inView) {
      throw new LabError('obstructed', 'The target centre is still outside the visible area after panning', { hint: 'Inspect the layout around the control.' });
    }
    if (!point.hitOk) {
      throw new LabError('obstructed', `A pointer at the target's centre lands on ${point.hit ?? 'another element'}, not the target`, {
        details: { hit: point.hit }, hint: 'Something covers the control. Close overlays or dialogs, or inspect the layout.',
      });
    }
    return point;
  }

  /**
   * Physical click/tap with verification: pan the target into the visual viewport as a person would,
   * check what sits under its centre, dispatch input at visual-viewport coordinates, then confirm which
   * element actually received pointerdown and click.
   */
  private async click(handle: ElementHandle<Element>, notes: string[]): Promise<string> {
    const page = this.page!;
    const point = await this.reach(handle, notes);
    const method = this.session!.device.hasTouch ? 'tap' : 'click';
    const token = randomBytes(4).toString('hex');
    this.hits = this.hits.filter((h) => h.token === token);
    await handle.evaluate(armHitCapture, token);
    try {
      if (method === 'tap') await page.touchscreen.tap(point.x, point.y);
      else await page.mouse.click(point.x, point.y);
    } catch (err) {
      if (page.isClosed()) {
        notes.push('the page closed itself in response (e.g. window.close())');
        return method;
      }
      throw new LabError('action_failed', `${method} failed: ${firstLine(err)}`);
    }
    // The synthesised click follows the touch sequence asynchronously; give it a short, bounded window.
    const deadline = Date.now() + 500;
    while (!this.hits.some((h) => h.token === token && h.type === 'click') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const hits = this.hits.filter((h) => h.token === token);
    const down = hits.find((h) => h.type === 'pointerdown');
    const click = hits.find((h) => h.type === 'click');
    const miss = [down, click].find((h) => h && !h.onTarget);
    if (miss) {
      throw new LabError('obstructed', `The ${method} was delivered to ${miss.target}, not the target`, {
        details: { delivered: hits }, hint: 'The event may have triggered that other element. Observe before retrying.',
      });
    }
    if (!down && !click) notes.push('input was dispatched but no pointer event was observed (the page may have navigated immediately)');
    else if (!click) notes.push(`pointerdown reached the target but no click followed within 500ms`);
    return method;
  }

  private async fill(handle: ElementHandle<Element>, value: string, notes: string[]): Promise<string> {
    const f = await handle.evaluate(fillability);
    this.fillSecret = f.secret === true;
    if (!f.fillable) throw new LabError('not_fillable', `Target cannot be filled: ${f.reason ?? 'not a text field'}`);
    if (f.disabled) throw new LabError('disabled', 'Target is disabled');
    await this.bringIntoView(handle, notes);
    try {
      await handle.fill(value, { timeout: ACTION_TIMEOUT_MS });
    } catch (err) {
      throw new LabError('action_failed', `fill failed: ${firstLine(err)}`);
    }
    return 'fill';
  }

  /** A key or chord, on a control (focused first) or on whatever has focus. */
  private async press(r: ActionRequest, notes: string[]): Promise<string> {
    const page = this.page!;
    if (r.ref) {
      await this.withRef(r.ref, async (h) => {
        await this.bringIntoView(h, notes);
        await h.focus();
      });
    }
    // A printable key typed into a password-like field is part of a secret.
    this.fillSecret = !isNamedKey(r.key!) && await page.evaluate(focusedIsSecret).catch(() => false);
    try {
      await page.keyboard.press(r.key!);
    } catch (err) {
      if (/Unknown key/i.test(firstLine(err))) {
        throw new LabError('invalid_request', `Unknown key "${r.key}"`, { hint: 'Use key names such as Enter, Escape, Tab, ArrowDown, Backspace, or chords like Shift+Tab and Control+a.' });
      }
      throw new LabError('action_failed', `press failed: ${firstLine(err)}`);
    }
    return 'keyboard';
  }

  private async select(handle: ElementHandle<Element>, values: string[], notes: string[]): Promise<string> {
    const info = await handle.evaluate(selectInfo);
    if (!info.select) {
      throw new LabError('not_selectable', 'Target is not a native <select>', { hint: 'For a custom list box, click it to open the list, then click the option.' });
    }
    if (info.disabled) throw new LabError('disabled', 'Target is disabled');
    if (values.length > 1 && !info.multiple) throw new LabError('invalid_request', 'This list allows only one choice');
    const chosen = values.map((v) => info.options.find((o) => o.value === v) ?? info.options.find((o) => o.label === v)
      ?? info.options.find((o) => o.label.toLowerCase() === v.toLowerCase()));
    const missing = values.filter((_, i) => !chosen[i]);
    if (missing.length) {
      throw new LabError('not_found', `No option ${missing.map((m) => JSON.stringify(m)).join(', ')} in this list`, {
        details: { options: info.options.slice(0, 20).map((o) => o.label) }, hint: 'Use an option label or value from details.options.',
      });
    }
    const disabled = chosen.find((o) => o!.disabled);
    if (disabled) throw new LabError('disabled', `Option "${disabled.label}" is disabled`);
    await this.bringIntoView(handle, notes);
    try {
      await handle.selectOption(chosen.map((o) => ({ value: o!.value })), { timeout: ACTION_TIMEOUT_MS });
    } catch (err) {
      throw new LabError('action_failed', `select failed: ${firstLine(err)}`);
    }
    return 'select';
  }

  /** check / uncheck through the same verified tap as click, then confirm the state actually changed. */
  private async setChecked(handle: ElementHandle<Element>, want: boolean, notes: string[]): Promise<string> {
    const s = await handle.evaluate(checkability);
    if (!s.kind) throw new LabError('not_checkable', 'Target is not a checkbox, radio button or switch');
    if (s.disabled) throw new LabError('disabled', 'Target is disabled');
    if (!want && s.kind === 'radio') {
      throw new LabError('invalid_request', 'A radio button cannot be unchecked directly', { hint: 'Check another option in the same group.' });
    }
    if (s.checked === want) {
      notes.push(`already ${want ? 'checked' : 'unchecked'}; nothing was done`);
      return 'none';
    }
    const method = await this.click(handle, notes);
    const deadline = Date.now() + 500;
    let now = s.checked;
    while (Date.now() < deadline) {
      now = await handle.evaluate(checkability).then((c) => c.checked).catch(() => want);
      if (now === want) return method;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new LabError('action_failed', `The ${method} reached the control but it is still ${now ? 'checked' : 'unchecked'}`, {
      hint: 'The page may handle it differently (a confirmation, a label elsewhere). Observe to see what changed.',
    });
  }

  private async scroll(r: ActionRequest, notes: string[]): Promise<string> {
    const page = this.page!;
    if (!r.direction) {
      // Bring a control into view, the way a person scrolls until they can see it.
      return this.withRef(r.ref!, async (h) => {
        const { dx, dy } = await h.evaluate(centreInView);
        notes.push(dx || dy ? `scrolled ${dy >= 0 ? 'down' : 'up'} ${Math.abs(dy)}px${dx ? ` and ${Math.abs(dx)}px sideways` : ''} to bring the control into view` : 'the control was already in view; nothing moved');
        return 'scroll';
      });
    }
    const vp = this.session!.device.viewport;
    const vertical = r.direction === 'up' || r.direction === 'down';
    const amount = Math.round(r.amount ?? (vertical ? vp.height : vp.width) * 0.8);
    const sign = r.direction === 'down' || r.direction === 'right' ? 1 : -1;
    const delta = { dx: vertical ? 0 : sign * amount, dy: vertical ? sign * amount : 0 };
    const run = async (el?: ElementHandle<Element>) => page.evaluate(scrollByAmount, { el: el ?? null, ...delta });
    const out = r.ref ? await this.withRef(r.ref, run) : await run();
    const moved = Math.abs(vertical ? out.moved.y : out.moved.x);
    notes.push(out.atEnd
      ? `${out.target} did not move: it is already at the ${r.direction === 'down' ? 'bottom' : r.direction === 'up' ? 'top' : `${r.direction} edge`}`
      : `${out.target} scrolled ${r.direction} ${moved}px${moved < amount ? ` (reached the end; asked for ${amount}px)` : ''}`);
    return 'scroll';
  }

  /** A touch drag across the screen (swipe left = the finger moves left), as real touch input. */
  private async swipe(r: ActionRequest, notes: string[]): Promise<string> {
    const page = this.page!;
    const device = this.session!.device;
    if (!device.hasTouch) {
      throw new LabError('invalid_request', `swipe needs a touch device; ${device.id} has none`, { hint: 'Use scroll, or start with a touch profile such as mobile-390.' });
    }
    const vp = device.viewport;
    let start = { x: vp.width / 2, y: vp.height / 2 };
    if (r.ref) start = await this.withRef(r.ref, (h) => this.reach(h, notes));
    const horizontal = r.direction === 'left' || r.direction === 'right';
    const distance = Math.round(r.amount ?? (horizontal ? vp.width : vp.height) * 0.6);
    const sign = r.direction === 'right' || r.direction === 'down' ? 1 : -1;
    const clamp = (v: number, max: number) => Math.min(max - 4, Math.max(4, v));
    const end = horizontal ? { x: clamp(start.x + sign * distance, vp.width), y: start.y } : { x: start.x, y: clamp(start.y + sign * distance, vp.height) };
    const beforePos = await page.evaluate(scrollPositions);
    const cdp = await this.cdpFor(page);
    const steps = 12;
    const point = (x: number, y: number) => [{ x: Math.round(x), y: Math.round(y), id: 1, radiusX: 4, radiusY: 4, force: 1 }];
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(start.x, start.y) });
      for (let i = 1; i <= steps; i++) {
        await new Promise((res) => setTimeout(res, 16));
        const t = i / steps;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t) });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } catch (err) {
      throw new LabError('action_failed', `swipe failed: ${firstLine(err)}`);
    }
    // A swipe can leave a fling scrolling, and Chromium's gesture recogniser stays busy briefly after
    // the touch ends; a tap in that window only stops the gesture (for a person too). Wait at least
    // 300 ms, and until nothing has moved for 150 ms, bounded at 1.5 s.
    const ended = Date.now();
    await new Promise((res) => setTimeout(res, 300));
    let afterPos = await page.evaluate(scrollPositions).catch(() => beforePos);
    for (let still = 0; still < 3 && Date.now() - ended < 1500;) {
      await new Promise((res) => setTimeout(res, 50));
      const now = await page.evaluate(scrollPositions).catch(() => afterPos);
      still = JSON.stringify(now) === JSON.stringify(afterPos) ? still + 1 : 0;
      afterPos = now;
    }
    const moved = Object.keys(afterPos).filter((k) => afterPos[k] !== beforePos[k]).map((k) => `${k.replace(/\.[xy]$/, '')} ${k.endsWith('.x') ? 'x' : 'y'} ${afterPos[k]! - (beforePos[k] ?? 0) > 0 ? '+' : ''}${afterPos[k]! - (beforePos[k] ?? 0)}px`);
    const travel = Math.round(Math.hypot(end.x - start.x, end.y - start.y));
    notes.push(`swiped ${r.direction} ${travel}px from (${Math.round(start.x)}, ${Math.round(start.y)}); ${moved.length ? `scrolled: ${moved.slice(0, 3).join(', ')}` : 'nothing scrolled (the page may handle the gesture itself)'}`);
    return 'touch';
  }

  private async history_(direction: 'back' | 'forward', notes: string[]): Promise<string> {
    const page = this.page!;
    const cdp = await this.cdpFor(page);
    const nav = await cdp.send('Page.getNavigationHistory');
    const next = nav.entries[nav.currentIndex + (direction === 'back' ? -1 : 1)];
    // The blank page a new tab starts on is not part of the app's history.
    const canGo = !!next && next.url !== 'about:blank';
    if (!canGo) {
      throw new LabError('no_history', `There is no ${direction === 'back' ? 'earlier' : 'later'} page in this tab's history`, {
        hint: direction === 'back' && this.openers.has(this.activeTab) ? `This tab was opened by ${this.openers.get(this.activeTab)}; switch_tab to return.` : 'Nothing to do; observe the current page.',
      });
    }
    const entry = nav.entries[nav.currentIndex + (direction === 'back' ? -1 : 1)];
    try {
      await (direction === 'back' ? page.goBack({ waitUntil: 'commit', timeout: 10_000 }) : page.goForward({ waitUntil: 'commit', timeout: 10_000 }));
    } catch (err) {
      notes.push(`the ${direction} navigation had not committed after 10 s (${firstLine(err)})`);
    }
    if (entry) notes.push(`went ${direction} to ${pathOf(entry.url)}`);
    // What a person sees too: the browser puts the page back where it was scrolled, and whatever the app
    // kept only in memory (an applied filter, an open panel) may be gone. Check the observation's scroll line.
    notes.push('the browser restores the earlier scroll position, and page state kept only in memory (filters, open panels) may have been reset');
    return 'history';
  }

  private async hover(handle: ElementHandle<Element>, notes: string[]): Promise<string> {
    const point = await this.reach(handle, notes);
    await this.page!.mouse.move(point.x, point.y, { steps: 2 });
    if (this.session!.device.hasTouch) notes.push('hover has no touch equivalent: a person on this touch device cannot reveal what this showed');
    return 'mouse';
  }

  /** Files must resolve (following symlinks) inside the profile's uploads.allow entries. */
  private resolveUploads(files: string[]): string[] {
    const root = this.profile!.root;
    const allowed = this.profile!.uploads.allow.map((a) => { try { return realpathSync(a); } catch { return undefined; } }).filter((a): a is string => !!a);
    if (!this.profile!.uploads.allow.length) {
      throw new LabError('upload_not_allowed', 'This project allows no uploads', { hint: 'Add "uploads": {"allow": ["<dir>"]} to agentlab.json, listing project directories the lab may read.' });
    }
    return files.map((f) => {
      let real: string;
      try {
        real = realpathSync(resolve(root, f));
      } catch {
        throw new LabError('not_found', `No such file: ${f}`, { hint: 'Paths are relative to the project root.' });
      }
      if (!allowed.some((a) => real === a || real.startsWith(a + sep))) {
        throw new LabError('upload_not_allowed', `${f} is outside the directories this project allows for upload`, {
          hint: `Allowed: ${this.profile!.uploads.allow.map((a) => relative(root, a) || '.').join(', ')} (uploads.allow in agentlab.json).`,
        });
      }
      if (!statSync(real).isFile()) throw new LabError('invalid_request', `${f} is not a file`);
      return real;
    });
  }

  private async upload(ref: string, files: string[], notes: string[]): Promise<string> {
    const paths = this.resolveUploads(files);
    const page = this.page!;
    return this.withRef(ref, async (h) => {
      const info = await h.evaluate(uploadInfo);
      if (info.fileInput) {
        if (info.disabled) throw new LabError('disabled', 'Target is disabled');
        if (paths.length > 1 && !info.multiple) throw new LabError('invalid_request', 'This file input accepts one file');
        await this.bringIntoView(h, notes);
        try {
          await h.setInputFiles(paths, { timeout: ACTION_TIMEOUT_MS });
        } catch (err) {
          throw new LabError('action_failed', `upload failed: ${firstLine(err)}`);
        }
        return 'set-files';
      }
      // A button or label that opens the file chooser: tap it as a person would, then choose the files.
      const chooser = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => undefined);
      const method = await this.click(h, notes);
      const fc = await chooser;
      if (!fc) {
        throw new LabError('not_uploadable', `The ${method} did not open a file chooser, and the target is not a file input`, {
          hint: 'Target the file input itself, or the button that opens the chooser.',
        });
      }
      if (paths.length > 1 && !fc.isMultiple()) throw new LabError('invalid_request', 'This file chooser accepts one file');
      await fc.setFiles(paths, { timeout: ACTION_TIMEOUT_MS });
      notes.push(`the ${method} opened a file chooser; chose ${paths.map((p) => basename(p)).join(', ')}`);
      return method;
    });
  }

  /** Press on the source, move in steps to the drop target (or by dx/dy), release. */
  private async drag(handle: ElementHandle<Element>, r: ActionRequest, notes: string[]): Promise<string> {
    const page = this.page!;
    const from = await this.reach(handle, notes);
    let to: { x: number; y: number };
    if (r.toRef) {
      to = await this.withRef(r.toRef, async (t) => {
        const p = await t.evaluate(targetPoint);
        if (!p.inView) {
          throw new LabError('obstructed', 'The drop target is not on screen while the source is', { hint: 'Scroll so both are visible, or drag by dx/dy.' });
        }
        if (!p.hitOk) throw new LabError('obstructed', `The drop target's centre is covered by ${p.hit ?? 'another element'}`);
        return p;
      });
    } else {
      to = { x: from.x + (r.dx ?? 0), y: from.y + (r.dy ?? 0) };
      const vp = this.session!.device.viewport;
      if (to.x < 0 || to.y < 0 || to.x > vp.width || to.y > vp.height) {
        throw new LabError('invalid_request', `Dragging by (${r.dx ?? 0}, ${r.dy ?? 0}) would leave the ${vp.width}x${vp.height} view`);
      }
    }
    try {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + Math.sign(to.x - from.x) * 4, from.y + Math.sign(to.y - from.y) * 4, { steps: 2 });
      await page.mouse.move(to.x, to.y, { steps: 12 });
      await page.mouse.up();
    } catch (err) {
      throw new LabError('action_failed', `drag failed: ${firstLine(err)}`);
    }
    if (this.session!.device.hasTouch) notes.push('dispatched as a mouse drag; touch drag gestures are not emulated');
    return 'mouse-drag';
  }

  private async openTab(path: string, notes: string[]): Promise<string> {
    const url = this.origin + path;
    assertUrlAllowed(url, this.profile!.allowExternalUrl);
    const page = await this.context!.newPage();
    const id = this.tabIds.get(page) ?? this.registerTab(page, this.activeTab);
    if (!this.tabEvents.opened.includes(id)) this.tabEvents.opened.push(id);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      notes.push(`the page had not loaded after 30 s (${firstLine(err)})`);
    }
    await this.activate(id);
    notes.push(`opened tab ${id} at ${path}`);
    return 'new-tab';
  }

  private async switchTab(tab: string, notes: string[]): Promise<string> {
    if (!this.tabs.has(tab)) throw new LabError('unknown_tab', `No open tab ${tab}`, { hint: `Open tabs: ${[...this.tabs.keys()].join(', ')}` });
    if (tab === this.activeTab) notes.push(`${tab} is already the active tab`);
    else await this.activate(tab);
    return 'tab';
  }

  private async closeTab(tab: string | undefined, notes: string[]): Promise<string> {
    const id = tab ?? this.activeTab;
    const page = this.tabs.get(id);
    if (!page) throw new LabError('unknown_tab', `No open tab ${id}`, { hint: `Open tabs: ${[...this.tabs.keys()].join(', ')}` });
    if (this.tabs.size === 1) throw new LabError('invalid_request', `${id} is the only tab`, { hint: 'Use stop to end the session.' });
    await page.close({ runBeforeUnload: false });
    await this.tabClosed(id);
    notes.push(`closed tab ${id}; active tab is ${this.activeTab}`);
    return 'tab';
  }

  private async cdpFor(page: Page): Promise<CDPSession> {
    let s = this.cdp.get(page);
    if (!s) {
      s = await this.context!.newCDPSession(page);
      this.cdp.set(page, s);
    }
    return s;
  }

  private async bringIntoView(handle: ElementHandle<Element>, notes: string[]): Promise<void> {
    // Evidence for a pan finding is what a person sees before panning: the target out of view.
    if (this.opts.evidenceFrames && await handle.evaluate(needsHorizontalPan)) this.prePanFrame = await this.captureFrame();
    const { dx, dy } = await handle.evaluate(panIntoView);
    this.actionPanX += dx;
    if (dx) {
      notes.push(`view panned sideways ${Math.abs(dx)}px to reach the target: it starts outside the ${this.session!.device.viewport.width}px-wide view, so a person must discover a horizontal pan`);
    }
    if (dy) notes.push(`scrolled ${dy > 0 ? 'down' : 'up'} ${Math.abs(dy)}px to bring the target into view`);
  }

  /** Target point, re-measured until the element stops moving (animations, smooth layout shifts). */
  private async stablePoint(handle: ElementHandle<Element>): Promise<TargetPoint> {
    let prev = await handle.evaluate(targetPoint);
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 32));
      const next = await handle.evaluate(targetPoint);
      if (Math.abs(next.x - prev.x) < 1 && Math.abs(next.y - prev.y) < 1) return next;
      prev = next;
    }
    return prev;
  }

  /**
   * Wait until the document is loaded, the DOM has been quiet for policy.quietMs and no awaited
   * request is open, bounded by policy.maxMs. Requests already open before `since`, EventSource and
   * WebSocket connections, and policy.backgroundRequests are not awaited, so long-polling and
   * streaming pages do not stall every action. A timeout is reported, never thrown.
   */
  private async settle(since: number, fromPath?: string): Promise<SettleReport> {
    const page = this.page!;
    const { quietMs, maxMs } = this.settlePolicy;
    const t0 = Date.now();
    const remaining = () => maxMs - (Date.now() - t0);
    const idle = (r: { key: string; responded?: boolean }) => {
      const last = this.bodyActivity.get(r.key);
      return !!r.responded && last !== undefined && Date.now() - last > BODY_IDLE_MS;
    };
    const awaited = () => [...this.requests.values()].filter((r) => !r.background && r.started >= since && !idle(r));
    const ignored = () => [...this.requests.values()].filter((r) => r.background || r.started < since || idle(r)).length;
    let cause: SettleReport['cause'] = 'dom';
    while (remaining() > 0) {
      if (page.isClosed()) return { ms: Date.now() - t0, reason: 'quiet', ignored: ignored() };
      await page.waitForLoadState('domcontentloaded', { timeout: Math.max(1, remaining()) }).catch(() => undefined);
      let dom: 'quiet' | 'timeout' | 'busy' | 'timers' | 'route' | 'empty';
      try {
        dom = await page.evaluate(waitForDomQuiet, { quietMs, maxMs: Math.max(50, remaining()), timerMaxMs: this.settlePolicy.timerMaxMs, ...(fromPath ? { fromPath } : {}) });
      } catch {
        continue; // context destroyed by navigation; loop waits for the new document
      }
      if (dom !== 'quiet') { cause = dom === 'timeout' ? 'dom' : dom; break; }
      if (!awaited().length) return { ms: Date.now() - t0, reason: 'quiet', ignored: ignored() };
      cause = 'network';
      while (awaited().length && remaining() > 0) await new Promise((r) => setTimeout(r, 20));
    }
    const pending = awaited().map((r) => r.label);
    if (pending.length) cause = 'network';
    return { ms: Date.now() - t0, reason: 'timeout', cause, ...(pending.length ? { pending: pending.slice(0, 5) } : {}), ignored: ignored() };
  }

  /** The visible (visual) viewport as a CSS-pixel JPEG, or undefined if the page cannot be captured. */
  private async captureFrame(): Promise<Buffer | undefined> {
    try {
      return await this.page!.screenshot({ type: 'jpeg', quality: 70, scale: 'css', caret: 'initial', animations: 'allow', timeout: 2000 });
    } catch {
      return undefined;
    }
  }

  private saveFrame(jpeg: Buffer | undefined, name: string): string | undefined {
    if (!jpeg) return undefined;
    try {
      const dir = join(this.session!.runDir, 'frames');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${name}.jpg`);
      writeFileSync(file, jpeg);
      return file;
    } catch {
      return undefined;
    }
  }

  private saveFindings(): void {
    if (this.child) return;
    try {
      writeFileSync(join(this.session!.runDir, 'findings.json'), JSON.stringify(this.findings.list(), null, 2));
    } catch { /* artifacts must never break a session */ }
  }

  private record(kind: string, data: unknown): void {
    if (!this.session || this.child) return;
    try {
      appendFileSync(join(this.session.runDir, 'actions.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind, data }) + '\n');
    } catch { /* logging must never break a session */ }
  }

  private emit(event: LabEvent): void {
    try { this.opts.onEvent?.(event); } catch { /* observer errors are not session errors */ }
  }
}

function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

function existsFile(file: string): boolean {
  try { return statSync(file).isFile(); } catch { return false; }
}

const SECRET_MASK = '‹secret›';

/** Arguments each action needs, checked before anything touches the page. */
function validateAction(r: ActionRequest): void {
  const need = (ok: boolean, message: string) => { if (!ok) throw new LabError('invalid_request', `${r.action}: ${message}`); };
  const targeted = ['click', 'fill', 'select', 'check', 'uncheck', 'hover', 'upload', 'drag'];
  if (targeted.includes(r.action)) need(!!r.ref, 'needs a ref, or a name (optionally with role)');
  switch (r.action) {
    case 'click': case 'check': case 'uncheck': case 'hover': case 'back': case 'forward': case 'close_tab': return;
    case 'fill': return need(typeof r.value === 'string', 'needs the text to enter');
    case 'press': return need(typeof r.key === 'string' && r.key.length > 0, 'needs a key, e.g. Enter');
    case 'select': return need(Array.isArray(r.values) && r.values.length > 0, 'needs at least one option (label or value)');
    case 'scroll': return need(!!r.direction || !!r.ref, 'needs a direction, a ref to bring into view, or both');
    case 'swipe': return need(!!r.direction, 'needs a direction (left, right, up or down)');
    case 'upload': return need(Array.isArray(r.files) && r.files.length > 0, 'needs at least one file');
    case 'drag': return need(!!r.toRef || r.dx !== undefined || r.dy !== undefined, 'needs a toRef, or dx/dy');
    case 'open_tab': return need(typeof r.path === 'string' && r.path.startsWith('/'), 'needs a path on the app origin, starting with "/"');
    case 'switch_tab': return need(typeof r.tab === 'string', 'needs a tab id, e.g. t2');
    default: throw new LabError('invalid_request', `Unsupported action "${String(r.action)}"`);
  }
}

/** Keys with names (Enter, Tab, Shift+Tab…) are not text; a single character is. */
function isNamedKey(key: string): boolean {
  const last = key.split('+').at(-1) ?? key;
  return last.length > 1;
}

function describeAction(r: ActionRequest, target: ControlSummary | undefined, before: Observation | undefined, secret = false): string {
  const what = target ? `${target.role} "${target.name}"` : r.ref;
  const other = r.toRef ? before?.controls.find((c) => c.ref === r.toRef) : undefined;
  switch (r.action) {
    case 'click': return `click ${what}`;
    case 'fill': return secret ? `fill ${what} with ${SECRET_MASK} (${(r.value ?? '').length} characters)` : `fill ${what} with ${JSON.stringify(redactValue(r.value ?? ''))}`;
    case 'press': return `press ${secret ? SECRET_MASK : r.key}${what ? ` in ${what}` : ''}`;
    case 'select': return `select ${(r.values ?? []).map((v) => JSON.stringify(redactValue(v))).join(', ')} in ${what}`;
    case 'check': case 'uncheck': case 'hover': return `${r.action} ${what}`;
    case 'scroll': return r.direction ? `scroll ${r.direction}${r.amount ? ` ${r.amount}px` : ''}${what ? ` in ${what}` : ''}` : `scroll ${what} into view`;
    case 'swipe': return `swipe ${r.direction}${what ? ` on ${what}` : ''}`;
    case 'back': case 'forward': return `go ${r.action}`;
    case 'upload': return `upload ${(r.files ?? []).map((f) => basename(f)).join(', ')} to ${what}`;
    case 'drag': return `drag ${what} ${r.toRef ? `onto ${other ? `${other.role} "${other.name}"` : r.toRef}` : `by (${r.dx ?? 0}, ${r.dy ?? 0})px`}`;
    case 'open_tab': return `open a new tab at ${r.path}`;
    case 'switch_tab': return `switch to tab ${r.tab}`;
    case 'close_tab': return `close tab ${r.tab ?? '(current)'}`;
  }
}

/** The request as written to actions.jsonl: long values shortened, secrets masked. */
function loggedRequest(r: ActionRequest, secret: boolean): ActionRequest {
  return {
    ...r,
    ...(r.value !== undefined ? { value: secret ? SECRET_MASK : redactValue(r.value) } : {}),
    ...(r.key !== undefined && secret ? { key: SECRET_MASK } : {}),
  };
}

function redactValue(value: string): string {
  return value.length > 40 ? `${value.slice(0, 12)}…(${value.length} chars)` : value;
}

function firstLine(err: unknown): string {
  return redactUrlSecrets((err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '');
}
