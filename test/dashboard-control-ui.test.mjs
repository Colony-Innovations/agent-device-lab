// The dashboard's supervision controls (rendered in Chromium): the mode badge and buttons, the view-only
// link, pause / take over / return / stop requests, an interactive viewport while a person has control,
// typed text that is never echoed, and the timeline's control, human and refused entries. Driven by a
// real Supervisor feeding the real SessionFeed and server; the session itself is faked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { SessionFeed } from '../dist/core/feed.js';
import { Supervisor } from '../dist/core/control.js';
import { Dashboard } from '../dist/dashboard/server.js';
import { LabError } from '../dist/core/schema.js';

let browser, page, dash, feed, sup, jpeg;
let controlCalls = [];
let inputCalls = [];
let failNext;

const d390 = { id: 'mobile-390', label: 'm', viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
const tokenOf = (url) => new URLSearchParams(new URL(url).hash.slice(1)).get('token');
const SECRET = 'hunter2-not-for-display';

const until = async (fn, what) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const badge = (text) => page.waitForFunction((t) => document.getElementById('ctl-badge').textContent === t, text, { timeout: 5000 });
const disabled = (op) => page.locator(`#ctl-${op}`).getAttribute('aria-disabled').then((v) => v === 'true');

before(async () => {
  browser = await chromium.launch();
  const shot = await (await browser.newPage({ viewport: { width: 40, height: 80 } })).screenshot({ type: 'jpeg' });
  jpeg = shot;

  feed = new SessionFeed();
  sup = new Supervisor();
  sup.onChange((change) => feed.apply({ kind: 'control', change }));
  const source = {
    active: true,
    screencast: async (onFrame) => { onFrame(jpeg); return async () => {}; },
  };
  dash = await Dashboard.listen({
    feed,
    source: () => source,
    control: (op, by) => {
      controlCalls.push({ op, by });
      if (failNext) { const e = failNext; failNext = undefined; throw e; }
      return sup.request(op, by);
    },
    input: async (input) => { inputCalls.push(input); },
  });
  feed.apply({ kind: 'starting', project: 'p', url: 'http://127.0.0.1:1/', device: d390, headed: true });
  feed.apply({ kind: 'start', result: {
    session: { id: 's-1', device: d390, browser: { engine: 'chromium', version: '153', headed: true }, environment: 'e' },
    server: { url: 'http://127.0.0.1:1', owned: false, reused: true, readyMs: 1 },
    observation: { gen: 1, url: 'http://127.0.0.1:1/', route: '/', title: 't', controls: [], layout: [], omitted: 0, console: { errors: 0 }, network: { failed: 0 } },
  } });

  page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  page.setDefaultTimeout(5000);
  await page.goto(dash.url);
  await page.locator('#supervision').waitFor({ state: 'visible' });
});

after(async () => {
  await browser?.close();
  await dash?.close();
});

test('the control link shows the supervision bar with the agent in control', async () => {
  assert.equal(await page.locator('#ctl-badge').textContent(), 'Agent in control');
  assert.equal(await page.locator('#ctl-badge').getAttribute('role'), 'status');
  assert.equal(await page.locator('#ctl-viewonly').isVisible(), false);
  assert.equal(await page.locator('#human-panel').isVisible(), false);
  assert.equal(await disabled('pause'), false);
  assert.equal(await disabled('pause-next'), false);
  assert.equal(await disabled('takeover'), false);
  assert.equal(await disabled('stop'), false);
  assert.equal(await disabled('emergency-stop'), false);
  assert.equal(await disabled('resume'), true);
  assert.equal(await disabled('return'), true);
  assert.equal(await page.locator('#ctl-buttons button').count(), 7);
});

test('the view-only link shows a note, no buttons, and its token cannot control', async () => {
  const p = await browser.newPage();
  await p.goto(dash.viewUrl);
  await p.locator('#ctl-viewonly').waitFor({ state: 'visible' });
  assert.match(await p.locator('#ctl-viewonly').innerText(), /view-only link: controls need the URL from `agentlab ui`/);
  assert.equal(await p.locator('#supervision').isVisible(), false);
  assert.equal(await p.locator('#ctl-buttons button:visible').count(), 0);
  assert.equal(await p.locator('#state').textContent(), 'active', 'monitoring still works');
  const status = await p.evaluate(async (t) => {
    const r = await fetch('/api/control', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: '{"op":"pause"}' });
    const i = await fetch('/api/input', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: '{"type":"key","key":"Enter"}' });
    return [r.status, i.status];
  }, tokenOf(dash.viewUrl));
  assert.deepEqual(status, [401, 401]);
  assert.deepEqual(controlCalls, []);
  assert.deepEqual(inputCalls, []);
  await p.close();
});

