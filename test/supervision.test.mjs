// Supervision against a real headless browser: a person pauses, takes over and stops the session while
// the agent is navigating, settling, scanning or failing. Pins what completes, what is refused, what a
// person's input records (never typed text), and how a scripted flow waits.
// The test app runs on 5362 (everything but the stop tests) and 5363 (stop and emergency stop); the Lab
// starts and stops it from a temp profile.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lab } from '../dist/core/lab.js';
import { SessionFeed } from '../dist/core/feed.js';
import { SessionHost, dispatch } from '../dist/core/commands.js';
import { runFlow } from '../dist/cli/flow.js';

const temps = [];
const labs = new Set();
const tmp = (prefix) => { const d = mkdtempSync(join(tmpdir(), `agentlab-sup-${prefix}-`)); temps.push(d); return d; };
after(async () => {
  for (const lab of labs) await lab.close().catch(() => undefined);
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const SERVER = `
import { createServer } from 'node:http';
const hits = {};
const head = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">' +
  '<style>body{margin:0;font:16px sans-serif;padding:12px}a,button,input{min-height:44px;min-width:88px;font-size:16px;margin:6px 0;display:inline-block}</style>';
const nav = '<nav><a href="/">Home</a> <a href="/timer">Timer</a> <a href="/form">Form</a> <a href="/blocked">Blocked</a> <a href="/slow">Slow page</a> <a href="/slow?ms=4000">Very slow page</a></nav>';
const pages = {
  '/': head + nav + '<h1>Home</h1>',
  '/a': head + '<h1>Page A</h1><button>Alpha</button>',
  '/b': head + '<h1>Page B</h1><button>Beta</button>',
  '/timer': head + nav + '<h1>Timer</h1><button id="go">Start timer</button><p id="out" role="status"></p><script>' +
    'go.onclick = () => { setTimeout(() => { out.textContent = "Done"; }, 700); };</script>',
  '/form': head + nav + '<h1>Form</h1><label for="email">Email</label><input id="email" type="email" name="contact">' +
    '<label for="pw">Password</label><input id="pw" type="password" name="pw"><button id="save" type="button">Save</button>' +
    '<p id="out" role="status"></p><script>save.onclick = () => { out.textContent = "Saved"; };</script>',
  '/blocked': head + '<h1>Blocked</h1><button id="c">Covered</button><div style="position:fixed;inset:0;z-index:10;background:rgba(0,0,0,.01)"></div>',
};
createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return res.end('ok');
  if (url.pathname === '/__hits') return res.end(JSON.stringify(hits));
  hits[url.pathname] = (hits[url.pathname] ?? 0) + 1;
  const html = (b) => res.writeHead(200, { 'content-type': 'text/html' }).end(b);
  if (url.pathname === '/slow') return setTimeout(() => html(head + nav + '<h1>Slow page done</h1>'), Number(url.searchParams.get('ms') ?? 800));
  if (pages[url.pathname]) return html(pages[url.pathname]);
  res.writeHead(404).end();
}).listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`;

const SCAN = {
  devices: ['mobile-390', 'tablet-768'],
  scenarios: [{ name: 'Page A', route: '/a' }, { name: 'Page B', route: '/b' }],
};

/** A temp project serving the test app on `port`, with a Lab that records every event. */
function project(port) {
  const dir = tmp('proj');
  writeFileSync(join(dir, 'server.mjs'), SERVER);
  writeFileSync(join(dir, 'agentlab.json'), JSON.stringify({
    schemaVersion: 2, name: 'supervision', startPath: '/', device: 'mobile-390', scan: SCAN,
    services: { web: { command: 'node server.mjs', cwd: dir, url: `http://127.0.0.1:${port}`, env: { PORT: String(port) }, readiness: { path: '/health', timeoutMs: 15_000 } } },
  }));
  return dir;
}

async function open(port) {
  const dir = project(port);
  const stateDir = tmp('state');
  const events = [];
  const feed = new SessionFeed();
  const listeners = [];
  const lab = new Lab({ stateDir, onEvent: (e) => { events.push(e); feed.apply(e); for (const fn of listeners) fn(e); } });
  labs.add(lab);
  const start = await lab.start({ project: dir, headed: false });
  return { lab, events, feed, dir, stateDir, port, runDir: start.session.runDir, start, listeners };
}
async function shut(s) {
  await s.lab.close();
  labs.delete(s.lab);
}

const url = (s, path) => `http://127.0.0.1:${s.port}${path}`;
const hitCount = async (s, path) => (await (await fetch(url(s, '/__hits'))).json())[path] ?? 0;
/** The request the in-flight action is waiting on has reached the server. */
const inFlight = (s, path, before = 0) => until(async () => (await hitCount(s, path)) > before, 10_000, `${path} to be requested`);
const ref = (lab, role, name) => lab.findRef({ role, name });
const click = (lab, role, name) => lab.act({ action: 'click', ref: ref(lab, role, name) });
const portFree = (port) => new Promise((resolve) => {
  const c = connect(port, '127.0.0.1');
  c.on('connect', () => { c.destroy(); resolve(false); });
  c.on('error', () => resolve(true));
});
/** The error code of an action that returned outcome error or was refused (thrown). */
async function codeOf(p) {
  try {
    const r = await p;
    return r.outcome === 'error' ? r.error.code : 'ok';
  } catch (e) {
    return e.code;
  }
}
/** Run `fn` synchronously the first time an event matches (so a request lands exactly between two units of work). */
function onceOn(s, match, fn) {
  let done = false;
  s.listeners.push((e) => { if (!done && match(e)) { done = true; fn(); } });
}
const kinds = (events, kind) => events.filter((e) => e.kind === kind);

/** A tap at the centre of an element, as the dashboard sends it: fractions of the viewport. */
async function tapOn(lab, selector) {
  const page = lab.activePage;
  const box = await page.locator(selector).boundingBox();
  const vp = page.viewportSize();
  await lab.humanInput({ type: 'tap', x: (box.x + box.width / 2) / vp.width, y: (box.y + box.height / 2) / vp.height });
}

/** Every text file under a directory (frames are images and skipped). */
function textFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...textFiles(p));
    else if (!/\.(jpe?g|png)$/.test(name)) out.push(p);
  }
  return out;
}
function assertNowhere(needle, s, extra = [], what = 'text') {
  const where = {
    'the events': JSON.stringify(s.events),
    'the feed snapshot': JSON.stringify(s.feed.snapshot()),
    'the findings': JSON.stringify(s.lab.inspect().findings),
    ...Object.fromEntries(extra),
  };
  for (const [name, body] of Object.entries(where)) assert.ok(!body.includes(needle), `${what} leaked into ${name}`);
  for (const f of textFiles(s.runDir)) assert.ok(!readFileSync(f, 'utf8').includes(needle), `${what} leaked into ${f}`);
}

