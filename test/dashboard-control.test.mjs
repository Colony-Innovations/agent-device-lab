// The dashboard's supervision endpoints over real HTTP, with a real Lab behind a SessionHost:
// who may POST (control token in an Authorization header only, exact Origin, JSON, at most 8 KB),
// what each failure returns, canControl by token, and the caps on open streams.
// The Lab starts a tiny app on 5364 from a temp profile. Dashboards use an ephemeral port.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionFeed } from '../dist/core/feed.js';
import { SessionHost, dispatch } from '../dist/core/commands.js';
import { Dashboard } from '../dist/dashboard/server.js';
import { sse } from './helpers/stream.mjs';

const dir = mkdtempSync(join(tmpdir(), 'agentlab-dashctl-'));
writeFileSync(join(dir, 'server.mjs'), `
import { createServer } from 'node:http';
const page = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">' +
  '<h1>Control</h1><label for="e">Email</label><input id="e" type="email" style="height:44px;width:200px"><button style="height:44px;min-width:88px">Go</button>';
createServer((req, res) => {
  if (req.url === '/health') return res.end('ok');
  res.writeHead(200, { 'content-type': 'text/html' }).end(page);
}).listen(5364, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`);
writeFileSync(join(dir, 'agentlab.json'), JSON.stringify({
  schemaVersion: 2, name: 'dashctl',
  services: { web: { command: 'node server.mjs', cwd: dir, url: 'http://127.0.0.1:5364', readiness: { path: '/health', timeoutMs: 15_000 } } },
}));

const feed = new SessionFeed();
const host = new SessionHost({ stateDir: join(dir, 'state'), evidenceFrames: true, onEvent: (e) => feed.apply(e) }, { headless: true });
let dash;
let base;
let token;
let viewToken;
const tokenOf = (u) => new URLSearchParams(new URL(u).hash.slice(1)).get('token');

