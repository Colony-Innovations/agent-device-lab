import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FindingStore, fingerprintOf } from '../dist/core/findings.js';
import { DETECTORS } from '../dist/core/detectors.js';
import { checkFilter } from '../dist/core/checks.js';

const exportCsv = { ref: 'e10', role: 'button', name: 'Export CSV', rect: { x: 482, y: 147, w: 116, h: 44 }, clip: { side: 'right', px: 208 } };
const obs = (over = {}) => ({
  route: '/reports', gen: 2, viewport: { width: 390, height: 844 }, documentWidth: 598, controls: [exportCsv],
  layout: [
    { kind: 'horizontal-overflow', severity: 'medium', key: 'overflow', message: 'document is 598px wide', evidence: { documentWidth: 598 } },
    { kind: 'control-clipped', severity: 'high', key: 'clipped:e10', ref: 'e10', message: 'button "Export CSV" extends 208px', evidence: { pastEdgePx: 208 } },
  ],
  ...over,
});

test('layout flags become findings once, deduplicated across refs and generations', () => {
  const store = new FindingStore('mobile-390');
  const first = store.recordObservation(obs(), ['open /invoices', 'click link "Reports"']);
  assert.deepEqual(first.map((f) => [f.id, f.kind]), [['F1', 'horizontal-overflow'], ['F2', 'control-clipped']]);
  assert.deepEqual(first[1].reproduction, ['open /invoices', 'click link "Reports"']);

  // Same page observed again after a navigation: new ref, same control.
  const again = store.recordObservation(obs({ gen: 5, controls: [{ ...exportCsv, ref: 'e30' }], layout: obs().layout.map((f) => (f.ref ? { ...f, ref: 'e30' } : f)) }), []);
  assert.equal(again.length, 0);
  assert.equal(store.size, 2);
  assert.equal(store.get('F2').occurrences, 2);
  assert.equal(store.get('F2').lastSeenGen, 5);
  assert.equal(store.get('F2').target.ref, 'e30');
});

test('a sideways pan is its own high-severity finding when the control started fully outside', () => {
  const store = new FindingStore('mobile-390');
  const f = store.recordHorizontalPan(obs(), exportCsv, { role: 'button', name: 'Export CSV', ref: 'e10' }, 208, ['open', 'click link "Reports"', 'click button "Export CSV"']);
  assert.equal(f.kind, 'horizontal-pan-required');
  assert.equal(f.severity, 'high');
  assert.equal(f.source, 'interaction');
  assert.equal(f.evidence.panPx, 208);
  assert.equal(f.reproduction.at(-1), 'click button "Export CSV"');
  assert.equal(store.recordHorizontalPan(obs(), exportCsv, { role: 'button', name: 'Export CSV', ref: 'e10' }, 208, []), undefined, 'deduplicated');
});

test('a partially visible control that needed a pan is medium severity', () => {
  const store = new FindingStore('mobile-390');
  const to = { ref: 'e9', role: 'textbox', name: 'To', rect: { x: 290, y: 0, w: 180, h: 44 }, clip: { side: 'right', px: 80 } };
  assert.equal(store.recordHorizontalPan(obs(), to, { role: 'textbox', name: 'To', ref: 'e9' }, 80, []).severity, 'medium');
});

test('findings are attributed per device: the same defect at two widths is two findings, sweep refs are dropped', () => {
  const store = new FindingStore('mobile-390');
  const session = store.recordObservation(obs(), ['open']);
  const at320 = store.recordObservation(obs({ viewport: { width: 320, height: 568 } }), ['open', 'sweep'], { device: 'mobile-320' });
  assert.deepEqual(session.map((f) => f.device), ['mobile-390', 'mobile-390']);
  assert.deepEqual(at320.map((f) => [f.device, f.viewportWidth]), [['mobile-320', 320], ['mobile-320', 320]]);
  assert.equal(store.size, 4, 'no cross-device deduplication');
  assert.equal(session[1].target.ref, 'e10', 'session findings keep the actionable ref');
  assert.equal(at320[1].target.ref, undefined, 'sweep refs belong to a closed context');
  assert.ok([...session, ...at320].every((f) => f.confidence === 'heuristic'));
  const pan = store.recordHorizontalPan(obs(), exportCsv, { role: 'button', name: 'Export CSV', ref: 'e10' }, 208, [], { device: 'mobile-320', source: 'sweep-reachability' });
  assert.deepEqual([pan.confidence, pan.source, pan.device], ['confirmed', 'sweep-reachability', 'mobile-320']);
  const blocked = store.recordObstruction(obs(), exportCsv, 'div#banner "Promo"', ['open'], { device: 'tablet-768' });
  assert.deepEqual([blocked.kind, blocked.confidence, blocked.severity, blocked.evidence.coveredBy], ['control-obstructed', 'confirmed', 'high', 'div#banner "Promo"']);
});