// ---------------------------------------------------------------------------------------------
test('pause during navigation: the click completes with its result, then the session is paused and refuses actions', async () => {
  const s = await open(5362);
  try {
    const { lab } = s;
    const p = click(lab, 'link', 'Slow page');
    await inFlight(s, '/slow');
    const state = lab.supervise('pause', 'dashboard');
    assert.equal(state.mode, 'pausing');
    assert.equal(state.pending, 'paused');
    assert.equal(lab.control.busy, true);

    const r = await p;
    assert.equal(r.outcome, 'success', JSON.stringify(r.error));
    assert.equal(r.navigated, true);
    assert.equal(r.observation.route, '/slow');
    assert.deepEqual(r.observation.headings, ['h1 Slow page done']);
    assert.equal(lab.control.mode, 'paused');

    // Nothing runs and nothing is queued while paused.
    const hits = await hitCount(s, '/timer');
    await assert.rejects(click(lab, 'link', 'Timer'), (e) => e.code === 'session_paused' && e.toJSON().recoverable === true && e.details.control.mode === 'paused');
    await assert.rejects(lab.act({ action: 'back' }), { code: 'session_paused' });
    await assert.rejects(lab.sweep({ route: '/a' }), { code: 'session_paused' });
    await assert.rejects(lab.scan(), { code: 'session_paused' });
    await assert.rejects(lab.saveAuth(), { code: 'session_paused' });
    await sleep(300);
    assert.equal(await hitCount(s, '/timer'), hits, 'the refused click was not queued');
    assert.equal(lab.lastObservation.route, '/slow');
    assert.ok(kinds(s.events, 'refused').some((e) => e.command === 'click' && e.error.code === 'session_paused'), 'the refusal is on the timeline');

    // Read-only commands still work.
    const obs = await lab.observe();
    assert.equal(obs.route, '/slow');
    assert.ok(Array.isArray(lab.inspect().findings));
    assert.equal((await lab.tabList()).length, 1);
    assert.equal(lab.status().active, true);

    lab.supervise('resume');
    assert.equal(lab.control.mode, 'agent');
    const next = await click(lab, 'link', 'Timer');
    assert.equal(next.outcome, 'success');
    assert.equal(next.observation.route, '/timer', 'nobody touched the page, so no re-observe was needed');

    const modes = kinds(s.events, 'control').map((e) => `${e.change.op}:${e.change.state.mode}`);
    assert.deepEqual(modes, ['pause:pausing', 'settled:paused', 'resume:agent']);
  } finally {
    await shut(s);
  }
});