test('Pause posts the op as JSON with the token in a Bearer header, never in the URL', async () => {
  const req = page.waitForRequest((r) => r.url().endsWith('/api/control') && r.method() === 'POST');
  await page.locator('#ctl-pause').click();
  const r = await req;
  assert.equal(r.headers().authorization, `Bearer ${tokenOf(dash.url)}`);
  assert.match(r.headers()['content-type'], /^application\/json/);
  assert.deepEqual(r.postDataJSON(), { op: 'pause' });
  assert.equal(r.url().includes('token'), false);
  await badge('Paused');
  assert.deepEqual(controlCalls.map((c) => c.op), ['pause']);
  assert.equal(await page.locator('#ctl-pause').getAttribute('aria-pressed'), 'true');
  assert.equal(await disabled('resume'), false);
  assert.equal(await disabled('pause'), true);
});

test('the badge follows the feed, not only clicks', async () => {
  sup.request('resume', 'elsewhere');
  await badge('Agent in control');
  sup.begin('scan');
  sup.request('pause-next', 'elsewhere');
  await badge('Pausing after scan…');
  sup.end();
  await badge('Paused');
  sup.request('resume', 'elsewhere');
  await badge('Agent in control');
  assert.equal(await page.locator('#ctl-detail').textContent(), '', 'nothing happened in the page, so no observe is required');
});

test('a server refusal is shown inline as text', async () => {
  failNext = new LabError('invalid_control', 'Cannot pause: the session is <b>already</b> pausing');
  await page.locator('#ctl-pause').click();
  await page.locator('#ctl-error').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#ctl-error').textContent(), 'Cannot pause: the session is <b>already</b> pausing');
  assert.equal(await page.locator('#ctl-error b').count(), 0, 'rendered as text, not HTML');
  assert.equal(await page.locator('#ctl-badge').textContent(), 'Agent in control', 'the state did not change');
  // The next successful request clears it.
  await page.locator('#ctl-pause-next').click();
  await badge('Paused');
  assert.equal(await page.locator('#ctl-error').isVisible(), false);
  await page.locator('#ctl-resume').click();
  await badge('Agent in control');
});

