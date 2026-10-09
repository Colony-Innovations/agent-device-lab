import type { RawBeforeOrigin, RawClip, RawElement, RawFixed, RawLabel, RawLayout, RawOutside, RawScroller, RawTarget, RawTextOverflow, RawBox } from './extract.js';
import type { ControlMatcher, EvidenceBasis, EvidenceFrame, FindingKind, FindingTarget, TapTargetPolicy } from './schema.js';

// The detector engine's decisions. extract.ts measures the page; everything here is pure: which
// measurements are findings, their severity, and whether they are confirmed (a deterministic
// measurement shows a person is affected) or heuristic. Unit-tested without a browser.

export interface DetectorInfo {
  version: number;
  /**
   * The underlying problem it describes. Findings about the same element in the same family are one
   * problem (e.g. a control covered at its centre is found by both the reach check and the fixed-bar
   * check), so they share a fingerprint and group together in reports.
   */
  family: 'overflow' | 'offscreen' | 'covered' | 'clipped' | 'modal' | 'target-size' | 'wrap' | 'shift' | 'scroll';
  description: string;
}

export const DETECTORS: Readonly<Record<FindingKind, DetectorInfo>> = {
  'horizontal-overflow': { version: 1, family: 'overflow', description: 'The document is wider than the viewport, so the page pans sideways.' },
  'control-clipped': { version: 1, family: 'offscreen', description: 'A control extends past the left or right edge of the viewport.' },
  'horizontal-pan-required': { version: 1, family: 'offscreen', description: 'Reaching a control needed a sideways pan of the view.' },
  'control-obstructed': { version: 2, family: 'covered', description: 'After scrolling a control into view (and on past a fixed bar), a pointer at its centre lands on another element.' },
  'container-clipped': { version: 3, family: 'clipped', description: 'A control or text is cut off by an ancestor with overflow hidden or clip.' },
  'text-clipped': { version: 3, family: 'clipped', description: 'Text overflows its own box, which hides the overflow without an ellipsis.' },
  'text-truncated': { version: 1, family: 'clipped', description: 'Text is shortened with an ellipsis or line clamp.' },
  'fixed-collision': { version: 1, family: 'covered', description: 'Two fixed or sticky layers overlap; no scrolling moves them apart.' },
  'content-under-fixed': { version: 1, family: 'covered', description: 'At the top or bottom of the page, content stays under a fixed or sticky bar.' },
  'modal-overflow': { version: 1, family: 'modal', description: 'An open dialog or drawer extends past the viewport and cannot be scrolled.' },
  'unreachable-content': { version: 2, family: 'clipped', description: 'Content lies before a scroll origin (left of or above it), where no scrolling can reveal it.' },
  'outside-container': { version: 1, family: 'overflow', description: 'A control sticks out of the visible box (border, background or shadow) that contains it.' },
  'content-scroll-x': { version: 2, family: 'scroll', description: 'An ordinary content region scrolls sideways, with nothing marking it as an intentional scroller.' },
  'tap-target': { version: 1, family: 'target-size', description: 'A target is smaller than the chosen WCAG target-size rule allows, after its exceptions.' },
  'layout-shift': { version: 1, family: 'shift', description: 'Content moved while a state settled, without recent input (Layout Instability API).' },
  'text-wrap-change': { version: 1, family: 'wrap', description: 'A control label is on one line at a width and on more lines at a nearby narrower width.' },
};

/** A detector's result, before the store adds device, scenario, state, ids and reproduction. */
export interface DetectorHit {
  kind: FindingKind;
  severity: 'high' | 'medium' | 'low';
  confidence: 'confirmed' | 'heuristic';
  confidenceScore: number;
  basis: EvidenceBasis[];
  target?: FindingTarget;
  message: string;
  evidence: Record<string, number | string>;
  frames?: EvidenceFrame[];
}