test('takeover during settling: the action reports its settle result, the person drives, and what they type is never recorded', async () => {
  const s = await open(5362);
  const EMAIL = 'zq-typed-email-8817@example.test';
  const PASSWORD = 'hunter2-Pw-9Xqz!';
  try {
    const { lab } = s;
    await click(lab, 'link', 'Timer');
    const oldRef = ref(lab, 'button', 'Start timer');
    const p = click(lab, 'button', 'Start timer');
    await sleep(250);                                              // the click landed; the 700 ms timer is pending
    assert.equal(lab.supervise('takeover').mode, 'pausing');
    const r = await p;
    assert.equal(r.outcome, 'success', JSON.stringify(r.error));
    assert.ok(r.settle, 'a settle report, not an exception');
    assert.ok(JSON.stringify(r.changes).includes('Done'), 'it waited for the timer before returning');
    assert.equal(lab.control.mode, 'human');

    await assert.rejects(lab.observe(), (e) => e.code === 'human_control' && e.toJSON().recoverable === true);
    await assert.rejects(click(lab, 'link', 'Form'), { code: 'human_control' });

    // Dashboard input works only now. A person navigates, types into two fields, and taps a button.
    await tapOn(lab, 'a[href="/form"]');
    await lab.activePage.waitForURL(/\/form$/);
    await tapOn(lab, '#email');
    await lab.humanInput({ type: 'text', text: EMAIL });
    await sleep(1000);                                             // the recorder reports typing once it pauses
    await tapOn(lab, '#save');
    await tapOn(lab, '#pw');
    await lab.humanInput({ type: 'text', text: PASSWORD });
    await sleep(1000);

    const human = kinds(s.events, 'human').map((e) => e.action);
    const email = human.find((a) => a.type === 'type' && a.target?.name === 'Email');
    assert.deepEqual(email, { type: 'type', target: { role: 'textbox', name: 'Email' }, chars: EMAIL.length });
    assert.ok(human.some((a) => a.type === 'tap' && a.target?.role === 'link' && a.target?.name === 'Form'), 'the link tap');
    assert.ok(human.some((a) => a.type === 'navigate' && a.detail === '/form'), 'the navigation');
    assert.ok(human.some((a) => a.type === 'tap' && a.target?.role === 'button' && a.target?.name === 'Save'), 'the button tap');
    const pw = human.find((a) => a.type === 'type' && a.target?.name === 'Password');
    assert.equal(pw?.secret, true);
    assert.ok(!('chars' in pw), 'not even the length of a password');
    assert.deepEqual(pw.target, { role: 'textbox', name: 'Password' });

    // The same facts are on the dashboard's timeline, without values.
    const snap = s.feed.snapshot();
    assert.ok(snap.timeline.some((e) => e.kind === 'human'), 'human entries on the timeline');
    assertNowhere(EMAIL, s, [], 'typed email');
    assertNowhere(PASSWORD, s, [], 'password');
    assertNowhere('hunter2', s, [], 'password prefix');
    assert.ok(readFileSync(join(s.runDir, 'actions.jsonl'), 'utf8').includes('"kind":"human"'), 'recorded in actions.jsonl');

    // Back to the agent: everything issued before is stale until it observes.
    lab.supervise('return');
    assert.equal(lab.control.state.observeRequired, true);
    await assert.rejects(lab.act({ action: 'click', ref: oldRef }), { code: 'observation_required' });
    await assert.rejects(lab.act({ action: 'back' }), { code: 'observation_required' });
    const obs = await lab.observe();
    assert.equal(obs.route, '/form');
    assert.equal(await codeOf(lab.act({ action: 'click', ref: oldRef })), 'stale_ref');
    const fresh = obs.controls.find((c) => c.name === 'Save');
    assert.equal((await lab.act({ action: 'click', ref: fresh.ref })).outcome, 'success');
    assert.equal(lab.control.state.observeRequired, false);
    // The observation shows the page's own state (the password field is masked); the password is still nowhere.
    assert.ok(!JSON.stringify(obs).includes(PASSWORD));
    assertNowhere(PASSWORD, s, [], 'password after the hand-back');
  } finally {
    await shut(s);
  }
});