test('while a person has control the viewport takes taps and scrolls, text and keys', async () => {
  await page.waitForFunction(() => document.getElementById('viewport').naturalWidth > 0);
  inputCalls = [];
  // Not interactive yet: a click sends nothing.
  await page.locator('#viewport').click({ position: { x: 20, y: 20 } });
  assert.deepEqual(inputCalls, []);

  await page.locator('#ctl-takeover').click();
  await badge('You have control');
  await page.locator('#human-panel').waitFor({ state: 'visible' });
  assert.match(await page.locator('#human-panel .human-banner').innerText(), /You have control of the browser\. The agent is waiting\. Your actions are recorded as descriptions only \(no typed text\)\. You can also use the browser window directly\./);
  assert.equal(await page.locator('#ctl-takeover').getAttribute('aria-pressed'), 'true');
  assert.equal(await disabled('return'), false);
  assert.equal(await disabled('takeover'), true);

  // Tap
  await page.locator('#vp-expand').click();
  assert.equal(await page.locator('#vp-dialog #supervision').isVisible(), true, 'supervision stays available in the expanded view');
  const box = await page.locator('#viewport').boundingBox();
  await page.locator('#viewport').click({ position: { x: box.width / 4, y: box.height / 2 } });
  await until(() => inputCalls.some((i) => i.type === 'tap'), 'a tap');
  const tap = inputCalls.find((i) => i.type === 'tap');
  assert.ok(tap.x >= 0 && tap.x <= 1 && tap.y >= 0 && tap.y <= 1, `x,y are fractions: ${tap.x}, ${tap.y}`);
  assert.ok(Math.abs(tap.x - 0.25) < 0.02 && Math.abs(tap.y - 0.5) < 0.02, `about a quarter across, half down: ${tap.x}, ${tap.y}`);

  // Scroll
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 300);
  await until(() => inputCalls.some((i) => i.type === 'scroll'), 'a scroll');
  const scroll = inputCalls.find((i) => i.type === 'scroll');
  assert.ok(scroll.dy > 0 && scroll.dy <= 5000, `dy ${scroll.dy}`);

  // Keys
  await page.locator('#human-panel [data-key="Shift+Tab"]').click();
  await page.locator('#human-panel [data-key="ArrowDown"]').click();
  await until(() => inputCalls.filter((i) => i.type === 'key').length === 2, 'two keys');
  assert.deepEqual(inputCalls.filter((i) => i.type === 'key').map((i) => i.key), ['Shift+Tab', 'ArrowDown']);
  for (const size of [{ width: 640, height: 320 }, { width: 320, height: 480 }]) {
    await page.setViewportSize(size);
    await page.waitForFunction(() => {
      const frame = document.getElementById('viewport').getBoundingClientRect();
      const dialog = document.getElementById('vp-dialog').getBoundingClientRect();
      return frame.width > 0 && frame.height > 0 && frame.bottom <= dialog.bottom && frame.right <= dialog.right;
    });
    const frame = await page.locator('#viewport').boundingBox();
    assert.ok(Math.abs(frame.width / frame.height - 390 / 844) < 0.01, `mobile device ratio preserved at ${size.width}×${size.height}`);
  }
  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.locator('#vp-close').click();
  await page.locator('#vp-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#supervision').isVisible(), true);
});

test('typed text is sent once and appears nowhere on the page afterwards', async () => {
  inputCalls = [];
  await page.locator('#human-text').fill(SECRET);
  await page.locator('#human-type').click();
  await until(() => inputCalls.some((i) => i.type === 'text'), 'the text');
  assert.deepEqual(inputCalls.find((i) => i.type === 'text'), { type: 'text', text: SECRET });
  await until(async () => (await page.locator('#human-text').inputValue()) === '', 'the box to clear');

  // The server describes what the person did without the text; the page shows that, never the text.
  feed.apply({ kind: 'human', action: { type: 'type', target: { role: 'textbox', name: 'Password' }, secret: true } });
  await page.locator('#timeline li[data-kind="human"]', { hasText: 'typed into textbox "Password" (hidden)' }).waitFor();

  const seen = await page.evaluate((s) => ({
    text: document.body.innerText.includes(s),
    html: document.documentElement.outerHTML.includes(s),
    values: [...document.querySelectorAll('input, textarea')].some((el) => el.value.includes(s)),
    title: document.title.includes(s),
  }), SECRET);
  assert.deepEqual(seen, { text: false, html: false, values: false, title: false });

  // The hide option masks the box.
  await page.locator('#human-hide').check();
  assert.equal(await page.locator('#human-text').getAttribute('type'), 'password');
  await page.locator('#human-hide').uncheck();
});