export interface DetectorOptions {
  tapTargets: TapTargetPolicy;
  layoutShiftMin: number;
  enabled: (kind: FindingKind) => boolean;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const who = (el: RawElement) => `${el.role} "${el.name || el.selector}"`;

export function targetOf(el: RawElement): FindingTarget {
  return { role: el.role, name: el.name || el.selector, ...(el.ref ? { ref: el.ref } : {}), selector: el.selector };
}

/** Every layout detector over one measured state. */
export function detectLayout(raw: RawLayout, opts: DetectorOptions): DetectorHit[] {
  const on = opts.enabled;
  const hits: DetectorHit[] = [];
  if (on('tap-target')) hits.push(...tapTargetHits(raw.targets, opts.tapTargets));
  if (on('container-clipped')) for (const c of raw.clips) { const h = clipHit(c); if (h) hits.push(h); }
  for (const t of raw.texts) {
    const h = textHit(t);
    if (h && on(h.kind)) hits.push(h);
  }
  if (on('fixed-collision')) hits.push(...fixedCollisionHits(raw.fixed));
  if (on('unreachable-content')) for (const b of raw.beforeOrigin) { const h = beforeOriginHit(b); if (h) hits.push(h); }
  if (on('outside-container')) for (const o of raw.outside) hits.push(outsideHit(o));
  if (on('content-scroll-x')) for (const s of raw.scrollers) { const h = scrollerHit(s, raw.viewport.width); if (h) hits.push(h); }
  return hits;
}

// ---------- tap targets (WCAG 2.2) ----------

/**
 * SC 2.5.8 Target Size (Minimum), level AA: a target is at least 24×24 CSS px, unless
 *  - spacing: a 24 px circle centred on its box intersects no other target and no other undersized
 *    target's circle;
 *  - inline: it sits in a sentence (its size is set by the line of text);
 *  - user agent: its size is set by the browser and not changed by the author.
 * (The "equivalent" and "essential" exceptions cannot be measured and are not applied.)
 * SC 2.5.5 Target Size (Enhanced), level AAA: at least 44×44, with the inline, user-agent (and
 * unmeasurable) exceptions but no spacing exception.
 */
export function tapTargetHits(targets: readonly RawTarget[], policy: TapTargetPolicy): DetectorHit[] {
  const aaa = policy.standard === 'wcag22-aaa';
  const min = aaa ? 44 : 24;
  const radius = 12;
  const centre = (b: RawBox) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const small = (t: RawTarget) => t.box.w < min - 0.05 || t.box.h < min - 0.05;
  const contains = (a: RawBox, b: RawBox) => a.x <= b.x + 0.5 && a.y <= b.y + 0.5 && a.x + a.w >= b.x + b.w - 0.5 && a.y + a.h >= b.y + b.h - 0.5;
  const distToBox = (p: { x: number; y: number }, b: RawBox) => Math.hypot(Math.max(b.x - p.x, 0, p.x - (b.x + b.w)), Math.max(b.y - p.y, 0, p.y - (b.y + b.h)));
  const hits: DetectorHit[] = [];
  for (const t of targets) {
    if (!small(t) || t.inline || t.userAgent) continue;
    const c = centre(t.box);
    let conflict: { other: RawTarget; distance: number; how: string } | undefined;
    if (!aaa) {
      for (const o of targets) {
        if (o === t || contains(o.box, t.box) || contains(t.box, o.box)) continue;
        const d = distToBox(c, o.box);
        if (d < radius - 0.05) { conflict = { other: o, distance: d, how: `its 24 px circle reaches ${who(o.el)} (${r1(d)} px from its centre)` }; break; }
        if (small(o) && !o.inline && !o.userAgent) {
          const dc = Math.hypot(c.x - centre(o.box).x, c.y - centre(o.box).y);
          if (dc < 2 * radius - 0.05) { conflict = { other: o, distance: dc, how: `its 24 px circle overlaps the circle of ${who(o.el)} (centres ${r1(dc)} px apart; 24 px needed)` }; break; }
        }
      }
      if (!conflict) continue; // the spacing exception applies
    }
    const rule = aaa ? 'WCAG 2.2 SC 2.5.5 (AAA, 44 px)' : 'WCAG 2.2 SC 2.5.8 (AA, 24 px)';
    hits.push({
      kind: 'tap-target', severity: 'medium', confidence: 'confirmed', confidenceScore: 0.9, basis: ['standard'], target: targetOf(t.el),
      message: `${who(t.el)} is ${r1(t.box.w)}×${r1(t.box.h)} px, under the ${min} px minimum of ${rule}` +
        (conflict ? `, and the spacing exception does not apply: ${conflict.how}` : ''),
      evidence: {
        width: r1(t.box.w), height: r1(t.box.h), minimum: min, standard: policy.standard,
        ...(conflict ? { nearest: who(conflict.other.el).slice(0, 80), distancePx: r1(conflict.distance) } : {}),
      },
    });
  }
  return hits;
}

// ---------- clipping ----------

function clipHit(c: RawClip): DetectorHit | undefined {
  if (c.visibleShare <= 0.001 || c.peek || c.moving || c.hiddenPx < 4) return undefined; // hidden on purpose, a peeking carousel, content in motion, or a sub-pixel nick
  const hidden = 1 - c.visibleShare;
  const base = { kind: 'container-clipped' as const, target: targetOf(c.el), basis: ['clipping'] as EvidenceBasis[] };
  const evidence = { hiddenPx: c.hiddenPx, visibleShare: c.visibleShare, clippedBy: c.clipper, width: r1(c.box.w), height: r1(c.box.h) };
  if (c.el.control) {
    if (!c.centreHit) {
      return { ...base, severity: 'high', confidence: 'confirmed', confidenceScore: 0.95, basis: ['clipping', 'hit-test'], evidence,
        message: `${who(c.el)} is cut off by ${c.clipper} (${pct(hidden)} hidden, ${c.hiddenPx} px); a pointer at its centre does not reach it` };
    }
    return { ...base, severity: hidden >= 0.1 ? 'medium' : 'low', confidence: 'confirmed', confidenceScore: 0.85, evidence,
      message: `${who(c.el)} is partly cut off by ${c.clipper} (${pct(hidden)} hidden, ${c.hiddenPx} px)` };
  }
  if (hidden >= 0.1) {
    return { ...base, severity: hidden >= 0.25 ? 'medium' : 'low', confidence: 'confirmed', confidenceScore: 0.85, evidence,
      message: `text "${c.el.name}" is cut off by ${c.clipper} (${pct(hidden)} hidden, ${c.hiddenPx} px)` };
  }
  return { ...base, severity: 'low', confidence: 'heuristic', confidenceScore: 0.4, basis: ['geometry'], evidence,
    message: `text "${c.el.name}" loses ${c.hiddenPx} px at the edge of ${c.clipper}` };
}

function textHit(t: RawTextOverflow): DetectorHit | undefined {
  if (t.moving && !t.ellipsis && !t.clamp) return undefined; // a marquee or carousel in motion: what is cut changes every frame
  const shown = t.clientSize / Math.max(1, t.scrollSize);
  const evidence = { axis: t.axis, fullPx: t.scrollSize, shownPx: t.clientSize, shownShare: r1(shown * 100) / 100, alternative: t.alternative ? 'yes' : 'no' };
  const label = t.control ? `the label of ${who(t.control)}` : t.heading ? `heading or label "${t.el.name}"` : `text "${t.el.name}"`;
  const target = targetOf(t.control ?? t.el);
  if (t.ellipsis || t.clamp) {
    const important = !!t.control || t.heading;
    if (important && !t.alternative) {
      return { kind: 'text-truncated', severity: 'medium', confidence: 'confirmed', confidenceScore: 0.85, basis: ['clipping'], target, evidence,
        message: `${label} is truncated with ${t.ellipsis ? 'an ellipsis' : 'a line clamp'} (shows ${t.clientSize} of ${t.scrollSize} px) and no title or accessible name gives the full text` };
    }
    return { kind: 'text-truncated', severity: 'low', confidence: 'heuristic', confidenceScore: 0.4, basis: ['geometry'], target, evidence,
      message: `${label} is truncated (shows ${t.clientSize} of ${t.scrollSize} px)${t.alternative ? '; the full text is available as a title or accessible name' : ''}` };
  }
  if (t.axis === 'y' && !t.control && !t.heading) {
    return { kind: 'text-clipped', severity: 'medium', confidence: 'heuristic', confidenceScore: 0.6, basis: ['geometry'], target, evidence,
      message: `${label} is taller than its box (${t.scrollSize} px in ${t.clientSize} px) and the rest is hidden without a clamp or ellipsis` };
  }
  const hidden = 1 - shown;
  return {
    kind: 'text-clipped', severity: t.control && hidden >= 0.25 ? 'high' : 'medium', confidence: 'confirmed', confidenceScore: 0.9, basis: ['clipping'], target, evidence,
    message: `${label} is cut off: ${t.scrollSize} px of text in a ${t.clientSize} px box that hides the rest without an ellipsis (${pct(hidden)} hidden)`,
  };
}

// ---------- fixed layers ----------

function fixedCollisionHits(fixed: readonly RawFixed[]): DetectorHit[] {
  const layers = fixed.filter((f) => f.onScreen >= 0.5 && f.viewportShare < 0.6 && f.box.w * f.box.h >= 64);
  const hits: DetectorHit[] = [];
  const seen = new Set<string>();
  for (const a of layers) {
    for (const c of a.controls) {
      if (!c.coveredBy) continue;
      const b = layers.find((l) => l !== a && l.el.selector === c.coveredBy) ?? fixed.find((l) => l.el.selector === c.coveredBy);
      if (!b || b.viewportShare >= 0.6) continue; // a backdrop under a dialog covers the page by design
      const key = `${c.el.selector}|${c.el.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        kind: 'fixed-collision', severity: 'high', confidence: 'confirmed', confidenceScore: 0.95, basis: ['hit-test'], target: targetOf(c.el),
        message: `${who(c.el)} in the ${a.position} layer ${a.el.selector} is covered at its centre by the ${b.position} layer ${who(b.el)}; both stay put when the page scrolls, so a person cannot uncover it`,
        evidence: { coveredBy: b.el.selector, layer: a.el.selector, targetLeft: r1(c.box.x), targetTop: r1(c.box.y), targetWidth: r1(c.box.w), targetHeight: r1(c.box.h) },
      });
    }
  }
  for (let i = 0; i < layers.length; i++) {
    for (let j = i + 1; j < layers.length; j++) {
      const a = layers[i]!;
      const b = layers[j]!;
      const ix = Math.max(0, Math.min(a.box.x + a.box.w, b.box.x + b.box.w) - Math.max(a.box.x, b.box.x));
      const iy = Math.max(0, Math.min(a.box.y + a.box.h, b.box.y + b.box.h) - Math.max(a.box.y, b.box.y));
      if (ix * iy < 64) continue;
      const smaller = a.box.w * a.box.h <= b.box.w * b.box.h ? a : b;
      const other = smaller === a ? b : a;
      if (hits.some((h) => h.evidence.layer === smaller.el.selector || h.evidence.layer === other.el.selector)) continue; // already confirmed by a hit test
      const share = (ix * iy) / Math.max(1, smaller.box.w * smaller.box.h);
      hits.push({
        kind: 'fixed-collision', severity: share >= 0.25 ? 'medium' : 'low', confidence: 'heuristic', confidenceScore: 0.5, basis: ['geometry'], target: targetOf(smaller.el),
        message: `the ${smaller.position} layer ${who(smaller.el)} overlaps the ${other.position} layer ${who(other.el)} by ${Math.round(ix)}×${Math.round(iy)} px (${pct(share)} of it); no control is covered at its centre`,
        evidence: { overlapWith: other.el.selector, overlapPx: Math.round(ix * iy), overlapShare: r1(share * 100) / 100 },
      });
    }
  }
  return hits;
}

/** Content that stays under a fixed or sticky bar at the page's top or bottom (see coveredAtExtremes). */
export function coveredHits(covered: readonly { el: RawElement; bar: string; edge: 'top' | 'bottom'; share: number; centreCovered: boolean; box: RawBox }[]): DetectorHit[] {
  const hits: DetectorHit[] = [];
  for (const c of covered) {
    const where = c.edge === 'bottom' ? 'at the bottom of the page' : 'at the top of the page';
    const evidence = { bar: c.bar, edge: c.edge, coveredShare: c.share, targetTop: r1(c.box.y), targetHeight: r1(c.box.h) };
    const base = { kind: 'content-under-fixed' as const, target: targetOf(c.el), evidence };
    if (c.el.control && c.centreCovered) {
      hits.push({ ...base, severity: 'high', confidence: 'confirmed', confidenceScore: 0.95, basis: ['hit-test'],
        message: `${who(c.el)} stays under the fixed bar ${c.bar} ${where}: the page cannot scroll further, so a pointer at its centre always lands on the bar` });
    } else if (!c.el.control && c.share >= 0.5) {
      hits.push({ ...base, severity: 'medium', confidence: 'confirmed', confidenceScore: 0.85, basis: ['clipping'],
        message: `text "${c.el.name}" stays ${pct(c.share)} hidden under the fixed bar ${c.bar} ${where}; no scroll position reveals it` });
    } else {
      hits.push({ ...base, severity: 'low', confidence: 'heuristic', confidenceScore: 0.5, basis: ['geometry'],
        message: `${c.el.control ? who(c.el) : `text "${c.el.name}"`} is ${pct(c.share)} under the fixed bar ${c.bar} ${where}` });
    }
  }
  return hits;
}

/**
 * An open dialog or drawer taller or wider than the viewport. Confirmed when a control inside it
 * cannot be brought into view even after scrolling it (and its scroll containers) into view.
 */
export function modalHits(modal: RawLayout['modal'], unreachable: readonly { el: RawElement; box: RawBox }[], viewport: { width: number; height: number }): DetectorHit[] {
  if (!modal) return [];
  const evidence = { dialogBottom: r1(modal.box.y + modal.box.h), dialogRight: r1(modal.box.x + modal.box.w), viewportWidth: viewport.width, viewportHeight: viewport.height, overflowPx: modal.overflowPx, scrollable: modal.scrollable ? 'yes' : 'no' };
  if (unreachable.length) {
    const first = unreachable[0]!;
    // The dialog is the problem (which controls fall off depends on the height), so it is the target.
    return [{
      kind: 'modal-overflow', severity: 'high', confidence: 'confirmed', confidenceScore: 0.95, basis: ['interaction'], target: targetOf(modal.el),
      message: `${who(modal.el)} extends ${modal.overflowPx} px past the ${viewport.width}×${viewport.height} viewport; ${unreachable.length} control(s) inside it cannot be scrolled into view: ${unreachable.slice(0, 4).map((u) => who(u.el)).join(', ')}${unreachable.length > 4 ? ', …' : ''}`,
      evidence: { ...evidence, unreachable: unreachable.length, firstUnreachable: who(first.el).slice(0, 80) },
    }];
  }
  if (modal.overflowPx >= 4 && !modal.scrollable) {
    return [{
      kind: 'modal-overflow', severity: 'medium', confidence: 'heuristic', confidenceScore: 0.6, basis: ['geometry'], target: targetOf(modal.el),
      message: `${who(modal.el)} extends ${modal.overflowPx} px past the ${viewport.width}×${viewport.height} viewport and has no scrollable area; every control inside was still reachable`,
      evidence,
    }];
  }
  return [];
}

function beforeOriginHit(b: RawBeforeOrigin): DetectorHit | undefined {
  if (b.hiddenPx < 4 || b.moving) return undefined;
  const evidence = { hiddenPx: b.hiddenPx, hiddenShare: b.share, container: b.container, left: r1(b.box.x), top: r1(b.box.y) };
  const base = { kind: 'unreachable-content' as const, target: targetOf(b.el), evidence };
  const what = b.el.control ? who(b.el) : `text "${b.el.name}"`;
  const msg = `${what} starts ${b.hiddenPx} px before the scroll origin of ${b.container} (${pct(b.share)} of it); no scrolling can reveal that part`;
  if (b.el.control) return { ...base, severity: b.centreHidden ? 'high' : 'medium', confidence: 'confirmed', confidenceScore: 0.9, basis: ['clipping'], message: msg };
  if (b.share >= 0.25) return { ...base, severity: 'medium', confidence: 'confirmed', confidenceScore: 0.85, basis: ['clipping'], message: msg };
  return { ...base, severity: 'low', confidence: 'heuristic', confidenceScore: 0.5, basis: ['geometry'], message: msg };
}

function outsideHit(o: RawOutside): DetectorHit {
  const worst = Math.max(o.overhang.top, o.overhang.right, o.overhang.bottom, o.overhang.left);
  const side = (Object.entries(o.overhang) as [string, number][]).sort((a, b) => b[1] - a[1])[0]![0];
  return {
    kind: 'outside-container', severity: worst >= 16 ? 'medium' : 'low', confidence: 'heuristic', confidenceScore: 0.5, basis: ['geometry'], target: targetOf(o.el),
    message: `${who(o.el)} sticks ${worst} px out of the ${side} of its container ${o.container}`,
    evidence: { overhangPx: worst, side, container: o.container, containerWidth: r1(o.containerBox.w), width: r1(o.box.w) },
  };
}

function scrollerHit(s: RawScroller, viewportWidth: number): DetectorHit | undefined {
  const excess = s.scrollWidth - s.clientWidth;
  if (s.intentional || excess < 4) return undefined;
  return {
    kind: 'content-scroll-x', severity: s.paragraphs > 0 && excess >= s.clientWidth * 0.25 ? 'medium' : 'low', confidence: 'heuristic', confidenceScore: 0.4, basis: ['geometry'],
    target: targetOf(s.el),
    message: `${s.el.selector} scrolls sideways by ${excess} px (content ${s.scrollWidth} px in ${s.clientWidth} px) at a ${viewportWidth} px viewport, and nothing marks it as an intentional scroller (no carousel, list, table, tab or snap semantics)`,
    evidence: { scrollWidth: s.scrollWidth, clientWidth: s.clientWidth, excessPx: excess, paragraphs: s.paragraphs },
  };
}

// ---------- layout shift ----------

export interface ShiftEntry { value: number; recentInput: boolean; at: number; sources: { selector: string; name: string; from: number[]; to: number[] }[] }

/**
 * Unexpected layout shifts while a state settled: the browser's layout-shift entries that had no
 * recent input, summed. 0.1 is the Core Web Vitals boundary above which CLS is not "good".
 */
export function shiftHits(entries: readonly ShiftEntry[], min: number, when: string): DetectorHit[] {
  const unexpected = entries.filter((e) => !e.recentInput);
  const score = unexpected.reduce((s, e) => s + e.value, 0);
  if (score < min || !unexpected.length) return [];
  const sources = unexpected.flatMap((e) => e.sources);
  const biggest = [...sources].sort((a, b) => Math.abs(b.to[1]! - b.from[1]!) + Math.abs(b.to[0]! - b.from[0]!) - (Math.abs(a.to[1]! - a.from[1]!) + Math.abs(a.to[0]! - a.from[0]!)))[0];
  const moved = sources.slice(0, 3).map((s) => `${s.selector}${s.name ? ` "${s.name}"` : ''} (${s.from[0]},${s.from[1]})→(${s.to[0]},${s.to[1]})`).join('; ');
  const confirmed = score >= 0.1;
  return [{
    kind: 'layout-shift', severity: confirmed ? 'medium' : 'low', confidence: confirmed ? 'confirmed' : 'heuristic', confidenceScore: confirmed ? 0.85 : 0.5,
    basis: ['browser-metric'],
    // One problem per state and route, whichever element moved most at a given width.
    target: { role: 'page', name: 'layout', ...(biggest ? { selector: biggest.selector } : {}) },
    message: `content moved ${when} without recent input: layout-shift score ${score.toFixed(3)} over ${unexpected.length} shift(s)${confirmed ? ' (above the 0.1 Core Web Vitals threshold)' : ''}; moved: ${moved}`,
    evidence: { score: Math.round(score * 1000) / 1000, shifts: unexpected.length, firstAtMs: unexpected[0]!.at },
  }];
}

// ---------- label wrapping across nearby widths ----------

export interface WrapSample {
  device: string;
  width: number;
  labels: readonly RawLabel[];
  /** Controls (role + name) whose label was found clipped or truncated without an alternative at this width. */
  hiddenLabels: ReadonlySet<string>;
  frame?: string;
}

export const labelKey = (el: { role: string; name: string }) => `${el.role}\u0000${el.name}`;

export function matchesControl(m: ControlMatcher, el: { role: string; name: string }, route?: string): boolean {
  const glob = (p: string, s: string) => new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(s);
  return (!m.role || m.role === el.role) && (!m.name || glob(m.name, el.name)) && (!m.route || !route || glob(m.route, route));
}

/**
 * Compare label line counts between nearby widths (the wider at most `ratio` times the narrower). A
 * label that wraps only at the narrower width is a heuristic warning unless it causes harm there:
 * clipping or a hidden label, overlap with another control (functional), a control much taller than
 * at the wider width or than the control beside it (cosmetic), or a declared no-wrap expectation.
 */
export function wrapHits(samples: readonly WrapSample[], opts: { ratio: number; noWrap: readonly ControlMatcher[]; route?: string }): { device: string; hit: DetectorHit }[] {
  const sorted = [...samples].sort((a, b) => a.width - b.width);
  const out: { device: string; hit: DetectorHit }[] = [];
  const done = new Set<string>();
  for (let i = 0; i < sorted.length - 1; i++) {
    const n = sorted[i]!;
    const w = sorted[i + 1]!;
    if (w.width / n.width > opts.ratio) continue;
    const wide = new Map(w.labels.map((l) => [labelKey(l.el), l]));
    for (const ln of n.labels) {
      const lw = wide.get(labelKey(ln.el));
      const key = `${n.device}|${labelKey(ln.el)}`;
      if (!lw || ln.lines <= lw.lines || done.has(key)) continue;
      done.add(key);
      const heightRatio = ln.box.h / Math.max(1, lw.box.h);
      const rowRatio = ln.rowMinH ? ln.box.h / Math.max(1, ln.rowMinH) : 1;
      const harm: string[] = [];
      let kind: 'functional' | 'expectation' | 'cosmetic' | 'none' = 'none';
      if (n.hiddenLabels.has(labelKey(ln.el))) harm.push('its label is cut off or truncated');
      if (ln.overlaps) harm.push(`it overlaps ${ln.overlaps}`);
      if (harm.length) kind = 'functional';
      const expected = opts.noWrap.find((m) => matchesControl(m, ln.el, opts.route));
      if (kind === 'none' && expected) { kind = 'expectation'; harm.push('the project expects this label never to wrap (scan.noWrap)'); }
      const tall = heightRatio >= 1.35 && ln.box.h - lw.box.h >= 12;
      const uneven = rowRatio >= 1.3;
      if (kind === 'none' && (tall || uneven)) {
        kind = 'cosmetic';
        if (tall) harm.push(`it grows from ${r1(lw.box.h)} to ${r1(ln.box.h)} px tall (${heightRatio.toFixed(2)}×)`);
        if (uneven) harm.push(`it is ${rowRatio.toFixed(2)}× the height of the control beside it (${r1(ln.rowMinH!)} px)`);
      }
      const severity = kind === 'functional' || kind === 'expectation' ? 'medium' : 'low';
      const confirmed = kind !== 'none';
      const basis: EvidenceBasis[] = kind === 'functional' ? ['comparison', 'clipping'] : ['comparison'];
      const verdict = kind === 'functional' ? 'Functional harm' : kind === 'expectation' ? 'Violates a declared expectation' : kind === 'cosmetic' ? 'Cosmetic: nothing is hidden or covered' : 'No harm measured: wrapping by itself is not a defect';
      const frames: EvidenceFrame[] = [
        ...(n.frame ? [{ label: `${n.width} px: ${ln.lines} lines`, path: n.frame, device: n.device }] : []),
        ...(w.frame ? [{ label: `${w.width} px: ${lw.lines} line${lw.lines > 1 ? 's' : ''}`, path: w.frame, device: w.device }] : []),
      ];
      out.push({
        device: n.device,
        hit: {
          kind: 'text-wrap-change', severity, confidence: confirmed ? 'confirmed' : 'heuristic', confidenceScore: kind === 'functional' ? 0.85 : kind === 'expectation' ? 0.9 : kind === 'cosmetic' ? 0.7 : 0.4,
          basis, target: targetOf(ln.el), frames,
          message: `${who(ln.el)} wraps to ${ln.lines} lines at ${n.width} px (${r1(ln.box.h)} px tall) but fits on ${lw.lines} line${lw.lines > 1 ? 's' : ''} at ${w.width} px (${r1(lw.box.h)} px). ` +
            `${verdict}${harm.length ? `: ${harm.join('; ')}` : ''}`,
          evidence: {
            harm: kind, linesNarrow: ln.lines, linesWide: lw.lines, widthNarrow: n.width, widthWide: w.width, comparedWith: w.device,
            heightNarrow: r1(ln.box.h), heightWide: r1(lw.box.h), controlWidthNarrow: r1(ln.box.w), controlWidthWide: r1(lw.box.w),
            ...(ln.rowMinH ? { rowNeighbourHeight: r1(ln.rowMinH) } : {}),
          },
        },
      });
    }
  }
  return out;
}
