import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DETECTORS, coveredHits, detectLayout, matchesControl, modalHits, shiftHits, tapTargetHits, wrapHits, labelKey } from '../dist/core/detectors.js';

// ---------- factories for the raw measurements extract.ts produces ----------

const el = (role, name, over = {}) => ({ role, name, selector: `${role}.${name.replace(/\W+/g, '-').toLowerCase() || 'x'}`, control: role === 'button' || role === 'link', ...over });
const box = (x, y, w, h) => ({ x, y, w, h });
const target = (x, y, w, h, over = {}) => ({ el: el('button', `t${x}`), box: box(x, y, w, h), inline: false, userAgent: false, ...over });
const rawLayout = (over = {}) => ({
  viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 }, scrollMax: { x: 0, y: 2000 },
  targets: [], clips: [], texts: [], fixed: [], scrollers: [], outside: [], beforeOrigin: [], labels: [], examined: 0, omitted: 0, ...over,
});
const only = (...kinds) => ({ tapTargets: { standard: 'wcag22-aa' }, layoutShiftMin: 0.05, enabled: (k) => kinds.includes(k) });
const all = { tapTargets: { standard: 'wcag22-aa' }, layoutShiftMin: 0.05, enabled: () => true };
const AA = { standard: 'wcag22-aa' };
const AAA = { standard: 'wcag22-aaa' };

// ---------- tap targets ----------

test('tap targets: 18x18 targets 2 px apart each fail WCAG 2.2 SC 2.5.8', () => {
  const hits = tapTargetHits([target(0, 0, 18, 18), target(20, 0, 18, 18), target(40, 0, 18, 18)], AA);
  assert.equal(hits.length, 3);
  for (const h of hits) {
    assert.deepEqual([h.kind, h.severity, h.confidence], ['tap-target', 'medium', 'confirmed']);
    assert.deepEqual(h.basis, ['standard']);
    assert.equal(h.evidence.width, 18);
    assert.equal(h.evidence.height, 18);
    assert.equal(h.evidence.minimum, 24);
    assert.ok('nearest' in h.evidence && 'distancePx' in h.evidence, 'the spacing conflict is evidenced');
    assert.match(h.message, /2\.5\.8/);
  }
});

test('tap targets: the spacing exception spares 20x20 targets whose 24 px circles do not overlap', () => {
  // Centres 28 px apart: circles (radius 12) do not meet, and neither circle reaches the other box.
  assert.deepEqual(tapTargetHits([target(0, 0, 20, 20), target(28, 0, 20, 20)], AA), []);
  assert.deepEqual(tapTargetHits([target(0, 0, 20, 20)], AA), [], 'an isolated small target is fine');
});

test('tap targets: a small target whose circle reaches a large neighbour fails', () => {
  // Centre of the 20x20 box at x=10; the big box starts at x=21: 11 px away, under the 12 px radius.
  const hits = tapTargetHits([target(0, 12, 20, 20), target(21, 0, 100, 44)], AA);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].evidence.width, 20);
  assert.equal(hits[0].evidence.distancePx, 11);
});

test('tap targets: inline and user-agent targets are exempt', () => {
  const hits = tapTargetHits([target(0, 0, 18, 18, { inline: true }), target(20, 0, 18, 18, { userAgent: true })], AA);
  assert.deepEqual(hits, []);
});

test('tap targets: 30x30 passes AA and fails AAA, which has no spacing exception', () => {
  assert.deepEqual(tapTargetHits([target(0, 0, 30, 30)], AA), []);
  const hits = tapTargetHits([target(0, 0, 30, 30)], AAA);
  assert.equal(hits.length, 1, 'an isolated 30x30 target still fails AAA');
  assert.equal(hits[0].evidence.minimum, 44);
  assert.equal(hits[0].evidence.standard, 'wcag22-aaa');
  assert.match(hits[0].message, /2\.5\.5/);
});

test('tap targets: a target nested inside another target is not compared against it', () => {
  // Without the containment rule the inner box's centre would sit 0 px from the outer box.
  const outer = target(0, 0, 100, 44, { el: el('link', 'Card') });
  const inner = target(10, 10, 20, 20, { el: el('button', 'Fav') });
  assert.deepEqual(tapTargetHits([outer, inner], AA), []);
  assert.deepEqual(tapTargetHits([inner, outer], AA), []);
});

// ---------- clipping ----------

