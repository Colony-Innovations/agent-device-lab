// Web V1 actions through the Lab API against the interaction fixture (fixtures/interaction-app, its
// README is the oracle): select, check, press, scroll, swipe, back/forward, hover, drag, upload, tabs.
// One headless session on port 5351; the tests run in order and share it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Lab } from '../dist/core/lab.js';

const state = mkdtempSync(join(tmpdir(), 'agentlab-actions-'));
const project = resolve('fixtures/interaction-app');
const lab = new Lab({ stateDir: state });
let start;

before(async () => {
  start = await lab.start({ project, headed: false });
});
after(async () => {
  await lab.close();
  rmSync(state, { recursive: true, force: true });
});

const ref = (name, role) => lab.findRef({ role, name });
const act = (request) => lab.act(request);
const statusOf = (obs) => obs.messages.find((m) => m.role === 'status')?.text;

/** A successful result always carries how it settled, what changed and the new observation. */
function ok(r) {
  assert.equal(r.outcome, 'success', `${r.action}: ${r.error?.code} ${r.error?.message}`);
  assert.ok(['quiet', 'timeout'].includes(r.settle?.reason), `settle ${JSON.stringify(r.settle)}`);
  assert.ok(r.changes, 'changes');
  assert.ok(r.observation, 'observation');
  return r;
}
/** An error result names its code and is recoverable within the session. */
function fails(r, code) {
  assert.equal(r.outcome, 'error', `${r.action} should fail with ${code}`);
  assert.equal(r.error.code, code, r.error.message);
  assert.equal(r.error.recoverable, true);
  return r;
}
function hasStatus(r, text) {
  assert.equal(statusOf(r.observation), text, `status in ${JSON.stringify(r.observation.messages)}`);
}
const goHome = async () => ok(await act({ action: 'click', ref: ref('Home', 'link') }));
const goTo = async (link) => {
  await goHome();
  const r = ok(await act({ action: 'click', ref: ref(link, 'link') }));
  assert.equal(r.navigated, true);
  return r;
};

test('back on the start page has no history to go to', async () => {
  assert.equal(start.observation.route, '/');
  const r = await act({ action: 'back' });
  if (r.outcome === 'success') await act({ action: 'forward' }); // keep the later tests on the app if this fails
  fails(r, 'no_history');
});

test('back and forward move between documents, and between pushState entries in one document', async () => {
  ok(await act({ action: 'click', ref: ref('Form controls', 'link') }));
  let r = ok(await act({ action: 'back' }));
  assert.equal(r.method, 'history');
  assert.equal(r.observation.route, '/');
  assert.equal(r.changes.reset?.reason, 'navigation');
  r = ok(await act({ action: 'forward' }));
  assert.equal(r.observation.route, '/form');

  r = ok(await act({ action: 'click', ref: ref('Next step', 'button') }));
  hasStatus(r, 'Step 2');
  r = ok(await act({ action: 'back' }));
  assert.equal(r.changes.reset, undefined, 'popstate within the document keeps the baseline');
  assert.equal(r.navigated, false);
  hasStatus(r, 'Step 1');
});

test('select chooses an option by label or value and reports unknown options', async () => {
  let r = ok(await act({ action: 'select', ref: ref('Plan', 'combobox'), values: ['Pro'] }));
  assert.equal(r.method, 'select');
  hasStatus(r, 'Plan: Pro');
  r = ok(await act({ action: 'select', ref: ref('Plan', 'combobox'), values: ['team'] }));
  hasStatus(r, 'Plan: Team');

  r = fails(await act({ action: 'select', ref: ref('Plan', 'combobox'), values: ['Enterprise'] }), 'not_found');
  assert.deepEqual(r.error.details.options, ['Free', 'Pro', 'Team']);
  fails(await act({ action: 'select', ref: ref('Next step', 'button'), values: ['Pro'] }), 'not_selectable');
});

test('check and uncheck toggle checkboxes, radios and switches, and never uncheck a radio', async () => {
  let r = ok(await act({ action: 'check', ref: ref('Email me updates', 'checkbox') }));
  assert.equal(r.method, 'tap');
  hasStatus(r, 'Email updates on');
  r = ok(await act({ action: 'check', ref: ref('Email me updates', 'checkbox') }));
  assert.equal(r.method, 'none');
  assert.ok(r.notes.some((n) => n.includes('already checked')), r.notes.join('; '));
  r = ok(await act({ action: 'uncheck', ref: ref('Email me updates', 'checkbox') }));
  hasStatus(r, 'Email updates off');

  r = ok(await act({ action: 'check', ref: ref('Large', 'radio') }));
  hasStatus(r, 'Size: Large');
  fails(await act({ action: 'uncheck', ref: ref('Large', 'radio') }), 'invalid_request');

  r = ok(await act({ action: 'check', ref: ref('Dark mode', 'switch') }));
  hasStatus(r, 'Dark mode on');
  assert.equal(r.observation.controls.find((c) => c.role === 'switch' && c.name === 'Dark mode').checked, true);

  fails(await act({ action: 'check', ref: ref('Locked option', 'checkbox') }), 'disabled');
});

