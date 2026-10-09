import { LabError } from './schema.js';

// Session supervision: a person watching the dashboard can pause the agent, take over the browser,
// resume or return control, and stop the run. Pure state machine; the Lab performs the side effects
// (closing on stop, invalidating refs on return) and adapters only forward requests to it.
//
// Nothing is ever queued: while the session is not under agent control, agent commands are refused
// with a recoverable, structured error at the moment they would run.

export type ControlMode = 'agent' | 'pausing' | 'paused' | 'human' | 'stopping' | 'stopped';
export type ControlOp = 'pause' | 'pause-next' | 'resume' | 'takeover' | 'return' | 'stop' | 'emergency-stop';
export const CONTROL_OPS: readonly ControlOp[] = ['pause', 'pause-next', 'resume', 'takeover', 'return', 'stop', 'emergency-stop'];

/** How an agent command interacts with the page: read-only, observe, or anything that acts. */
export type CommandKind = 'read' | 'observe' | 'act';

export interface ControlState {
  mode: ControlMode;
  /** While `pausing` or `stopping`: what happens once the command in flight finishes. */
  pending?: 'paused' | 'human' | 'stop';
  /** Long commands (scan, sweep, a flow) stop at their next checkpoint instead of running to the end. */
  interrupt: boolean;
  /** Who made the last change, e.g. "dashboard". */
  by?: string;
  /** When the current mode began (ISO time). */
  since: string;
  /** The session operation in flight, if any. */
  busy?: { command: string; since: string };
  /** Refs issued before control came back are stale; the agent must observe before acting. */
  observeRequired: boolean;
  /** Interactions a person made in the browser since the session was last under agent control. */
  humanInteractions: number;
}

/**
 * How a supervision stop is recorded. A stop from the terminal is the owner channel, but anything with a
 * shell as this user can issue it, so it is labelled by where it came from rather than as a person's.
 */
export function stopReason(op: 'stop' | 'emergency-stop', by = 'dashboard'): string {
  if (by === 'terminal') return op === 'stop' ? 'stopped from the terminal' : 'emergency stop from the terminal';
  return `${op === 'stop' ? 'stopped' : 'emergency stop'} by a person (${by})`;
}

/** What a transition did, for the timeline. */
export interface ControlChange { op: ControlOp | 'settled' | 'observed'; by?: string; state: ControlState }

const iso = () => new Date().toISOString();

export class Supervisor {
  private s: ControlState = { mode: 'agent', interrupt: false, since: iso(), observeRequired: false, humanInteractions: 0 };
  private readonly listeners = new Set<(c: ControlChange) => void>();
  private waiters: { resolve: () => void; reject: (e: LabError) => void }[] = [];
  private idleWaiters: (() => void)[] = [];

  get state(): ControlState {
    return structuredClone(this.s);
  }

  get mode(): ControlMode {
    return this.s.mode;
  }

  /** A person is watching or holding the page: human input is recorded only then. */
  get recordingHuman(): boolean {
    return this.s.mode === 'paused' || this.s.mode === 'human';
  }

