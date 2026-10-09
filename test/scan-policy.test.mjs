import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSuppressions, groupFindings, evaluatePolicy, DEFAULT_POLICY, KIND_TITLES } from '../dist/core/scan-policy.js';

let n = 0;
const finding = (over = {}) => {
  n += 1;
  return {
    id: `F${n}`, kind: 'tap-target', detector: { name: 'tap-target', version: 1 }, severity: 'medium', source: 'scan',
    confidence: 'confirmed', confidenceScore: 0.9, basis: ['standard'], route: '/orders/42', device: 'mobile-390', viewportWidth: 390,
    scenario: 'Orders', state: 's0', target: { role: 'button', name: 'Delete order', ref: 'e5', selector: 'main > button' },
    message: 'too small', evidence: { w: 20 }, fingerprint: `fp-${n}`, firstSeen: { gen: 1, at: 't' }, lastSeenGen: 1, occurrences: 1,
    reproduction: ['open /orders/42'], ...over,
  };
};
const ctx = { today: '2026-09-29', scenarios: ['Orders', 'Filters'], devices: ['mobile-390', 'mobile-320'] };
const rule = (over = {}) => ({ reason: 'accepted', ...over });

test('each suppression field narrows the match', () => {
  const a = finding({ kind: 'tap-target', fingerprint: 'A' });
  const b = finding({ kind: 'text-clipped', fingerprint: 'B', route: '/other', device: 'mobile-320', scenario: 'Filters', target: { role: 'link', name: 'Help' } });
  const m = (r) => matchSuppressions([a, b], [rule(r)], ctx).statuses[0].matched;
  assert.deepEqual(m({ kind: 'tap-target' }), [a.id]);
  assert.deepEqual(m({ kind: ['tap-target', 'text-clipped'] }), [a.id, b.id]);
  assert.deepEqual(m({ fingerprint: 'B' }), [b.id]);
  assert.deepEqual(m({ kind: 'tap-target', route: '/other' }), []);
  assert.deepEqual(m({ kind: ['tap-target', 'text-clipped'], route: '/orders/42' }), [a.id]);
  assert.deepEqual(m({ kind: ['tap-target', 'text-clipped'], target: { role: 'link' } }), [b.id]);
  assert.deepEqual(m({ kind: ['tap-target', 'text-clipped'], target: { name: 'Help' } }), [b.id]);
  assert.deepEqual(m({ kind: ['tap-target', 'text-clipped'], scenario: 'Filters' }), [b.id]);
  assert.deepEqual(m({ kind: ['tap-target', 'text-clipped'], device: 'mobile-390' }), [a.id]);
});

test('route and target name accept * globs, anchored, * crossing slashes', () => {
  const f = finding({ route: '/orders/42/items', target: { role: 'button', name: 'Delete order' } });
  const m = (r) => matchSuppressions([f], [rule({ kind: 'tap-target', ...r })], ctx).statuses[0].matched.length;
  assert.equal(m({ route: '/orders/*' }), 1);
  assert.equal(m({ route: '/orders/*/items' }), 1);
  assert.equal(m({ route: '/orders' }), 0);
  assert.equal(m({ route: 'orders/*' }), 0);
  assert.equal(m({ route: '/orders/4.*' }), 0);
  assert.equal(m({ target: { name: 'Delete *' } }), 1);
  assert.equal(m({ target: { name: 'delete *' } }), 0);
  assert.equal(m({ target: { name: 'Delete' } }), 0);
  assert.equal(m({ target: { name: '*' } }), 1);
});

test('a target rule never matches a finding without a target', () => {
  const f = finding({ target: undefined });
  assert.equal(matchSuppressions([f], [rule({ kind: 'tap-target', target: { role: 'button' } })], ctx).statuses[0].matched.length, 0);
  assert.equal(matchSuppressions([f], [rule({ kind: 'tap-target', target: { name: '*' } })], ctx).statuses[0].matched.length, 0);
});

test('first matching rule wins; later rules still list what they matched', () => {
  const f = finding();
  const { statuses, applied } = matchSuppressions([f], [rule({ kind: 'tap-target', reason: 'first', expires: '2026-12-31' }), rule({ kind: 'tap-target', reason: 'second' })], ctx);
  assert.deepEqual(applied.get(f.id), { rule: 0, reason: 'first', expires: '2026-12-31' });
  assert.deepEqual(statuses.map((s) => [s.rule, s.status, s.matched]), [[0, 'applied', [f.id]], [1, 'applied', [f.id]]]);
  const noExpiry = matchSuppressions([f], [rule({ kind: 'tap-target' })], ctx).applied.get(f.id);
  assert.deepEqual(noExpiry, { rule: 0, reason: 'accepted' });
  assert.ok(!('expires' in noExpiry));
});