// ---------- scan findings: contexts, fingerprints, severity guard ----------

const where = (route = '/checkout') => ({ route, viewport: { width: 390 }, gen: 1 });
const hit = (over = {}) => ({
  kind: 'tap-target', severity: 'medium', confidence: 'confirmed', confidenceScore: 0.9, basis: ['standard'],
  target: { role: 'button', name: 'Save', ref: 'e5', selector: '#save' }, message: 'button "Save" is 18x18 px', evidence: { width: 18, height: 18 }, ...over,
});
const scanCtx = (over = {}) => ({ device: 'mobile-390', scenario: 'checkout', state: 'after setup', ...over });

test('recordHit: the same problem in a later state is one finding that lists both states', () => {
  const store = new FindingStore('mobile-390');
  const first = store.recordHit(hit(), where(), ['open /checkout'], scanCtx());
  assert.equal(first.fresh, true);
  const second = store.recordHit(hit(), { ...where(), gen: 4 }, ['open /checkout', 'click "Filters"'], scanCtx({ state: 'explored Filters' }));
  assert.equal(second.fresh, false);
  assert.equal(store.size, 1);
  assert.equal(second.finding, first.finding);
  assert.equal(first.finding.occurrences, 2);
  assert.deepEqual(first.finding.states, ['after setup', 'explored Filters']);
  assert.equal(first.finding.lastSeenGen, 4);
  store.recordHit(hit(), where(), [], scanCtx({ state: 'explored Filters' }));
  assert.deepEqual(first.finding.states, ['after setup', 'explored Filters'], 'a repeated state is listed once');
});

test('recordHit: scenario and device split findings but keep one fingerprint; route or element changes it', () => {
  const store = new FindingStore('mobile-390');
  const a = store.recordHit(hit(), where(), [], scanCtx()).finding;
  const otherScenario = store.recordHit(hit(), where(), [], scanCtx({ scenario: 'cart' })).finding;
  const otherDevice = store.recordHit(hit(), where(), [], scanCtx({ device: 'mobile-320' })).finding;
  assert.equal(store.size, 3);
  assert.equal(otherScenario.fingerprint, a.fingerprint);
  assert.equal(otherDevice.fingerprint, a.fingerprint);
  const otherRoute = store.recordHit(hit(), where('/cart'), [], scanCtx()).finding;
  const otherName = store.recordHit(hit({ target: { role: 'button', name: 'Delete' } }), where(), [], scanCtx()).finding;
  assert.notEqual(otherRoute.fingerprint, a.fingerprint);
  assert.notEqual(otherName.fingerprint, a.fingerprint);
});

test('fingerprintOf ignores the route fragment but not the path', () => {
  const t = { role: 'button', name: 'Save' };
  assert.equal(fingerprintOf('tap-target', '/a#x', t), fingerprintOf('tap-target', '/a#y', t));
  assert.equal(fingerprintOf('tap-target', '/a#x', t), fingerprintOf('tap-target', '/a', t));
  assert.notEqual(fingerprintOf('tap-target', '/a', t), fingerprintOf('tap-target', '/b', t));
  assert.notEqual(fingerprintOf('tap-target', '/a', t), fingerprintOf('tap-target', '/a', { ...t, context: 'Card 2' }));
  assert.match(fingerprintOf('layout-shift', '/a'), /^[0-9a-f]{12}$/, 'a finding with no target still has one');
});

test('a control covered at its centre is one problem whether the reach check or a fixed bar found it', () => {
  const store = new FindingStore('mobile-390');
  const save = { ref: 'e5', role: 'button', name: 'Save', rect: { x: 0, y: 0, w: 60, h: 40 } };
  const ctx = scanCtx();
  const reach = store.obstructionResult(obs({ route: '/checkout' }), save, 'div#bar', [], ctx).finding;
  const under = store.recordHit(hit({ kind: 'content-under-fixed', basis: ['hit-test'] }), where(), [], ctx).finding;
  const tap = store.recordHit(hit({ kind: 'tap-target' }), where(), [], ctx).finding;
  assert.equal(reach.kind, 'control-obstructed');
  assert.equal(under.fingerprint, reach.fingerprint);
  assert.notEqual(tap.fingerprint, reach.fingerprint);
});