test('press sends keys to a control or to the page, and keys typed into a PIN are masked', async () => {
  await goTo('Keyboard');
  let r = ok(await act({ action: 'press', key: '?' }));
  assert.equal(r.method, 'keyboard');
  assert.equal(r.changes.dialog?.to, 'Shortcuts');
  assert.equal(r.observation.dialog, 'Shortcuts');
  r = ok(await act({ action: 'press', key: 'Escape' }));
  assert.equal(r.observation.dialog, undefined);
  hasStatus(r, 'Shortcuts closed');

  ok(await act({ action: 'fill', ref: ref('Search', 'searchbox'), value: 'lamps' }));
  r = ok(await act({ action: 'press', ref: ref('Search', 'searchbox'), key: 'Enter' }));
  hasStatus(r, 'Searched for: lamps');

  fails(await act({ action: 'press', key: 'NotAKey' }), 'invalid_request');

  ok(await act({ action: 'fill', ref: ref('PIN'), value: '1234' }));
  ok(await act({ action: 'press', ref: ref('PIN'), key: '5' }));
  r = ok(await act({ action: 'press', ref: ref('PIN'), key: 'Enter' }));
  hasStatus(r, 'PIN entered (5 digits)');

  const log = readFileSync(join(start.session.runDir, 'actions.jsonl'), 'utf8');
  assert.ok(!log.includes('1234'), 'the filled PIN is not logged');
  assert.ok(!log.includes('"key":"5"'), 'a digit typed into the PIN is not logged');
  assert.ok(log.includes('‹secret›'), 'the secret is masked, not dropped');
  const reproduction = JSON.stringify(lab.inspect()) + JSON.stringify(lab.history);
  assert.ok(!reproduction.includes('1234'), 'no PIN in findings or reproduction history');
  assert.ok(!/press 5\b/.test(reproduction), 'no PIN digit in reproduction history');
});

test('scroll moves the page or a region, brings controls into view, and says when nothing moved', async () => {
  await goTo('Scroll and swipe');
  let r = ok(await act({ action: 'scroll', direction: 'up' }));
  assert.ok(r.notes.some((n) => n.includes('did not move')), r.notes.join('; '));

  r = ok(await act({ action: 'scroll', ref: ref('Photo 1', 'button'), direction: 'right' }));
  assert.equal(r.method, 'scroll');
  assert.ok(r.notes.some((n) => n.includes('region "Photos"')), r.notes.join('; '));
  hasStatus(r, 'Showing photo 2');

  for (let i = 0; i < 6 && statusOf(r.observation) !== 'Loaded 20 items'; i++) {
    r = ok(await act({ action: 'scroll', direction: 'down' }));
    assert.ok(r.notes.some((n) => n.includes('page scrolled down')), r.notes.join('; '));
  }
  hasStatus(r, 'Loaded 20 items');

  await goTo('Scroll and swipe');
  r = ok(await act({ action: 'scroll', ref: ref('Back to top', 'button') }));
  assert.ok(r.notes.some((n) => n.includes('into view')), r.notes.join('; '));
  const top = r.observation.controls.find((c) => c.name === 'Back to top');
  assert.equal(top?.offscreen, undefined, 'Back to top is on screen');
});

test('swipe is real touch input on a control', async () => {
  let r = ok(await act({ action: 'swipe', ref: ref('Card', 'button'), direction: 'left' }));
  assert.equal(r.method, 'touch');
  hasStatus(r, 'Swiped left');
  r = ok(await act({ action: 'swipe', ref: ref('Card', 'button'), direction: 'up' }));
  assert.equal(r.method, 'touch');
  hasStatus(r, 'Swiped up');
});

test('a tap right after a swipe still clicks', async () => {
  const r = ok(await act({ action: 'click', ref: ref('Home', 'link') }));
  assert.equal(r.navigated, true, `the tap after the swipe went nowhere: ${r.notes.join('; ')}`);
});