test('expired rules do not apply; today is still valid', () => {
  const f = finding();
  const r = matchSuppressions([f], [rule({ kind: 'tap-target', expires: '2026-09-28' })], ctx);
  assert.equal(r.statuses[0].status, 'expired');
  assert.deepEqual(r.statuses[0].matched, []);
  assert.equal(r.applied.size, 0);
  const today = matchSuppressions([f], [rule({ kind: 'tap-target', expires: '2026-09-29' })], ctx);
  assert.equal(today.statuses[0].status, 'applied');
});

test('unmatched is stale; a scope outside the run is not-evaluated', () => {
  const f = finding();
  const { statuses } = matchSuppressions([f], [
    rule({ kind: 'text-clipped' }),
    rule({ kind: 'text-clipped', scenario: 'Checkout' }),
    rule({ kind: 'text-clipped', device: 'desktop' }),
    rule({ kind: 'text-clipped', scenario: 'Filters', device: 'mobile-320' }),
  ], { ...ctx });
  assert.deepEqual(statuses.map((s) => s.status), ['unmatched', 'not-evaluated', 'not-evaluated', 'unmatched']);
});

test('matchSuppressions does not mutate its inputs', () => {
  const fs = [finding()];
  const rules = [rule({ kind: 'tap-target' })];
  const before = JSON.stringify([fs, rules, ctx]);
  matchSuppressions(fs, rules, ctx);
  assert.equal(JSON.stringify([fs, rules, ctx]), before);
  assert.equal(fs[0].suppressed, undefined);
});

test('groups share a fingerprint across devices and scenarios', () => {
  const a = finding({ fingerprint: 'X', device: 'mobile-390', scenario: 'Orders' });
  const b = finding({ fingerprint: 'X', device: 'mobile-320', scenario: undefined });
  const c = finding({ fingerprint: 'Y', kind: 'modal-overflow', target: undefined, route: '/cart' });
  const groups = groupFindings([a, b, c]);
  assert.equal(groups.length, 2);
  const gx = groups.find((g) => g.fingerprint === 'X');
  assert.deepEqual(gx.devices, ['mobile-320', 'mobile-390']);
  assert.deepEqual(gx.scenarios, ['Orders', 'session']);
  assert.deepEqual(gx.findings, [a.id, b.id]);
  assert.equal(gx.title, 'Tap target too small or too close: button "Delete order"');
  assert.equal('ref' in gx.target, false);
  const gy = groups.find((g) => g.fingerprint === 'Y');
  assert.equal(gy.title, 'Dialog or drawer overflows the screen: /cart');
  assert.deepEqual(groups.map((g) => g.id), ['G1', 'G2']);
});

test('every finding kind has a title', () => {
  for (const k of ['tap-target', 'text-wrap-change', 'modal-overflow', 'content-under-fixed', 'fixed-collision', 'container-clipped', 'text-clipped', 'text-truncated', 'unreachable-content', 'outside-container', 'content-scroll-x', 'layout-shift', 'horizontal-overflow', 'control-clipped', 'horizontal-pan-required', 'control-obstructed']) {
    assert.ok(KIND_TITLES[k], k);
  }
});

test('group severity and confidence come from unsuppressed members', () => {
  const hi = finding({ fingerprint: 'X', severity: 'high', confidence: 'confirmed', suppressed: { rule: 0, reason: 'r' } });
  const lo = finding({ fingerprint: 'X', severity: 'low', confidence: 'heuristic' });
  const [g] = groupFindings([hi, lo]);
  assert.equal(g.severity, 'low');
  assert.equal(g.confidence, 'heuristic');
  assert.equal(g.suppressed, false);
  assert.equal(g.kind, 'tap-target');
});

test('a group with every member suppressed keeps the overall severity and sorts last', () => {
  const s1 = finding({ fingerprint: 'S', severity: 'high', suppressed: { rule: 1, reason: 'r' } });
  const s2 = finding({ fingerprint: 'S', severity: 'low', confidence: 'heuristic', suppressed: { rule: 1, reason: 'r' } });
  const live = finding({ fingerprint: 'L', severity: 'low', confidence: 'heuristic' });
  const groups = groupFindings([s1, s2, live]);
  assert.deepEqual(groups.map((g) => g.fingerprint), ['L', 'S']);
  assert.equal(groups[1].suppressed, true);
  assert.equal(groups[1].severity, 'high');
  assert.equal(groups[1].confidence, 'confirmed');
});

test('groups order by suppression, severity, confidence, then first finding id', () => {
  const f = (fp, severity, confidence, extra = {}) => finding({ fingerprint: fp, severity, confidence, ...extra });
  const items = [
    f('a', 'low', 'confirmed'), f('b', 'high', 'heuristic'), f('c', 'high', 'confirmed'), f('d', 'medium', 'confirmed'),
    f('e', 'high', 'confirmed'), f('f', 'high', 'confirmed', { suppressed: { rule: 0, reason: 'r' } }),
  ];
  const groups = groupFindings(items);
  assert.deepEqual(groups.map((g) => g.fingerprint), ['c', 'e', 'b', 'd', 'a', 'f']);
  // numeric id order: F9 before F10
  const nine = finding({ id: 'F10', fingerprint: 'n10' });
  const ten = finding({ id: 'F9', fingerprint: 'n9' });
  assert.deepEqual(groupFindings([nine, ten]).map((g) => g.fingerprint), ['n9', 'n10']);
});

