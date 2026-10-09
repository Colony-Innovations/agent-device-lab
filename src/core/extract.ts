// Functions in this file are serialised by Playwright and run inside the page.
// They must be self-contained: no imports, no references to module scope.

export interface ExtractArgs {
  nextRef: number;
  limit: number;
}

export interface RawControl {
  ref: string;
  role: string;
  name: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  selected?: boolean;
  required?: boolean;
  invalid?: boolean;
  focused?: boolean;
  /** Only for controls sharing role and name with another: the heading of their own card or section. */
  context?: string;
  offscreen?: 'above' | 'below';
  clip?: { side: 'left' | 'right'; px: number };
  scrollRegion?: boolean;
  rect: { x: number; y: number; w: number; h: number };
}

export interface RawPage {
  docId: string;
  nextRef: number;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  /** Mobile browsers widen the layout viewport when content overflows; equals viewport.width otherwise. */
  layoutViewportWidth: number;
  scroll: { x: number; y: number };
  documentWidth: number;
  headings: string[];
  dialog?: string;
  controls: RawControl[];
  omitted: number;
  inert: { ref: string; role: string; name: string }[];
  messages: { role: string; text: string }[];
  focused?: string;
}

export function extractPage(args: ExtractArgs): RawPage {
  const KEY = '__agentDeviceLab_v1';
  const w = window as unknown as Record<string, any>;
  if (!w[KEY]) {
    Object.defineProperty(w, KEY, {
      enumerable: false,
      value: { docId: Math.random().toString(36).slice(2, 10), byRef: new Map<string, WeakRef<Element>>(), byEl: new WeakMap<Element, string>() },
    });
  }
  const reg = w[KEY] as { docId: string; byRef: Map<string, WeakRef<Element>>; byEl: WeakMap<Element, string> };
  let nextRef = args.nextRef;

  const clean = (s: string | null | undefined, max = 80) => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  };
  const textOf = (el: Element) => clean((el as HTMLElement).innerText ?? el.textContent);

  const INTERACTIVE = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[contenteditable=""]', '[contenteditable="true"]',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=switch]', '[role=tab]',
    '[role=menuitem]', '[role=option]', '[role=combobox]', '[role=textbox]', '[role=searchbox]', '[role=slider]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type;
      if (type === 'checkbox' || type === 'radio') return type;
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    if ((el as HTMLElement).isContentEditable) return 'textbox';
    return 'generic';
  };

  const nameOf = (el: Element): string => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = clean(labelledBy.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? textOf(n) : ''; }).join(' '));
      if (t) return t;
    }
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const input = el as HTMLInputElement;
      if (['button', 'submit', 'reset'].includes(input.type)) return clean(input.value);
      const label = input.labels?.[0];
      if (label) return textOf(label);
      return clean(input.placeholder || input.title || input.name);
    }
    const text = textOf(el);
    if (text) return text;
    const img = el.querySelector('img[alt]');
    return clean(img?.getAttribute('alt') || el.getAttribute('title'));
  };

  const isShown = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    return !el.closest('[aria-hidden="true"], [inert]');
  };

  const refFor = (el: Element): string => {
    let ref = reg.byEl.get(el);
    if (!ref) {
      ref = `e${nextRef++}`;
      reg.byEl.set(el, ref);
      reg.byRef.set(ref, new WeakRef(el));
    }
    return ref;
  };

  // A modal dialog scopes observation: background controls are inert and reported only as a count.
  const modal = Array.from(document.querySelectorAll('dialog[open], [role=dialog][aria-modal=true], [role=alertdialog]'))
    .find((d) => isShown(d) && (d.matches(':modal') || d.getAttribute('aria-modal') === 'true' || d.getAttribute('role') === 'alertdialog'));
  const scope: ParentNode = modal ?? document;

  // vw is the device-width viewport pages are designed for. What the person actually sees is the visual
  // viewport, which can be panned inside a wider layout viewport on mobile.
  const vw = document.documentElement.clientWidth;
  const vv = window.visualViewport;
  const panX = vv ? vv.offsetLeft : 0;
  const panY = vv ? vv.offsetTop : 0;
  const visibleH = vv ? vv.height : window.innerHeight;
  const sx = window.scrollX;
  const sy = window.scrollY;
  const active = document.activeElement;

  const controls: RawControl[] = [];
  const elements: Element[] = [];
  let omitted = 0;
  for (const el of Array.from(scope.querySelectorAll(INTERACTIVE))) {
    if (!isShown(el)) continue;
    // Skip elements nested inside another interactive element already captured (e.g. span[tabindex] in a button).
    const parentControl = el.parentElement?.closest(INTERACTIVE);
    if (parentControl && isShown(parentControl) && scope.contains(parentControl)) continue;
    if (controls.length >= args.limit) { omitted++; continue; }

    const r = el.getBoundingClientRect();
    const c: RawControl = {
      ref: refFor(el),
      role: roleOf(el),
      name: nameOf(el),
      rect: { x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) },
    };
    const input = el as HTMLInputElement;
    if ((el.tagName === 'INPUT' && c.role !== 'button') || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      if (c.role === 'checkbox' || c.role === 'radio') c.checked = input.checked;
      else c.value = input.type === 'password' ? (input.value ? '••••' : '') : clean(input.value, 60);
      if (input.required) c.required = true;
    } else if ((el as HTMLElement).isContentEditable) {
      c.value = textOf(el);
    }
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') c.disabled = true;
    const ariaChecked = el.getAttribute('aria-checked');
    if (ariaChecked) c.checked = ariaChecked === 'true';
    const ariaPressed = el.getAttribute('aria-pressed');
    if (ariaPressed === 'true' || ariaPressed === 'false') c.pressed = ariaPressed === 'true';
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) c.expanded = expanded === 'true';
    const selected = el.getAttribute('aria-selected');
    if (selected === 'true' || selected === 'false') c.selected = selected === 'true';
    if (el.getAttribute('aria-invalid') === 'true') c.invalid = true;
    if (el === active) c.focused = true;
    if (r.bottom <= panY) c.offscreen = 'above';
    else if (r.top >= panY + visibleH) c.offscreen = 'below';
    const docLeft = r.left + sx;
    const docRight = r.right + sx;
    // An intentional horizontal scroller (carousel, chip row, wide table wrapper) that fits the viewport
    // keeps its overflow to itself: its items are reachable by scrolling it, not by panning the page.
    let scroller: Element | null = null;
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const ox = getComputedStyle(a).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && a.scrollWidth > a.clientWidth + 1) { scroller = a; break; }
    }
    const sr = scroller?.getBoundingClientRect();
    // Entirely off-screen inside a fixed layer, or entirely left of the page's origin: a closed
    // off-canvas panel. No pan can reach it, so it is hidden by design, not cut off.
    const offCanvas = () => {
      if (docRight <= 1) return true;
      if (docLeft < vw - 1) return false;
      for (let a: Element | null = el; a && a !== document.documentElement; a = a.parentElement) if (getComputedStyle(a).position === 'fixed') return true;
      return false;
    };
    if (sr && sr.left + sx >= -1 && sr.right + sx <= vw + 1) c.scrollRegion = true;
    else if ((docRight > vw + 1 || docLeft < -1) && offCanvas()) { /* hidden by design */ }
    else if (docRight > vw + 1) c.clip = { side: 'right', px: Math.round(docRight - vw) };
    else if (docLeft < -1) c.clip = { side: 'left', px: Math.round(-docLeft) };
    controls.push(c);
    elements.push(el);
  }

  // Repeated labels ("View profile" ×3) are ambiguous to an agent; a person tells them apart by the
  // card they sit in. Give each duplicate the heading of the nearest ancestor that holds no twin.
  const key = (c: RawControl) => `${c.role}\u0000${c.name}`;
  const counts = new Map<string, number>();
  for (const c of controls) counts.set(key(c), (counts.get(key(c)) ?? 0) + 1);
  controls.forEach((c, i) => {
    const el = elements[i]!;
    if ((counts.get(key(c)) ?? 0) < 2) {
      // A lone control inside a card or list item ("View profile" when one result is left) still says
      // nothing about what it belongs to: name the card by its heading.
      const card = el.closest('article, li, [role=listitem], [role=article]');
      const title = card && card !== el ? Array.from(card.querySelectorAll('h1, h2, h3, h4, h5, h6, [role=heading]')).find((h) => !h.contains(el) && !el.contains(h) && isShown(h) && textOf(h)) : undefined;
      if (title && !c.name.includes(textOf(title).slice(0, 60))) c.context = textOf(title).slice(0, 60);
      return;
    }
    const twins = elements.filter((other, j) => j !== i && key(controls[j]!) === key(c));
    // Twin-free ancestors, nearest first: prefer a heading from any of them (the card's title); only
    // when there is none, use a short text label placed before the control (e.g. a day name).
    const scopes: Element[] = [];
    for (let anc = el.parentElement, depth = 0; anc && anc !== document.body && depth < 8; anc = anc.parentElement, depth++) {
      if (twins.some((t) => anc!.contains(t))) break;
      scopes.push(anc);
    }
    const heading = scopes.map((anc) => Array.from(anc.querySelectorAll('h1, h2, h3, h4, h5, h6, [role=heading], legend'))
      .find((h) => !h.contains(el) && isShown(h) && textOf(h))).find(Boolean);
    const label = heading ?? scopes.map((anc) => Array.from(anc.querySelectorAll('*')).find((n) =>
      !n.contains(el) && !n.closest(INTERACTIVE) && (n.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
      Array.from(n.childNodes).some((t) => t.nodeType === Node.TEXT_NODE && t.textContent!.trim()) &&
      isShown(n) && textOf(n).length <= 60)).find(Boolean);
    if (label) c.context = textOf(label).slice(0, 60);
  });

  const inert: RawPage['inert'] = [];
  if (modal) {
    for (const el of Array.from(document.querySelectorAll(INTERACTIVE))) {
      if (modal.contains(el)) continue;
      const ref = reg.byEl.get(el);
      if (ref && el.getBoundingClientRect().width > 0) inert.push({ ref, role: roleOf(el), name: nameOf(el) });
    }
  }

  const headings = Array.from(document.querySelectorAll('h1, h2'))
    .filter((h) => isShown(h) && (!modal || !modal.contains(h)))
    .slice(0, 6)
    .map((h) => `${h.tagName.toLowerCase()} ${textOf(h)}`);

  const messages = Array.from(document.querySelectorAll('[role=alert], [role=status], [aria-live]:not([aria-live=off]), output'))
    .filter((m) => isShown(m) && textOf(m))
    .slice(0, 8)
    .map((m) => ({ role: m.getAttribute('role') ?? (m.tagName === 'OUTPUT' ? 'status' : 'live'), text: textOf(m).slice(0, 120) }));

  return {
    docId: reg.docId,
    nextRef,
    url: location.href,
    title: document.title,
    viewport: { width: vw, height: document.documentElement.clientHeight },
    layoutViewportWidth: window.innerWidth,
    scroll: { x: Math.round(sx + panX), y: Math.round(sy + panY) },
    documentWidth: document.documentElement.scrollWidth,
    headings,
    dialog: modal ? (nameOf(modal) || 'dialog') : undefined,
    controls,
    omitted,
    inert,
    messages,
    focused: active ? reg.byEl.get(active) : undefined,
  };
}

