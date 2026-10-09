import type { RawPage } from './extract.js';
import { redactUrlSecrets } from './url-redact.js';
import { SCHEMA_VERSION, type Changes, type Control, type ControlSummary, type FieldChange, type LayoutFlag, type Observation } from './schema.js';

/** Turn raw page data into a normalised observation with layout flags. Pure. */
export function buildObservation(
  raw: RawPage,
  ctx: { sessionId: string; gen: number; consoleErrors: number; failedRequests: number },
): Observation {
  const { pathname, search, hash } = new URL(raw.url);
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: ctx.sessionId,
    gen: ctx.gen,
    docId: raw.docId,
    // Tokens in the query or fragment never leave the page: see url-redact.ts.
    url: redactUrlSecrets(raw.url),
    route: redactUrlSecrets(pathname + search + hash),
    title: raw.title,
    viewport: raw.viewport,
    scroll: raw.scroll,
    documentWidth: raw.documentWidth,
    layoutViewportWidth: raw.layoutViewportWidth,
    headings: raw.headings,
    ...(raw.dialog !== undefined ? { dialog: raw.dialog } : {}),
    controls: raw.controls,
    omitted: raw.omitted,
    inert: raw.inert,
    messages: raw.messages,
    ...(raw.focused ? { focused: raw.focused } : {}),
    layout: layoutFlags(raw),
    console: { errors: ctx.consoleErrors },
    network: { failed: ctx.failedRequests },
    findings: 0,
  };
}

/**
 * First-slice layout signals, measured in CSS px. This is not the responsive scanner: it only reports
 * document-level horizontal overflow and observed controls that extend past the layout viewport.
 */
export function layoutFlags(raw: Pick<RawPage, 'viewport' | 'documentWidth' | 'controls'> & { layoutViewportWidth?: number }): LayoutFlag[] {
  const flags: LayoutFlag[] = [];
  const vw = raw.viewport.width;
  if (raw.documentWidth > vw + 1) {
    flags.push({
      kind: 'horizontal-overflow',
      severity: 'medium',
      key: 'overflow',
      message: `document is ${raw.documentWidth}px wide, viewport is ${vw}px (page pans sideways)` +
        (raw.layoutViewportWidth && raw.layoutViewportWidth > vw + 1 ? `; mobile browser widened the layout viewport to ${raw.layoutViewportWidth}px` : ''),
      evidence: { documentWidth: raw.documentWidth, viewportWidth: vw, excessPx: raw.documentWidth - vw, ...(raw.layoutViewportWidth ? { layoutViewportWidth: raw.layoutViewportWidth } : {}) },
    });
  }
  for (const c of raw.controls) {
    if (!c.clip) continue;
    const beyond = Math.min(c.clip.px, c.rect.w);
    const hiddenShare = beyond / Math.max(c.rect.w, 1);
    flags.push({
      kind: 'control-clipped',
      severity: hiddenShare >= 0.5 ? 'high' : 'medium',
      key: `clipped:${c.ref}`,
      ref: c.ref,
      message: `${c.role} "${c.name}" extends ${c.clip.px}px past the ${c.clip.side} edge of the ${vw}px viewport` +
        (hiddenShare >= 1 ? ' (entirely outside the initial view)' : ` (${Math.round(hiddenShare * 100)}% outside)`),
      evidence: { left: c.rect.x, right: c.rect.x + c.rect.w, width: c.rect.w, viewportWidth: vw, side: c.clip.side, pastEdgePx: c.clip.px },
    });
  }
  return flags;
}

const summary = (c: Control): ControlSummary => ({ ref: c.ref, role: c.role, name: c.name });
const TRACKED: (keyof Control)[] = ['name', 'value', 'disabled', 'checked', 'pressed', 'expanded', 'selected', 'required', 'invalid'];