const clip = (over = {}) => ({ el: el('button', 'Export'), box: box(0, 0, 100, 40), visible: box(0, 0, 80, 40), clipper: 'div.track', visibleShare: 0.8, hiddenPx: 20, peek: false, centreHit: true, ...over });
const clipHits = (c) => detectLayout(rawLayout({ clips: [c] }), only('container-clipped'));

test('clipping: hidden on purpose, peeking carousel and sub-pixel nicks are not findings', () => {
  assert.deepEqual(clipHits(clip({ visibleShare: 0 })), []);
  assert.deepEqual(clipHits(clip({ peek: true })), []);
  assert.deepEqual(clipHits(clip({ hiddenPx: 3 })), []);
});

test('clipping: a control the pointer cannot reach at its centre is high and confirmed by the hit test', () => {
  const [h] = clipHits(clip({ centreHit: false, visibleShare: 0.5, hiddenPx: 50 }));
  assert.deepEqual([h.kind, h.severity, h.confidence], ['container-clipped', 'high', 'confirmed']);
  assert.ok(h.basis.includes('hit-test'));
});

test('clipping: a control 20% hidden that is still hit at its centre is medium confirmed', () => {
  const [h] = clipHits(clip({ centreHit: true, visibleShare: 0.8, hiddenPx: 20 }));
  assert.deepEqual([h.severity, h.confidence], ['medium', 'confirmed']);
});

test('clipping: text is confirmed when a tenth or more is hidden, otherwise a low heuristic', () => {
  const text = (over) => clip({ el: el('text', 'Long paragraph', { control: false }), ...over });
  const [thirty] = clipHits(text({ visibleShare: 0.7, hiddenPx: 30 }));
  assert.deepEqual([thirty.severity, thirty.confidence], ['medium', 'confirmed']);
  const [five] = clipHits(text({ visibleShare: 0.95, hiddenPx: 5 }));
  assert.deepEqual([five.severity, five.confidence], ['low', 'heuristic']);
});

test('clipping: content in motion (a marquee or carousel) is never container-clipped, however much is hidden', () => {
  assert.deepEqual(clipHits(clip({ moving: true, centreHit: false, visibleShare: 0.5, hiddenPx: 50 })), []);
  const text = el('text', 'Copper Jewellery', { control: false });
  assert.deepEqual(clipHits(clip({ el: text, moving: true, visibleShare: 0.3, hiddenPx: 70 })), []);
  assert.equal(clipHits(clip({ moving: false, visibleShare: 0.3, hiddenPx: 70 })).length, 1, 'the same clip without motion is still reported');
  assert.ok(DETECTORS['container-clipped'].version >= 3 && DETECTORS['text-clipped'].version >= 3 && DETECTORS['unreachable-content'].version >= 2);
});

// ---------- text overflow ----------

const overflow = (over = {}) => ({ el: el('text', 'A long label', { control: false }), heading: false, axis: 'x', ellipsis: false, clamp: false, scrollSize: 200, clientSize: 100, alternative: false, ...over });
const textHits = (t) => detectLayout(rawLayout({ texts: [t] }), all);
const btn = el('button', 'Checkout now');

test('text overflow: an ellipsis on a control label with no alternative is confirmed truncation', () => {
  const [h] = textHits(overflow({ control: btn, ellipsis: true, alternative: false }));
  assert.deepEqual([h.kind, h.severity, h.confidence], ['text-truncated', 'medium', 'confirmed']);
  assert.equal(h.target.name, 'Checkout now', 'the control is the target, not the inner text');
});

test('text overflow: an alternative (title or full accessible name) makes truncation a low heuristic', () => {
  const [h] = textHits(overflow({ control: btn, ellipsis: true, alternative: true }));
  assert.deepEqual([h.kind, h.severity, h.confidence], ['text-truncated', 'low', 'heuristic']);
});

test('text overflow: an ellipsis on plain text is a low heuristic', () => {
  const [h] = textHits(overflow({ ellipsis: true }));
  assert.deepEqual([h.kind, h.severity, h.confidence], ['text-truncated', 'low', 'heuristic']);
});

test('text overflow: a line clamp counts as truncation', () => {
  const [h] = textHits(overflow({ clamp: true, axis: 'y', control: btn }));
  assert.equal(h.kind, 'text-truncated');
});

