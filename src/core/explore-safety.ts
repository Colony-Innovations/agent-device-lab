import { matchesControl } from './detectors.js';
import type { ControlTraits } from './extract.js';
import type { Control, ExploreConfig, ExploreDecision } from './schema.js';

// Which controls automatic exploration may activate. Pure, so every rule is unit-tested. The order
// matters: a project deny entry and the hard blocks win over everything, a project allow entry wins
// over the name and form heuristics, and only controls whose attributes say what they open are
// explored on their own. Anything else that looks like it might open UI is skipped with the reason.

/** Names that suggest the action changes data, spends money, signs out or leaves: never activated automatically. */
const CONSEQUENTIAL = /\b(delete|remove|destroy|erase|purge|discard|clear all|archive|trash|unsubscribe|deactivate|close account|cancel|log ?out|sign ?out|pay|purchase|buy|checkout|check out|place order|order now|confirm|submit|send|publish|post|save|apply|book|reserve|transfer|withdraw|refund|charge|donate|subscribe|upgrade|downgrade|reset|revoke|block|report|approve|reject|accept|decline|invite|upload|attach|install|download|print|call|dial|share)\b/i;

/** The word that makes a control's name suggest a consequential action, if any (also used to gate replay). */
export function consequentialWord(name: string): string | undefined {
  return CONSEQUENTIAL.exec(name)?.[0];
}

/** Names that hint a control opens something, without attributes that say so: skipped as ambiguous. */
const MAYBE_OPENS = /\b(menu|filters?|sort|more|options|settings|details|show|expand|open|view|edit|actions?|toggle|drawer|panel|categories|account|profile|help|info|language|notifications?)\b|^[^\p{L}\p{N}]*$/iu;

const POPUP_KIND: Record<string, string> = { menu: 'menu', true: 'menu', listbox: 'listbox', tree: 'tree', grid: 'grid', dialog: 'dialog' };

/** Lower sorts first: panels that open over the page before toggles that only change a filter. */
export const KIND_PRIORITY: Record<string, number> = { 'allow-listed': 0, dialog: 1, menu: 2, listbox: 3, tree: 3, grid: 3, disclosure: 4, accordion: 5, tab: 6, toggle: 7 };

/**
 * The exploration verdict for one observed control, or undefined when it is not a candidate and not
 * worth recording (an ordinary link, a text field, an already open disclosure).
 */
export function classifyControl(c: Control, t: ControlTraits | undefined, cfg: Pick<ExploreConfig, 'allow' | 'deny'>, route: string): ExploreDecision | undefined {
  const base = { role: c.role, name: c.name, ...(c.context ? { context: c.context } : {}) };
  const skip = (reason: string): ExploreDecision => ({ ...base, verdict: 'skip', reason });
  const explore = (kind: string, reason: string): ExploreDecision => ({ ...base, verdict: 'explore', kind, reason });
  if (c.disabled) return undefined;
  const textual = ['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider'].includes(c.role) && !t?.haspopup;
  if (textual) return undefined; // typing is not exploration

  // 1. The project says never.
  if (cfg.deny.some((m) => matchesControl(m, c, route))) return skip('on the project\'s explore.deny list');
  if (!t) return skip('its attributes could not be read, so its safety cannot be determined');

  // 2. Hard blocks: leaving the app, files, downloads, new windows.
  if (t.file) return skip('opens a file chooser (upload)');
  if (t.link === 'external') return skip('external link: exploration stays on the app\'s origin');
  if (t.download) return skip('downloads a file');
  if (t.newTab) return skip('opens a new tab or window');

  // 3. The project says this control only opens UI.
  if (cfg.allow.some((m) => matchesControl(m, c, route))) return explore('allow-listed', 'on the project\'s explore.allow list');

  // 4. Consequential by name, or by what it does to a form.
  const named = CONSEQUENTIAL.exec(c.name);
  if (named) return skip(`its name suggests a consequential action ("${named[0]}")`);
  if (t.submits) return skip(`would submit the form${t.formName ? ` "${t.formName}"` : ''}`);
  if (t.resets) return skip('resets a form');
  if (t.link === 'same-origin') {
    return t.haspopup || t.expanded === 'false' ? skip('link to another page: exploration stays on this route') : undefined;
  }

  // 5. Attributes that say what it opens.
  if (t.haspopup && t.haspopup !== 'false') return explore(POPUP_KIND[t.haspopup] ?? 'menu', `aria-haspopup="${t.haspopup}"`);
  if (t.expanded === 'false') return explore(t.tag === 'summary' ? 'accordion' : 'disclosure', `aria-expanded="false"${t.controlsHidden ? ' and aria-controls names a hidden panel' : ''}`);
  if (t.expanded === 'true') return undefined; // already open; closing it is how the scan restores the state
  if (t.closedDetails) return explore('accordion', 'summary of a closed <details>');
  if ((t.role === 'tab' || c.role === 'tab') && t.selected !== 'true') return explore('tab', 'an unselected tab (role="tab")');
  if (t.controlsHidden) return explore('disclosure', 'aria-controls names a hidden panel');
  if (t.pressed === 'false' && c.role === 'button') return explore('toggle', 'a toggle button (aria-pressed="false") that filters or changes the view');

  // 6. Looks like it could open something, but nothing says what it does.
  if (c.role === 'menuitem' || c.role === 'menuitemcheckbox' || c.role === 'menuitemradio') return skip('a menu item performs an action; its purpose cannot be determined');
  if ((c.role === 'button' || c.role === 'link') && MAYBE_OPENS.test(c.name)) {
    return skip('purpose ambiguous: no aria-haspopup, aria-expanded, aria-controls or tab role says what it opens (add it to scan.explore.allow if it only opens UI)');
  }
  return undefined;
}

/** Candidates first by what they open, then in page order. */
export function orderCandidates<T extends { kind?: string }>(decisions: readonly T[]): T[] {
  return decisions.map((d, i) => ({ d, i })).sort((a, b) => (KIND_PRIORITY[a.d.kind ?? ''] ?? 9) - (KIND_PRIORITY[b.d.kind ?? ''] ?? 9) || a.i - b.i).map((x) => x.d);
}

/**
 * A state's identity for restoring: route, open dialog, headings, and each control's role, name and
 * open, pressed, checked and selected state. Values typed into fields are not part of it.
 */
export function stateSignature(o: { route: string; dialog?: string; headings: readonly string[]; controls: readonly Control[] }): string {
  const controls = o.controls.map((c) => [c.role, c.name, c.context ?? '', c.expanded ?? '', c.pressed ?? '', c.checked ?? '', c.selected ?? ''].join('\u0001'));
  return [o.route, o.dialog ?? '', o.headings.join('\u0002'), controls.join('\u0002')].join('\u0003');
}

/** The guard for exploring contexts: requests that could change data, or navigations off the origin. */
export function blockedRequest(method: string, url: string, navigation: boolean, origin: string): string | undefined {
  let u: URL;
  try { u = new URL(url); } catch { return `${method} ${url.slice(0, 60)}`; }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return undefined;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return `${method.toUpperCase()} ${u.origin === origin ? u.pathname : u.origin + u.pathname}`;
  if (navigation && u.origin !== origin) return `navigation to ${u.origin}`;
  return undefined;
}
