// Dashboard server: local access control, event delivery, reconnect, viewer-gated frame capture and
// shutdown. Uses a real SessionFeed and a fake frame source, so no browser is involved.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { SessionFeed } from '../dist/core/feed.js';
import { Dashboard } from '../dist/dashboard/server.js';
import { mjpeg, sse, until } from './helpers/stream.mjs';

const device = { id: 'mobile-390', label: 'm', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const starting = { kind: 'starting', project: 'fixture', url: 'http://127.0.0.1:5199/', device, headed: false };
const observation = (gen) => ({ gen, url: 'http://127.0.0.1:5199/', route: '/', title: 't', controls: [], layout: [], omitted: 0, console: { errors: 0 }, network: { failed: 0 } });
const start = (id) => ({ kind: 'start', result: {
  session: { id, device, browser: { engine: 'chromium', version: '153', headed: false }, environment: 'emulation' },
  server: { url: 'http://127.0.0.1:5199', owned: false, reused: true, readyMs: 3 }, observation: observation(1),
} });
const closed = { kind: 'closed', result: { reason: 'requested', browserClosed: true, server: { owned: false, stopped: false, detail: 'not owned' } } };
const JPEG = (n) => Buffer.from([0xff, 0xd8, n & 0xff, 0xff, 0xd9]);

/** Stands in for a Lab: counts screencast starts and stops and emits a frame every 20 ms while running. */
function fakeSource() {
  const s = {
    active: true, starts: 0, stops: 0, running: false, opts: undefined,
    async screencast(onFrame, opts) {
      s.starts++; s.running = true; s.opts = opts;
      let n = 0;
      onFrame(JPEG(n++));
      const timer = setInterval(() => onFrame(JPEG(n++)), 20);
      return async () => { clearInterval(timer); s.running = false; s.stops++; };
    },
  };
  return s;
}

let feed, source, dash, base, token;
beforeEach(async () => {
  feed = new SessionFeed();
  source = fakeSource();
  dash = await Dashboard.listen({ feed, source: () => source });
  feed.apply(starting);
  feed.apply(start('s-1'));
  ({ base, token } = parse(dash.url));
});
afterEach(async () => { await dash.close(); });

function parse(url) {
  const u = new URL(url);
  return { base: u.origin, token: new URLSearchParams(u.hash.slice(1)).get('token') };
}

function get(path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request(base + path, { method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('binds to loopback only and keeps the token out of requests', () => {
  assert.match(dash.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]{32}$/, 'token in the fragment, not the path or query');
});

test('access control: token required, host and origin pinned, read-only', async () => {
  const page = await get('/');
  assert.equal(page.status, 200, 'the page itself is static code');
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.ok(!page.body.includes('s-1'), 'no session data without the token');

  assert.equal((await get('/api/state')).status, 401);
  assert.equal((await get(`/api/state?token=${token.slice(0, -1)}x`)).status, 401, 'wrong token');
  assert.equal((await get('/api/state?token=short')).status, 401, 'wrong length');
  assert.equal((await get('/api/events')).status, 401);
  assert.equal((await get('/api/viewport')).status, 401);
  assert.equal(source.starts, 0, 'an unauthorised viewer never starts capture');

  const ok = await get(`/api/state?token=${token}`);
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).status.sessionId, 's-1');
  assert.equal(ok.headers['access-control-allow-origin'], undefined, 'no CORS');
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal((await get('/api/state', { authorization: `Bearer ${token}` })).status, 200);

  // DNS rebinding: a hostile name resolving to 127.0.0.1 still sends its own Host header.
  assert.equal((await get(`/api/state?token=${token}`, { host: 'attacker.example' })).status, 403);
  assert.equal((await get(`/api/state?token=${token}`, { origin: 'http://attacker.example' })).status, 403);
  assert.equal((await get(`/api/state?token=${token}`, { origin: base })).status, 200);
  assert.equal((await get(`/api/state?token=${token}`, {}, 'POST')).status, 405);
  assert.equal((await get(`/api/frames/..%2F..%2Fetc%2Fpasswd?token=${token}`)).status, 404);
  assert.equal((await get(`/api/frames/F1.jpg?token=${token}`)).status, 404, 'no frame recorded');
});

test('a new session rotates the token and disconnects viewers of the previous one', async () => {
  const events = sse(`${base}/api/events?token=${token}`);
  const view = mjpeg(`${base}/api/viewport?token=${token}`);
  await events.next((m) => m.event === 'snapshot');
  await until(() => view.frames.length > 0, 3000, 'first frame');
  feed.apply(closed);
  feed.apply(starting);                                          // next session in the same process (MCP)
  await events.waitEnd();
  await until(() => view.ended, 3000, 'viewport stream to end');
  assert.equal((await get(`/api/state?token=${token}`)).status, 401, 'the old link is revoked');
  const next = parse(dash.url).token;
  assert.notEqual(next, token);
  assert.equal((await get(`/api/state?token=${next}`)).status, 200);
});

test('events: snapshot first, then live messages in order', async () => {
  const events = sse(`${base}/api/events?token=${token}`);
  const snap = await events.next((m) => m.event === 'snapshot');
  assert.equal(snap.json.status.state, 'active');
  assert.deepEqual(snap.json.timeline.map((e) => e.kind), ['start']);
  feed.apply({ kind: 'server-log', line: 'GET /api/invoices 200' });
  feed.apply({ kind: 'observe', observation: observation(2) });
  const entry = await events.next((m) => m.json.event?.type === 'timeline');
  assert.equal(entry.json.event.entry.kind, 'observe');
  const live = events.messages.filter((m) => m.event === 'feed');
  assert.deepEqual(live.map((m) => Number(m.id)), live.map((m) => m.json.seq), 'SSE ids are feed sequence numbers');
  assert.ok(live.every((m, i) => i === 0 || m.json.seq === live[i - 1].json.seq + 1), 'no gaps');
  assert.equal(live[0].json.event.type, 'server-log');
  events.close();
});

test('reconnect with Last-Event-ID replays only what was missed; a refresh gets a snapshot', async () => {
  const first = sse(`${base}/api/events?token=${token}`);
  await first.next((m) => m.event === 'snapshot');
  feed.apply({ kind: 'server-log', line: 'one' });
  const last = await first.next((m) => m.json.event?.line === 'one');
  first.close();                                                   // connection drops
  feed.apply({ kind: 'server-log', line: 'two' });
  feed.apply({ kind: 'server-log', line: 'three' });

  const again = sse(`${base}/api/events?token=${token}`, { 'last-event-id': last.id });
  await again.next((m) => m.json.event?.line === 'three');
  assert.deepEqual(again.messages.map((m) => m.event), ['feed', 'feed'], 'no snapshot on a resumable reconnect');
  assert.deepEqual(again.messages.map((m) => m.json.event.line), ['two', 'three']);
  again.close();

  const refresh = sse(`${base}/api/events?token=${token}`);
  const snap = await refresh.next((m) => m.event === 'snapshot');
  assert.deepEqual(snap.json.serverLog, ['one', 'two', 'three'], 'a refreshed dashboard restores the session state');
  assert.deepEqual(snap.json.timeline.map((e) => e.kind), ['start']);
  refresh.close();

  const stale = sse(`${base}/api/events?token=${token}`, { 'last-event-id': '999999' });
  assert.equal((await stale.next(() => true)).event, 'snapshot', 'an unknown position falls back to a snapshot');
  stale.close();
});

test('frames are captured only while a viewer is connected', async () => {
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(source.starts, 0, 'no viewer, no capture');
  const sub = sse(`${base}/api/events?token=${token}`);         // watching events alone does not stream frames
  await sub.next((m) => m.event === 'snapshot');
  assert.equal(source.starts, 0);

  const a = mjpeg(`${base}/api/viewport?token=${token}`);
  await until(() => a.frames.length >= 3, 3000, 'frames for viewer a');
  assert.equal(source.starts, 1);
  assert.deepEqual(source.opts, { maxFps: 5, maxWidth: 1920, quality: 85 }, 'clearer desktop frames with capped rate and size by default');
  assert.deepEqual([...a.frames[0]], [0xff, 0xd8, 0, 0xff, 0xd9]);

  const b = mjpeg(`${base}/api/viewport?token=${token}`);         // a second viewer shares the capture
  await until(() => b.frames.length >= 1, 3000, 'frames for viewer b');
  assert.equal(source.starts, 1);
  a.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(source.running, true, 'one viewer still connected');
  b.close();
  await until(() => !source.running, 3000, 'capture to stop');
  assert.equal(source.stops, 1);
  assert.equal(dash.getStats().viewers.frames, 0);

  const c = mjpeg(`${base}/api/viewport?token=${token}`);
  await until(() => c.frames.length >= 1, 3000, 'reconnected viewer');
  assert.equal(source.starts, 2, 'capture restarts for a returning viewer');
  c.close();
  sub.close();
  await until(() => !source.running, 3000, 'capture to stop');
});

test('session stop ends the streams and capture; close releases the port', async () => {
  const events = sse(`${base}/api/events?token=${token}`);
  const view = mjpeg(`${base}/api/viewport?token=${token}`);
  await until(() => view.frames.length > 0, 3000, 'frames');
  feed.apply(closed);
  const final = await events.next((m) => m.json.event?.type === 'status' && m.json.event.status.state === 'ended');
  assert.equal(final.json.event.status.endedReason, 'requested');
  await until(() => view.ended, 3000, 'viewport stream to end');
  await until(() => !source.running, 3000, 'capture to stop');
  assert.equal(source.starts, source.stops);

  const late = mjpeg(`${base}/api/viewport?token=${token}`);       // a viewer opening after the end gets the last frame
  await until(() => late.ended, 3000, 'late viewer stream to end');
  assert.equal(late.frames.length, 1);
  assert.equal(source.starts, 1, 'no capture after the session ended');

  await dash.close();
  await assert.rejects(get('/api/state'), /ECONNREFUSED/);
  assert.equal(events.ended, true);
});