test('text overflow: sideways cut-off without an ellipsis is text-clipped and confirmed', () => {
  const [inControl] = textHits(overflow({ control: btn, scrollSize: 200, clientSize: 100 })); // 50% hidden
  assert.deepEqual([inControl.kind, inControl.severity, inControl.confidence], ['text-clipped', 'high', 'confirmed']);
  const [slight] = textHits(overflow({ control: btn, scrollSize: 110, clientSize: 100 })); // under 25% hidden
  assert.deepEqual([slight.severity, slight.confidence], ['medium', 'confirmed']);
  const [plain] = textHits(overflow({ scrollSize: 200, clientSize: 100 }));
  assert.deepEqual([plain.kind, plain.severity, plain.confidence], ['text-clipped', 'medium', 'confirmed']);
});

test('text overflow: plain text cut off vertically with no clamp is only a heuristic', () => {
  const [h] = textHits(overflow({ axis: 'y', scrollSize: 300, clientSize: 100 }));
  assert.deepEqual([h.kind, h.severity, h.confidence], ['text-clipped', 'medium', 'heuristic']);
});

test('text overflow: disabled kinds are not reported', () => {
  assert.deepEqual(detectLayout(rawLayout({ texts: [overflow({ ellipsis: true })] }), only('text-clipped')), []);
});

// ---------- fixed layers ----------

const layer = (selector, b, over = {}) => ({ el: el('banner', selector, { selector, control: false }), box: b, position: 'fixed', edge: 'top', viewportShare: 0.1, controls: [], onScreen: 1, ...over });
const fixedHits = (fixed) => detectLayout(rawLayout({ fixed }), only('fixed-collision'));

test('fixed layers: a control covered at its centre by another fixed layer is one high confirmed collision', () => {
  const save = el('button', 'Save');
  const a = layer('#toolbar', box(0, 0, 390, 56), { controls: [{ el: save, box: box(300, 8, 60, 40), coveredBy: '#banner' }] });
  const b = layer('#banner', box(0, 20, 390, 56)); // overlaps a: the pair heuristic must not repeat the finding
  const hits = fixedHits([a, b]);
  assert.equal(hits.length, 1);
  assert.deepEqual([hits[0].kind, hits[0].severity, hits[0].confidence], ['fixed-collision', 'high', 'confirmed']);
  assert.deepEqual(hits[0].basis, ['hit-test']);
  assert.equal(hits[0].target.name, 'Save');
});

test('fixed layers: a backdrop layer never counts as covering', () => {
  const save = el('button', 'Save');
  const a = layer('#toolbar', box(0, 0, 390, 56), { controls: [{ el: save, box: box(300, 8, 60, 40), coveredBy: '#backdrop' }] });
  const backdrop = layer('#backdrop', box(0, 0, 390, 844), { viewportShare: 1 });
  assert.deepEqual(fixedHits([a, backdrop]), []);
});

test('fixed layers: two overlapping layers with no covered control are heuristic, sized by the overlap', () => {
  const medium = fixedHits([layer('#a', box(0, 0, 390, 56)), layer('#b', box(0, 40, 390, 56))]); // 16 of 56 px = 29% of the smaller
  assert.equal(medium.length, 1);
  assert.deepEqual([medium[0].severity, medium[0].confidence], ['medium', 'heuristic']);
  const low = fixedHits([layer('#a', box(0, 0, 390, 56)), layer('#b', box(0, 48, 390, 56))]); // 8 of 56 px = 14%
  assert.deepEqual([low[0].severity, low[0].confidence], ['low', 'heuristic']);
  assert.deepEqual(fixedHits([layer('#a', box(0, 0, 8, 8)), layer('#b', box(4, 4, 8, 8))]), [], 'a tiny overlap is ignored');
});

test('fixed layers: layers mostly off screen are ignored', () => {
  assert.deepEqual(fixedHits([layer('#a', box(0, 0, 390, 56)), layer('#drawer', box(0, 0, 390, 56), { onScreen: 0.3 })]), []);
});

// ---------- content under fixed bars ----------

test('content under a fixed bar: control, strongly covered text and weakly covered text', () => {
  const [control] = coveredHits([{ el: el('button', 'Pay'), bar: '#cta', edge: 'bottom', share: 0.6, centreCovered: true, box: box(0, 800, 100, 40) }]);
  assert.deepEqual([control.kind, control.severity, control.confidence], ['content-under-fixed', 'high', 'confirmed']);
  const text = (share) => coveredHits([{ el: el('text', 'Terms apply', { control: false }), bar: '#cta', edge: 'bottom', share, centreCovered: false, box: box(0, 800, 100, 20) }])[0];
  assert.deepEqual([text(0.5).severity, text(0.5).confidence], ['medium', 'confirmed']);
  assert.deepEqual([text(0.3).severity, text(0.3).confidence], ['low', 'heuristic']);
});

