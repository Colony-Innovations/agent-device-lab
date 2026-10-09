import { formatAction, formatClose, formatInspect, formatObservation, formatScan, formatStart, formatSweep, formatTabs } from './format.js';
import { scanSummary } from './scan.js';
import { SWEEP_DEVICES } from './devices.js';
import { Lab, type LabOptions } from './lab.js';
import { LabError, type ActionName, type ActionRequest, type Direction } from './schema.js';
import { stopReason, type CommandKind, type ControlOp, type ControlState } from './control.js';

// Transport-neutral command table. The CLI daemon and the MCP stdio server both dispatch through it;
// neither adapter contains session logic of its own.

type PropSchema =
  | { type: 'string'; description: string; enum?: string[]; maxLength?: number }
  | { type: 'number'; description: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description: string }
  | { type: 'array'; items: { type: 'string'; maxLength?: number }; description: string; minItems?: number; maxItems?: number };

/** Bounds applied when a property sets none, so no argument is unbounded (MCP input is untrusted). */
const DEFAULT_MAX_LENGTH = 4096;
const DEFAULT_MAX_ITEMS = 100;
export interface InputSchema { type: 'object'; properties: Record<string, PropSchema>; required?: string[]; additionalProperties: false }

export interface CommandOutput { result: Record<string, unknown>; text: string }

export type Surface = 'cli' | 'mcp';

export interface Command {
  name: string;
  description: string;
  inputSchema: InputSchema;
  surfaces: readonly Surface[];
  /** read: never refused; observe: refused while a person holds the page; act: needs agent control. */
  kind: CommandKind;
  run(host: SessionHost, args: Record<string, unknown>, surface: Surface): Promise<CommandOutput>;
}

/**
 * Owns the current Lab. A Lab is single-use; after a session ends, the next `start` gets a fresh one.
 * Adapters may also force options (e.g. headless for a benchmark) that callers cannot override.
 */
export class SessionHost {
  private current: Lab;
  /**
   * Set by an adapter that serves the live dashboard. Start and status results carry this URL, which is
   * view-only: control (pause, takeover, stop) needs the person's URL from `agentlab ui`.
   */
  dashboardUrl?: () => string;
  /** A person stopped the session from the dashboard: no new session starts in this process. */
  halted?: string;

  constructor(private readonly options: LabOptions, readonly forced: { headless?: boolean } = {}) {
    this.current = new Lab(options);
  }

  get lab(): Lab {
    return this.current;
  }

  /**
   * A person's supervision request (from the dashboard). After a stop or emergency stop this process
   * starts no further session, so an agent cannot simply start again behind the person's back.
   */
  supervise(op: ControlOp, by = 'dashboard'): ControlState {
    const state = this.current.supervise(op, by);
    if (op === 'stop' || op === 'emergency-stop') this.halted = stopReason(op, by);
    return state;
  }

  /** A Lab ready for `start`: the current one if unused, otherwise a new one once the old has ended. */
  forStart(): Lab {
    if (this.halted) {
      throw new LabError('session_stopped', `Not starting: the previous session was ${this.halted}`, {
        hint: 'Ask the user before continuing; they can restart the MCP server or the CLI session themselves.',
      });
    }
    const s = this.current.status();
    if (s.session && !s.active) this.current = new Lab(this.options);
    return this.current;
  }
}

const schema = (properties: Record<string, PropSchema>, required: string[] = []): InputSchema =>
  ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });

const target = {
  ref: { type: 'string', description: 'Session ref from the latest observation, e.g. e12' },
  role: { type: 'string', description: 'Role, used with name when no ref is given' },
  name: { type: 'string', description: 'Exact accessible name, used when no ref is given' },
} as const satisfies Record<string, PropSchema>;

const optionalTarget = {
  ref: { type: 'string', description: 'Session ref from the latest observation (optional)' },
  role: { type: 'string', description: 'Role, used with name when no ref is given' },
  name: { type: 'string', description: 'Exact accessible name, used when no ref is given' },
} as const satisfies Record<string, PropSchema>;

const DIRECTIONS = ['up', 'down', 'left', 'right'];

/**
 * Run one action through the Lab. A role+name target is resolved against the latest observation
 * (never guessed). `targeted` actions need a target; others (press, scroll, swipe…) may omit it.
 */
