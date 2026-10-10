import { MAX_FINDINGS } from './findings.js';
import type { CloseResult, HumanAction, InspectResult, StartResult } from './lab.js';
import { stopReason, type ControlChange } from './control.js';
import type { ActionResult, Changes, Control, Finding, LabErrorJSON, Observation, ServiceInfo, ScanResult, SettleReport, SweepResult, TabInfo } from './schema.js';

// Concise text renderings for agents and people. JSON output carries the full structure.

const q = (s: string) => JSON.stringify(s);
const MAX_CHANGE_ITEMS = 12;
const MAX_SCAN_GROUPS = 12;

export function formatControl(c: Control): string {
  const parts = [c.ref, c.role, q(c.name)];
  if (c.context) parts.push(`in ${q(c.context)}`);
  if (c.value !== undefined && c.value !== '') parts.push(`value=${q(c.value)}`);
  if (c.checked !== undefined) parts.push(c.checked ? 'checked' : 'unchecked');
  if (c.pressed !== undefined) parts.push(c.pressed ? 'pressed' : 'not-pressed');
  if (c.selected !== undefined) parts.push(c.selected ? 'selected' : 'not-selected');
  if (c.expanded !== undefined) parts.push(c.expanded ? 'expanded' : 'collapsed');
  for (const flag of ['disabled', 'required', 'invalid', 'focused'] as const) if (c[flag]) parts.push(flag);
  if (c.offscreen) parts.push(`offscreen-${c.offscreen}`);
  if (c.clip) parts.push(`CLIPPED-${c.clip.side} ${c.clip.px}px`);
  return parts.join(' ');
}

export function formatObservation(o: Observation): string {
  const lines = [
    `gen ${o.gen}  route ${o.route}  title ${q(o.title)}  viewport ${o.viewport.width}x${o.viewport.height}  scroll ${o.scroll.x},${o.scroll.y}`,
  ];
  if (o.headings.length) lines.push(`headings: ${o.headings.map((h) => h.replace(/^(h\d) (.*)$/, (_, t, n) => `${t} ${q(n)}`)).join('; ')}`);
  if (o.dialog !== undefined) lines.push(`dialog: ${q(o.dialog)} (modal; ${o.inert.length} background controls inert)`);
  lines.push(`controls (${o.controls.length}${o.omitted ? `, ${o.omitted} omitted by budget` : ''}):`);
  for (const c of o.controls) lines.push(`  ${formatControl(c)}`);
  if (o.messages.length) lines.push(`messages: ${o.messages.map((m) => `${m.role} ${q(m.text)}`).join('; ')}`);
  lines.push(o.layout.length
    ? `layout: ${o.layout.length} flag(s)\n${o.layout.map((f) => `  [${f.severity}] ${f.kind}: ${f.message}`).join('\n')}`
    : 'layout: no flags');
  lines.push(`console: ${o.console.errors} errors  network: ${o.network.failed} failed requests  findings: ${o.findings} in session${o.findings ? ' (inspect for details)' : ''}`);
  return lines.join('\n');
}

/** Why a settle timed out, in words (what was still busy and what to tune). */
export function settleCauseText(cause: SettleReport['cause'], pending: readonly string[] = []): string {
  return cause === 'network'
    ? `request still open: ${pending.join(', ')}; if it is long-lived by design, add it to settle.backgroundRequests`
    : cause === 'busy' ? 'the page kept a visible aria-busy="true" region'
    : cause === 'timers' ? 'short timers kept being scheduled; if that is a polling loop, lower settle.timerMaxMs or set it to 0'
    : cause === 'route' ? 'the address changed to a new route but the page never rendered it (no elements were added or removed)'
    : cause === 'empty' ? 'the page has scripts but nothing was drawn (the app root is still empty); a page that is meant to be blank will always time out here'
    : 'the DOM kept changing';
}

export function formatSettle(s: SettleReport): string {
  const ignored = s.ignored ? `; ${s.ignored} background request${s.ignored === 1 ? '' : 's'} not awaited` : '';
  if (s.reason === 'quiet') return `settled quiet in ${s.ms}ms${ignored}`;
  return `settle timed out after ${s.ms}ms (${settleCauseText(s.cause, s.pending)})${ignored}`;
}