/** In-page: look up a ref in the registry. Returns the element separately via evaluateHandle. */
export function lookupRef(ref: string): Element | null {
  const reg = (window as unknown as Record<string, any>)['__agentDeviceLab_v1'];
  const el: Element | undefined = reg?.byRef.get(ref)?.deref();
  return el && el.isConnected ? el : null;
}

export function currentDocId(): string | null {
  return (window as unknown as Record<string, any>)['__agentDeviceLab_v1']?.docId ?? null;
}

export interface TargetPoint {
  /** Centre in visual-viewport coordinates: what touchscreen/mouse input dispatch expects. */
  x: number;
  y: number;
  inView: boolean;
  /** elementFromPoint at the centre lands on the target (or its label/descendant). */
  hitOk: boolean;
  hit?: string;
  /** The covering element is (inside) a fixed or sticky bar, which scrolling can move the target out from under. */
  hitFixed?: boolean;
}

/**
 * In-page: centre the element in the view. Used when its centre is under a fixed or sticky bar (a
 * bottom tab bar, a sticky header): a person would scroll a little further, so the lab does too.
 */
export function centreInView(el: Element): { dx: number; dy: number } {
  const vv = window.visualViewport;
  const pan = () => ({ x: window.scrollX + (vv ? vv.offsetLeft : 0), y: window.scrollY + (vv ? vv.offsetTop : 0) });
  const before = pan();
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  const after = pan();
  return { dx: Math.round(after.x - before.x), dy: Math.round(after.y - before.y) };
}

/** In-page: reset the page to its top-left corner without smooth scrolling (pages may set scroll-behavior: smooth). */
export function scrollToOrigin(): void {
  window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
}

/** In-page: bring the element into the visual viewport if needed. Returns how far the view panned. */
export function panIntoView(el: Element): { dx: number; dy: number } {
  const vv = window.visualViewport;
  const pan = () => ({ x: window.scrollX + (vv ? vv.offsetLeft : 0), y: window.scrollY + (vv ? vv.offsetTop : 0) });
  const before = pan();
  const r = el.getBoundingClientRect();
  const left = vv ? vv.offsetLeft : 0;
  const top = vv ? vv.offsetTop : 0;
  const width = vv ? vv.width : window.innerWidth;
  const height = vv ? vv.height : window.innerHeight;
  if (r.left < left || r.right > left + width || r.top < top || r.bottom > top + height) {
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  }
  const after = pan();
  return { dx: Math.round(after.x - before.x), dy: Math.round(after.y - before.y) };
}

/** In-page: would reaching this element need a sideways pan of the visual viewport? (No side effects.) */
export function needsHorizontalPan(el: Element): boolean {
  const vv = window.visualViewport;
  const r = el.getBoundingClientRect();
  const left = vv ? vv.offsetLeft : 0;
  const width = vv ? vv.width : window.innerWidth;
  return r.left < left || r.right > left + width;
}