test('hover shows a tooltip and notes that touch cannot; drag reorders and moves a slider', async () => {
  await goTo('Pointer');
  let r = ok(await act({ action: 'hover', ref: ref('Info', 'button') }));
  hasStatus(r, 'Tooltip shown');
  assert.ok(r.notes.some((n) => /touch/.test(n)), r.notes.join('; '));

  r = ok(await act({ action: 'drag', ref: ref('Task B', 'button'), toRef: ref('Task A', 'button') }));
  hasStatus(r, 'Order: B, A, C');

  r = ok(await act({ action: 'drag', ref: ref('Volume', 'slider'), dx: 75 }));
  const volume = /^Volume (\d+)$/.exec(statusOf(r.observation) ?? '');
  assert.ok(volume, `status ${statusOf(r.observation)}`);
  assert.ok(Number(volume[1]) > 50, `volume ${volume[1]}`);
});

test('upload gives files to an input or a file chooser, only from uploads.allow', async () => {
  await goTo('Upload');
  let r = ok(await act({ action: 'upload', ref: ref('Attachments'), files: ['uploads/notes.txt'] }));
  assert.equal(r.method, 'set-files');
  hasStatus(r, 'Attached: notes.txt (79 bytes)');
  r = ok(await act({ action: 'upload', ref: ref('Attachments'), files: ['uploads/photo.png', 'uploads/notes.txt'] }));
  hasStatus(r, 'Attached: photo.png (70 bytes), notes.txt (79 bytes)');

  r = ok(await act({ action: 'upload', ref: ref('Choose photo', 'button'), files: ['uploads/photo.png'] }));
  hasStatus(r, 'Photo: photo.png (70 bytes)');
  assert.ok(r.notes.some((n) => n.includes('file chooser')), r.notes.join('; '));

  fails(await act({ action: 'upload', ref: ref('Attachments'), files: ['package.json'] }), 'upload_not_allowed');
  fails(await act({ action: 'upload', ref: ref('Attachments'), files: ['../../package.json'] }), 'upload_not_allowed');
});

test('tabs: new tabs and pop-ups become active, refs stay with their tab, closing returns to the opener', async () => {
  await goTo('Tabs');
  const popupRef = ref('Open popup', 'button');
  let r = ok(await act({ action: 'click', ref: ref('Open help', 'link') }));
  assert.deepEqual(r.changes.tabs.opened, ['t2']);
  assert.deepEqual(r.changes.tabs.active, { from: 't1', to: 't2' });
  assert.equal(r.observation.tab, 't2');
  assert.ok(r.observation.headings.includes('h1 Help'), r.observation.headings.join(', '));
  assert.deepEqual((await lab.tabList()).map((t) => [t.id, t.active]), [['t1', false], ['t2', true]]);

  r = fails(await act({ action: 'click', ref: popupRef }), 'stale_ref');
  assert.match(r.error.message, /tab t1/);

  r = ok(await act({ action: 'switch_tab', tab: 't1' }));
  assert.ok(r.observation.headings.includes('h1 Tabs'), r.observation.headings.join(', '));

  r = ok(await act({ action: 'click', ref: ref('Open popup', 'button') }));
  assert.deepEqual(r.changes.tabs.opened, ['t3']);
  assert.deepEqual(r.changes.tabs.active, { from: 't1', to: 't3' });
  assert.ok(r.observation.headings.includes('h1 Popup'), r.observation.headings.join(', '));
  r = ok(await act({ action: 'click', ref: ref('Send hello', 'button') }));
  hasStatus(r, 'Sent');
  r = ok(await act({ action: 'click', ref: ref('Close window', 'button') }));
  assert.ok(r.changes.tabs.closed.includes('t3'), JSON.stringify(r.changes.tabs));
  assert.deepEqual(r.changes.tabs.active, { from: 't3', to: 't1' });
  assert.equal(statusOf(await lab.observe()), 'Popup said hello');

  ok(await act({ action: 'close_tab', tab: 't2' }));
  fails(await act({ action: 'close_tab', tab: 't1' }), 'invalid_request');

  r = ok(await act({ action: 'open_tab', path: '/keys' }));
  assert.equal(r.changes.tabs.opened.length, 1);
  assert.equal(r.observation.tab, r.changes.tabs.opened[0]);
  assert.ok(r.observation.headings.includes('h1 Keyboard'), r.observation.headings.join(', '));
  fails(await act({ action: 'switch_tab', tab: 't99' }), 'unknown_tab');
});