async function act(host: SessionHost, action: ActionName, args: Record<string, unknown>, targeted = true): Promise<CommandOutput> {
  const lab = host.lab;
  // Refused before the target is resolved, so a paused or taken-over session says so instead of not_found.
  lab.admit(action, 'act');
  let ref = args.ref as string | undefined;
  if (!ref && args.name !== undefined) ref = lab.findRef({ role: args.role as string | undefined, name: args.name as string });
  if (!ref && targeted) throw new LabError('invalid_request', `${action} needs a ref, or a name (optionally with role)`);
  const request: ActionRequest = {
    action, ...(ref ? { ref } : {}),
    ...pick(args, ['value', 'key', 'values', 'amount', 'toRef', 'dx', 'dy', 'files', 'tab', 'path']),
    ...(args.direction ? { direction: args.direction as Direction } : {}),
  };
  const result = await lab.act(request);
  return { result: result as unknown as Record<string, unknown>, text: formatAction(result) };
}

function pick(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
}

const action = (name: ActionName, description: string, properties: Record<string, PropSchema>, required: string[] = [], targeted = true): Command => ({
  name, description, surfaces: ['cli', 'mcp'], kind: 'act', inputSchema: schema(properties, required), run: (host, args) => act(host, name, args, targeted),
});

export const COMMANDS: readonly Command[] = [
  {
    name: 'start',
    kind: 'act',
    description: 'Start or reuse the project web server from its agentlab.json profile, open a Chromium session with the device profile, and return the first observation.',
    surfaces: ['cli', 'mcp'],
    inputSchema: schema({
      project: { type: 'string', description: 'Project directory or path to agentlab.json' },
      device: { type: 'string', description: 'Device profile id (default: from the profile)', maxLength: 100 },
      headed: { type: 'boolean', description: 'Open a visible browser window (default false: watch in the dashboard instead)' },
      slowMoMs: { type: 'number', description: 'Delay each browser operation, for watching', minimum: 0, maximum: 10_000 },
      auth: { type: 'string', enum: ['auto', 'saved', 'fresh'], description: 'Saved sign-in state: auto (default: use it if saved), saved (require it), fresh (signed-out session)' },
      trace: { type: 'boolean', description: 'Record a Playwright trace so a failure bundle can include a sanitized copy (default false)' },
    }, ['project']),
    async run(host, args) {
      const result = await host.forStart().start({
        project: args.project as string,
        device: args.device as string | undefined,
        // `mcp --headed` (forced.headless === false) shows the window unless the caller says otherwise.
        headed: host.forced.headless ? false : ((args.headed as boolean | undefined) ?? (host.forced.headless === false ? true : undefined)),
        slowMoMs: args.slowMoMs as number | undefined,
        auth: args.auth as 'auto' | 'saved' | 'fresh' | undefined,
        trace: args.trace as boolean | undefined,
      });
      const url = host.dashboardUrl?.();
      return {
        result: { ...result, ...(url ? { dashboard: { url } } : {}) },
        text: formatStart(result) + (url ? `\ndashboard: ${url}  (live viewport, timeline and findings for a person watching)` : ''),
      };
    },
  },
  {
    name: 'observe',
    kind: 'observe',
    description: 'Return the compact state: route, headings, open dialog, visible interactive controls with session refs, page messages, layout flags, finding count, and console/network counts.',
    surfaces: ['cli', 'mcp'],
    inputSchema: schema({ limit: { type: 'number', description: 'Maximum controls to return (default 40)', minimum: 1, maximum: 500 } }),
    async run(host, args) {
      const result = await host.lab.observe({ limit: args.limit as number | undefined });
      return { result: result as unknown as Record<string, unknown>, text: formatObservation(result) };
    },
  },
  {
    name: 'click',
    kind: 'act',
    description: 'Tap (touch profiles) or click a control from the latest observation, by ref or unambiguous role+name. Verifies the event reached the control, waits for the UI to settle, and returns what changed plus any new usability findings.',
    surfaces: ['cli', 'mcp'],
    inputSchema: schema({ ...target }),
    run: (host, args) => act(host, 'click', args),
  },
  {
    name: 'fill',
    kind: 'act',
    description: 'Replace the text of a text field from the latest observation, by ref or unambiguous role+name, then return what changed.',
    surfaces: ['cli', 'mcp'],
    inputSchema: schema({ ...target, value: { type: 'string', description: 'Text to enter', maxLength: 20_000 } }, ['value']),
    run: (host, args) => act(host, 'fill', args),
  },
  {
    name: 'inspect',
    kind: 'read',
    description: 'Usability findings recorded in this session (layout overflow, clipped controls, controls only reachable by a sideways pan) with measured evidence and reproduction steps. Pass id for one finding, or ref for a control and its findings.',
    surfaces: ['cli', 'mcp'],
    inputSchema: schema({
      id: { type: 'string', description: 'Finding id, e.g. F2' },
      ref: { type: 'string', description: 'Control ref from the latest observation' },
    }),
    async run(host, args) {
      const result = host.lab.inspect({ id: args.id as string | undefined, ref: args.ref as string | undefined });
      return { result: result as unknown as Record<string, unknown>, text: formatInspect(result) };
    },
  },
  {
    name: 'sweep',
    kind: 'act',
    description: 'Responsive sweep: load a route (default: the current one) at 320, 390, 768 and 1440 CSS px, one isolated browser context per width with the session\'s cookies and storage, and check layout (heuristic) and whether each control can be reached without a sideways pan or an obstruction (confirmed). Returns per-width results, findings and a report path; the session page is untouched.',
    surfaces: ['cli', 'mcp'],
    inputSchema: schema({
      route: { type: 'string', description: 'Path to sweep, e.g. /app/discover (default: current route)' },
      devices: { type: 'string', description: `Comma-separated device ids (default: ${SWEEP_DEVICES.join(',')})` },
    }),
    async run(host, args) {
      const devices = typeof args.devices === 'string' ? args.devices.split(',').map((d) => d.trim()).filter(Boolean) : undefined;
      const result = await host.lab.sweep({ route: args.route as string | undefined, devices });
      return { result: result as unknown as Record<string, unknown>, text: formatSweep(result) };
    },
  },
  {
    name: 'scan',
    kind: 'act',
    description: 'Stateful responsive scan: run the project\'s declared scenarios (agentlab.json scan.scenarios: a route, setup steps such as opening a drawer or a dialog, devices and checks) or one route as loaded, each device in its own isolated browser context, optionally exploring menus, disclosures, tabs and dialogs that are safe to open. Checks layout, clipping, fixed-bar collisions, dialog overflow, tap targets (WCAG 2.2), label wrapping between nearby widths and layout shifts. Returns the verdict, problem groups (inspect ids for details) and HTML/JSON report paths; the session page is untouched.',
    surfaces: ['cli', 'mcp'],
    inputSchema: schema({
      scenarios: { type: 'string', description: 'Comma-separated scenario names (default: all declared)' },
      route: { type: 'string', description: 'Scan this route as loaded instead of the declared scenarios' },
      devices: { type: 'string', description: 'Comma-separated device ids, overriding the scenarios\' devices' },
      explore: { type: 'boolean', description: 'Explore safe state-opening controls (default: the profile\'s scan.explore.enabled)' },
    }),
    async run(host, args) {
      const list = (v: unknown) => typeof v === 'string' ? v.split(',').map((d) => d.trim()).filter(Boolean) : undefined;
      const result = await host.lab.scan({
        scenarios: list(args.scenarios), devices: list(args.devices), route: args.route as string | undefined, explore: args.explore as boolean | undefined,
      });
      return { result: scanSummary(result) as unknown as Record<string, unknown>, text: formatScan(result) };
    },
  },
  {
    name: 'bundle',
    kind: 'read',
    description: 'Write a failure bundle for the session so far: the action log (replayable by `agentlab replay`), recent observations, findings, console and network failures, evidence frames and, when the session records a trace, a sanitized trace. Secrets are removed. Returns the bundle\'s id, folder, files and counts, never its contents.',
    surfaces: ['cli', 'mcp'],
    inputSchema: schema({ note: { type: 'string', description: 'Why the bundle is being written', maxLength: 500 } }),
    async run(host, args) {
      const r = await host.lab.bundle({ reason: (args.note as string | undefined) ?? 'requested' });
      const c = r.counts;
      const trace = r.trace === 'included' ? ', sanitized trace' : typeof r.trace === 'object' ? `, trace left out (${r.trace.dropped})` : '';
      return {
        result: { id: r.id, dir: r.dir, files: r.files, counts: c, trace: r.trace },
        text: `bundle ${r.id} → ${r.dir}\n${c.actions} actions, ${c.observations} observations, ${c.findings} findings, ${c.consoleErrors} console errors, ${c.failedRequests} failed requests, ${c.frames} frames${trace}\nreplay: agentlab replay ${r.dir}`,
      };
    },
  },
  {
    name: 'status',
    kind: 'read',
    description: 'Report whether a session is active, its device, server ownership and current route.',
    surfaces: ['cli'],
    inputSchema: schema({}),
    async run(host) {
      const s = host.lab.status();
      const url = host.dashboardUrl?.();
      const text = (s.session
        ? `session ${s.session.id} ${s.active ? 'active' : `ended (${s.endedReason})`}  device ${s.session.device.id}  route ${s.route ?? '?'}  gen ${s.gen}  server ${s.server?.url} (${s.server?.owned ? 'owned' : 'reused'})`
        : 'no session') + (url ? `\ndashboard: ${url}` : '');
      return { result: { ...s, ...(url ? { dashboard: { url } } : {}) }, text };
    },
  },
  {
    name: 'stop',
    kind: 'act',
    description: 'Close the browser and stop the web server only if this session started it. Findings remain in the run directory.',
    surfaces: ['cli', 'mcp'],
    inputSchema: schema({}),
    async run(host, _args, surface) {
      // From the terminal, stop is the owner's safety operation: it goes through even while a person has
      // paused or taken over (the daemon socket is owner-only). An agent's MCP stop still needs control.
      if (surface === 'cli' && host.lab.control.mode !== 'agent') return stopAsOwner(host);
      host.lab.admit('stop', 'act');
      const result = await host.lab.close('requested');
      return { result: result as unknown as Record<string, unknown>, text: formatClose(result) };
    },
  },
  action('press', 'Press a key or chord (Enter, Escape, Tab, ArrowDown, Shift+Tab, Control+a) on a control (focused first) or on whatever has focus. Keys typed into password fields are masked in logs.',
    { key: { type: 'string', description: 'Key name or chord', maxLength: 64 }, ...optionalTarget }, ['key'], false),
  action('select', 'Choose options in a native <select> by label or value, then return what changed.',
    { ...target, values: { type: 'array', items: { type: 'string', maxLength: 1000 }, minItems: 1, maxItems: 100, description: 'Option labels or values' } }, ['values']),
  action('check', 'Check a checkbox, radio button or switch with a verified tap; a no-op if it is already checked. Confirms the state changed.', { ...target }),
  action('uncheck', 'Uncheck a checkbox or switch with a verified tap; a no-op if it is already unchecked.', { ...target }),
  action('scroll', 'Scroll the page, or the scrollable region containing a control, in a direction (down = reveal what is below), or bring a control into view when no direction is given. Reports how far it actually moved.',
    { direction: { type: 'string', enum: DIRECTIONS, description: 'Where to look next' }, amount: { type: 'number', description: 'CSS px (default 80% of the view)', minimum: 1, maximum: 100_000 }, ...optionalTarget }, [], false),
  action('swipe', 'Touch swipe (the finger moves in this direction) from a control or the centre of the view, as real touch input. Needs a touch device profile.',
    { direction: { type: 'string', enum: DIRECTIONS, description: 'Finger movement' }, amount: { type: 'number', description: 'CSS px (default 60% of the view)', minimum: 1, maximum: 100_000 }, ...optionalTarget }, ['direction'], false),
  action('back', 'Go back in the active tab\'s history, then return what changed.', {}, [], false),
  action('forward', 'Go forward in the active tab\'s history, then return what changed.', {}, [], false),
  action('hover', 'Move the pointer over a control (after scrolling it into view) and return what appeared.', { ...target }),
  action('upload', 'Give files to a file input, or to a button that opens a file chooser. Files are project-relative and must be inside the profile\'s uploads.allow directories.',
    { ...target, files: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: 'Project-relative file paths' } }, ['files']),
  action('drag', 'Drag a control onto another control (toRef) or by an offset (dx, dy CSS px), with a real pointer press, move and release.',
    { ...target, toRef: { type: 'string', description: 'Ref of the drop target' }, dx: { type: 'number', description: 'Horizontal offset', minimum: -100_000, maximum: 100_000 }, dy: { type: 'number', description: 'Vertical offset', minimum: -100_000, maximum: 100_000 } }),
  {
    name: 'tabs',
    kind: 'read',
    description: 'List open tabs (pop-ups and target=_blank links become tabs); the active one is observed and acted on.',
    surfaces: ['cli', 'mcp'],
    inputSchema: schema({}),
    async run(host) {
      const tabs = await host.lab.tabList();
      return { result: { tabs }, text: formatTabs(tabs) };
    },
  },
  action('open_tab', 'Open a new tab at a path on the app\'s origin and switch to it.', { path: { type: 'string', description: 'Path, e.g. /help' } }, ['path'], false),
  action('switch_tab', 'Make another tab the active one and observe it.', { tab: { type: 'string', description: 'Tab id, e.g. t2' } }, ['tab'], false),
  action('close_tab', 'Close a tab (default: the active one) and switch to its opener.', { tab: { type: 'string', description: 'Tab id (default: active)' } }, [], false),
  {
    name: 'auth_save',
    kind: 'act',
    description: 'Save this session\'s sign-in state (cookies and localStorage) so later sessions start signed in. Written owner-only to a git-ignored file; the state itself is never returned.',
    surfaces: ['cli', 'mcp'],
    inputSchema: schema({}),
    async run(host) {
      const r = await host.lab.saveAuth();
      return { result: r as unknown as Record<string, unknown>, text: `saved sign-in state: ${r.cookies} cookies, ${r.origins} origins with storage → ${r.file} (owner-only; start with auth "fresh" to ignore it)` };
    },
  },
];