export function formatFinding(f: Finding, detail = false): string {
  const head = `${f.id} [${f.severity}, ${f.confidence}] ${f.kind} @${f.device}: ${f.message}`;
  if (!detail) return head;
  const evidence = Object.entries(f.evidence).map(([k, v]) => `${k}=${v}`).join(' ');
  return [
    head,
    `  device ${f.device} (${f.viewportWidth}px) · route ${f.route} · source ${f.source} · seen ${f.occurrences}x (gen ${f.firstSeen.gen}–${f.lastSeenGen})`,
    `  evidence: ${evidence}`,
    '  reproduce:',
    ...f.reproduction.map((step, i) => `    ${i + 1}. ${step}`),
  ].join('\n');
}

export function formatInspect(r: InspectResult): string {
  const lines: string[] = [];
  if (r.control) lines.push(`control ${formatControl(r.control)}  rect x=${r.control.rect.x} y=${r.control.rect.y} w=${r.control.rect.w} h=${r.control.rect.h}`);
  if (!r.findings.length) lines.push(r.control ? 'no findings for this control' : 'no findings in this session');
  const detail = r.findings.length === 1 || !!r.control;
  for (const f of r.findings) lines.push(formatFinding(f, detail));
  if (r.omitted) lines.push(`${r.omitted} further findings were not recorded (the session keeps at most ${MAX_FINDINGS})`);
  return lines.join('\n');
}

export function formatChanges(c: Changes): string[] {
  const items: string[] = [];
  if (c.tabs) {
    if (c.tabs.opened.length) items.push(`+ tab ${c.tabs.opened.join(', ')}`);
    if (c.tabs.closed.length) items.push(`- tab ${c.tabs.closed.join(', ')}`);
    if (c.tabs.active) items.push(`active tab ${c.tabs.active.from} → ${c.tabs.active.to}`);
  }
  if (c.route) items.push(`route ${c.route.from} → ${c.route.to}`);
  if (c.title) items.push(`title ${q(c.title.from)} → ${q(c.title.to)}`);
  if (c.dialog) {
    if (c.dialog.to !== undefined && c.dialog.from === undefined) items.push(`+ dialog ${q(c.dialog.to)}`);
    else if (c.dialog.to === undefined) items.push(`- dialog ${q(c.dialog.from ?? '')}`);
    else items.push(`dialog ${q(c.dialog.from ?? '')} → ${q(c.dialog.to)}`);
  }
  for (const h of c.headingsAdded) items.push(`+ ${h}`);
  for (const h of c.headingsRemoved) items.push(`- ${h}`);
  for (const a of c.added) items.push(`+ ${a.role} ${q(a.name)} ${a.ref}`);
  for (const r of c.removed) items.push(`- ${r.role} ${q(r.name)} ${r.ref}`);
  for (const ch of c.changed) {
    const fields = ch.fields.map((f) => typeof f.to === 'boolean' ? (f.to ? f.field : `not ${f.field}`) : f.to === '••••' ? `${f.field} set (hidden: password field)` : `${f.field} ${q(String(f.from ?? ''))}→${q(String(f.to ?? ''))}`);
    items.push(`~ ${ch.role} ${ch.ref} ${fields.join(', ')}`);
  }
  if (c.rerendered.length) items.push(`${c.rerendered.length} unchanged controls re-rendered with new refs (${c.rerendered.map((r) => `${r.from}→${r.to}`).join(', ')})`);
  if (c.covered) items.push(`${c.covered} background controls now behind the dialog`);
  if (c.uncovered) items.push(`${c.uncovered} background controls available again`);
  for (const m of c.messagesAdded) items.push(`+ ${m.role} ${q(m.text)}`);
  for (const m of c.messagesRemoved) items.push(`- ${m.role} ${q(m.text)}`);
  if (c.focus) items.push(`focus ${c.focus.from ?? 'none'} → ${c.focus.to ?? 'none'}`);
  for (const f of c.layoutAdded) items.push(`+ layout [${f.severity}] ${f.kind}: ${f.message}`);
  for (const f of c.layoutResolved) items.push(`- layout ${f.kind} resolved`);
  if (items.length > MAX_CHANGE_ITEMS) {
    const rest = items.length - MAX_CHANGE_ITEMS;
    return [...items.slice(0, MAX_CHANGE_ITEMS), `… ${rest} more changes (observe for current state; CLI --json for all changes)`];
  }
  return items;
}