/** In-page: where a finger or pointer would land for this element, and what is actually there. */
export function targetPoint(el: Element): TargetPoint {
  const vv = window.visualViewport;
  // An inline link wrapped over two lines has its box centre between the lines, on the text around
  // it; a person taps one of its line boxes, so aim at the centre of the largest one.
  const lines = Array.from(el.getClientRects()).filter((b) => b.width > 0 && b.height > 0);
  const r = lines.length > 1 ? lines.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a)) : el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const scale = vv ? vv.scale : 1;
  const x = (cx - (vv ? vv.offsetLeft : 0)) * scale;
  const y = (cy - (vv ? vv.offsetTop : 0)) * scale;
  const inView = x >= 0 && y >= 0 && x <= (vv ? vv.width * scale : window.innerWidth) && y <= (vv ? vv.height * scale : window.innerHeight);
  const hit = document.elementFromPoint(cx, cy);
  const hitOk = !!hit && (hit === el || el.contains(hit) || (hit instanceof HTMLLabelElement && hit.control === el));
  let hitFixed = false;
  for (let n: Element | null = hit && !hitOk ? hit : null; n && n !== document.documentElement; n = n.parentElement) {
    const pos = getComputedStyle(n).position;
    if (pos === 'fixed' || pos === 'sticky') { hitFixed = true; break; }
  }
  return { x, y, inView, hitOk, ...(hit && !hitOk ? { hit: describeElement(hit), hitFixed } : {}) };

  function describeElement(n: Element): string {
    const label = (n.getAttribute('aria-label') || (n as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const id = n.id ? `#${n.id}` : '';
    const cls = typeof n.className === 'string' && n.className.trim() ? `.${n.className.trim().split(/\s+/).join('.')}` : '';
    return `${n.tagName.toLowerCase()}${id}${cls}${label ? ` "${label}"` : ''}`;
  }
}

/**
 * In-page: report the next pointerdown and click to the lab through an exposed binding, saying whether
 * they reached `el`. Uses a binding (not page state) so delivery survives a navigation the click causes.
 */
export function armHitCapture(el: Element, token: string): void {
  const report = (window as unknown as Record<string, (info: unknown) => void>)['__agentDeviceLabHit'];
  if (!report) return;
  for (const type of ['pointerdown', 'click']) {
    const listener = (e: Event) => {
      const t = e.target as Element | null;
      const onTarget = !!t && (t === el || el.contains(t) || (t instanceof HTMLLabelElement && t.control === el));
      const desc = t ? `${t.tagName.toLowerCase()}${t.id ? `#${t.id}` : ''}${(t as HTMLElement).innerText ? ` "${(t as HTMLElement).innerText.replace(/\s+/g, ' ').trim().slice(0, 40)}"` : ''}` : 'nothing';
      report({ token, type, onTarget, target: desc });
    };
    document.addEventListener(type, listener, { capture: true, once: true });
    setTimeout(() => document.removeEventListener(type, listener, { capture: true }), 3000);
  }
}

/** In-page: describe why an element can or cannot be filled. */
export function fillability(el: Element): { fillable: boolean; disabled: boolean; reason?: string; secret?: boolean } {
  const disabled = (el as HTMLInputElement).disabled || el.getAttribute('aria-disabled') === 'true';
  if ((el as HTMLElement).isContentEditable) return { fillable: true, disabled };
  if (el.tagName === 'TEXTAREA') return { fillable: !(el as HTMLTextAreaElement).readOnly, disabled, reason: 'read-only' };
  if (el.tagName === 'INPUT') {
    const input = el as HTMLInputElement;
    const nonText = ['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color'];
    if (nonText.includes(input.type)) return { fillable: false, disabled, reason: `input type=${input.type} is not a text field` };
    if (input.readOnly) return { fillable: false, disabled, reason: 'read-only' };
    // Values typed here are never written to logs, reproduction steps or reports.
    const secret = input.type === 'password' || /(password|one-time-code|cc-number|cc-csc)/i.test(input.autocomplete || '');
    return { fillable: true, disabled, ...(secret ? { secret } : {}) };
  }
  return { fillable: false, disabled, reason: `<${el.tagName.toLowerCase()}> is not a text field` };
}

/** In-page: is this a checkbox, radio or switch, and what state is it in? */
export function checkability(el: Element): { kind?: 'checkbox' | 'radio' | 'switch'; checked: boolean; disabled: boolean } {
  const disabled = (el as HTMLInputElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
  if (el.tagName === 'INPUT') {
    const input = el as HTMLInputElement;
    if (input.type === 'checkbox' || input.type === 'radio') return { kind: input.type, checked: input.checked, disabled };
    return { checked: false, disabled };
  }
  const role = el.getAttribute('role');
  if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
    const kind = role === 'switch' ? 'switch' : role.endsWith('radio') ? 'radio' : 'checkbox';
    return { kind, checked: el.getAttribute('aria-checked') === 'true', disabled };
  }
  return { checked: false, disabled };
}

/** In-page: a native <select> and its options (labels bounded), or why it is not one. */
export function selectInfo(el: Element): { select: boolean; disabled: boolean; multiple: boolean; options: { value: string; label: string; selected: boolean; disabled: boolean }[] } {
  if (el.tagName !== 'SELECT') return { select: false, disabled: false, multiple: false, options: [] };
  const sel = el as HTMLSelectElement;
  return {
    select: true,
    disabled: sel.disabled,
    multiple: sel.multiple,
    options: Array.from(sel.options).slice(0, 200).map((o) => ({
      value: o.value, label: (o.label || o.text).replace(/\s+/g, ' ').trim().slice(0, 80), selected: o.selected, disabled: o.disabled,
    })),
  };
}

/** In-page: is this a file input (directly, or through its label)? */
export function uploadInfo(el: Element): { fileInput: boolean; multiple: boolean; disabled: boolean } {
  const input = el.tagName === 'INPUT' ? el as HTMLInputElement : el instanceof HTMLLabelElement ? el.control as HTMLInputElement | null : null;
  if (input && input.type === 'file') return { fileInput: true, multiple: input.multiple, disabled: input.disabled };
  return { fileInput: false, multiple: false, disabled: (el as HTMLButtonElement).disabled === true };
}

/** In-page: is the focused element a password-like field? Keys pressed there are masked in history. */
export function focusedIsSecret(): boolean {
  const el = document.activeElement as HTMLInputElement | null;
  if (!el || el.tagName !== 'INPUT') return false;
  return el.type === 'password' || /(password|one-time-code|cc-number|cc-csc)/i.test(el.autocomplete || '');
}

/**
 * In-page: scroll the page, or the nearest scrollable container of `el` along the axis, by (dx, dy)
 * CSS px without smooth scrolling. Returns what scrolled and how far it actually moved.
 */
export function scrollByAmount(args: { el?: Element | null; dx: number; dy: number }): { target: string; moved: { x: number; y: number }; atEnd: boolean } {
  const { el, dx, dy } = args;
  const horizontal = dx !== 0;
  const scrollable = (n: Element) => {
    const st = getComputedStyle(n);
    const overflow = horizontal ? st.overflowX : st.overflowY;
    const room = horizontal ? n.scrollWidth - n.clientWidth : n.scrollHeight - n.clientHeight;
    return room > 1 && (overflow === 'auto' || overflow === 'scroll');
  };
  let box: Element | null = null;
  for (let n: Element | null = el ?? null; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    if (scrollable(n)) { box = n; break; }
  }
  if (box) {
    const before = { x: box.scrollLeft, y: box.scrollTop };
    box.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    const moved = { x: Math.round(box.scrollLeft - before.x), y: Math.round(box.scrollTop - before.y) };
    const label = box.getAttribute('aria-label') || box.id || box.tagName.toLowerCase();
    return { target: `region "${label.slice(0, 40)}"`, moved, atEnd: moved.x === 0 && moved.y === 0 };
  }
  const vv = window.visualViewport;
  const pos = () => ({ x: window.scrollX + (vv ? vv.offsetLeft : 0), y: window.scrollY + (vv ? vv.offsetTop : 0) });
  const before = pos();
  window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  const after = pos();
  const moved = { x: Math.round(after.x - before.x), y: Math.round(after.y - before.y) };
  return { target: 'page', moved, atEnd: moved.x === 0 && moved.y === 0 };
}

/** In-page: scroll positions of the page and of every scrolled container, to measure what a gesture moved. */
export function scrollPositions(): Record<string, number> {
  const out: Record<string, number> = { 'page.x': Math.round(window.scrollX), 'page.y': Math.round(window.scrollY) };
  let i = 0;
  for (const n of Array.from(document.querySelectorAll('body *'))) {
    if (i >= 50) break;
    if (n.scrollWidth <= n.clientWidth + 1 && n.scrollHeight <= n.clientHeight + 1) continue;
    const label = (n.getAttribute('aria-label') || n.id || n.tagName.toLowerCase()).slice(0, 40);
    out[`region "${label}".x`] = Math.round(n.scrollLeft);
    out[`region "${label}".y`] = Math.round(n.scrollTop);
    i++;
  }
  return out;
}

/**
 * Init script (runs before page scripts in every document): track pending one-shot setTimeout timers
 * so settling can wait for timer-driven work (in-memory mock APIs, debounces, delayed transitions)
 * that neither mutates the DOM nor touches the network while it waits. setInterval is not tracked.
 * Each timer records the depth of the timer chain that created it, so re-arming loops can be ignored.
 */
export function installTimerTracking(): void {
  const key = '__agentDeviceLab_timers';
  if ((window as any)[key]) return;
  const pending = new Map<number, { due: number; delay: number; depth: number }>();
  Object.defineProperty(window, key, { value: pending, enumerable: false });
  const set = window.setTimeout.bind(window);
  const clear = window.clearTimeout.bind(window);
  let depth = 0;
  const tracked = function (handler: TimerHandler, delay?: number, ...args: unknown[]): number {
    if (typeof handler !== 'function') return set(handler, delay, ...args);
    const d = Math.max(0, Number(delay) || 0);
    const mine = depth;
    let id = 0;
    const run = function (this: unknown, ...a: unknown[]) {
      pending.delete(id);
      const prev = depth;
      depth = mine + 1;
      try { return (handler as (...x: unknown[]) => unknown).apply(this, a); } finally { depth = prev; }
    };
    id = set(run, d, ...args);
    pending.set(id, { due: performance.now() + d, delay: d, depth: mine });
    return id;
  };
  window.setTimeout = tracked as typeof window.setTimeout;
  window.clearTimeout = ((id?: number) => { if (id !== undefined) pending.delete(id); clear(id); }) as typeof window.clearTimeout;
}

/**
 * Init script: record same-document route changes (pushState, replaceState, popstate) and the last time
 * the page's element structure changed (elements added or removed, or `hidden` toggled). A client-side
 * router can change the address at once and render the new page later, e.g. React Router 7 renders a
 * navigation inside a transition that React's scheduler runs through MessageChannel, with no timer,
 * request or DOM change in between. Text-only changes (a button's busy label) do not count as the new
 * page having rendered.
 */
export function installNavTracking(): void {
  const key = '__agentDeviceLab_nav';
  if ((window as any)[key]) return;
  // windowAt: when the page last asked for a new window (wall clock, comparable with the lab's Date.now()).
  const state = { at: 0, path: location.pathname, structureAt: 0, windowAt: 0 };
  Object.defineProperty(window, key, { value: state, enumerable: false });
  // A new tab is delivered to the lab only after the browser has created it, which can be later than the
  // opener page goes quiet; recording the request lets settling wait for it.
  const opensWindow = (target: string) => !!target && !['_self', '_top', '_parent'].includes(target.toLowerCase());
  const originalOpen = window.open;
  window.open = function (...args: Parameters<Window['open']>) {
    state.windowAt = Date.now();
    return originalOpen.apply(window, args);
  } as Window['open'];
  window.addEventListener('click', (e) => {
    const a = e.defaultPrevented || !(e.target instanceof Element) ? null : e.target.closest('a[href], area[href]') as HTMLAnchorElement | null;
    if (a && (opensWindow(a.target) || e.ctrlKey || e.metaKey || e.shiftKey)) state.windowAt = Date.now();
  });
  window.addEventListener('submit', (e) => {
    const form = e.target as HTMLFormElement | null;
    const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
    if (!e.defaultPrevented && opensWindow(submitter?.formTarget || form?.target || '')) state.windowAt = Date.now();
  });
  const mark = () => {
    if (location.pathname === state.path) return;
    state.path = location.pathname;
    state.at = performance.now();
  };
  for (const name of ['pushState', 'replaceState'] as const) {
    const original = history[name].bind(history);
    history[name] = function (...args: Parameters<History['pushState']>) {
      const r = original(...args);
      mark();
      return r;
    } as History['pushState'];
  }
  window.addEventListener('popstate', mark, true);
  new MutationObserver((records) => {
    for (const r of records) {
      const structural = r.type === 'attributes' ||
        [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)].some((n) => n.nodeType === Node.ELEMENT_NODE);
      if (structural) { state.structureAt = performance.now(); return; }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
}

/**
 * In-page: resolve when the DOM has been quiet for quietMs (and nothing is busy, animating or on a short
 * timer), or after maxMs. With `fromPath` (the path before the action): when the action changed the
 * route within this document, also wait until the page's element structure has changed since then,
 * so the old page is not observed under the new address.
 */
export function waitForDomQuiet(opts: { quietMs: number; maxMs: number; timerMaxMs: number; fromPath?: string }): Promise<'quiet' | 'timeout' | 'busy' | 'timers' | 'route' | 'empty'> {
  return new Promise((resolve) => {
    const start = performance.now();
    let last = start;
    const mo = new MutationObserver(() => { last = performance.now(); });
    mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    // A visible aria-busy region is the page saying it is still loading, even when nothing mutates
    // (e.g. an app waiting on a timer or an in-memory mock API).
    const busy = () => [...document.querySelectorAll('[aria-busy="true"]')].some((el) =>
      el.getBoundingClientRect().width > 0 && el.checkVisibility({ visibilityProperty: true }));
    // Finite running animations (route and drawer entrances) change what a person sees without DOM
    // mutations; an element fading in from opacity 0 would otherwise be observed as invisible.
    // Infinite ones (spinners, pulses) never finish and are ignored.
    const animating = () => document.getAnimations().some((a) => {
      if (a.playState !== 'running') return false;
      const end = a.effect?.getComputedTiming().endTime;
      return typeof end === 'number' && Number.isFinite(end);
    });
    // Short one-shot timers still pending (see installTimerTracking); long chains are treated as loops.
    const timers = (window as any).__agentDeviceLab_timers as Map<number, { due: number; delay: number; depth: number }> | undefined;
    const timersPending = () => {
      if (!timers || opts.timerMaxMs <= 0) return false;
      const now = performance.now();
      for (const t of timers.values()) if (t.delay <= opts.timerMaxMs && t.depth <= 3 && t.due >= now - 50) return true;
      return false;
    };
    // The route changed (away from the path the action started on) but the new page has not rendered.
    const nav = (window as any).__agentDeviceLab_nav as { at: number; path: string; structureAt: number } | undefined;
    const routePending = () => !!opts.fromPath && !!nav && nav.at > 0 && location.pathname !== opts.fromPath && nav.structureAt <= nav.at;
    // The document has scripts but nothing is drawn yet: an app root still empty while its modules load
    // and evaluate. A dev server serves every module separately, so a lazy route renders only after a
    // chain of dynamic imports, with gaps of pure evaluation (no request, timer or DOM change) longer
    // than quietMs. Once something is drawn this stops being asked. A document without scripts, or
    // with content, is never pending.
    const scripts = Array.from(document.scripts).some((x) => !/json|template|html|importmap|speculationrules/i.test(x.type));
    let drawn = !scripts;
    const emptyPending = () => {
      if (drawn) return false;
      const b = document.body;
      if (!b) return false;
      drawn = !!b.innerText.trim() || Array.from(b.querySelectorAll('*')).some((el) => {
        const t = el.tagName.toLowerCase();
        return t.includes('-') || ['img', 'svg', 'canvas', 'video', 'audio', 'iframe', 'object', 'embed', 'input', 'button', 'a', 'select', 'textarea'].includes(t);
      });
      return !drawn;
    };
    const tick = () => {
      const now = performance.now();
      const isBusy = busy();
      const isTimer = timersPending();
      const isRoute = routePending();
      const isEmpty = emptyPending();
      if (isBusy || isTimer || isRoute || isEmpty || animating()) last = Math.max(last, now - opts.quietMs + 20);
      if (now - last >= opts.quietMs) { mo.disconnect(); resolve('quiet'); }
      else if (now - start >= opts.maxMs) { mo.disconnect(); resolve(isBusy ? 'busy' : isTimer ? 'timers' : isRoute ? 'route' : isEmpty ? 'empty' : 'timeout'); }
      else setTimeout(tick, 20);
    };
    setTimeout(tick, 20);
  });
}

// ---------- scan measurements (web v1 m2) ----------
// Raw geometry for the layout detectors. These functions only measure; every decision about what is a
// finding, its severity and its confidence is made by the pure code in detectors.ts, so it is unit-tested.

/** An element a detector talks about: a control (with its session ref when observed) or other content. */
export interface RawElement {
  role: string;
  name: string;
  selector: string;
  control: boolean;
  ref?: string;
}

export interface RawBox { x: number; y: number; w: number; h: number }

export interface RawTarget { el: RawElement; box: RawBox; inline: boolean; userAgent: boolean }

export interface RawClip {
  el: RawElement;
  box: RawBox;
  /** The visible part: the element's box cut by every overflow-clipping ancestor (viewport coordinates). */
  visible: RawBox;
  clipper: string;
  /** Share of the element's area that is visible, 0–1. */
  visibleShare: number;
  hiddenPx: number;
  /** The clipping ancestor lays out a row of similar items (a carousel track peeking the next slide). */
  peek: boolean;
  /** The element, or an ancestor between it and the clipper, runs an infinite or transform animation (a marquee or carousel in motion). */
  moving: boolean;
  /** A pointer at the element's centre lands on it. */
  centreHit: boolean;
}

export interface RawTextOverflow {
  el: RawElement;
  /** The control whose label this text is (the element itself, or its nearest control ancestor). */
  control?: RawElement;
  heading: boolean;
  axis: 'x' | 'y';
  ellipsis: boolean;
  clamp: boolean;
  scrollSize: number;
  clientSize: number;
  /** The full text is available another way: a title attribute, or an accessible name that is not cut. */
  alternative: boolean;
  /** The element, or an ancestor up to its clipping container, runs an infinite or transform animation. */
  moving: boolean;
}

export interface RawFixed {
  el: RawElement;
  box: RawBox;
  position: 'fixed' | 'sticky';
  edge: 'top' | 'bottom' | 'none';
  /** Share of the viewport area it covers (backdrops and full-screen overlays are near 1). */
  viewportShare: number;
  /** Its controls; coveredBy names the other fixed layer a pointer at the control's centre lands on. */
  controls: { el: RawElement; box: RawBox; coveredBy?: string }[];
  /** Visible share of its own box within the viewport (an off-canvas panel is near 0). */
  onScreen: number;
}

export interface RawScroller {
  el: RawElement;
  box: RawBox;
  scrollWidth: number;
  clientWidth: number;
  /** Why it is an intentional horizontal scroller, or undefined when nothing says so. */
  intentional?: string;
  paragraphs: number;
}

export interface RawOutside { el: RawElement; box: RawBox; container: string; containerBox: RawBox; overhang: { top: number; right: number; bottom: number; left: number } }

export interface RawBeforeOrigin { el: RawElement; box: RawBox; container: string; hiddenPx: number; share: number; centreHidden: boolean; moving: boolean }

export interface RawLabel { el: RawElement; lines: number; box: RawBox; rowMinH?: number; rowMaxH?: number; rowCount: number; overlaps?: string }

export interface RawModal { el: RawElement; box: RawBox; scrollable: boolean; overflowPx: number; controls: number }

export interface RawLayout {
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  scrollMax: { x: number; y: number };
  modal?: RawModal;
  targets: RawTarget[];
  clips: RawClip[];
  texts: RawTextOverflow[];
  fixed: RawFixed[];
  scrollers: RawScroller[];
  outside: RawOutside[];
  beforeOrigin: RawBeforeOrigin[];
  labels: RawLabel[];
  /** Elements examined, and how many more there were than the budget allowed. */
  examined: number;
  omitted: number;
}

/** In-page: measure the geometry every layout detector needs, in one pass (viewport coordinates). */
export function measureLayout(args: { maxElements: number; maxItems: number }): RawLayout {
  const reg = (window as unknown as Record<string, any>)['__agentDeviceLab_v1'] as { byEl: WeakMap<Element, string> } | undefined;
  const CONTROL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[role=combobox],[role=slider],[tabindex]:not([tabindex="-1"])';
  const clean = (s: string | null | undefined, max = 60) => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  };
  const vw = document.documentElement.clientWidth;
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const box = (r: DOMRect): RawBox => ({ x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 });
  const cs = (el: Element) => getComputedStyle(el);

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type;
      if (type === 'checkbox' || type === 'radio') return type;
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      return type === 'range' ? 'slider' : 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'img') return 'img';
    return el.matches(CONTROL) ? 'generic' : 'text';
  };
  const nameOf = (el: Element): string => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = clean(labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '));
      if (t) return t;
    }
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    const input = el as HTMLInputElement;
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(input.type)) return clean(input.value);
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return clean(input.labels?.[0]?.textContent || input.placeholder || input.name);
    return clean((el as HTMLElement).innerText ?? el.textContent) || clean(el.querySelector('img[alt]')?.getAttribute('alt') || el.getAttribute('title'));
  };
  const selectorOf = (el: Element): string => {
    const parts: string[] = [];
    for (let n: Element | null = el; n && n !== document.body && parts.length < 4; n = n.parentElement) {
      let p = n.tagName.toLowerCase();
      if (n.id && /^[A-Za-z][\w-]{0,30}$/.test(n.id)) { parts.unshift(`${p}#${n.id}`); break; }
      const cls = typeof n.className === 'string' ? n.className.trim().split(/\s+/).find((c) => /^[A-Za-z][\w-]{0,24}$/.test(c)) : undefined;
      if (cls) p += `.${cls}`;
      const same = n.parentElement ? Array.from(n.parentElement.children).filter((c) => c.tagName === n!.tagName) : [];
      if (same.length > 1) p += `:nth-of-type(${same.indexOf(n) + 1})`;
      parts.unshift(p);
    }
    return parts.join(' > ').slice(0, 120);
  };
  const describe = (el: Element): RawElement => {
    const control = el.matches(CONTROL);
    const ref = reg?.byEl.get(el);
    return { role: roleOf(el), name: nameOf(el), selector: selectorOf(el), control, ...(ref ? { ref } : {}) };
  };
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  };
  // Visually hidden on purpose (screen-reader-only text, skip links): never a layout defect.
  const srOnly = (el: Element) => {
    for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
      const r = n.getBoundingClientRect();
      const s = cs(n);
      if ((r.width <= 2 && r.height <= 2) || s.clip === 'rect(0px, 0px, 0px, 0px)' || /inset\(50%/.test(s.clipPath)) return true;
    }
    return false;
  };
  const hasOwnText = (el: Element) => Array.from(el.childNodes).some((t) => t.nodeType === Node.TEXT_NODE && (t.textContent ?? '').trim());
  const inter = (a: { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }) => ({
    left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom),
  });
  const area = (r: { left: number; top: number; right: number; bottom: number }) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
  const hits = (el: Element, x: number, y: number) => {
    if (x < 0 || y < 0 || x >= vw || y >= vh) return false;
    const h = document.elementFromPoint(x, y);
    return !!h && (h === el || el.contains(h) || (h instanceof HTMLLabelElement && h.control === el));
  };

  // A modal dialog or drawer scopes the checks: the background is inert while it is open.
  const modalEl = Array.from(document.querySelectorAll('dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]'))
    .find((d) => shown(d) && (d.matches(':modal') || d.getAttribute('aria-modal') === 'true' || d.getAttribute('role') === 'alertdialog'));
  const scope: Element = modalEl ?? document.body;

  const all = Array.from(scope.querySelectorAll('*'));
  const omitted = Math.max(0, all.length - args.maxElements);
  const els = all.slice(0, args.maxElements).filter(shown);
  const cap = <T>(list: T[]) => list.slice(0, args.maxItems);

  // ---- tap targets (every control, not only the observed ones) ----
  const targets: RawTarget[] = [];
  const controls = els.filter((el) => el.matches(CONTROL) && !(el.parentElement?.closest(CONTROL)) && !el.closest('[inert], [aria-hidden="true"]') &&
    !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true' && cs(el).pointerEvents !== 'none' && !srOnly(el));
  for (const el of controls) {
    const s = cs(el);
    const tag = el.tagName.toLowerCase();
    // Inline: a link inside a sentence, its size set by the line of text around it.
    const parent = el.parentElement;
    const inline = s.display === 'inline' && !!parent && Array.from(parent.childNodes).some((t) => t.nodeType === Node.TEXT_NODE && (t.textContent ?? '').trim().length > 1);
    // A native control whose size the user agent decides (an unstyled checkbox or radio).
    const userAgent = tag === 'input' && ['checkbox', 'radio'].includes((el as HTMLInputElement).type) && s.appearance !== 'none';
    targets.push({ el: describe(el), box: box(el.getBoundingClientRect()), inline, userAgent });
  }

  // ---- clipping by overflow:hidden/clip ancestors, and text cut inside its own box ----
  const clips: RawClip[] = [];
  const texts: RawTextOverflow[] = [];
  /**
   * Content in motion: the element or an ancestor before `stop` has a running animation or transition that
   * never ends (a marquee) or moves it (transform, translate, rotate, scale). What a moving strip clips
   * changes every frame, so it is not a defect a person can be shown.
   */
  const movingBetween = (el: Element, stop: Element | null) => {
    for (let n: Element | null = el; n && n !== stop; n = n.parentElement) {
      let anims: Animation[] = [];
      try { anims = n.getAnimations(); } catch { /* not supported */ }
      for (const a of anims) {
        if (a.playState !== 'running') continue;
        if (a.effect?.getComputedTiming().iterations === Infinity) return true;
        const frames = (a.effect as KeyframeEffect | null)?.getKeyframes?.() ?? [];
        if (frames.some((k) => 'transform' in k || 'translate' in k || 'rotate' in k || 'scale' in k)) return true;
      }
    }
    return false;
  };
  /** The nearest ancestor that clips with overflow hidden or clip (not the body, whose overflow is a scroll lock). */
  const clippingAncestor = (el: Element): Element | null => {
    for (let a = el.parentElement; a && a !== document.documentElement && a !== document.body; a = a.parentElement) {
      const s = cs(a);
      if (s.overflowX === 'hidden' || s.overflowX === 'clip' || s.overflowY === 'hidden' || s.overflowY === 'clip') return a;
    }
    return null;
  };
  const clipRectOf = (el: Element) => {
    let vis = el.getBoundingClientRect() as { left: number; top: number; right: number; bottom: number };
    let clipper = '';
    let clipperEl: Element | null = null;
    let peek = false;
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = cs(a);
      const hx = s.overflowX === 'hidden' || s.overflowX === 'clip';
      const hy = s.overflowY === 'hidden' || s.overflowY === 'clip';
      if (!hx && !hy) continue;
      if (a === document.body) continue; // body overflow:hidden is a scroll lock, not a clip
      const r = a.getBoundingClientRect();
      const inner = { left: r.left + a.clientLeft, top: r.top + a.clientTop, right: r.left + a.clientLeft + a.clientWidth, bottom: r.top + a.clientTop + a.clientHeight };
      const next = { left: hx ? Math.max(vis.left, inner.left) : vis.left, right: hx ? Math.min(vis.right, inner.right) : vis.right,
        top: hy ? Math.max(vis.top, inner.top) : vis.top, bottom: hy ? Math.min(vis.bottom, inner.bottom) : vis.bottom };
      if (area(next) < area(vis) - 0.5 && !clipper) {
        clipper = selectorOf(a);
        clipperEl = a;
        // A track of similar items side by side (slides, cards) inside the clipper: a peeking carousel.
        const track = Array.from(a.querySelectorAll(':scope > *, :scope > * > *')).find((t) => t.children.length >= 3 && ['flex', 'grid', 'inline-flex'].includes(cs(t).display) && t.contains(el));
        if (track) {
          const ws = Array.from(track.children).map((c) => c.getBoundingClientRect().width).filter((w) => w > 0);
          peek = ws.length >= 3 && Math.max(...ws) - Math.min(...ws) <= Math.max(...ws) * 0.2;
        }
      }
      vis = next;
    }
    return { vis, clipper, peek, moving: clipperEl ? movingBetween(el, clipperEl) : false };
  };
  /** Some of the element's own text is drawn inside its padding box. Text moved wholly outside it (text-indent: -3000px image replacement, font-size 0) is hidden on purpose. */
  const textInBox = (el: Element) => {
    const r = el.getBoundingClientRect();
    const left = r.left + el.clientLeft, top = r.top + el.clientTop;
    const right = left + el.clientWidth, bottom = top + el.clientHeight;
    const range = document.createRange();
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType !== Node.TEXT_NODE || !(n.textContent ?? '').trim()) continue;
      range.selectNodeContents(n);
      for (const t of Array.from(range.getClientRects())) {
        if (t.width > 0.5 && t.height > 0.5 && t.right > left + 0.5 && t.left < right - 0.5 && t.bottom > top + 0.5 && t.top < bottom - 0.5) return true;
      }
    }
    return false;
  };
  for (const el of els) {
    if (srOnly(el)) continue;
    // A native listbox scrolls and clips its own options; they are not content cut off by the page.
    if (el.tagName === 'OPTION' || el.tagName === 'OPTGROUP') continue;
    const isControl = el.matches(CONTROL);
    const textLeaf = hasOwnText(el);
    if (!isControl && !textLeaf) continue;
    const r = el.getBoundingClientRect();
    const { vis, clipper, peek, moving } = clipRectOf(el);
    const full = area(r);
    const seen = area(vis);
    if (clipper && full > 0 && seen < full - 0.5) {
      const hiddenPx = Math.round(Math.max(vis.left - r.left, r.right - vis.right, vis.top - r.top, r.bottom - vis.bottom, 0));
      clips.push({ el: describe(el), box: box(r), visible: { x: vis.left, y: vis.top, w: Math.max(0, vis.right - vis.left), h: Math.max(0, vis.bottom - vis.top) },
        clipper, visibleShare: Math.round((seen / full) * 1000) / 1000, hiddenPx, peek, moving, centreHit: hits(el, r.left + r.width / 2, r.top + r.height / 2) });
    }
    if (!textLeaf || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') continue;
    const s = cs(el);
    if (!textInBox(el)) continue; // the text lies wholly outside its own box: image replacement, hidden on purpose
    const ctl = isControl ? el : el.parentElement?.closest(CONTROL) ?? null;
    const heading = /^H[1-6]$/.test(el.tagName) || el.getAttribute('role') === 'heading' || !!el.closest('label, legend, th');
    const clamp = s.getPropertyValue('-webkit-line-clamp') !== 'none' && s.getPropertyValue('-webkit-line-clamp') !== '';
    const fullText = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const titled = !!el.closest('[title]') && (el.closest('[title]')!.getAttribute('title') ?? '').trim().length >= fullText.length - 1;
    const named = !!ctl && (ctl.getAttribute('aria-label') ?? '').trim().length >= fullText.length - 1;
    const push = (axis: 'x' | 'y', scrollSize: number, clientSize: number, ellipsis: boolean) => texts.push({
      el: describe(el), ...(ctl ? { control: describe(ctl) } : {}), heading, axis, ellipsis, clamp, scrollSize, clientSize, alternative: titled || named, moving: movingBetween(el, clippingAncestor(el)),
    });
    if ((s.overflowX === 'hidden' || s.overflowX === 'clip') && el.scrollWidth > el.clientWidth + 2) push('x', el.scrollWidth, el.clientWidth, s.textOverflow === 'ellipsis');
    else if ((s.overflowY === 'hidden' || s.overflowY === 'clip') && el.scrollHeight > el.clientHeight + 2) push('y', el.scrollHeight, el.clientHeight, clamp);
  }

  // ---- fixed and sticky layers ----
  const fixed: RawFixed[] = [];
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (fixed.length >= 30) break;
    const s = cs(el);
    if (s.position !== 'fixed' && s.position !== 'sticky') continue;
    if (!shown(el)) continue;
    let nested = false;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const p = cs(a).position;
      if (p === 'fixed' || p === 'sticky') { nested = true; break; }
    }
    if (nested) continue;
    const r = el.getBoundingClientRect();
    // A sticky element only behaves like a fixed bar while it is stuck at its offset.
    if (s.position === 'sticky') {
      const top = parseFloat(s.top);
      const bottom = parseFloat(s.bottom);
      const stuck = (!Number.isNaN(top) && Math.abs(r.top - top) <= 1) || (!Number.isNaN(bottom) && Math.abs(vh - r.bottom - bottom) <= 1);
      if (!stuck) continue;
    }
    const onVp = inter(r, { left: 0, top: 0, right: vw, bottom: vh });
    const own = Math.max(1, area(r));
    const edge = r.top <= 1 && r.height < vh * 0.5 ? 'top' : r.bottom >= vh - 1 && r.height < vh * 0.5 ? 'bottom' : 'none';
    // Hit-test each control's centre: what a finger lands on there, when it is another fixed layer.
    const coverOf = (c: Element) => {
      const cr = c.getBoundingClientRect();
      const x = cr.left + cr.width / 2;
      const y = cr.top + cr.height / 2;
      if (x < 0 || y < 0 || x >= vw || y >= vh) return undefined;
      const h = document.elementFromPoint(x, y);
      if (!h || h === c || c.contains(h) || el.contains(h)) return undefined;
      for (let n: Element | null = h; n && n !== document.documentElement; n = n.parentElement) {
        const p = cs(n).position;
        if (p === 'fixed' || p === 'sticky') return selectorOf(n);
      }
      return undefined;
    };
    const inner = Array.from(el.querySelectorAll(CONTROL)).filter(shown).slice(0, 12).map((c) => ({ el: describe(c), box: box(c.getBoundingClientRect()), coveredBy: coverOf(c) }));
    if (el.matches(CONTROL)) inner.unshift({ el: describe(el), box: box(r), coveredBy: coverOf(el) });
    fixed.push({ el: describe(el), box: box(r), position: s.position as 'fixed' | 'sticky', edge,
      viewportShare: Math.round((area(onVp) / (vw * vh)) * 1000) / 1000, controls: inner, onScreen: Math.round((area(onVp) / own) * 1000) / 1000 });
  }

  // ---- horizontal scrollers inside content ----
  const scrollers: RawScroller[] = [];
  for (const el of els) {
    const s = cs(el);
    if (!(s.overflowX === 'auto' || s.overflowX === 'scroll') || el.scrollWidth <= el.clientWidth + 1) continue;
    if (el === document.documentElement || el === document.body) continue;
    if (el.tagName === 'SELECT') continue; // a native listbox scrolls its own options
    const role = el.getAttribute('role') ?? '';
    const reasons = [
      ['tablist', 'listbox', 'grid', 'table', 'toolbar', 'menubar', 'tree', 'region'].includes(role) ? `role=${role}` : '',
      /carousel|slider|slideshow/i.test(`${el.getAttribute('aria-roledescription') ?? ''} ${el.className}`) ? 'carousel' : '',
      s.scrollSnapType && s.scrollSnapType !== 'none' ? 'scroll-snap' : '',
      el.querySelector(':scope > table, :scope > pre, :scope > code, :scope > * > table') || ['PRE', 'CODE', 'TABLE'].includes(el.tagName) ? 'table or code' : '',
    ];
    const kids = Array.from(el.children).filter(shown);
    const row = kids.length >= 3 && kids.every((k, i) => i === 0 || k.getBoundingClientRect().left > kids[i - 1]!.getBoundingClientRect().left);
    if (row) reasons.push('a row of items');
    const intentional = reasons.filter(Boolean).join(', ') || undefined;
    scrollers.push({ el: describe(el), box: box(el.getBoundingClientRect()), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
      ...(intentional ? { intentional } : {}), paragraphs: el.querySelectorAll('p').length });
  }

  // ---- controls sticking out of their visible container ----
  const outside: RawOutside[] = [];
  const looksLikeBox = (a: Element) => {
    const s = cs(a);
    // A box a person sees as one: a background, a shadow, or borders on at least three sides (a
    // divider line along one edge does not make a container a control can "leave").
    const border = ['top', 'right', 'bottom', 'left'].filter((side) => parseFloat(s.getPropertyValue(`border-${side}-width`)) > 0 && !/rgba\(.*, 0\)|transparent/.test(s.getPropertyValue(`border-${side}-color`))).length >= 3;
    const bg = !/rgba\(0, 0, 0, 0\)|transparent/.test(s.backgroundColor);
    return border || bg || s.boxShadow !== 'none';
  };
  for (const el of controls) {
    const s = cs(el);
    if (s.position === 'absolute' || s.position === 'fixed') continue; // corner badges and floating buttons are placed on purpose
    let container: Element | null = null;
    // A scrolling or clipping element in between (a scrolled list inside a panel) hides whatever passes
    // the panel's edge, so nothing a person sees sticks out.
    let clippedBetween = false;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (looksLikeBox(a)) { container = a; break; }
      const as = cs(a);
      if (as.overflowX !== 'visible' || as.overflowY !== 'visible') { clippedBetween = true; break; }
    }
    if (!container || clippedBetween) continue;
    const cst = cs(container);
    if (cst.overflowX !== 'visible' || cst.overflowY !== 'visible') continue; // clipping is reported as container-clipped
    const r = el.getBoundingClientRect();
    const c = container.getBoundingClientRect();
    if (c.width >= vw - 1 && c.left <= 0) continue; // a full-width band is not a container a control can leave
    const overhang = { top: Math.round(c.top - r.top), right: Math.round(r.right - c.right), bottom: Math.round(r.bottom - c.bottom), left: Math.round(c.left - r.left) };
    if (Math.max(overhang.top, overhang.right, overhang.bottom, overhang.left) >= 4) {
      outside.push({ el: describe(el), box: box(r), container: selectorOf(container), containerBox: box(c), overhang });
    }
  }

  // ---- content before a scroll origin (left of or above it), which no scrolling can reveal ----
  const beforeOrigin: RawBeforeOrigin[] = [];
  const scrollBoxes = [document.documentElement, ...els.filter((e) => { const s = cs(e); return ['auto', 'scroll'].includes(s.overflowX) || ['auto', 'scroll'].includes(s.overflowY); })];
  for (const el of els) {
    if (srOnly(el) || !(el.matches(CONTROL) || hasOwnText(el))) continue;
    if (cs(el).position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    // The nearest scroll container (or the document) and its origin in viewport coordinates.
    let sc: Element = document.documentElement;
    for (let a = el.parentElement; a; a = a.parentElement) if (scrollBoxes.includes(a) && a !== document.documentElement) { sc = a; break; }
    let originX: number;
    let originY: number;
    if (sc === document.documentElement) { originX = -window.scrollX; originY = -window.scrollY; }
    else { const b = sc.getBoundingClientRect(); originX = b.left + sc.clientLeft - sc.scrollLeft; originY = b.top + sc.clientTop - sc.scrollTop; }
    const hiddenX = Math.max(0, originX - r.left);
    const hiddenY = Math.max(0, originY - r.top);
    if (hiddenX < 2 && hiddenY < 2) continue;
    const share = 1 - Math.max(0, r.width - hiddenX) * Math.max(0, r.height - hiddenY) / Math.max(1, r.width * r.height);
    if (share >= 0.999) continue; // entirely before the origin: an off-canvas panel, not cut content
    beforeOrigin.push({ el: describe(el), box: box(r), container: sc === document.documentElement ? 'the page' : selectorOf(sc),
      hiddenPx: Math.round(Math.max(hiddenX, hiddenY)), share: Math.round(share * 1000) / 1000,
      centreHidden: r.left + r.width / 2 < originX || r.top + r.height / 2 < originY, moving: movingBetween(el, sc) });
  }

  // ---- control label lines, for comparing widths ----
  const labels: RawLabel[] = [];
  // What is actually visible of a box: cut by every ancestor that does not let overflow show
  // (scrolled content under a drawer's footer does not overlap the footer).
  const visibleBox = (el: Element) => {
    let v = el.getBoundingClientRect() as { left: number; top: number; right: number; bottom: number };
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const st = cs(a);
      if (st.overflowX === 'visible' && st.overflowY === 'visible') continue;
      const b = a.getBoundingClientRect();
      v = { left: st.overflowX !== 'visible' ? Math.max(v.left, b.left) : v.left, right: st.overflowX !== 'visible' ? Math.min(v.right, b.right) : v.right,
        top: st.overflowY !== 'visible' ? Math.max(v.top, b.top) : v.top, bottom: st.overflowY !== 'visible' ? Math.min(v.bottom, b.bottom) : v.bottom };
    }
    return v;
  };
  const ctlBoxes = controls.map((c) => ({ c, r: c.getBoundingClientRect(), v: visibleBox(c) }));
  for (const { c, r, v } of ctlBoxes) {
    if (labels.length >= 80) break;
    const range = document.createRange();
    const tops = new Set<number>();
    const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!(t.textContent ?? '').trim()) continue;
      range.selectNodeContents(t);
      for (const lr of Array.from(range.getClientRects())) if (lr.width > 1) tops.add(Math.round(lr.top));
    }
    // Rects of one line can differ by a pixel or two (inline boxes); merge tops closer than 4 px.
    const lines = [...tops].sort((a, b) => a - b).filter((t, i, a) => i === 0 || t - a[i - 1]! >= 4).length;
    if (!lines) continue;
    const row = ctlBoxes.filter((o) => o.c !== c && o.c.parentElement === c.parentElement &&
      Math.min(o.r.bottom, r.bottom) - Math.max(o.r.top, r.top) > Math.min(o.r.height, r.height) * 0.5);
    const overlap = ctlBoxes.find((o) => o.c !== c && !o.c.contains(c) && !c.contains(o.c) && area(inter(o.v, v)) > 16);
    labels.push({ el: describe(c), lines, box: box(r), rowCount: row.length,
      ...(row.length ? { rowMinH: Math.min(...row.map((o) => o.r.height)), rowMaxH: Math.max(...row.map((o) => o.r.height)) } : {}),
      ...(overlap ? { overlaps: `${roleOf(overlap.c)} "${nameOf(overlap.c)}"` } : {}) });
  }

  let modal: RawModal | undefined;
  if (modalEl) {
    const r = modalEl.getBoundingClientRect();
    const inner = [modalEl, ...Array.from(modalEl.querySelectorAll('*'))].some((n) => {
      const s = cs(n);
      return ['auto', 'scroll'].includes(s.overflowY) && n.scrollHeight > n.clientHeight + 1;
    });
    modal = { el: describe(modalEl), box: box(r), scrollable: inner, overflowPx: Math.round(Math.max(0, r.bottom - vh, r.right - vw, -r.top, -r.left)),
      controls: modalEl.querySelectorAll(CONTROL).length };
  }

  const se = document.scrollingElement ?? document.documentElement;
  return {
    viewport: { width: vw, height: Math.round(vh) },
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    scrollMax: { x: Math.max(0, se.scrollWidth - se.clientWidth), y: Math.max(0, se.scrollHeight - se.clientHeight) },
    ...(modal ? { modal } : {}),
    targets: targets.slice(0, 400), clips: cap(clips), texts: cap(texts), fixed, scrollers: cap(scrollers), outside: cap(outside),
    beforeOrigin: cap(beforeOrigin), labels, examined: els.length, omitted,
  };
}

