// The text rendering of a result must retain the facts a reader needs without the JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAction, formatControl, formatError, formatObservation } from '../dist/core/format.js';
import { diffObservations } from '../dist/core/observation.js';

const control = (ref, name, extra = {}) => ({ ref, role: 'tab', name, rect: { x: 0, y: 0, w: 100, h: 44 }, ...extra });
const observation = (extra = {}) => ({
  schemaVersion: 1, sessionId: 's', gen: 1, docId: 'd', url: 'http://127.0.0.1/a', route: '/a', title: 'A',
  viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 }, documentWidth: 390, layoutViewportWidth: 390,
  headings: [], controls: [], omitted: 0, inert: [], messages: [], layout: [], findings: 0,
  console: { errors: 0 }, network: { failed: 0 }, ...extra,
});
const action = (before, after) => ({
  schemaVersion: 1, action: 'press', outcome: 'success', method: 'keyboard', elapsedMs: 100,
  settle: { ms: 100, reason: 'quiet', ignored: 0 }, navigated: false, notes: [],
  changes: diffObservations(before, after), newConsoleErrors: [], newFailedRequests: [], newFindings: [], observation: after,
});

test('text observations retain selected tab state and password masks', () => {
  assert.match(formatControl(control('e1', 'Overview', { selected: true })), / selected$/);
  assert.match(formatControl(control('e2', 'Details', { selected: false })), / not-selected$/);
  const text = formatObservation(observation({ controls: [control('e3', 'Password', { role: 'textbox', value: '••••' })], omitted: 4 }));
  assert.match(text, /value="••••"/);
  assert.match(text, /controls \(1, 4 omitted by budget\)/);
});

test('a title-only action reports the title change', () => {
  assert.match(formatAction(action(observation(), observation({ title: 'Updated' }))), /changed: title "A" → "Updated"/);
});

test('clearing a value and selecting a tab remain explicit changes in text', () => {
  const before = observation({ controls: [control('e1', 'Details', { selected: false }), control('e2', 'Name', { role: 'textbox', value: 'Acme' })] });
  const after = observation({ controls: [control('e1', 'Details', { selected: true }), control('e2', 'Name', { role: 'textbox', value: '' })] });
  const text = formatAction(action(before, after));
  assert.match(text, /~ tab e1 selected/);
  assert.match(text, /~ textbox e2 value "Acme"→""/);
});

test('action changes are bounded, count omissions, and tell MCP clients how to recover current state', () => {
  const controls = Array.from({ length: 20 }, (_, i) => control(`e${i + 1}`, `Tab ${i + 1}`));
  const text = formatAction(action(observation(), observation({ controls, omitted: 3 })));
  assert.match(text, /8 more changes \(observe for current state; CLI --json for all changes\)/);
  assert.match(text, /3 omitted by budget \(observe with a larger limit for current controls\)/);
  assert.doesNotMatch(text, /\+ tab "Tab 20"/);
  const result = action(observation(), observation({ controls }));
  result.newFindings = [{ id: 'F1', severity: 'high', confidence: 'confirmed', kind: 'control-clipped', device: 'mobile-390', message: 'Save is clipped' }];
  assert.match(formatAction(result), /finding: F1 \[high, confirmed\] control-clipped/);
});

test('a baseline reset includes the complete budgeted observation and fresh refs', () => {
  const text = formatAction(action(observation(), observation({ docId: 'new', route: '/next', controls: [control('e9', 'Next')], omitted: 2 })));
  assert.match(text, /refs from the previous page are stale/);
  assert.match(text, /route \/next/);
  assert.match(text, /controls \(1, 2 omitted by budget\):\n  e9 tab "Next"/);
});

test('text errors retain recovery hints and supervision state without dumping arbitrary details', () => {
  const text = formatError({
    code: 'observation_required', message: 'Observe after hand-back', recoverable: true, hint: 'Run observe first.',
    details: { control: { mode: 'agent', by: 'dashboard', since: '2026-10-10T00:00:00Z', observeRequired: true, interrupt: false, humanInteractions: 1, extra: 'hidden-detail' }, extra: 'hidden-detail' },
  });
  assert.match(text, /recoverable: true/);
  assert.match(text, /hint: Run observe first\./);
  assert.match(text, /control: agent by="dashboard" since="2026-10-10T00:00:00Z" observeRequired=true interrupt=false humanInteractions=1/);
  assert.doesNotMatch(text, /hidden-detail/);
  assert.match(formatError({ code: 'session_stopped', message: 'Stopped', recoverable: false }), /recoverable: false/);
  const pending = formatError({ code: 'session_paused', message: 'Pausing', recoverable: true,
    details: { control: { mode: 'pausing', pending: 'human', interrupt: true, busy: { command: 'scan', since: '2026-10-10T00:00:00Z' } } } });
  assert.match(pending, /control: pausing pending=human interrupt=true busy="scan" busySince="2026-10-10T00:00:00Z"/);
});

test('failed action text retains new console errors and failed requests', () => {
  const r = { ...action(observation(), observation()), outcome: 'error', error: { code: 'stale_ref', message: 'Old ref', recoverable: true },
    newConsoleErrors: [{ type: 'error', text: 'Render failed', at: 1 }], newFailedRequests: [{ method: 'GET', url: '/a', status: 500, at: 1 }] };
  const text = formatAction(r);
  assert.match(text, /ERROR stale_ref/);
  assert.match(text, /recoverable: true/);
  assert.match(text, /console: 1 new errors \("Render failed"\)  network: 1 new failures \(GET \/a 500\)/);
});
