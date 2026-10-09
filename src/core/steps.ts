import type { Lab, TargetQuery } from './lab.js';
import type { ActionName, ActionRequest, ActionResult, Direction, Finding, Observation } from './schema.js';

// Steps shared by flows (src/cli/flow.ts) and scan scenarios (src/core/scan.ts): role/name targets are
// resolved against the latest observation (never guessed) into the same ActionRequest the CLI and MCP
// send, and expectations are checked against the resulting observation.

export interface Expectation {
  route?: string;
  heading?: string;
  dialog?: string | null;
  message?: string;
  control?: TargetQuery & { disabled?: boolean; invalid?: boolean };
  noControl?: TargetQuery;
  /** "clean" for no flags, or a list of flags that must be present. */
  layout?: 'clean' | { kind: string; name?: string }[];
  note?: string;
  navigated?: boolean;
  /** The active tab after the step, e.g. "t2". */
  tab?: string;
  /** "none": no findings in the session so far; or findings that must have been recorded. */
  findings?: 'none' | { kind: string; name?: string; severity?: string }[];
}

export interface FlowStep extends TargetQuery {
  do?: ActionName;
  value?: string;
  /** press */
  key?: string;
  /** select */
  values?: string[];
  /** scroll, swipe */
  direction?: Direction;
  amount?: number;
  /** drag: the drop target by role/name, or an offset */
  to?: TargetQuery;
  dx?: number;
  dy?: number;
  /** upload: project-relative files */
  files?: string[];
  /** switch_tab, close_tab / open_tab */
  tab?: string;
  path?: string;
  label?: string;
  expect?: Expectation;
}

/** Resolve a step's role/name targets against the latest observation (never guessed) into a request. */
export function stepRequest(lab: Lab, step: FlowStep): ActionRequest {
  const hasTarget = step.name !== undefined || step.nameContains !== undefined;
  const ref = hasTarget ? lab.findRef({ role: step.role, name: step.name, nameContains: step.nameContains }) : undefined;
  const toRef = step.to ? lab.findRef(step.to) : undefined;
  const { do: action, value, key, values, direction, amount, dx, dy, files, tab, path } = step;
  return Object.fromEntries(Object.entries({ action, ref, value, key, values, direction, amount, toRef, dx, dy, files, tab, path })
    .filter(([, v]) => v !== undefined)) as unknown as ActionRequest;
}

/** A step aimed at a field with one of these words in its name or role carries a secret: its value is never shown. */
export const SECRET_FIELD = /pass|secret|token|otp|pin|cvv|cvc/i;
export const isSecretStep = (s: Pick<FlowStep, 'name' | 'nameContains' | 'role'>): boolean => SECRET_FIELD.test(`${s.name ?? ''} ${s.nameContains ?? ''} ${s.role ?? ''}`);

export function describeStep(step: FlowStep): string {
  if (!step.do) return 'check';
  const has = step.name !== undefined || step.nameContains !== undefined;
  const target = has ? `${step.role ?? 'control'} ${step.name !== undefined ? JSON.stringify(step.name) : `containing ${JSON.stringify(step.nameContains)}`}` : '';
  switch (step.do) {
    // The label is printed before the lab sees the field, so it cannot know a password field by its type:
    // a fill's value never appears here. The action line that follows shows it when the field is not secret.
    case 'fill': return `fill ${target}`;
    // A single character may be part of a password: only named keys (Enter, Tab, Control+a) are shown.
    case 'press': return `press ${step.key && [...step.key].length === 1 ? 'a character' : step.key}${target ? ` in ${target}` : ''}`;
    case 'select': return `select ${(step.values ?? []).join(', ')} in ${target}`;
    case 'scroll': case 'swipe': return `${step.do} ${step.direction ?? 'to'}${target ? ` ${target}` : ''}`;
    case 'upload': return `upload ${(step.files ?? []).join(', ')} to ${target}`;
    case 'drag': return `drag ${target} ${step.to ? `onto ${step.to.name}` : `by (${step.dx ?? 0}, ${step.dy ?? 0})`}`;
    case 'open_tab': return `open tab at ${step.path}`;
    case 'switch_tab': case 'close_tab': return `${step.do} ${step.tab ?? ''}`.trim();
    default: return `${step.do}${target ? ` ${target}` : ''}`;
  }
}