  onChange(fn: (c: ControlChange) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /**
   * Apply a person's request. Throws `invalid_control` for a request that makes no sense in the current
   * mode (e.g. resume while the agent already has control), so the dashboard can say why.
   */
  request(op: ControlOp, by = 'dashboard'): ControlState {
    const s = this.s;
    const busy = !!s.busy;
    const invalid = (why: string) => new LabError('invalid_control', `Cannot ${op}: ${why}`, { details: { mode: s.mode } });
    if (s.mode === 'stopped') throw invalid('the session has stopped');
    switch (op) {
      case 'pause':
      case 'pause-next': {
        const interrupt = op === 'pause';
        if (s.mode === 'agent') this.set(busy ? { mode: 'pausing', pending: 'paused', interrupt } : { mode: 'paused', interrupt: false }, by);
        else if (s.mode === 'pausing' && s.pending === 'paused') this.set({ mode: 'pausing', pending: 'paused', interrupt: s.interrupt || interrupt }, by);
        else throw invalid(`the session is ${describe(s)}`);
        break;
      }
      case 'takeover':
        if (s.mode === 'agent' || s.mode === 'pausing' || s.mode === 'paused') {
          this.set(busy ? { mode: 'pausing', pending: 'human', interrupt: true } : { mode: 'human', interrupt: false }, by);
        } else throw invalid(`the session is ${describe(s)}`);
        break;
      case 'resume':
        if (s.mode === 'paused' || (s.mode === 'pausing' && s.pending === 'paused')) {
          this.set({ mode: 'agent', interrupt: false, observeRequired: s.observeRequired || s.humanInteractions > 0 }, by);
        } else throw invalid(s.mode === 'human' ? 'a person has control; use return to hand it back' : `the session is ${describe(s)}`);
        break;
      case 'return':
        if (s.mode === 'human' || (s.mode === 'pausing' && s.pending === 'human')) {
          // Whatever the person did, refs from before are no longer trustworthy.
          this.set({ mode: 'agent', interrupt: false, observeRequired: s.mode === 'human' || s.humanInteractions > 0 }, by);
        } else throw invalid(`the session is ${describe(s)}`);
        break;
      case 'stop':
        if (s.mode === 'stopping') throw invalid('it is already stopping');
        this.set(busy ? { mode: 'stopping', pending: 'stop', interrupt: true } : { mode: 'stopped', interrupt: true }, by);
        break;
      case 'emergency-stop':
        this.set({ mode: 'stopped', interrupt: true }, by);
        break;
    }
    this.emit(op, by);
    return this.state;
  }

  /**
   * Refuse an agent command that may not run now. Read-only commands always run; observe runs unless a
   * person holds the page; anything that acts needs agent control and, after a hand-back, a fresh observe.
   */
  admit(command: string, kind: CommandKind): void {
    if (kind === 'read') return;
    const s = this.s;
    const details = { control: { mode: s.mode, ...(s.by ? { by: s.by } : {}), since: s.since } };
    if (s.mode === 'stopping' || s.mode === 'stopped') {
      throw new LabError('session_stopped', `${command} refused: a person stopped this session`, {
        hint: 'Nothing was run. The session is closing or closed; ask the user before starting another.', details
      });
    }
    if (s.mode === 'human' || (s.mode === 'pausing' && s.pending === 'human')) {
      throw new LabError('human_control', `${command} refused: a person has taken control of the browser`, {
        hint: 'Nothing was run and nothing is queued. Wait for the person to hand control back, then observe (refs from before will be stale).', details,
      });
    }
    if (kind === 'observe') return;
    if (s.mode === 'paused' || s.mode === 'pausing') {
      throw new LabError('session_paused', `${command} refused: a person paused the session`, {
        hint: 'Nothing was run and nothing is queued. observe, inspect and status still work; retry the action after the person resumes.', details,
      });
    }
    // Stopping acts on no ref, so stale refs do not matter: after a hand-back it needs no fresh observe.
    if (s.observeRequired && command !== 'stop') {
      throw new LabError('observation_required', `${command} refused: a person used the browser since the last observation`, {
        hint: 'Refs issued before are stale. Run observe, then act on fresh refs.', details,
      });
    }
  }

  /** The agent observed after a hand-back: acting is allowed again. */
  observed(): void {
    if (this.s.mode !== 'agent' || !this.s.observeRequired) return;
    this.set({ mode: 'agent', interrupt: false, observeRequired: false, humanInteractions: 0 }, this.s.by);
    this.emit('observed', this.s.by);
  }

  /** A person interacted with the page while it was paused or under their control. */
  humanInteraction(): void {
    if (this.recordingHuman) this.s.humanInteractions++;
  }

  /** A session operation began. Nested operations (a scan inside a flow step) keep the outer label. */
  begin(command: string): void {
    this.s.busy ??= { command, since: iso() };
  }

  /** The operation in flight finished: a pending pause, takeover or stop takes effect now. */
  end(): void {
    if (!this.s.busy) return;
    delete this.s.busy;
    const s = this.s;
    if (s.mode === 'pausing') this.set({ mode: s.pending === 'human' ? 'human' : 'paused', interrupt: false }, s.by);
    else if (s.mode === 'stopping') this.set({ mode: 'stopped', interrupt: true }, s.by);
    else { this.flushIdle(); return; }
    this.emit('settled', s.by);
    this.flushIdle();
  }

  get busy(): boolean {
    return !!this.s.busy;
  }

  /** Resolves when no operation is in flight. */
  whenIdle(): Promise<void> {
    if (!this.s.busy) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  /** For long commands between units of work: true when they should stop now (pause, takeover or stop). */
  shouldInterrupt(): boolean {
    return this.s.interrupt && (this.s.mode === 'pausing' || this.s.mode === 'stopping' || this.s.mode === 'stopped');
  }

  /**
   * For a scripted runner (a flow) that has no one to return an error to: wait until the agent has
   * control. Rejects with session_stopped when a person stops the session.
   */
  waitForTurn(): Promise<void> {
    const s = this.s.mode;
    if (s === 'agent') return Promise.resolve();
    if (s === 'stopping' || s === 'stopped') return Promise.reject(new LabError('session_stopped', 'A person stopped this session'));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private set(next: Partial<ControlState> & Pick<ControlState, 'mode' | 'interrupt'>, by?: string): void {
    const keep = { observeRequired: this.s.observeRequired, humanInteractions: this.s.humanInteractions, ...(this.s.busy ? { busy: this.s.busy } : {}) };
    const modeChanged = next.mode !== this.s.mode;
    this.s = { ...keep, ...next, ...(by ? { by } : {}), since: modeChanged ? iso() : this.s.since };
    if (next.mode === 'agent' && modeChanged) this.s.humanInteractions = 0;
    if (!next.pending) delete this.s.pending;
    this.wake();
  }

  private wake(): void {
    const m = this.s.mode;
    if (m === 'agent') {
      for (const w of this.waiters.splice(0)) w.resolve();
    } else if (m === 'stopping' || m === 'stopped') {
      for (const w of this.waiters.splice(0)) w.reject(new LabError('session_stopped', 'A person stopped this session'));
    }
  }

  private flushIdle(): void {
    for (const r of this.idleWaiters.splice(0)) r();
  }

  private emit(op: ControlChange['op'], by?: string): void {
    const change: ControlChange = { op, ...(by ? { by } : {}), state: this.state };
    for (const fn of this.listeners) fn(change);
  }
}

function describe(s: ControlState): string {
  if (s.mode === 'pausing') return s.pending === 'human' ? 'waiting to hand control to a person' : 'already pausing';
  if (s.mode === 'human') return 'under a person\'s control';
  return s.mode;
}
