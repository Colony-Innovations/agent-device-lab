// Pure tests for the diff engine and layout flags: no browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffObservations, layoutFlags } from '../dist/core/observation.js';

const control = (ref, role, name, extra = {}) => ({ ref, role, name, rect: { x: 16, y: 16, w: 100, h: 44 }, ...extra });
const obs = (over = {}) => ({
  schemaVersion: 1, sessionId: 's', gen: 1, docId: 'd1', url: 'http://127.0.0.1/a', route: '/a', title: 'A',
  viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 }, documentWidth: 390, layoutViewportWidth: 390,
  headings: ['h1 A'], controls: [], omitted: 0, inert: [], messages: [], layout: [], console: { errors: 0 }, network: { failed: 0 },
  ...over,
});

test('no baseline yields a reset marker', () => {
  assert.deepEqual(diffObservations(undefined, obs()).reset, { reason: 'no-baseline' });
});

test('new document resets the baseline instead of diffing controls', () => {
  const c = diffObservations(obs({ controls: [control('e1', 'link', 'A')] }), obs({ docId: 'd2', route: '/b', controls: [control('e2', 'link', 'B')] }));
  assert.deepEqual(c.reset, { reason: 'navigation' });
  assert.deepEqual(c.route, { from: '/a', to: '/b' });
  assert.equal(c.added.length, 0);
});

test('modal open reports dialog and covered background, not removals', () => {
  const before = obs({ controls: [control('e1', 'button', 'New'), control('e2', 'link', 'Home')] });
  const after = obs({
    dialog: 'Create', controls: [control('e3', 'textbox', 'Customer', { focused: true })],
    inert: [{ ref: 'e1', role: 'button', name: 'New' }, { ref: 'e2', role: 'link', name: 'Home' }], focused: 'e3',
  });
  const c = diffObservations(before, after);
  assert.deepEqual(c.dialog, { from: undefined, to: 'Create' });
  assert.equal(c.covered, 2);
  assert.deepEqual(c.removed, []);
  assert.deepEqual(c.added.map((a) => a.ref), ['e3']);
  assert.deepEqual(c.focus, { from: undefined, to: 'e3' });
});

test('property changes: disabled, invalid, value', () => {
  const c = diffObservations(
    obs({ controls: [control('e1', 'button', 'Save'), control('e2', 'textbox', 'Customer', { value: '' })] }),
    obs({ controls: [control('e1', 'button', 'Save', { disabled: true }), control('e2', 'textbox', 'Customer', { value: 'Acme', invalid: true })] }),
  );
  const byRef = Object.fromEntries(c.changed.map((x) => [x.ref, x.fields.map((f) => f.field).sort()]));
  assert.deepEqual(byRef, { e1: ['disabled'], e2: ['invalid', 'value'] });
});

test('validation message and toast are reported as message changes', () => {
  const c = diffObservations(obs(), obs({ messages: [{ role: 'alert', text: 'Customer is required' }] }));
  assert.deepEqual(c.messagesAdded, [{ role: 'alert', text: 'Customer is required' }]);
  assert.equal(c.none, false);
});

test('re-rendered controls pair by role+name, not position', () => {
  const before = obs({ controls: [control('e1', 'link', 'INV-001'), control('e2', 'link', 'INV-002')] });
  const after = obs({ controls: [control('e5', 'link', 'INV-002'), control('e6', 'link', 'INV-001'), control('e7', 'link', 'INV-003')] });
  const c = diffObservations(before, after);
  assert.deepEqual(c.rerendered.map((r) => `${r.from}->${r.to}`).sort(), ['e1->e6', 'e2->e5']);
  assert.deepEqual(c.added.map((a) => a.name), ['INV-003']);
  assert.deepEqual(c.removed, []);
});

test('controls that vanish while covered by a dialog are removed once it closes', () => {
  const during = obs({ dialog: 'X', controls: [control('e9', 'button', 'Close')], inert: [{ ref: 'e1', role: 'link', name: 'Gone' }] });
  const c = diffObservations(during, obs({ controls: [] }));
  assert.deepEqual(c.removed.map((r) => r.ref), ['e9', 'e1']);
});

test('identical observations report none', () => {
  const o = obs({ controls: [control('e1', 'button', 'A')] });
  assert.equal(diffObservations(o, structuredClone(o)).none, true);
});

test('layout flags: overflow plus clipped control severity', () => {
  const flags = layoutFlags({
    viewport: { width: 390, height: 844 }, documentWidth: 598, layoutViewportWidth: 598,
    controls: [
      control('e9', 'textbox', 'To', { rect: { x: 290, y: 0, w: 180, h: 44 }, clip: { side: 'right', px: 80 } }),
      control('e10', 'button', 'Export CSV', { rect: { x: 482, y: 0, w: 116, h: 44 }, clip: { side: 'right', px: 208 } }),
    ],
  });
  assert.deepEqual(flags.map((f) => [f.kind, f.severity, f.ref]), [
    ['horizontal-overflow', 'medium', undefined], ['control-clipped', 'medium', 'e9'], ['control-clipped', 'high', 'e10'],
  ]);
  assert.match(flags[0].message, /widened the layout viewport to 598px/);
});

test('clean layout has no flags', () => {
  assert.deepEqual(layoutFlags({ viewport: { width: 390, height: 844 }, documentWidth: 390, controls: [control('e1', 'button', 'A')] }), []);
});