const run = (over = {}) => ({ scenario: 'Filters drawer', device: 'mobile-320', width: 320, height: 640, status: 'ok', ms: 1, states: [], decisions: [], decisionsOmitted: 0, limits: [], findings: [], ...over });

test('default policy fails on confirmed high but not on heuristic high', () => {
  assert.deepEqual(DEFAULT_POLICY, { failOn: 'high', failOnErrors: false, failOnHeuristic: false });
  const conf = finding({ severity: 'high', confidence: 'confirmed' });
  const heur = finding({ severity: 'high', confidence: 'heuristic' });
  const fail = evaluatePolicy([conf, heur], [], DEFAULT_POLICY);
  assert.equal(fail.result, 'fail');
  assert.ok(fail.reasons[0].includes(`1 confirmed finding at or above high severity (${conf.id})`), fail.reasons[0]);
  assert.ok(!fail.reasons[0].includes(heur.id));
  const pass = evaluatePolicy([heur], [], DEFAULT_POLICY);
  assert.equal(pass.result, 'pass');
  assert.ok(pass.reasons.includes('1 heuristic warning is not counted (failOnHeuristic is off)'), pass.reasons.join('|'));
  // A confirmed finding under the threshold is named as confirmed, and as not failing the scan.
  const low = evaluatePolicy([finding({ severity: 'low', confidence: 'confirmed' })], [], DEFAULT_POLICY);
  assert.equal(low.result, 'pass');
  assert.ok(low.reasons.includes('1 confirmed finding below high severity does not fail the scan (failOn is high)'), low.reasons.join('|'));
});

test('failOn thresholds', () => {
  const med = finding({ severity: 'medium' });
  const low = finding({ severity: 'low' });
  const at = (failOn, fs) => evaluatePolicy(fs, [], { ...DEFAULT_POLICY, failOn }).result;
  assert.equal(at('high', [med, low]), 'pass');
  assert.equal(at('medium', [med, low]), 'fail');
  assert.equal(at('medium', [low]), 'pass');
  assert.equal(at('low', [low]), 'fail');
  assert.equal(at('none', [med, low, finding({ severity: 'high' })]), 'pass');
});

test('reasons list several ids', () => {
  const a = finding({ severity: 'high' });
  const b = finding({ severity: 'high' });
  const v = evaluatePolicy([a, b], [], DEFAULT_POLICY);
  assert.ok(v.reasons[0].startsWith(`2 confirmed findings at or above high severity (${a.id}, ${b.id})`));
});

test('failOnHeuristic counts heuristic findings', () => {
  const heur = finding({ severity: 'high', confidence: 'heuristic' });
  const v = evaluatePolicy([heur], [], { ...DEFAULT_POLICY, failOnHeuristic: true });
  assert.equal(v.result, 'fail');
  assert.ok(v.reasons[0].includes(heur.id));
});

test('suppressed findings never count', () => {
  const s = finding({ severity: 'high', suppressed: { rule: 0, reason: 'r' } });
  const s2 = finding({ severity: 'high', confidence: 'heuristic', suppressed: { rule: 0, reason: 'r' } });
  const v = evaluatePolicy([s, s2], [], { failOn: 'low', failOnErrors: true, failOnHeuristic: true });
  assert.equal(v.result, 'pass');
  assert.ok(v.reasons.includes('2 suppressed findings are not counted'), v.reasons.join('|'));
});

test('failOnErrors fails on failed runs and names them', () => {
  const failed = run({ status: 'failed', failedAt: 'setup' });
  const off = evaluatePolicy([], [failed], DEFAULT_POLICY);
  assert.equal(off.result, 'pass');
  assert.ok(off.reasons.some((r) => r.startsWith('1 scenario run failed but failOnErrors is off')), off.reasons.join('|'));
  const on = evaluatePolicy([], [failed, run()], { ...DEFAULT_POLICY, failOnErrors: true });
  assert.equal(on.result, 'fail');
  assert.ok(on.reasons.includes('1 scenario run failed: "Filters drawer" on mobile-320 (setup)'), on.reasons.join('|'));
  assert.deepEqual(on.policy, { ...DEFAULT_POLICY, failOnErrors: true });
});

test('a clean scan passes with a reason', () => {
  const v = evaluatePolicy([], [run()], DEFAULT_POLICY);
  assert.equal(v.result, 'pass');
  assert.equal(v.reasons.length, 1);
});