test('severity guard: a heuristic is high only when a deterministic measurement backs it', () => {
  const store = new FindingStore('mobile-390');
  const geometric = store.recordHit(hit({ kind: 'outside-container', confidence: 'heuristic', severity: 'high', basis: ['geometry'], target: { role: 'button', name: 'A' } }), where(), [], scanCtx()).finding;
  const measured = store.recordHit(hit({ kind: 'outside-container', confidence: 'heuristic', severity: 'high', basis: ['clipping'], target: { role: 'button', name: 'B' } }), where(), [], scanCtx()).finding;
  assert.equal(geometric.severity, 'medium');
  assert.equal(measured.severity, 'high');
  const confirmed = store.recordHit(hit({ severity: 'high', confidence: 'confirmed', basis: ['geometry'], target: { role: 'button', name: 'C' } }), where(), [], scanCtx()).finding;
  assert.equal(confirmed.severity, 'high', 'the guard applies to heuristics only');
});

test('every finding carries detector, score, basis and a 12 hex character fingerprint', () => {
  const store = new FindingStore('mobile-390');
  const fromHit = store.recordHit(hit({ kind: 'container-clipped', basis: ['clipping', 'hit-test'] }), where(), [], scanCtx()).finding;
  const fromObservation = store.recordObservation(obs(), [])[0];
  const pan = store.recordHorizontalPan(obs(), exportCsv, { role: 'button', name: 'Export CSV', ref: 'e10' }, 208, []);
  for (const f of [fromHit, fromObservation, pan]) {
    assert.deepEqual(f.detector, { name: f.kind, version: DETECTORS[f.kind].version });
    assert.equal(typeof f.confidenceScore, 'number');
    assert.ok(Array.isArray(f.basis) && f.basis.length > 0);
    assert.match(f.fingerprint, /^[0-9a-f]{12}$/);
  }
  assert.deepEqual(fromHit.basis, ['clipping', 'hit-test']);
});

test('scan-context findings drop the ref; session findings keep it', () => {
  const store = new FindingStore('mobile-390');
  assert.equal(store.recordHit(hit(), where(), [], scanCtx()).finding.target.ref, undefined);
  const session = store.recordHit(hit({ target: { role: 'button', name: 'Other', ref: 'e9' } }), where(), [], {}).finding;
  assert.equal(session.target.ref, 'e9');
});

test('adopt copies a finding into a scenario context', () => {
  const setup = new FindingStore('mobile-390');
  const original = setup.recordHit(hit(), where(), ['step'], { device: 'mobile-390' }).finding;
  const scan = new FindingStore('mobile-390');
  const r = scan.adopt(original, ['open', 'click'], scanCtx());
  assert.equal(r.fresh, true);
  assert.notEqual(r.finding, original);
  assert.deepEqual([r.finding.kind, r.finding.message, r.finding.route], [original.kind, original.message, original.route]);
  assert.deepEqual([r.finding.scenario, r.finding.state, r.finding.device], ['checkout', 'after setup', 'mobile-390']);
  assert.deepEqual(r.finding.reproduction, ['open', 'click']);
  assert.equal(r.finding.fingerprint, original.fingerprint);
  assert.equal(scan.adopt(original, [], scanCtx()).fresh, false, 'adopting twice merges');
});

test('suppress sets and clears the suppression without dropping the finding', () => {
  const store = new FindingStore('mobile-390');
  const f = store.recordHit(hit(), where(), [], scanCtx()).finding;
  store.suppress(f.id, { rule: 0, reason: 'known' });
  assert.deepEqual(store.get(f.id).suppressed, { rule: 0, reason: 'known' });
  store.suppress(f.id, undefined);
  assert.equal(store.get(f.id).suppressed, undefined);
  assert.equal(store.size, 1);
  store.suppress('F99', { rule: 0, reason: 'x' }); // unknown ids are ignored
});

test('checkFilter: enable limits kinds, disable removes them, undefined allows all', () => {
  const onlyTap = checkFilter({ enable: ['tap-target'] });
  assert.equal(onlyTap('tap-target'), true);
  assert.equal(onlyTap('layout-shift'), false);
  const both = checkFilter({ disable: ['layout-shift'] }, { disable: ['tap-target'] });
  assert.equal(both('layout-shift'), false);
  assert.equal(both('tap-target'), false);
  assert.equal(both('text-clipped'), true);
  const open = checkFilter(undefined, undefined);
  assert.ok(open('tap-target') && open('layout-shift'));
  assert.ok(checkFilter()('tap-target'));
  assert.equal(checkFilter({ enable: [] })('tap-target'), true, 'an empty enable list limits nothing');
  assert.equal(checkFilter({ enable: ['tap-target'] }, { disable: ['tap-target'] })('tap-target'), false, 'every config must allow the kind');
});