before(async () => {
  dash = await Dashboard.listen({
    feed, source: () => host.lab,
    control: (op, by) => host.supervise(op, by),
    input: (i) => host.lab.humanInput(i),
  });
  base = new URL(dash.url).origin;
  token = tokenOf(dash.url);
  viewToken = tokenOf(dash.viewUrl);
  const started = await dispatch(host, 'mcp', 'start', { project: dir });
  assert.equal(started.ok, true, JSON.stringify(started));
  // Starting a session issues fresh tokens.
  token = tokenOf(dash.url);
  viewToken = tokenOf(dash.viewUrl);
});
after(async () => {
  await host.lab.close().catch(() => undefined);
  await dash?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** POST with full control of the headers. Resolves with the status and parsed body (or the raw text). */
function post(path, body, { auth = `Bearer ${token}`, origin = base, contentType = 'application/json', headers = {}, query = '' } = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const h = { ...(auth ? { authorization: auth } : {}), ...(origin ? { origin } : {}), ...(contentType ? { 'content-type': contentType } : {}), 'content-length': Buffer.byteLength(payload), ...headers };
    const req = request(base + path + query, { method: 'POST', headers: h, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, json, text }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const control = (op, opts) => post('/api/control', { op }, opts);
const state = async (t = token, via = 'header') => {
  const res = await fetch(`${base}/api/state${via === 'query' ? `?token=${t}` : ''}`, via === 'header' ? { headers: { authorization: `Bearer ${t}` } } : {});
  return { status: res.status, json: await res.json() };
};
const tapOn = async (selector) => {
  const page = host.lab.activePage;
  const box = await page.locator(selector).boundingBox();
  const vp = page.viewportSize();
  return { type: 'tap', x: (box.x + box.width / 2) / vp.width, y: (box.y + box.height / 2) / vp.height };
};

test('the view token cannot control: POST /api/control and /api/input are 401 and change nothing', async () => {
  for (const path of ['/api/control', '/api/input']) {
    const r = await post(path, { op: 'pause', type: 'key', key: 'Tab' }, { auth: `Bearer ${viewToken}` });
    assert.equal(r.status, 401, path);
    assert.match(r.json.error, /view-only or expired/);
  }
  assert.equal(host.lab.control.mode, 'agent');
});

test('the control token in a query string, a missing token, a wrong token and a non-Bearer header are all 401', async () => {
  assert.equal((await control('pause', { auth: null, query: `?token=${token}` })).status, 401, 'query string is never accepted for POST');
  assert.equal((await control('pause', { auth: null })).status, 401);
  assert.equal((await control('pause', { auth: `Bearer ${token.slice(0, -1)}x` })).status, 401);
  assert.equal((await control('pause', { auth: 'Bearer short' })).status, 401);
  assert.equal((await control('pause', { auth: `Basic ${token}` })).status, 401);
  assert.equal(host.lab.control.mode, 'agent', 'no refused request changed anything');
});

test('the Origin must be this dashboard exactly; Sec-Fetch-Site must be same-origin', async () => {
  const port = new URL(base).port;
  assert.equal((await control('pause', { origin: null })).status, 403, 'no Origin');
  assert.equal((await control('pause', { origin: 'http://attacker.example' })).status, 403);
  assert.equal((await control('pause', { origin: `http://127.0.0.1:${Number(port) + 1}` })).status, 403, 'another port');
  assert.equal((await control('pause', { origin: `https://127.0.0.1:${port}` })).status, 403, 'another scheme');
  assert.equal((await control('pause', { origin: 'null' })).status, 403);
  assert.equal((await control('pause', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await control('pause', { headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
  assert.equal((await control('pause', { headers: { 'sec-fetch-site': 'none' } })).status, 403);
  assert.equal((await control('pause', { headers: { host: 'attacker.example' } })).status, 403, 'DNS rebinding');
  assert.equal((await post('/api/input', { type: 'key', key: 'Tab' }, { origin: 'http://attacker.example' })).status, 403);
  assert.equal(host.lab.control.mode, 'agent');
});

test('only application/json bodies of at most 8 KB that are JSON objects are read', async () => {
  assert.equal((await control('pause', { contentType: 'text/plain' })).status, 415);
  assert.equal((await control('pause', { contentType: 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await control('pause', { contentType: null })).status, 415);
  const big = await post('/api/control', { op: 'pause', pad: 'x'.repeat(9 * 1024) });
  assert.equal(big.status, 413, big.text);
  const bigInput = await post('/api/input', { type: 'text', text: 'x'.repeat(9 * 1024) });
  assert.equal(bigInput.status, 413);
  assert.equal((await post('/api/control', 'not json')).status, 400);
  assert.equal((await post('/api/control', '[1,2]')).status, 400);
  assert.equal((await post('/api/control', 'null')).status, 400);
  assert.equal((await post('/api/control', {})).status, 400, 'op is required');
  assert.equal((await post('/api/control', { op: 7 })).status, 400);
  assert.equal((await post('/api/control', { op: 'app' })).status, 400, 'an unknown op');
  assert.equal((await control('explode')).status, 400);
  assert.equal((await control('explode')).json.code, 'invalid_request');
  assert.equal((await post('/api/control', { op: 'pause' }, { contentType: 'application/json; charset=utf-8', origin: `http://localhost:${new URL(base).port}` })).status, 200, 'localhost is the same origin');
  assert.equal((await control('resume')).status, 200);
  assert.equal(host.lab.control.mode, 'agent');
});

test('a request that makes no sense in the current mode is 409 with the reason; input outside a takeover is 409', async () => {
  const r = await control('resume');
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'invalid_control');
  assert.match(r.json.error, /Cannot resume: /);
  assert.equal((await control('return')).status, 409);
  const input = await post('/api/input', { type: 'key', key: 'Tab' });
  assert.equal(input.status, 409);
  assert.equal(input.json.code, 'invalid_control');
  assert.match(input.json.error, /only while a person has taken control/);
  assert.equal(host.lab.control.mode, 'agent');
});

test('pause, takeover, input and return over HTTP; the dashboard state follows', async () => {
  let r = await control('pause');
  assert.equal(r.status, 200);
  assert.equal(r.json.control.mode, 'paused');
  assert.equal(r.json.control.by, 'dashboard');
  assert.equal((await state()).json.status.control.mode, 'paused');
  assert.equal((await post('/api/input', { type: 'key', key: 'Tab' })).status, 409, 'a pause is not a takeover');
  assert.equal((await control('pause')).status, 409, 'already paused');

  // Tools refuse while paused; the person's URL and the tool result are separate worlds.
  const refused = await dispatch(host, 'mcp', 'click', { role: 'button', name: 'Go' });
  assert.equal(refused.error.code, 'session_paused');

  r = await control('takeover');
  assert.equal(r.status, 200);
  assert.equal(r.json.control.mode, 'human');
  assert.equal((await post('/api/input', await tapOn('#e'))).status, 200);
  assert.equal((await post('/api/input', { type: 'text', text: 'hello' })).status, 200);
  assert.equal((await post('/api/input', { type: 'key', key: 'Tab' })).status, 200);
  assert.equal((await post('/api/input', { type: 'scroll', dy: 20 })).status, 200);
  assert.equal(await host.lab.activePage.inputValue('#e'), 'hello', 'the input reached the page');
  assert.equal((await post('/api/input', { type: 'key', key: 'F13' })).status, 400);
  assert.equal((await post('/api/input', { type: 'tap', x: 3, y: 0 })).status, 400);
  assert.equal((await post('/api/input', { type: 'nope' })).status, 400);
  assert.equal((await post('/api/input', { type: 'text', text: '' })).status, 400);
  assert.equal((await dispatch(host, 'mcp', 'observe', {})).error.code, 'human_control');

  r = await control('return');
  assert.equal(r.status, 200);
  assert.equal(r.json.control.mode, 'agent');
  assert.equal(r.json.control.observeRequired, true);
  assert.equal((await post('/api/input', { type: 'key', key: 'Tab' })).status, 409, 'the person handed control back');
  assert.equal((await dispatch(host, 'mcp', 'click', { role: 'button', name: 'Go' })).error.code, 'observation_required');
  assert.equal((await dispatch(host, 'mcp', 'observe', {})).ok, true);
  assert.equal((await dispatch(host, 'mcp', 'click', { role: 'button', name: 'Go' })).ok, true);
  assert.equal(host.lab.control.state.observeRequired, false);
});

test('canControl is true only for the control token (header or query); the view token reads but cannot control', async () => {
  assert.equal((await state(token, 'header')).json.canControl, true);
  assert.equal((await state(token, 'query')).json.canControl, true);
  const view = await state(viewToken, 'header');
  assert.equal(view.status, 200);
  assert.equal(view.json.canControl, false);
  assert.equal((await state(viewToken, 'query')).json.canControl, false);
  assert.equal((await state(viewToken, 'query')).json.status.sessionId, (await state()).json.status.sessionId, 'the same session state');
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
});

test('at most 32 event streams: the 33rd is refused with 503 and a retry hint; closing one frees a slot', async () => {
  const streams = [];
  try {
    for (let i = 0; i < 32; i++) {
      const s = sse(`${base}/api/events?token=${i % 2 ? viewToken : token}`);
      streams.push(s);
      assert.equal(await s.opened, 200, `stream ${i + 1}`);
    }
    assert.equal(dash.getStats().viewers.events, 32);
    const extra = sse(`${base}/api/events?token=${token}`);
    assert.equal(await extra.opened, 503);
    assert.equal(dash.getStats().viewers.events, 32);
    streams.pop().close();
    const start = Date.now();
    while (dash.getStats().viewers.events > 31 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20));
    const again = sse(`${base}/api/events?token=${token}`);
    streams.push(again);
    assert.equal(await again.opened, 200, 'a slot was freed');
  } finally {
    for (const s of streams) s.close();
  }
});

test('at most 8 viewport streams: the 9th is refused with 503', async () => {
  const views = [];
  const open = (i) => new Promise((resolve, reject) => {
    const req = request(`${base}/api/viewport?token=${i % 2 ? viewToken : token}`, (res) => { views.push({ req, res }); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  try {
    for (let i = 0; i < 8; i++) assert.equal(await open(i), 200, `viewer ${i + 1}`);
    assert.equal(dash.getStats().viewers.frames, 8);
    assert.equal(await open(8), 503);
    assert.equal(dash.getStats().viewers.frames, 8);
  } finally {
    for (const { req, res } of views) { res.destroy(); req.destroy(); }
  }
  const start = Date.now();
  while ((dash.getStats().viewers.frames > 0 || dash.getStats().screencast.running) && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 20));
  assert.equal(dash.getStats().viewers.frames, 0);
  assert.equal(dash.getStats().screencast.running, false, 'capture stops with the last viewer');
});

test('stop over HTTP closes the session; further control is refused because nothing is left to control', async () => {
  const r = await control('stop');
  assert.equal(r.status, 200);
  assert.equal(r.json.control.mode, 'stopped');
  assert.match(host.halted, /stopped by a person/);
  await host.lab.close();
  assert.equal(host.lab.status().active, false);
  const again = await control('pause');
  assert.equal(again.status, 410);
  assert.equal(again.json.code, 'browser_closed');
  assert.equal((await post('/api/input', { type: 'key', key: 'Tab' })).status, 410);
  assert.equal((await dispatch(host, 'mcp', 'start', { project: dir })).error.code, 'session_stopped');
});