export function formatAction(r: ActionResult): string {
  const target = r.target ? ` ${r.target.role} ${q(r.target.name)}` : '';
  const head = `${r.action}${r.ref ? ` ${r.ref}` : ''}${target}`;
  if (r.outcome === 'error') {
    return [`${head} → ERROR ${formatError(r.error!)}`, ...r.notes.map((n) => `note: ${n}`), formatActionDiagnostics(r)].join('\n');
  }
  const lines = [`${head} → ok (${r.method}, ${r.elapsedMs}ms, ${r.settle ? formatSettle(r.settle) : 'settle unknown'})`];
  for (const n of r.notes) lines.push(`note: ${n}`);
  for (const f of r.newFindings) lines.push(`finding: ${formatFinding(f)}`);
  const c = r.changes!;
  if (c.reset) {
    const tabs = c.tabs ? formatChanges({ ...c, route: undefined, dialog: undefined, headingsAdded: [], headingsRemoved: [], added: [], removed: [], changed: [], rerendered: [], messagesAdded: [], messagesRemoved: [], layoutAdded: [], layoutResolved: [], focus: undefined, title: undefined, covered: 0, uncovered: 0 }).join('; ') + '; ' : '';
    const why = c.reset.reason === 'tab' ? 'another tab, baseline reset; refs from the previous tab need switch_tab' : 'new document, baseline reset; refs from the previous page are stale';
    lines.push(`changed: ${tabs}${c.route ? `route ${c.route.from} → ${c.route.to}; ` : ''}${why}`);
    lines.push(formatObservation(r.observation!));
  } else if (c.none) {
    lines.push('changed: no visible change');
  } else {
    lines.push(`changed: ${formatChanges(c).join('; ')}`);
  }
  if (!c.reset) {
    const o = r.observation!;
    if (o.omitted) lines.push(`controls: ${o.omitted} omitted by budget (observe with a larger limit for current controls)`);
    if (c.removed.length) lines.push(`refs: ${c.removed.length <= 8 ? c.removed.map((x) => x.ref).join(', ') : `${c.removed.length} earlier refs`} no longer exist; act on refs from this result or a fresh observe`);
    if (o.layout.length && !c.layoutAdded.length) lines.push(`layout: ${o.layout.length} existing flag(s) still present`);
  }
  lines.push(formatActionDiagnostics(r));
  return lines.join('\n');
}

function formatActionDiagnostics(r: ActionResult): string {
  const errs = r.newConsoleErrors.map((e) => q(e.text)).join('; ');
  const fails = r.newFailedRequests.map((f) => `${f.method} ${f.url} ${f.status ?? f.failure}`).join('; ');
  return `console: ${r.newConsoleErrors.length} new errors${errs ? ` (${errs})` : ''}  network: ${r.newFailedRequests.length} new failures${fails ? ` (${fails})` : ''}`;
}

export function formatStart(r: StartResult): string {
  const s = r.session;
  const d = s.device;
  const srv = r.server;
  const server = srv.owned
    ? `started ${q(srv.command ?? '')} pid ${srv.pid} → ${srv.url} ready in ${srv.readyMs}ms (owned: stopped on close)`
    : `reused healthy server at ${srv.url} (not owned: left running on close)`;
  const services = (r.services ?? []).length > 1 ? r.services.map((x) => `  ${formatService(x)}`) : [];
  return [
    `session ${s.id}  device ${d.id} ${d.viewport.width}x${d.viewport.height} @${d.deviceScaleFactor}x${d.hasTouch ? ' touch' : ''}  ${s.browser.headed ? 'headed' : 'headless'}${s.auth === 'saved-state' ? '  signed in from saved state' : ''}`,
    `environment: ${s.environment} (emulation, not a real device)`,
    `server: ${server}`,
    ...(services.length ? [`services (in ready order):`, ...services] : []),
    `run dir: ${s.runDir}`,
    formatObservation(r.observation),
  ].join('\n');
}

export function formatSweep(r: SweepResult): string {
  const byId = new Map(r.findings.map((f) => [f.id, f]));
  const lines = [`sweep ${r.id} of ${r.route}: ${r.devices.length} widths in ${r.ms}ms (serial, isolated contexts)`];
  for (const d of r.devices) {
    if (d.status === 'error') { lines.push(`  ${d.device} (${d.width}px): ERROR ${d.error?.code}: ${d.error?.message}`); continue; }
    const fs = d.findings.map((id) => byId.get(id)).filter((f): f is Finding => !!f);
    const confirmed = fs.filter((f) => f.confidence === 'confirmed');
    lines.push(`  ${d.device} (${d.width}px): document ${d.documentWidth}px, ${d.controls} controls, ${d.reachChecked} reach-checked → ` +
      (fs.length ? `${confirmed.length} confirmed, ${fs.length - confirmed.length} heuristic` : 'clean') +
      (d.settled !== 'quiet' ? `; settle timed out (${settleCauseText(d.settleCause ?? 'dom')})` : ''));
    for (const f of fs) lines.push(`    ${f.id} [${f.severity}, ${f.confidence}] ${f.kind}${f.target ? ` ${f.target.role} ${q(f.target.name)}` : ''}`);
  }
  if (r.interrupted) lines.push(`  interrupted (${r.interrupted.reason}${r.interrupted.by ? ` by ${r.interrupted.by}` : ''}): not run at ${r.interrupted.skipped.join(', ')}`);
  lines.push(`report: ${r.report}  (inspect <id> for measurements and reproduction)`);
  return lines.join('\n');
}