test('dashboard input is accepted only while a person has control, and is validated', async () => {
  const s = await open(5362);
  try {
    const { lab } = s;
    await assert.rejects(lab.humanInput({ type: 'tap', x: 0.5, y: 0.5 }), { code: 'invalid_control' });
    lab.supervise('pause');
    await assert.rejects(lab.humanInput({ type: 'key', key: 'Tab' }), { code: 'invalid_control' }, 'a pause is not a takeover');
    lab.supervise('takeover');
    await assert.rejects(lab.humanInput({ type: 'tap', x: 2, y: 0.5 }), { code: 'invalid_request' });
    await assert.rejects(lab.humanInput({ type: 'key', key: 'F13' }), { code: 'invalid_request' });
    await assert.rejects(lab.humanInput({ type: 'text', text: '' }), { code: 'invalid_request' });
    await assert.rejects(lab.humanInput({ type: 'text', text: 'x'.repeat(501) }), { code: 'invalid_request' });
    await assert.rejects(lab.humanInput({ type: 'scroll', dy: 1e9 }), { code: 'invalid_request' });
    await assert.rejects(lab.humanInput({ type: 'drag' }), { code: 'invalid_request' });
    await lab.humanInput({ type: 'scroll', dy: 10 });
    await lab.humanInput({ type: 'key', key: 'Tab' });
    lab.supervise('return');
    await assert.rejects(lab.humanInput({ type: 'key', key: 'Tab' }), { code: 'invalid_control' });
  } finally {
    await shut(s);
  }
});

test('a person using the page while paused makes resume a hand-back: observe first, and a control the observation lists again keeps its ref', async () => {
  const s = await open(5362);
  try {
    const { lab } = s;
    await click(lab, 'link', 'Form');
    const stale = ref(lab, 'button', 'Save');
    lab.supervise('pause');
    // A paused page can be used by hand (the person is watching the same browser); the recorder notices.
    // Input from Playwright is trusted to the page, exactly like a person's, so the recorder sees it.
    await lab.activePage.locator('#save').click();
    const gone = ref(lab, 'link', 'Home');
    await lab.activePage.evaluate(() => { document.querySelector('nav a[href="/"]').style.display = 'none'; });
    await until(() => lab.control.state.humanInteractions > 0, 5000, 'the recorder to report');
    assert.ok(kinds(s.events, 'human').length > 0);
    lab.supervise('resume');
    assert.equal(lab.control.state.observeRequired, true);
    await assert.rejects(lab.act({ action: 'click', ref: stale }), { code: 'observation_required' });
    await lab.observe();
    // The page is unchanged, so the same control keeps its ref and the fresh observation re-issued it.
    assert.equal(await codeOf(lab.act({ action: 'click', ref: stale })), 'ok');
    // A control the person changed underneath and the observation no longer lists stays stale.
    await assert.rejects(lab.act({ action: 'click', ref: gone }).then((r) => { if (r.outcome === 'error') throw Object.assign(new Error(r.error.message), { code: r.error.code }); }), { code: 'stale_ref' });
  } finally {
    await shut(s);
  }
});

// ---------------------------------------------------------------------------------------------
test('a scan paused after the first run stops at the next run: partial result, skipped runs listed, verdict incomplete, session page untouched', async () => {
  const s = await open(5362);
  try {
    const { lab } = s;
    const before = { route: lab.lastObservation.route, gen: lab.lastObservation.gen, url: lab.activePage.url() };
    onceOn(s, (e) => e.kind === 'scan' && e.phase === 'run-done', () => lab.supervise('pause'));

    const result = await lab.scan();
    assert.equal(result.runs.length, 1, 'the run already done is kept');
    assert.equal(result.runs[0].scenario, 'Page A');
    assert.equal(result.runs[0].device, 'mobile-390');
    assert.equal(result.interrupted.reason, 'paused');
    assert.deepEqual(result.interrupted.skipped, [
      { scenario: 'Page A', device: 'tablet-768' }, { scenario: 'Page B', device: 'mobile-390' }, { scenario: 'Page B', device: 'tablet-768' },
    ]);
    assert.equal(result.verdict.result, 'incomplete');
    assert.match(result.verdict.reasons[0], /interrupted: a person paused the session; 3 scenario run/);
    assert.equal(lab.control.mode, 'paused');
    assert.deepEqual(kinds(s.events, 'scan').filter((e) => e.phase === 'run-start').map((e) => `${e.scenario}/${e.device}`), ['Page A/mobile-390']);
    assert.equal(kinds(s.events, 'scan').at(-1).phase, 'done', 'the partial result is announced too');

    assert.deepEqual({ route: lab.lastObservation.route, gen: lab.lastObservation.gen, url: lab.activePage.url() }, before, 'the session page was not touched');
    assert.equal(await hitCount(s, '/b'), 0, 'skipped runs never loaded their route');
    await assert.rejects(lab.scan(), { code: 'session_paused' });

    lab.supervise('resume');
    const full = await lab.scan();
    assert.equal(full.interrupted, undefined);
    assert.equal(full.runs.length, 4);
    assert.notEqual(full.verdict.result, 'incomplete');
  } finally {
    await shut(s);
  }
});