export function getCommand(name: string, surface: Surface = 'cli'): Command {
  const cmd = COMMANDS.find((c) => c.name === name && c.surfaces.includes(surface));
  if (!cmd) {
    throw new LabError('invalid_request', `Unknown command "${name}"`, {
      hint: `Commands: ${COMMANDS.filter((c) => c.surfaces.includes(surface)).map((c) => c.name).join(', ')}`,
    });
  }
  return cmd;
}

/** Validate arguments against a command's flat schema. Returns a cleaned copy. */
export function validateArgs(cmd: Command, args: unknown): Record<string, unknown> {
  const input = (typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const prop = cmd.inputSchema.properties[key];
    if (!prop) throw new LabError('invalid_request', `${cmd.name}: unknown argument "${key}"`);
    const bad = (why: string) => new LabError('invalid_request', `${cmd.name}: "${key}" ${why}`);
    if (prop.type === 'array') {
      if (!Array.isArray(value) || !value.every((v) => typeof v === prop.items.type)) throw bad(`must be a list of ${prop.items.type}s`);
      if (prop.minItems && value.length < prop.minItems) throw bad(`needs at least ${prop.minItems} item(s)`);
      const maxItems = prop.maxItems ?? DEFAULT_MAX_ITEMS;
      if (value.length > maxItems) throw bad(`takes at most ${maxItems} items`);
      const maxLength = prop.items.maxLength ?? DEFAULT_MAX_LENGTH;
      if (value.some((v: string) => v.length > maxLength)) throw bad(`items must be at most ${maxLength} characters`);
    } else {
      if (typeof value !== prop.type) throw bad(`must be a ${prop.type}`);
      if (prop.type === 'string') {
        if (prop.enum && !prop.enum.includes(value as string)) throw bad(`must be one of ${prop.enum.join(', ')}`);
        const maxLength = prop.maxLength ?? DEFAULT_MAX_LENGTH;
        if ((value as string).length > maxLength) throw bad(`must be at most ${maxLength} characters`);
      }
      if (prop.type === 'number') {
        if (!Number.isFinite(value)) throw bad('must be a finite number');
        if (prop.minimum !== undefined && (value as number) < prop.minimum) throw bad(`must be at least ${prop.minimum}`);
        if (prop.maximum !== undefined && (value as number) > prop.maximum) throw bad(`must be at most ${prop.maximum}`);
      }
    }
    out[key] = value;
  }
  for (const key of cmd.inputSchema.required ?? []) {
    if (out[key] === undefined) throw new LabError('invalid_request', `${cmd.name}: "${key}" is required`);
  }
  return out;
}

/**
 * `agentlab stop` while the session is paused, held by a person, or already stopping: recorded as a stop
 * from the terminal. The command in flight (if any) finishes first, as with the dashboard's stop.
 */
async function stopAsOwner(host: SessionHost): Promise<CommandOutput> {
  const lab = host.lab;
  if (lab.status().active && lab.control.mode !== 'stopping' && lab.control.mode !== 'stopped') host.supervise('stop', 'terminal');
  await lab.control.whenIdle();
  const result = await lab.close(stopReason('stop', 'terminal'));
  return { result: result as unknown as Record<string, unknown>, text: formatClose(result) };
}

/** Run a command by name for an adapter: validation, dispatch and error normalisation in one place. */
export async function dispatch(host: SessionHost, surface: Surface, name: string, args: unknown):
  Promise<{ ok: true; output: CommandOutput } | { ok: false; error: ReturnType<LabError['toJSON']> }> {
  try {
    const cmd = getCommand(name, surface);
    return { ok: true, output: await cmd.run(host, validateArgs(cmd, args), surface) };
  } catch (err) {
    return { ok: false, error: LabError.from(err).toJSON() };
  }
}