export function formatScan(r: ScanResult): string {
  const groups = r.groups.filter((g) => !g.suppressed);
  const confirmed = groups.filter((g) => g.confidence === 'confirmed').length;
  const suppressed = r.groups.length - groups.length;
  const failed = r.runs.filter((x) => x.status === 'failed').length;
  const lines = [`scan ${r.id}: ${r.verdict.result.toUpperCase()} · ${r.runs.length} scenario runs (${failed} failed) · ${r.groups.length} problems (${confirmed} confirmed, ${groups.length - confirmed} heuristic, ${suppressed} suppressed) · ${r.ms} ms`];
  for (const reason of r.verdict.reasons) lines.push(reason);
  for (const run of r.runs) {
    lines.push(run.status === 'ok'
      ? `  ${run.scenario} @ ${run.device}: ok, ${run.states.length} states, ${run.findings.length} findings`
      : `  ${run.scenario} @ ${run.device}: FAILED at ${run.failedAt ?? 'unknown'}: ${run.error?.message ?? 'no message'}`);
  }
  if (groups.length) lines.push('problems (each G groups the findings F that are the same problem at different widths or scenarios; `inspect F1` shows one):');
  for (const g of groups.slice(0, MAX_SCAN_GROUPS)) lines.push(`  ${g.id} ${g.severity} ${g.confidence} ${g.title} [${g.devices.join(', ')}] (${g.findings.join(', ')})`);
  if (groups.length > MAX_SCAN_GROUPS) lines.push(`  … ${groups.length - MAX_SCAN_GROUPS} more`);
  lines.push(`report: ${r.reports.html}`, `json: ${r.reports.json}`);
  return lines.join('\n');
}

export function formatClose(r: CloseResult): string {
  const srv = r.server.owned
    ? `server ${r.server.stopped ? 'stopped' : 'NOT stopped'} (${r.server.detail})`
    : `server left running (${r.server.detail})`;
  const others = (r.services ?? []).length > 1
    ? `\nservices: ${r.services.map((x) => `${x.name} ${x.owned ? (x.stopped ? 'stopped' : 'NOT stopped') : 'left running'} (${x.detail})`).join('; ')}`
    : '';
  return `closed (${r.reason}): browser ${r.browserClosed ? 'closed' : 'was already gone'}; ${srv}${others}`;
}

export function formatService(s: ServiceInfo): string {
  return s.owned
    ? `${s.name}: started ${q(s.command)}${s.pid ? ` pid ${s.pid}` : ''}${s.url ? ` → ${s.url}` : ''}, ready (${s.readiness}) in ${s.readyMs}ms (owned)`
    : `${s.name}: reused ${s.url ?? s.readiness} (not owned: left running)`;
}

export function formatTabs(tabs: TabInfo[]): string {
  return tabs.map((t) => `${t.active ? '*' : ' '} ${t.id} ${t.url}${t.title ? `  ${q(t.title)}` : ''}${t.opener ? `  (opened by ${t.opener})` : ''}`).join('\n');
}