test('pause-next lets a whole scan finish, and only then pauses', async () => {
  const s = await open(5362);
  try {
    const { lab } = s;
    onceOn(s, (e) => e.kind === 'scan' && e.phase === 'run-done', () => lab.supervise('pause-next'));
    const result = await lab.scan();
    assert.equal(result.interrupted, undefined);
    assert.equal(result.runs.length, 4);
    assert.notEqual(result.verdict.result, 'incomplete');
    assert.equal(lab.control.mode, 'paused');
    await assert.rejects(lab.scan(), { code: 'session_paused' });
  } finally {
    await shut(s);
  }
});

test('a takeover during a scan interrupts it at the next run and hands the browser to the person', async () => {
  const s = await open(5362);
  try {
    const { lab } = s;
    onceOn(s, (e) => e.kind === 'scan' && e.phase === 'run-done', () => lab.supervise('takeover'));
    const result = await lab.scan();
    assert.equal(result.interrupted.reason, 'takeover');
    assert.equal(result.interrupted.skipped.length, 3);
    assert.equal(result.runs.length, 1);
    assert.equal(result.verdict.result, 'incomplete');
    assert.match(result.verdict.reasons[0], /a person took over the browser/);
    assert.equal(lab.control.mode, 'human');
    await assert.rejects(lab.observe(), { code: 'human_control' });
  } finally {
    await shut(s);
  }
});

test('a sweep paused after the first width stops at the next width', async () => {
  const s = await open(5362);
  try {
    const { lab } = s;
    onceOn(s, (e) => e.kind === 'sweep' && e.phase === 'device-done', () => lab.supervise('pause'));
    const result = await lab.sweep({ route: '/a', devices: ['mobile-390', 'tablet-768', 'desktop-1440'] });
    assert.equal(result.devices.length, 1);
    assert.equal(result.interrupted.reason, 'paused');
    assert.deepEqual(result.interrupted.skipped, ['tablet-768', 'desktop-1440']);
    assert.equal(lab.control.mode, 'paused');
    await assert.rejects(lab.sweep({ route: '/a' }), { code: 'session_paused' });
    lab.supervise('resume');
    const again = await lab.sweep({ route: '/a', devices: ['mobile-390'] });
    assert.equal(again.interrupted, undefined);
  } finally {
    await shut(s);
  }
});

// ---------------------------------------------------------------------------------------------
test('pause while an action fails: the error result is delivered normally, then the session is paused; resume works', async () => {
  const s = await open(5362);
  try {
    const { lab } = s;
    await click(lab, 'link', 'Blocked');
    const p = click(lab, 'button', 'Covered');
    lab.supervise('pause');                                        // in flight from the moment it was called
    const r = await p;
    assert.equal(r.outcome, 'error');
    assert.equal(r.error.code, 'obstructed');
    assert.equal(r.error.recoverable, true);
    assert.equal(lab.control.mode, 'paused');
    await assert.rejects(lab.act({ action: 'back' }), { code: 'session_paused' });

    lab.supervise('resume');
    const back = await lab.act({ action: 'back' });
    assert.equal(back.outcome, 'success');
    assert.equal(back.observation.route, '/');
  } finally {
    await shut(s);
  }
});

// ---------------------------------------------------------------------------------------------
test('stop while an action is in flight: the action completes, then the session closes and the owned server stops', async () => {
  const s = await open(5363);
  const { lab } = s;
  const p = click(lab, 'link', 'Slow page');
  await inFlight(s, '/slow');
  assert.equal(lab.supervise('stop', 'dashboard').mode, 'stopping');
  await assert.rejects(click(lab, 'link', 'Timer'), { code: 'session_stopped' }, 'nothing new starts while stopping');
  const r = await p;
  assert.equal(r.outcome, 'success', JSON.stringify(r.error));
  assert.equal(r.observation.route, '/slow');
  const closed = await lab.close();                                // the close the stop started
  const status = lab.status();
  assert.equal(status.active, false);
  assert.match(status.endedReason, /stopped by a person/);
  assert.equal(closed.server.owned, true);
  assert.equal(closed.server.stopped, true);
  assert.equal(await portFree(5363), true, 'the server the lab started is gone');
  assert.ok(kinds(s.events, 'closed').length >= 1);
  assert.deepEqual(kinds(s.events, 'control').map((e) => `${e.change.op}:${e.change.state.mode}`), ['stop:stopping', 'settled:stopped']);
  await assert.rejects(lab.observe(), { code: 'browser_closed' });
  labs.delete(lab);
});