/**
 * In-page: at the page's scroll extremes (top, then bottom), which content sits under a fixed or sticky
 * bar there. No scroll position can uncover it, because the page cannot scroll any further.
 */
export function coveredAtExtremes(args: { maxItems: number }): { el: RawElement; bar: string; edge: 'top' | 'bottom'; share: number; centreCovered: boolean; box: RawBox }[] {
  const CONTROL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[tabindex]:not([tabindex="-1"])';
  const reg = (window as unknown as Record<string, any>)['__agentDeviceLab_v1'] as { byEl: WeakMap<Element, string> } | undefined;
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const vw = document.documentElement.clientWidth;
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const out: ReturnType<typeof coveredAtExtremes> = [];
  const isFixed = (el: Element) => { for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) { const p = getComputedStyle(n).position; if (p === 'fixed' || p === 'sticky') return n; } return null; };
  const sel = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : ''}`;
  const describe = (el: Element): RawElement => {
    const control = el.matches(CONTROL);
    const ref = reg?.byEl.get(el);
    const name = clean(el.getAttribute('aria-label')) || clean((el as HTMLElement).innerText ?? el.textContent);
    return { role: control ? (el.getAttribute('role') ?? (el.tagName === 'A' ? 'link' : 'button')) : /^H[1-6]$/.test(el.tagName) ? 'heading' : 'text', name, selector: sel(el), control, ...(ref ? { ref } : {}) };
  };
  const se = document.scrollingElement ?? document.documentElement;
  if (getComputedStyle(document.body).overflowY === 'hidden' || getComputedStyle(document.documentElement).overflowY === 'hidden') return out; // scroll locked (a modal is open)
  for (const edge of ['top', 'bottom'] as const) {
    window.scrollTo({ left: 0, top: edge === 'top' ? 0 : se.scrollHeight, behavior: 'instant' });
    const bars = Array.from(document.body.querySelectorAll('*')).filter((el) => {
      const p = getComputedStyle(el).position;
      if (p !== 'fixed' && p !== 'sticky') return false;
      const r = el.getBoundingClientRect();
      if (r.width < vw * 0.5 || r.height < 8 || r.height > vh * 0.4) return false;
      return edge === 'top' ? r.top <= 1 && r.bottom > 0 : r.bottom >= vh - 1 && r.top < vh;
    });
    for (const bar of bars) {
      const b = bar.getBoundingClientRect();
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        if (out.length >= args.maxItems) break;
        if (bar.contains(el) || isFixed(el)) continue;
        const own = Array.from(el.childNodes).some((t) => t.nodeType === Node.TEXT_NODE && (t.textContent ?? '').trim());
        if (!el.matches(CONTROL) && !own) continue;
        if (el.parentElement?.closest(CONTROL)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        const ix = Math.max(0, Math.min(r.right, b.right) - Math.max(r.left, b.left));
        const iy = Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top));
        const share = (ix * iy) / Math.max(1, r.width * r.height);
        if (share < 0.2) continue;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const hit = cx >= 0 && cy >= 0 && cx < vw && cy < vh ? document.elementFromPoint(cx, cy) : null;
        const centreCovered = !!hit && !(hit === el || el.contains(hit));
        if (out.some((o) => o.el.selector === sel(el) && o.el.name === describe(el).name)) continue;
        out.push({ el: describe(el), bar: sel(bar), edge, share: Math.round(share * 1000) / 1000, centreCovered,
          box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } });
      }
    }
  }
  window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
  return out;
}

/** Init script: buffer layout shifts (the browser's own Layout Instability API) for takeLayoutShifts. */
export function installShiftObserver(): void {
  const key = '__agentDeviceLab_shifts';
  if ((window as any)[key]) return;
  const buffer: { value: number; recentInput: boolean; at: number; sources: { selector: string; name: string; from: number[]; to: number[] }[] }[] = [];
  Object.defineProperty(window, key, { value: buffer, enumerable: false });
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any[]) {
        if (buffer.length >= 200) buffer.shift();
        buffer.push({
          value: e.value, recentInput: !!e.hadRecentInput, at: Math.round(e.startTime),
          sources: (e.sources ?? []).slice(0, 5).map((s: any) => {
            const n = s.node as Element | null;
            const el = n && n.nodeType === 1 ? n : n?.parentElement ?? null;
            const r = (x: DOMRectReadOnly) => [Math.round(x.x), Math.round(x.y), Math.round(x.width), Math.round(x.height)];
            return {
              selector: el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : ''}` : 'text',
              name: el ? ((el.getAttribute('aria-label') || (el as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40)) : '',
              from: r(s.previousRect), to: r(s.currentRect),
            };
          }),
        });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch { /* the API is unavailable: no shifts are reported */ }
}