// ---------- modal ----------

const dialog = el('dialog', 'Settings', { control: false });
const modal = (over = {}) => ({ el: dialog, box: box(0, 100, 390, 900), scrollable: false, overflowPx: 156, controls: 4, ...over });
const vp = { width: 390, height: 844 };

test('modal: unreachable controls make the dialog itself the high confirmed target', () => {
  const unreachable = [{ el: el('button', 'Save'), box: box(0, 900, 100, 40) }, { el: el('button', 'Cancel'), box: box(120, 900, 100, 40) }];
  const hits = modalHits(modal(), unreachable, vp);
  assert.equal(hits.length, 1);
  assert.deepEqual([hits[0].kind, hits[0].severity, hits[0].confidence], ['modal-overflow', 'high', 'confirmed']);
  assert.equal(hits[0].target.role, 'dialog');
  assert.equal(hits[0].target.name, 'Settings');
  assert.equal(hits[0].evidence.unreachable, 2);
});

test('modal: overflow without unreachable controls is a medium heuristic; scrollable or absent is nothing', () => {
  assert.deepEqual(modalHits(undefined, [], vp), []);
  const [h] = modalHits(modal({ overflowPx: 10 }), [], vp);
  assert.deepEqual([h.kind, h.severity, h.confidence], ['modal-overflow', 'medium', 'heuristic']);
  assert.deepEqual(modalHits(modal({ scrollable: true }), [], vp), []);
  assert.deepEqual(modalHits(modal({ overflowPx: 2 }), [], vp), [], 'a sub-4 px overflow is ignored');
});

test('text overflow: text in an animated strip is never text-clipped; static cut-off text still is', () => {
  assert.deepEqual(textHits(overflow({ moving: true })), []);
  assert.deepEqual(textHits(overflow({ moving: true, axis: 'y' })), []);
  assert.equal(textHits(overflow({ moving: false }))[0].kind, 'text-clipped');
});

// ---------- before the scroll origin ----------

const before = (over = {}) => ({ el: el('button', 'Back'), box: box(-30, 0, 100, 40), container: 'div.row', hiddenPx: 30, share: 0.3, centreHidden: true, ...over });
const beforeHits = (b) => detectLayout(rawLayout({ beforeOrigin: [b] }), only('unreachable-content'));

test('before origin: a control hidden at its centre is high confirmed', () => {
  const [h] = beforeHits(before());
  assert.deepEqual([h.kind, h.severity, h.confidence], ['unreachable-content', 'high', 'confirmed']);
});

test('before origin: moving content is not unreachable content', () => {
  assert.deepEqual(beforeHits(before({ moving: true })), []);
});

test('before origin: text 30% hidden is medium confirmed; a sub-4 px nick is nothing', () => {
  const text = el('text', 'Heading', { control: false });
  const [h] = beforeHits(before({ el: text, share: 0.3 }));
  assert.deepEqual([h.severity, h.confidence], ['medium', 'confirmed']);
  assert.deepEqual(beforeHits(before({ hiddenPx: 3 })), []);
});

// ---------- outside container ----------

test('outside container: always heuristic, medium from 16 px', () => {
  const out = (right) => detectLayout(rawLayout({ outside: [{ el: el('button', 'Go'), box: box(0, 0, 100, 40), container: 'div.card', containerBox: box(0, 0, 100 - right, 40), overhang: { top: 0, right, bottom: 0, left: 0 } }] }), only('outside-container'))[0];
  assert.deepEqual([out(20).severity, out(20).confidence], ['medium', 'heuristic']);
  assert.deepEqual([out(16).severity, out(16).confidence], ['medium', 'heuristic']);
  assert.deepEqual([out(8).severity, out(8).confidence], ['low', 'heuristic']);
});

// ---------- sideways scrollers ----------

const scroller = (over = {}) => ({ el: el('region', 'div.list', { control: false }), box: box(0, 0, 300, 100), scrollWidth: 500, clientWidth: 300, paragraphs: 0, ...over });
const scrollHits = (s) => detectLayout(rawLayout({ scrollers: [s] }), only('content-scroll-x'));

test('scrollers: intentional or barely overflowing regions are nothing', () => {
  assert.deepEqual(scrollHits(scroller({ intentional: 'carousel' })), []);
  assert.deepEqual(scrollHits(scroller({ scrollWidth: 303 })), []);
});

test('scrollers: the detector version records the native-select exclusion', () => {
  assert.ok(DETECTORS['content-scroll-x'].version >= 2);
});

