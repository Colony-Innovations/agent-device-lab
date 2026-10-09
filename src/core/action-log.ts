import { consequentialWord } from './explore-safety.js';
import { redactSecrets } from './feed.js';
import { formatChanges } from './format.js';
import type {
  ActionRequest, ActionResult, Control, Observation, RecordedAction, RecordedAgentAction, RecordedArgs, RecordedObservation, RecordedTarget,
} from './schema.js';

// The structured, replay-oriented log of what an agent did in a session (kept in memory, non-child sessions
// only) and a compact copy of its last observations. Bundles (bundle.ts) and replay (replay.ts) read it.
// Pure apart from the log's own state, so it is unit-tested without a browser.

export const SECRET_MASK = '‹secret›';
export const ACTION_LOG_LIMIT = 500;
export const OBSERVATION_LOG_LIMIT = 10;
const CONTROLS_PER_OBSERVATION = 40;
const CHANGE_LINES = 10;
const VALUE_MAX = 2000;
/** Shorter typed secrets are not tracked for redaction passes: replacing a 2-character string everywhere would wreck the text. */
const MIN_TRACKED_SECRET = 4;
/** Fallback when an action failed before the field could be inspected: names that suggest a secret. */
const SECRETISH_NAME = /pass|secret|token|otp|pin|cvv|cvc/i;

/** The path of a route (query and hash dropped, they often carry tokens). */
export function routePath(route: string | undefined): string | undefined {
  return route === undefined ? undefined : route.split(/[?#]/)[0] || '/';
}

const recordedTarget = (c: Pick<Control, 'role' | 'name' | 'context'> | undefined): RecordedTarget | undefined =>
  c ? { role: c.role, name: c.name, ...(c.context ? { context: c.context } : {}) } : undefined;

export function summariseObservation(o: Observation): RecordedObservation {
  return {
    gen: o.gen, route: routePath(o.route) ?? '/', title: o.title.slice(0, 120), ...(o.dialog ? { dialog: o.dialog } : {}),
    headings: o.headings.slice(0, 20),
    controls: o.controls.slice(0, CONTROLS_PER_OBSERVATION).map((c) => ({
      role: c.role, name: c.name, ...(c.context ? { context: c.context } : {}), ...(c.value !== undefined ? { value: c.value } : {}),
    })),
    omitted: Math.max(0, o.controls.length - CONTROLS_PER_OBSERVATION) + o.omitted,
  };
}

/**
 * One agent action as it is recorded. `secret` is what the Lab knows (a password-like field was filled or
 * typed into); a masked field the observation shows as "••••" and, when the action failed before the field
 * was inspected, a secret-looking name are treated the same. A value is never kept for a secret field.
 */
export function recordAction(input: {
  request: ActionRequest; before?: Observation; result: ActionResult; secret: boolean; index: number; now?: Date;
}): RecordedAgentAction {
  const { request: r, before, result, index } = input;
  const target = before && r.ref ? before.controls.find((c) => c.ref === r.ref) : undefined;
  const to = before && r.toRef ? before.controls.find((c) => c.ref === r.toRef) : undefined;
  const typed = r.action === 'fill' || (r.action === 'press' && r.key !== undefined && r.key.split('+').at(-1)!.length === 1);
  const secret = typed && (input.secret || target?.value === '••••' || (result.outcome === 'error' && !!target && SECRETISH_NAME.test(target.name)));
  const args: RecordedArgs = {};
  let truncated = false;
  if (r.value !== undefined) {
    if (secret) args.value = SECRET_MASK;
    else { args.value = r.value.slice(0, VALUE_MAX); truncated = r.value.length > VALUE_MAX; }
  }
  if (r.key !== undefined) args.key = secret ? SECRET_MASK : r.key;
  if (r.values !== undefined) args.values = r.values.slice(0, 100).map((v) => v.slice(0, VALUE_MAX));
  for (const k of ['direction', 'amount', 'dx', 'dy', 'files', 'tab', 'path'] as const) if (r[k] !== undefined) (args as Record<string, unknown>)[k] = r[k];
  const after = result.observation ?? before;
  const t = recordedTarget(target);
  const tt = recordedTarget(to);
  return {
    index, at: (input.now ?? new Date()).toISOString(), actor: 'agent', action: r.action,
    ...(t ? { target: t } : {}), ...(tt ? { toTarget: tt } : {}), args,
    ...(secret ? { secret: true as const } : {}), ...(truncated ? { truncated: true as const } : {}),
    ...(before ? { routeBefore: routePath(before.route), ...(before.dialog ? { dialogBefore: before.dialog } : {}) } : {}),
    ...(after ? { routeAfter: routePath(after.route), ...(after.dialog ? { dialogAfter: after.dialog } : {}) } : {}),
    outcome: result.outcome,
    ...(result.error ? { error: { code: result.error.code, message: redactSecrets(result.error.message).slice(0, 300) } } : {}),
    changes: result.changes ? formatChanges(result.changes).slice(0, CHANGE_LINES).map((l) => redactSecrets(l).slice(0, 200)) : [],
    newFindings: result.newFindings.map((f) => f.id),
    consequential: [t?.name, tt?.name].some((n) => n !== undefined && !!consequentialWord(n)),
  };
}

export class ActionLog {
  private entries: RecordedAction[] = [];
  private omitted = 0;
  private next = 1;
  private recent: RecordedObservation[] = [];
  private readonly secrets = new Set<string>();
  private typedKeys = '';
  /** Route of the first observation of the session. */
  startRoute = '/';

  /** The agent's next action. Values typed into password-like fields are remembered (in memory only) for redaction. */
  agent(input: Omit<Parameters<typeof recordAction>[0], 'index'>): void {
    const entry = recordAction({ ...input, index: this.next });
    if (entry.secret && input.request.action === 'fill' && input.request.value !== undefined) this.remember(input.request.value);
    if (entry.secret && input.request.action === 'press' && input.request.key) {
      this.typedKeys += input.request.key;
      this.remember(this.typedKeys);
    } else this.typedKeys = '';
    this.push(entry);
  }

  person(description: string, now = new Date()): void {
    this.typedKeys = '';
    this.push({ index: this.next, at: now.toISOString(), actor: 'person', description: redactSecrets(description).slice(0, 200) });
  }

  observation(o: Observation): void {
    this.recent.push(summariseObservation(o));
    if (this.recent.length > OBSERVATION_LOG_LIMIT) this.recent.shift();
  }

  private push(entry: RecordedAction): void {
    this.next++;
    this.entries.push(entry);
    if (this.entries.length > ACTION_LOG_LIMIT) { this.entries.shift(); this.omitted++; }
  }

  private remember(value: string): void {
    if (value.length >= MIN_TRACKED_SECRET) this.secrets.add(value);
  }

  get actions(): RecordedAction[] { return structuredClone(this.entries); }
  get actionsOmitted(): number { return this.omitted; }
  get observations(): RecordedObservation[] { return structuredClone(this.recent); }
  /** Values the agent typed into password-like fields. For redaction passes only: never logged, never returned to a caller outside the process. */
  secretValues(): string[] { return [...this.secrets]; }
}