/** In-page: layout shifts since the last call (the buffer is emptied). */
export function takeLayoutShifts(): { value: number; recentInput: boolean; at: number; sources: { selector: string; name: string; from: number[]; to: number[] }[] }[] {
  const buffer = (window as any).__agentDeviceLab_shifts as ReturnType<typeof takeLayoutShifts> | undefined;
  if (!buffer) return [];
  return buffer.splice(0, buffer.length);
}

/** What exploration needs to know about each observed control to judge whether activating it is safe. */
export interface ControlTraits {
  ref: string;
  tag: string;
  role: string;
  type?: string;
  haspopup?: string;
  expanded?: string;
  selected?: string;
  pressed?: string;
  /** aria-controls names an element that is currently hidden. */
  controlsHidden?: boolean;
  /** A submit button: explicit type=submit, input submit/image, or a <button> with no type inside a form. */
  submits?: boolean;
  resets?: boolean;
  file?: boolean;
  /** Links: same page (#…), same origin, or another origin; plus target=_blank and download. */
  link?: 'same-page' | 'same-origin' | 'external';
  newTab?: boolean;
  download?: boolean;
  /** A <summary> of a closed <details>. */
  closedDetails?: boolean;
  formName?: string;
}

/** In-page: exploration traits for the given refs (from the session registry). */
export function controlTraits(refs: string[]): ControlTraits[] {
  const reg = (window as unknown as Record<string, any>)['__agentDeviceLab_v1'];
  const out: ControlTraits[] = [];
  for (const ref of refs) {
    const el: Element | undefined = reg?.byRef.get(ref)?.deref();
    if (!el || !el.isConnected) continue;
    const tag = el.tagName.toLowerCase();
    const t: ControlTraits = { ref, tag, role: el.getAttribute('role') ?? '' };
    const attr = (n: string) => el.getAttribute(n) ?? undefined;
    const set = <K extends keyof ControlTraits>(k: K, v: ControlTraits[K] | undefined) => { if (v !== undefined && v !== null && v !== '') t[k] = v; };
    set('haspopup', attr('aria-haspopup'));
    set('expanded', attr('aria-expanded'));
    set('selected', attr('aria-selected'));
    set('pressed', attr('aria-pressed'));
    const controls = attr('aria-controls');
    if (controls) {
      const target = document.getElementById(controls.split(/\s+/)[0]!);
      if (target && (target.hidden || !target.checkVisibility())) t.controlsHidden = true;
    }
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type;
      t.type = type;
      if (type === 'submit' || type === 'image') t.submits = true;
      if (type === 'reset') t.resets = true;
      if (type === 'file') t.file = true;
    }
    if (tag === 'button') {
      const type = el.getAttribute('type')?.toLowerCase();
      t.type = type ?? 'submit';
      const form = (el as HTMLButtonElement).form;
      if (form && (!type || type === 'submit')) { t.submits = true; set('formName', form.getAttribute('aria-label') ?? form.getAttribute('name') ?? form.id); }
      if (type === 'reset') t.resets = true;
    }
    if (tag === 'label' && (el as HTMLLabelElement).control instanceof HTMLInputElement && ((el as HTMLLabelElement).control as HTMLInputElement).type === 'file') t.file = true;
    if (tag === 'a' && el.hasAttribute('href')) {
      const raw = el.getAttribute('href') ?? '';
      const u = new URL(raw, location.href);
      t.link = raw.startsWith('#') || (u.origin === location.origin && u.pathname === location.pathname && u.search === location.search) ? 'same-page'
        : u.origin === location.origin ? 'same-origin' : 'external';
      if (el.getAttribute('target') === '_blank') t.newTab = true;
      if (el.hasAttribute('download')) t.download = true;
    }
    if (tag === 'summary') { const d = el.parentElement; if (d instanceof HTMLDetailsElement && !d.open) t.closedDetails = true; }
    out.push(t);
  }
  return out;
}