test('scrollers: heuristic low, medium when it holds prose and overflows by a quarter; never high or confirmed', () => {
  const [plain] = scrollHits(scroller());
  assert.deepEqual([plain.severity, plain.confidence], ['low', 'heuristic']);
  const [prose] = scrollHits(scroller({ paragraphs: 2 })); // 200 px excess >= 25% of 300
  assert.deepEqual([prose.severity, prose.confidence], ['medium', 'heuristic']);
  const [proseSlight] = scrollHits(scroller({ paragraphs: 2, scrollWidth: 340 })); // 40 px < 75 px
  assert.equal(proseSlight.severity, 'low');
});

// ---------- layout shift ----------

const shift = (value, over = {}) => ({ value, recentInput: false, at: 120, sources: [{ selector: 'div.hero', name: '', from: [0, 0], to: [0, 40] }], ...over });

test('layout shift: input-driven shifts are ignored and small totals are below the minimum', () => {
  assert.deepEqual(shiftHits([shift(0.5, { recentInput: true })], 0.05, 'while it settled'), []);
  assert.deepEqual(shiftHits([shift(0.03)], 0.05, 'while it settled'), []);
  assert.deepEqual(shiftHits([], 0.05, 'while it settled'), []);
});

test('layout shift: 0.05 to 0.1 is a low heuristic, 0.1 and up is a medium confirmed browser metric', () => {
  const [low] = shiftHits([shift(0.06)], 0.05, 'while it settled');
  assert.deepEqual([low.kind, low.severity, low.confidence], ['layout-shift', 'low', 'heuristic']);
  const [high] = shiftHits([shift(0.06), shift(0.06)], 0.05, 'while it settled'); // summed: 0.12
  assert.deepEqual([high.severity, high.confidence], ['medium', 'confirmed']);
  assert.deepEqual(high.basis, ['browser-metric']);
});

test('layout shift: the target is the page whichever element moved, so devices group together', () => {
  const a = shiftHits([shift(0.2, { sources: [{ selector: 'div.hero', name: '', from: [0, 0], to: [0, 40] }] })], 0.05, 'x')[0];
  const b = shiftHits([shift(0.2, { sources: [{ selector: 'p.intro', name: '', from: [0, 300], to: [0, 380] }] })], 0.05, 'x')[0];
  assert.equal(a.target.role, 'page');
  assert.equal(a.target.name, 'layout');
  assert.equal(b.target.role, 'page');
  assert.equal(b.target.name, 'layout');
});

// ---------- label wrapping across nearby widths ----------

const label = (lines, h, over = {}) => ({ el: el('button', 'Show 12 results'), lines, box: box(0, 0, 200, h), rowCount: 1, ...over });
const sample = (device, width, labels, over = {}) => ({ device, width, labels, hiddenLabels: new Set(), ...over });
const noOpts = { ratio: 1.35, noWrap: [] };

test('wrap: wrapping alone, with nothing measured wrong, is a low heuristic and says so', () => {
  const out = wrapHits([sample('mobile-320', 320, [label(2, 48)]), sample('mobile-390', 390, [label(1, 48)])], noOpts);
  assert.equal(out.length, 1);
  const { device, hit } = out[0];
  assert.equal(device, 'mobile-320');
  assert.deepEqual([hit.kind, hit.severity, hit.confidence], ['text-wrap-change', 'low', 'heuristic']);
  assert.equal(hit.evidence.harm, 'none');
  assert.match(hit.message, /wrapping by itself is not a defect/);
});

test('wrap: a much taller control, or one out of step with its row neighbour, is confirmed cosmetic', () => {
  const tall = wrapHits([sample('mobile-320', 320, [label(2, 70.8)]), sample('mobile-390', 390, [label(1, 48.4)])], noOpts)[0].hit;
  assert.deepEqual([tall.severity, tall.confidence, tall.evidence.harm], ['low', 'confirmed', 'cosmetic']);
  // 64/48 = 1.33 against the neighbour (>= 1.3) but only 1.33x against itself (< 1.35).
  const uneven = wrapHits([sample('mobile-320', 320, [label(2, 64, { rowMinH: 48, rowCount: 2 })]), sample('mobile-390', 390, [label(1, 48)])], noOpts)[0].hit;
  assert.deepEqual([uneven.severity, uneven.confidence, uneven.evidence.harm], ['low', 'confirmed', 'cosmetic']);
});