const matches = (o: Observation, q: TargetQuery) => o.controls.filter((c) =>
  (!q.role || c.role === q.role) && (q.name === undefined || c.name === q.name) && (q.nameContains === undefined || c.name.includes(q.nameContains)));

/** Evaluate expectations against the latest observation and action. Exported for tests. */
export function check(e: Expectation, o: Observation, action?: ActionResult, findings: Finding[] = []): { ok: boolean; text: string }[] {
  const checks: { ok: boolean; text: string }[] = [];
  const add = (ok: boolean, text: string) => checks.push({ ok, text });
  if (e.route !== undefined) add(o.route === e.route, `route is ${e.route} (got ${o.route})`);
  if (e.heading !== undefined) add(o.headings.some((h) => h.replace(/^h\d /, '') === e.heading), `heading "${e.heading}" (got ${o.headings.join(' | ') || 'none'})`);
  if (e.dialog !== undefined) {
    add(e.dialog === null ? o.dialog === undefined : o.dialog === e.dialog,
      e.dialog === null ? `no dialog open (got ${o.dialog ?? 'none'})` : `dialog "${e.dialog}" open (got ${o.dialog ?? 'none'})`);
  }
  if (e.message !== undefined) add(o.messages.some((m) => m.text.includes(e.message!)), `message containing "${e.message}" (got ${o.messages.map((m) => m.text).join(' | ') || 'none'})`);
  if (e.control) {
    const { disabled, invalid, ...q } = e.control;
    const found = matches(o, q).filter((c) => (disabled === undefined || !!c.disabled === disabled) && (invalid === undefined || !!c.invalid === invalid));
    add(found.length > 0, `control ${JSON.stringify(e.control)} present`);
  }
  if (e.noControl) add(matches(o, e.noControl).length === 0, `no control ${JSON.stringify(e.noControl)}`);
  if (e.layout === 'clean') add(o.layout.length === 0, `no layout flags (got ${o.layout.map((f) => f.kind).join(', ') || 'none'})`);
  else if (Array.isArray(e.layout)) {
    for (const want of e.layout) {
      const hit = o.layout.some((f) => f.kind === want.kind && (!want.name || (!!f.ref && o.controls.some((c) => c.ref === f.ref && c.name === want.name))));
      add(hit, `layout flag ${want.kind}${want.name ? ` on "${want.name}"` : ''} reported`);
    }
  }
  if (e.note !== undefined) add(!!action?.notes.some((n) => n.includes(e.note!)), `action note containing "${e.note}"`);
  if (e.navigated !== undefined) add(action?.navigated === e.navigated, `navigated is ${e.navigated}`);
  if (e.tab !== undefined) add((o.tab ?? 't1') === e.tab, `active tab is ${e.tab} (got ${o.tab ?? 't1'})`);
  if (e.findings === 'none') add(findings.length === 0, `no findings in session (got ${findings.map((f) => `${f.id} ${f.kind}`).join(', ') || 'none'})`);
  else if (Array.isArray(e.findings)) {
    for (const want of e.findings) {
      const hit = findings.find((f) => f.kind === want.kind && (!want.name || f.target?.name === want.name) && (!want.severity || f.severity === want.severity));
      add(!!hit, `finding ${want.kind}${want.name ? ` on "${want.name}"` : ''}${want.severity ? ` (${want.severity})` : ''} recorded${hit ? ` as ${hit.id}` : ''}`);
    }
  }
  return checks;
}