/**
 * Init script: report what a person does in the page (taps, typing, keys, choices, submits) through the
 * `__agentDeviceLabHuman` binding, at a privacy-safe level: the control's role and a short name, never
 * typed text; for password-like fields not even the length. The Lab keeps a report only while the
 * session is paused or under a person's control, so the agent's own input is never recorded as theirs.
 */
export function installHumanRecorder(): void {
  const w = window as unknown as { __agentDeviceLabHuman?: (a: unknown) => unknown; __agentDeviceLabHumanOn?: boolean; __agentDeviceLabHumanFlush?: () => void };
  if (w.__agentDeviceLabHumanOn) return;
  w.__agentDeviceLabHumanOn = true;
  const send = (a: Record<string, unknown>) => {
    try { void Promise.resolve(w.__agentDeviceLabHuman?.(a)).catch(() => undefined); } catch { /* binding not ready */ }
  };
  const clip = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const SECRET_AUTOCOMPLETE = /(password|one-time-code|cc-number|cc-csc)/i;
  const SECRET_NAME = /(pass|secret|token|otp|pin\b|cvv|cvc|iban|ssn)/i;
  const secret = (el: Element) => el instanceof HTMLInputElement &&
    (el.type === 'password' || SECRET_AUTOCOMPLETE.test(el.autocomplete || '') || SECRET_NAME.test(`${el.name} ${el.id}`));
  const role = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0]!;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el as HTMLInputElement).type;
      if (t === 'checkbox' || t === 'radio' || t === 'range') return t === 'range' ? 'slider' : t;
      if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
      if (t === 'file') return 'file';
      return 'textbox';
    }
    if ((el as HTMLElement).isContentEditable) return 'textbox';
    return tag;
  };
  const name = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clip(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
      if (clip(text)) return clip(text);
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) return clip(labels[0]!.textContent);
    const r = role(el);
    if (r === 'button' || r === 'link' || r === 'tab' || r === 'menuitem' || r === 'option') {
      const text = clip((el as HTMLElement).innerText || el.textContent);
      if (text) return text;
    }
    return clip(el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || (el as HTMLInputElement).value && (el as HTMLInputElement).type === 'submit' && (el as HTMLInputElement).value || '');
  };
  const target = (el: Element) => ({ role: role(el), name: name(el) });
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[contenteditable=""],[contenteditable="true"],[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=textbox],[tabindex]';
  const interactive = (t: EventTarget | null) => (t instanceof Element ? t.closest(INTERACTIVE) : null);
  const textLike = (el: Element) => el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable ||
    (el instanceof HTMLInputElement && !['checkbox', 'radio', 'file', 'range', 'button', 'submit', 'reset', 'image', 'color'].includes(el.type));

  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const el = interactive(e.target);
    // Checkboxes, radios, selects and file inputs are reported by their change; text fields by typing.
    if (!el || el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && (textLike(el) || ['checkbox', 'radio', 'file'].includes(el.type)))) return;
    send({ type: 'tap', target: target(el) });
  }, true);

  // Typing is described once it pauses (700 ms), and at once when the person leaves the field, presses
  // Enter or Tab, leaves the page, or control is handed back (the Lab calls the flush below).
  const pending = new Map<Element, ReturnType<typeof setTimeout>>();
  const flushTyping = (el: Element, requested = false) => {
    clearTimeout(pending.get(el));
    pending.delete(el);
    const s = secret(el);
    const length = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value.length : (el.textContent ?? '').length;
    send({ type: 'type', target: target(el), ...(s ? { secret: true } : { chars: length }), ...(requested ? { flushed: true } : {}) });
  };
  const flushAll = (requested: boolean) => { for (const el of [...pending.keys()]) flushTyping(el, requested); };
  w.__agentDeviceLabHumanFlush = () => flushAll(true);
  document.addEventListener('input', (e) => {
    if (!e.isTrusted || !(e.target instanceof Element) || !textLike(e.target)) return;
    const el = e.target;
    clearTimeout(pending.get(el));
    pending.set(el, setTimeout(() => flushTyping(el), 700));
  }, true);
  document.addEventListener('focusout', (e) => {
    if (e.isTrusted && e.target instanceof Element && pending.has(e.target)) flushTyping(e.target);
  }, true);
  window.addEventListener('pagehide', () => flushAll(false));
  document.addEventListener('change', (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const el = e.target;
    if (el instanceof HTMLSelectElement) send({ type: 'select', target: target(el), detail: `${el.selectedOptions.length} option(s) selected` });
    else if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) send({ type: 'check', target: target(el), detail: el.checked ? 'checked' : 'unchecked' });
    else if (el instanceof HTMLInputElement && el.type === 'file') send({ type: 'upload', target: target(el), detail: `${el.files?.length ?? 0} file(s) chosen` });
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted || !['Enter', 'Escape', 'Tab'].includes(e.key)) return;
    if ((e.key === 'Enter' || e.key === 'Tab') && e.target instanceof Element && pending.has(e.target)) flushTyping(e.target); // what was typed comes before the key
    send({ type: 'key', detail: `${e.shiftKey ? 'Shift+' : ''}${e.key}`, ...(e.target instanceof Element && e.target !== document.body ? { target: target(e.target) } : {}) });
  }, true);
  document.addEventListener('submit', (e) => {
    if (e.target instanceof HTMLFormElement) send({ type: 'submit', target: { role: 'form', name: clip(e.target.getAttribute('aria-label') || e.target.getAttribute('name') || e.target.id) } });
  }, true);
}