test('wrap: a cut-off label or an overlap is functional harm, medium and confirmed', () => {
  const key = labelKey(label(2, 48).el);
  const hidden = wrapHits([sample('mobile-320', 320, [label(2, 48)], { hiddenLabels: new Set([key]) }), sample('mobile-390', 390, [label(1, 48)])], noOpts)[0].hit;
  assert.deepEqual([hidden.severity, hidden.confidence, hidden.evidence.harm], ['medium', 'confirmed', 'functional']);
  const overlap = wrapHits([sample('mobile-320', 320, [label(2, 48, { overlaps: 'button "Next"' })]), sample('mobile-390', 390, [label(1, 48)])], noOpts)[0].hit;
  assert.deepEqual([overlap.severity, overlap.confidence, overlap.evidence.harm], ['medium', 'confirmed', 'functional']);
});

test('wrap: a declared no-wrap expectation makes it medium confirmed', () => {
  const opts = { ratio: 1.35, noWrap: [{ role: 'button', name: 'Show * results' }] };
  const hit = wrapHits([sample('mobile-320', 320, [label(2, 48)]), sample('mobile-390', 390, [label(1, 48)])], opts)[0].hit;
  assert.deepEqual([hit.severity, hit.confidence, hit.evidence.harm], ['medium', 'confirmed', 'expectation']);
  const other = wrapHits([sample('mobile-320', 320, [label(2, 48)]), sample('mobile-390', 390, [label(1, 48)])], { ratio: 1.35, noWrap: [{ role: 'link', name: 'Show * results' }] })[0].hit;
  assert.equal(other.evidence.harm, 'none', 'a matcher for another role does not apply');
});

test('wrap: widths further apart than the ratio are not compared', () => {
  assert.deepEqual(wrapHits([sample('mobile-390', 390, [label(2, 48)]), sample('tablet-768', 768, [label(1, 48)])], noOpts), []);
});

test('wrap: no change in line count, or a label that only exists at one width, is nothing', () => {
  assert.deepEqual(wrapHits([sample('a', 320, [label(1, 48)]), sample('b', 390, [label(1, 48)])], noOpts), []);
  assert.deepEqual(wrapHits([sample('a', 320, [label(2, 48)]), sample('b', 390, [])], noOpts), []);
});

test('wrap: the finding belongs to the narrower device and carries two frames, narrow first', () => {
  const out = wrapHits([
    sample('mobile-390', 390, [label(1, 48)], { frame: '/f/390.jpg' }),
    sample('mobile-320', 320, [label(2, 48)], { frame: '/f/320.jpg' }),
  ], noOpts);
  assert.equal(out.length, 1);
  assert.equal(out[0].device, 'mobile-320');
  const frames = out[0].hit.frames;
  assert.equal(frames.length, 2);
  assert.deepEqual([frames[0].path, frames[0].device], ['/f/320.jpg', 'mobile-320']);
  assert.deepEqual([frames[1].path, frames[1].device], ['/f/390.jpg', 'mobile-390']);
});

// ---------- matchesControl ----------

test('matchesControl: exact role, case-insensitive name glob, route glob', () => {
  const c = { role: 'button', name: 'Show 12 results' };
  assert.equal(matchesControl({ role: 'button' }, c), true);
  assert.equal(matchesControl({ role: 'link' }, c), false);
  assert.equal(matchesControl({ name: 'show * RESULTS' }, c), true);
  assert.equal(matchesControl({ name: 'show' }, c), false, 'a glob must match the whole name');
  assert.equal(matchesControl({ name: 'Show 1?' }, c), false, 'only * is a wildcard');
  assert.equal(matchesControl({ name: 'a.c' }, { role: 'button', name: 'abc' }), false, 'regex characters are literal');
  assert.equal(matchesControl({ route: '/products/*' }, c, '/products/12'), true);
  assert.equal(matchesControl({ route: '/products/*' }, c, '/cart'), false);
  assert.equal(matchesControl({ role: 'button', name: 'Show *', route: '/cart' }, c, '/cart'), true);
  assert.equal(matchesControl({}, c), true, 'an empty matcher matches every control');
});

// ---------- registry ----------

test('DETECTORS: every kind has a positive version, a family and a description', () => {
  for (const [kind, info] of Object.entries(DETECTORS)) {
    assert.ok(Number.isInteger(info.version) && info.version >= 1, kind);
    assert.ok(info.family && info.description, kind);
  }
  assert.equal(DETECTORS['control-obstructed'].family, DETECTORS['content-under-fixed'].family);
});