test('emergency stop during a slow navigation: the action fails with browser_closed at once and the server stops', async () => {
  const s = await open(5363);
  const { lab } = s;
  const p = click(lab, 'link', 'Very slow page');
  await inFlight(s, '/slow');
  const t0 = Date.now();
  assert.equal(lab.supervise('emergency-stop', 'dashboard').mode, 'stopped');
  const r = await p;
  assert.ok(Date.now() - t0 < 3000, `returned at once, not after the 4 s response (${Date.now() - t0} ms)`);
  assert.equal(r.outcome, 'error');
  assert.equal(r.error.code, 'browser_closed');
  await lab.close();
  assert.match(lab.status().endedReason, /emergency stop by a person/);
  assert.equal(await portFree(5363), true);
  await assert.rejects(lab.act({ action: 'back' }), { code: 'browser_closed' });
  labs.delete(lab);
});

test('a stop is final for the host: dispatch refuses start with session_stopped', async () => {
  const dir = project(5362);
  const host = new SessionHost({ stateDir: tmp('state') }, { headless: true });
  try {
    const started = await dispatch(host, 'mcp', 'start', { project: dir });
    assert.equal(started.ok, true, JSON.stringify(started));
    host.supervise('pause');
    // Refused commands are structured errors, and read-only ones still answer.
    for (const [name, args] of [['click', { role: 'link', name: 'Timer' }], ['sweep', {}], ['scan', {}], ['stop', {}], ['auth_save', {}], ['back', {}]]) {
      const out = await dispatch(host, 'mcp', name, args);
      assert.equal(out.ok, false, name);
      assert.equal(out.error.code, 'session_paused', name);
      assert.equal(out.error.recoverable, true);
      assert.ok(out.error.hint);
      assert.equal(out.error.details.control.mode, 'paused');
    }
    assert.equal((await dispatch(host, 'mcp', 'observe', {})).ok, true);
    assert.equal((await dispatch(host, 'mcp', 'inspect', {})).ok, true);
    assert.equal((await dispatch(host, 'mcp', 'tabs', {})).ok, true);
    assert.equal((await dispatch(host, 'cli', 'status', {})).ok, true);
    host.supervise('resume');
    assert.equal((await dispatch(host, 'mcp', 'click', { role: 'link', name: 'Timer' })).ok, true);

    host.supervise('stop');
    assert.match(host.halted, /stopped by a person/);
    await host.lab.close();
    const again = await dispatch(host, 'mcp', 'start', { project: dir });
    assert.equal(again.ok, false);
    assert.equal(again.error.code, 'session_stopped');
    assert.equal(again.error.recoverable, false);
    assert.equal(host.lab.status().active, false);
  } finally {
    await host.lab.close().catch(() => undefined);
  }
});

test('an emergency stop also halts the host', async () => {
  const dir = project(5362);
  const host = new SessionHost({ stateDir: tmp('state') }, { headless: true });
  try {
    assert.equal((await dispatch(host, 'mcp', 'start', { project: dir })).ok, true);
    host.supervise('emergency-stop');
    assert.match(host.halted, /emergency stop by a person/);
    await host.lab.close();
    assert.equal((await dispatch(host, 'mcp', 'start', { project: dir })).error.code, 'session_stopped');
    assert.equal((await dispatch(host, 'mcp', 'click', { ref: 'e1' })).ok, false);
  } finally {
    await host.lab.close().catch(() => undefined);
  }
});

test('agentlab stop from the terminal goes through a pause and a takeover; an MCP stop is still refused', async () => {
  const dir = project(5362);
  for (const op of ['pause', 'takeover']) {
    const host = new SessionHost({ stateDir: tmp('state') }, { headless: true });
    try {
      assert.equal((await dispatch(host, 'mcp', 'start', { project: dir })).ok, true);
      host.supervise(op);
      const refused = await dispatch(host, 'mcp', 'stop', {});
      assert.equal(refused.error.code, op === 'pause' ? 'session_paused' : 'human_control', op);
      const out = await dispatch(host, 'cli', 'stop', {});
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.equal(out.output.result.server.stopped, true, op);
      const status = host.lab.status();
      assert.equal(status.active, false);
      assert.equal(status.endedReason, 'stopped from the terminal');
      assert.equal(host.lab.control.state.by, 'terminal');
      assert.equal(host.halted, 'stopped from the terminal');
      assert.equal(await portFree(5362), true, `${op}: the owned server stopped`);
    } finally {
      await host.lab.close().catch(() => undefined);
    }
  }
});