test('the timeline shows control, human and refused entries distinctly, as text', async () => {
  feed.apply({ kind: 'human', action: { type: 'tap', target: { role: 'button', name: '<img src=x onerror=alert(1)>Save' } } });
  feed.apply({ kind: 'refused', command: 'click', error: { code: 'human_control', message: 'click refused: a person has taken control of the browser', recoverable: true, hint: 'Wait for the person to hand control back, then observe.' } });
  await page.locator('#timeline li[data-kind="refused"]').waitFor();

  const kinds = await page.locator('#timeline li[data-kind]').evaluateAll((els) => els.map((e) => e.dataset.kind));
  assert.ok(kinds.includes('control') && kinds.includes('human') && kinds.includes('refused'), kinds.join());

  const control = page.locator('#timeline li[data-kind="control"]', { hasText: 'a person took control of the browser (dashboard)' });
  assert.equal(await control.count(), 1);
  assert.match(await control.getAttribute('class'), /\bmarker\b/);

  const human = page.locator('#timeline li[data-kind="human"]', { hasText: 'person tapped button' });
  assert.match(await human.getAttribute('class'), /\bhuman\b/);
  assert.equal(await page.locator('#timeline img').count(), 0, 'page-derived text is never parsed as HTML');
  assert.match(await human.innerText(), /<img src=x onerror=alert\(1\)>Save/);

  const refused = page.locator('#timeline li[data-kind="refused"]');
  assert.match(await refused.getAttribute('class'), /\brefused\b/);
  const text = await refused.innerText();
  assert.match(text, /not run/);
  assert.match(text, /agent's click refused \(human_control\); nothing ran/);
  assert.match(text, /hint: Wait for the person to hand control back/);

  // Distinct treatment: three different styles for the three kinds.
  const styles = await page.evaluate(() => ['control', 'human', 'refused'].map((k) => {
    const cs = getComputedStyle(document.querySelector(`#timeline li[data-kind="${k}"]`));
    return [cs.display, cs.borderLeftStyle, cs.backgroundColor, cs.color].join('|');
  }));
  assert.equal(new Set(styles).size, 3, styles.join(' // '));
});

test('returning control hands the agent a stale-refs warning', async () => {
  await page.locator('#ctl-return').click();
  await badge('Agent in control');
  assert.equal(await page.locator('#human-panel').isVisible(), false);
  assert.equal(await page.locator('#ctl-detail').textContent(), 'agent must observe before acting');
  inputCalls = [];
  await page.locator('#viewport').click({ position: { x: 10, y: 10 } });
  assert.deepEqual(inputCalls, [], 'the viewport is no longer interactive');
  assert.match(await page.locator('#timeline').innerText(), /control returned to the agent \(dashboard\)/);
});

test('Stop run and Emergency stop need a confirming second click', async () => {
  controlCalls = [];
  await page.locator('#ctl-emergency-stop').click();
  assert.equal(await page.locator('#ctl-emergency-stop').textContent(), 'Confirm emergency stop');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(controlCalls, [], 'the first click sends nothing');

  // Clicking something else cancels the question.
  await page.locator('#ctl-pause-next').click();
  await badge('Paused');
  assert.equal(await page.locator('#ctl-emergency-stop').textContent(), 'Emergency stop');
  await page.locator('#ctl-resume').click();
  await badge('Agent in control');

  controlCalls = [];
  await page.locator('#ctl-stop').click();
  assert.equal(await page.locator('#ctl-stop').textContent(), 'Confirm stop run');
  assert.equal(controlCalls.length, 0);
  await page.locator('#ctl-emergency-stop').click();       // switching to the other button re-asks
  assert.equal(await page.locator('#ctl-stop').textContent(), 'Stop run');
  assert.equal(await page.locator('#ctl-emergency-stop').textContent(), 'Confirm emergency stop');
  assert.ok(!controlCalls.some((c) => c.op === 'stop' || c.op === 'emergency-stop'));

  const req = page.waitForRequest((r) => r.url().endsWith('/api/control'));
  await page.locator('#ctl-emergency-stop').click();
  assert.deepEqual((await req).postDataJSON(), { op: 'emergency-stop' });
  await badge('Stopped');
  assert.deepEqual(controlCalls.map((c) => c.op).filter((o) => o.endsWith('stop')), ['emergency-stop']);
  for (const op of ['pause', 'pause-next', 'resume', 'takeover', 'return', 'stop', 'emergency-stop']) assert.equal(await disabled(op), true, op);
  assert.match(await page.locator('#timeline li[data-kind="control"]:last-child').innerText(), /EMERGENCY STOP/);
});