/** Compare two observations. Refs are identity; a new document resets the baseline. Pure. */
export function diffObservations(prev: Observation | undefined, next: Observation): Changes {
  const changes: Changes = {
    added: [], removed: [], changed: [], rerendered: [], covered: 0, uncovered: 0,
    messagesAdded: [], messagesRemoved: [], headingsAdded: [], headingsRemoved: [],
    layoutAdded: [], layoutResolved: [], none: false,
  };
  if (!prev) {
    changes.reset = { reason: 'no-baseline' };
    return changes;
  }
  if (prev.route !== next.route) changes.route = { from: prev.route, to: next.route };
  if (prev.title !== next.title) changes.title = { from: prev.title, to: next.title };
  if (prev.docId !== next.docId) {
    changes.reset = { reason: 'navigation' };
    return changes;
  }

  if (prev.dialog !== next.dialog) changes.dialog = { from: prev.dialog, to: next.dialog };

  const before = new Map(prev.controls.map((c) => [c.ref, c]));
  const after = new Map(next.controls.map((c) => [c.ref, c]));
  const prevInert = new Map(prev.inert.map((c) => [c.ref, c]));
  const nextInert = new Set(next.inert.map((c) => c.ref));

  const appeared: Control[] = [];
  for (const [ref, c] of after) {
    const old = before.get(ref);
    if (!old) {
      if (prevInert.has(ref)) changes.uncovered++;
      else appeared.push(c);
      continue;
    }
    const fields: FieldChange[] = [];
    for (const key of TRACKED) {
      const a = old[key] ?? (key === 'value' || key === 'name' ? undefined : false);
      const b = c[key] ?? (key === 'value' || key === 'name' ? undefined : false);
      if (a !== b) fields.push({ field: key, from: a, to: b });
    }
    if (fields.length) changes.changed.push({ ...summary(c), fields });
  }
  // Gone from view: previously observed controls, plus controls that disappeared while covered by a dialog.
  const vanished: ControlSummary[] = [];
  for (const [ref, c] of before) {
    if (after.has(ref)) continue;
    if (nextInert.has(ref)) changes.covered++;
    else vanished.push(summary(c));
  }
  for (const [ref, c] of prevInert) if (!after.has(ref) && !nextInert.has(ref)) vanished.push(c);

  // Re-render heuristic: a vanished and an appeared control with the same role and name are the same
  // thing drawn again. Match by identity of role+name only, never by list position.
  const pool = new Map<string, ControlSummary[]>();
  for (const v of vanished) {
    const key = `${v.role}\u0000${v.name}`;
    pool.set(key, [...(pool.get(key) ?? []), v]);
  }
  for (const c of appeared) {
    const match = pool.get(`${c.role}\u0000${c.name}`)?.shift();
    if (match) changes.rerendered.push({ ...summary(c), from: match.ref, to: c.ref });
    else changes.added.push(summary(c));
  }
  changes.removed = [...pool.values()].flat();

  const msgKey = (m: { role: string; text: string }) => `${m.role}\u0000${m.text}`;
  const prevMsgs = new Set(prev.messages.map(msgKey));
  const nextMsgs = new Set(next.messages.map(msgKey));
  changes.messagesAdded = next.messages.filter((m) => !prevMsgs.has(msgKey(m)));
  changes.messagesRemoved = prev.messages.filter((m) => !nextMsgs.has(msgKey(m)));
  changes.headingsAdded = next.headings.filter((h) => !prev.headings.includes(h));
  changes.headingsRemoved = prev.headings.filter((h) => !next.headings.includes(h));
  if (prev.focused !== next.focused) changes.focus = { from: prev.focused, to: next.focused };

  const prevFlags = new Set(prev.layout.map((f) => f.key));
  const nextFlags = new Set(next.layout.map((f) => f.key));
  changes.layoutAdded = next.layout.filter((f) => !prevFlags.has(f.key));
  // A flag whose control merely left the observation (e.g. covered by a dialog) is not "resolved".
  changes.layoutResolved = prev.layout.filter((f) => !nextFlags.has(f.key) && (!f.ref || after.has(f.ref)));

  changes.none = !changes.route && !changes.title && !changes.dialog && !changes.added.length && !changes.removed.length &&
    !changes.changed.length && !changes.rerendered.length && !changes.covered && !changes.uncovered && !changes.messagesAdded.length &&
    !changes.messagesRemoved.length && !changes.headingsAdded.length && !changes.headingsRemoved.length &&
    !changes.focus && !changes.layoutAdded.length && !changes.layoutResolved.length;
  return changes;
}