test('stop right after a person hands control back needs no fresh observe, from the terminal or over MCP', async () => {
  const dir = project(5362);
  for (const surface of ['cli', 'mcp']) {
    {
      const back = ['takeover', 'return'];
      const host = new SessionHost({ stateDir: tmp('state') }, { headless: true });
      const what = `${surface} after ${back.join('/')}`;
      try {
        assert.equal((await dispatch(host, 'mcp', 'start', { project: dir })).ok, true);
        for (const op of back) host.supervise(op);
        assert.equal(host.lab.control.state.observeRequired, true, what);
        assert.equal((await dispatch(host, surface, 'click', { ref: 'e1' })).error.code, 'observation_required', `${what}: an action still needs an observe`);
        const out = await dispatch(host, surface, 'stop', {});
        assert.equal(out.ok, true, `${what}: ${JSON.stringify(out)}`);
        assert.equal(out.output.result.server.stopped, true, what);
        assert.equal(host.lab.status().endedReason, 'requested', what);
        assert.equal(await portFree(5362), true, `${what}: the owned server stopped`);
      } finally {
        await host.lab.close().catch(() => undefined);
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------
/** A flow: Form, then (on the Timer page) start the timer, then Home. */
function flowFile(port) {
  const dir = project(port);
  const file = join(dir, 'flow.json');
  writeFileSync(file, JSON.stringify({
    name: 'supervised', project: '.',
    steps: [
      { do: 'click', role: 'link', name: 'Form', expect: { route: '/form' } },
      { do: 'click', role: 'link', name: 'Timer', expect: { route: '/timer' } },
      { do: 'click', role: 'button', name: 'Start timer', expect: { message: 'Done' } },
      { do: 'click', role: 'link', name: 'Home', expect: { route: '/' } },
    ],
  }));
  return file;
}
async function runSupervised(file, onEvent, onLab) {
  const events = [];
  const output = [];
  let lab;
  const passed = await runFlow(file, {
    headed: false, json: false, stateDir: tmp('state'), write: (t) => output.push(t),
    lab: { onEvent: (e) => { events.push({ ...e, at: Date.now() }); onEvent?.(e, lab); } },
    onLab: (l) => { lab = l; onLab?.(l); },
  });
  return { passed, events, output: output.join('') };
}

test('a flow paused between steps waits, does not fail, and continues after resume', async () => {
  const file = flowFile(5362);
  let paused = false;
  const r = await runSupervised(file, (e, lab) => {
    if (!paused && e.kind === 'act') {
      paused = true;
      lab.supervise('pause');                                      // during step 1: takes effect when it ends
      setTimeout(() => lab.supervise('resume'), 700);
    }
  });
  assert.equal(r.passed, true, r.output);
  assert.match(r.output, /waiting: paused from the dashboard/);
  assert.match(r.output, /PASS supervised: 4\/4 steps/);
  assert.equal(kinds(r.events, 'refused').length, 0, 'the flow waited instead of being refused');
  const acts = kinds(r.events, 'act');
  assert.equal(acts.length, 4);
  assert.ok(acts[1].at - acts[0].at >= 600, `step 2 waited for the resume (${acts[1].at - acts[0].at} ms)`);
});

test('a flow whose page was used by a person re-observes by itself after the hand-back and completes', async () => {
  const file = flowFile(5362);
  let taken = false;
  const r = await runSupervised(file, (e, lab) => {
    if (!taken && e.kind === 'act') {
      taken = true;
      lab.supervise('takeover');
      void (async () => {
        await sleep(500);
        // The person leaves the Form page for the Timer page: step 2's target moves.
        await lab.activePage.locator('nav a[href="/timer"]').click();
        await lab.activePage.waitForURL(/\/timer$/);
        await sleep(300);
        lab.supervise('return');
      })();
    }
  });
  assert.equal(r.passed, true, r.output);
  assert.match(r.output, /waiting: a person has control of the browser/);
  const ret = r.events.findIndex((e) => e.kind === 'control' && e.change.op === 'return');
  assert.ok(ret > 0, 'returned');
  const after = r.events.slice(ret);
  assert.equal(after.find((e) => e.kind === 'observe' || e.kind === 'act')?.kind, 'observe', 'observes before the next action');
  assert.equal(kinds(r.events, 'refused').length, 0);
});

test('a flow ends with the session stopped by a person: it fails cleanly', async () => {
  const file = flowFile(5362);
  let stopped = false;
  const r = await runSupervised(file, (e, lab) => {
    if (!stopped && e.kind === 'act') { stopped = true; lab.supervise('pause'); setTimeout(() => lab.supervise('stop'), 300); }
  });
  assert.equal(r.passed, false);
  assert.match(r.output, /stopped this session|stopped/i);
});

// ---------------------------------------------------------------------------------------------
// A person's typing is described as soon as they leave the field, press Enter or Tab, or hand control
// back; it is no longer lost to the 700 ms debounce. Port 5397.
const typedEntries = (s) => kinds(s.events, 'human').map((e) => e.action).filter((a) => a.type === 'type');

test('control returned 100 ms after typing: the typing is in history and the timeline, labelled, with no typed text', async () => {
  const s = await open(5397);
  const TEXT = 'zq-quick-return-4410@example.test';
  try {
    const { lab } = s;
    await click(lab, 'link', 'Form');
    await lab.observe();
    assert.equal(lab.supervise('takeover').mode, 'human');
    await tapOn(lab, '#email');
    await lab.humanInput({ type: 'text', text: TEXT });
    await sleep(100);
    assert.equal(typedEntries(s).length, 0, 'the debounce has not fired yet');
    lab.supervise('return');
    await until(() => typedEntries(s).length > 0, 400, 'the typing flushed at the hand-back');
    assert.deepEqual(typedEntries(s)[0], { type: 'type', target: { role: 'textbox', name: 'Email' }, chars: TEXT.length, late: true });
    const step = `a person typed into textbox "Email" (${TEXT.length} chars) (reported as control returned)`;
    assert.ok(lab.steps.includes(step), lab.steps.join('\n'));
    assert.ok(s.feed.snapshot().timeline.some((e) => e.kind === 'human' && e.summary.includes(`typed into textbox "Email" (${TEXT.length} chars)`)), 'on the timeline');
    await sleep(900);
    assert.equal(typedEntries(s).length, 1, 'reported once: the debounce does not repeat it');
    assertNowhere(TEXT, s, [['the history', lab.steps.join('\n')]], 'typed text');
  } finally {
    await shut(s);
  }
});

test('typing is described immediately on Tab and on leaving the field, before the key or tap that follows', async () => {
  const s = await open(5397);
  try {
    const { lab } = s;
    await click(lab, 'link', 'Form');
    await lab.observe();
    lab.supervise('takeover');
    await tapOn(lab, '#email');
    await lab.humanInput({ type: 'text', text: 'abcde' });
    await lab.humanInput({ type: 'key', key: 'Tab' });
    await until(() => kinds(s.events, 'human').some((e) => e.action.type === 'key'), 400, 'the Tab report');
    const afterTab = kinds(s.events, 'human').map((e) => e.action).filter((a) => a.type === 'type' || a.type === 'key');
    assert.deepEqual(afterTab.map((a) => a.type), ['type', 'key'], 'what was typed comes before Tab');
    assert.equal(afterTab[0].chars, 5);
    assert.equal(afterTab[0].late, undefined, 'a person still in control: not labelled late');

    await tapOn(lab, '#email');
    await lab.humanInput({ type: 'text', text: 'fghij' });
    await tapOn(lab, '#save');
    await until(() => kinds(s.events, 'human').some((e) => e.action.type === 'tap' && e.action.target?.name === 'Save'), 400, 'the Save tap');
    const order = kinds(s.events, 'human').map((e) => e.action)
      .filter((a) => a.type === 'type' || (a.type === 'tap' && a.target?.name === 'Save')).map((a) => a.type);
    assert.deepEqual(order, ['type', 'type', 'tap'], 'blur flushed the typing before the tap');
    lab.supervise('return');
  } finally {
    await shut(s);
  }
});

test('input by the agent after control returned is never recorded as the person\'s typing', async () => {
  const s = await open(5397);
  try {
    const { lab } = s;
    await click(lab, 'link', 'Form');
    await lab.observe();
    lab.supervise('takeover');
    lab.supervise('return');
    await lab.observe();
    await lab.act({ action: 'fill', ref: ref(lab, 'textbox', 'Email'), value: 'agent-typed@example.test' });
    await sleep(1200);
    assert.equal(typedEntries(s).length, 0);
  } finally {
    await shut(s);
  }
});