export function formatError(e: LabErrorJSON): string {
  const lines = [`${e.code}: ${e.message}`];
  lines.push(`recoverable: ${e.recoverable}`);
  if (e.hint) lines.push(`hint: ${e.hint}`);
  const control = e.details?.control;
  if (control && typeof control === 'object') {
    const s = control as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof s.mode === 'string') parts.push(s.mode);
    if (typeof s.pending === 'string') parts.push(`pending=${s.pending}`);
    if (typeof s.by === 'string') parts.push(`by=${q(s.by)}`);
    if (typeof s.since === 'string') parts.push(`since=${q(s.since)}`);
    if (typeof s.observeRequired === 'boolean') parts.push(`observeRequired=${s.observeRequired}`);
    if (typeof s.interrupt === 'boolean') parts.push(`interrupt=${s.interrupt}`);
    if (typeof s.humanInteractions === 'number') parts.push(`humanInteractions=${s.humanInteractions}`);
    if (s.busy && typeof s.busy === 'object') {
      const busy = s.busy as Record<string, unknown>;
      if (typeof busy.command === 'string') parts.push(`busy=${q(busy.command)}`);
      if (typeof busy.since === 'string') parts.push(`busySince=${q(busy.since)}`);
    }
    if (parts.length) lines.push(`control: ${parts.join(' ')}`);
  }
  const tail = e.details?.logTail;
  if (Array.isArray(tail) && tail.length) lines.push('server log tail:', ...tail.map((l) => `  ${l}`));
  if (typeof e.details?.logFile === 'string') lines.push(`log file: ${e.details.logFile}`);
  const missing = e.details?.missing;
  if (Array.isArray(missing)) lines.push(...missing.map((m: any) => `  ${m.service} needs: ${m.names.join(', ')}`));
  const services = e.details?.services;
  if (Array.isArray(services)) lines.push('services:', ...services.map((s: any) => `  ${s.name}: ${s.status}${s.detail && s.status !== 'failed' ? ` (${s.detail})` : ''}${s.stopped ? `; stopped (${s.stopped})` : ''}`));
  const options = e.details?.options;
  if (Array.isArray(options)) lines.push(`options: ${options.map((o) => q(String(o))).join(', ')}`);
  const candidates = e.details?.candidates;
  if (Array.isArray(candidates)) lines.push(`candidates: ${candidates.map((c: any) => `${c.ref} ${c.role} ${q(c.name)}`).join('; ')}`);
  const sameRole = e.details?.sameRole;
  if (Array.isArray(sameRole)) lines.push(`same role: ${sameRole.map((c) => q(String(c))).join('; ')}`);
  return lines.join('\n');
}

/** A person's interaction in words, e.g. `tapped button "Save"`, `typed into textbox "Password" (hidden)`. */
export function formatHuman(a: HumanAction): string {
  const t = a.target ? ` ${a.target.role}${a.target.name ? ` ${q(a.target.name)}` : ''}` : '';
  switch (a.type) {
    case 'tap': return `tapped${t}`;
    case 'type': return `typed into${t}${a.secret ? ' (hidden)' : a.chars !== undefined ? ` (${a.chars} chars)` : ''}${a.late ? ' (reported as control returned)' : ''}`;
    case 'key': return `pressed ${a.detail ?? 'a key'}${t ? ` in${t}` : ''}`;
    case 'select': return `chose in${t}${a.detail ? `: ${a.detail}` : ''}`;
    case 'check': return `${a.detail ?? 'toggled'}${t}`;
    case 'upload': return `chose files for${t}${a.detail ? `: ${a.detail}` : ''}`;
    case 'submit': return `submitted${t}`;
    case 'navigate': return `moved the page to ${a.detail ?? '?'}`;
    case 'input-dropped': return a.detail ?? 'more interactions not listed';
  }
}

/** A supervision change in words, for the timeline and the daemon log. */
export function formatControlChange(c: ControlChange): string {
  const s = c.state;
  const by = c.by ? ` (${c.by})` : '';
  switch (c.op) {
    case 'pause': return s.mode === 'pausing' ? `pause requested${by}: after ${s.busy?.command ?? 'the current action'} finishes; long commands stop at their next step` : `paused${by}`;
    case 'pause-next': return s.mode === 'pausing' ? `pause requested${by}: before the next action; ${s.busy?.command ?? 'the current command'} runs to the end` : `paused${by}`;
    case 'takeover': return s.mode === 'pausing' ? `takeover requested${by}: after ${s.busy?.command ?? 'the current action'} finishes` : `a person took control of the browser${by}`;
    case 'resume': return `resumed: the agent has control${by}${s.observeRequired ? '; refs from before are stale, observe required' : ''}`;
    case 'return': return `control returned to the agent${by}; refs from before are stale, observe required`;
    case 'stop': return s.mode === 'stopping' ? `stop requested${by}: after ${s.busy?.command ?? 'the current action'} finishes` : stopReason('stop', c.by);
    case 'emergency-stop': return `EMERGENCY STOP${by}: browser closed and owned services stopped now`;
    case 'observed': return 'the agent observed afresh; it may act again';
    case 'settled': return s.mode === 'human' ? 'a person has control of the browser (the action in flight finished)'
      : s.mode === 'paused' ? 'paused (the action in flight finished)' : s.mode === 'stopped' ? 'stopping now (the action in flight finished)' : `control: ${s.mode}`;
  }
}
