// Saved sign-in state: save after signing in, reuse in later sessions, invalidate unusable files,
// refuse files others can read or git would track, and never let the cookie value leak. Port 5346.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lab } from '../dist/core/lab.js';
import { SessionFeed } from '../dist/core/feed.js';
import { formatAction, formatStart } from '../dist/core/format.js';

const SECRET = 'secret-cookie-value-123';
const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listening = (port) => new Promise((res) => {
  const s = connect({ host: '127.0.0.1', port });
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => res(false));
});
async function assertFree(port) {
  let busy = true;
  for (let i = 0; i < 50 && busy; i++) { busy = await listening(port); if (busy) await sleep(100); }
  assert.equal(busy, false, `port ${port} should be free`);
}

/** A tiny app: /login sets sid=<secret.txt> and goes to /app; /app redirects to /login without it. */
function makeProject(gitignore) {
  const dir = tmp('agentlab-auth-app-');
  writeFileSync(join(dir, 'secret.txt'), SECRET);
  writeFileSync(join(dir, 'server.mjs'), `
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const secret = () => readFileSync(new URL('./secret.txt', import.meta.url), 'utf8').trim();
const sid = (req) => /(?:^|;\\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
const html = (res, body) => res.writeHead(200, { 'content-type': 'text/html' })
  .end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">' + body);
createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/health') return res.end('ok');
  if (pathname === '/login' && req.method === 'POST') {
    res.writeHead(204, { 'set-cookie': 'sid=' + secret() + '; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax' });
    return res.end();
  }
  if (pathname === '/login') {
    return html(res, '<h1>Sign in</h1><button id="go">Sign in</button><script>go.onclick = async () => { await fetch("/login", { method: "POST" }); location.href = "/app"; };</script>');
  }
  if (pathname === '/app') {
    if (sid(req) !== secret()) return res.writeHead(302, { location: '/login' }).end();
    return html(res, '<h1>Signed in</h1>');
  }
  res.writeHead(404).end();
}).listen(5346, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`);
  writeFileSync(join(dir, 'agentlab.json'), JSON.stringify({
    schemaVersion: 2, name: 'auth-app',
    services: { web: { command: 'node server.mjs', url: 'http://127.0.0.1:5346', readiness: { path: '/health', timeoutMs: 10000 } } },
    startPath: '/app', auth: { loginPath: '/login' },
  }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (gitignore) writeFileSync(join(dir, '.gitignore'), '.agentlab/\n');
  return dir;
}

const project = makeProject(true);
const stateFile = join(project, '.agentlab', 'auth', 'state.json');
const stateDir = tmp('agentlab-auth-state-');

// Everything the sessions of tests 1–3 produced, checked for the cookie value in test 4.
const events = [];
const results = [];
const texts = [];
const runDirs = [];
let validState;

const newLab = () => new Lab({ stateDir, onEvent: (e) => events.push(e) });
const signIn = (lab) => lab.act({ action: 'click', ref: lab.findRef({ role: 'button', name: 'Sign in' }) });

test('a fresh session lands on /login; after signing in, saveAuth writes an owner-only file', async () => {
  const lab = newLab();
  try {
    const start = await lab.start({ project, headed: false });
    results.push(start); texts.push(formatStart(start)); runDirs.push(start.session.runDir);
    assert.equal(start.session.auth, 'fresh');
    assert.equal(start.observation.route, '/login');
    const click = await signIn(lab);
    results.push(click); texts.push(formatAction(click));
    assert.equal(click.outcome, 'success', JSON.stringify(click.error));
    assert.equal(click.observation.route, '/app');
    const saved = await lab.saveAuth();
    results.push(saved);
    assert.equal(saved.saved, true);
    assert.ok(saved.cookies >= 1);
  } finally {
    results.push(await lab.close());
  }
  assert.equal(statSync(stateFile).mode & 0o777, 0o600);
  assert.equal(statSync(join(project, '.agentlab', 'auth')).mode & 0o777, 0o700);
  validState = readFileSync(stateFile, 'utf8');
  assert.ok(validState.includes(SECRET), 'the file holds the session cookie (so test 4 has something to look for)');
});

test('a new session starts from the saved state and is signed in', async () => {
  const lab = newLab();
  try {
    const start = await lab.start({ project, headed: false });
    results.push(start); texts.push(formatStart(start)); runDirs.push(start.session.runDir);
    assert.equal(start.session.auth, 'saved-state');
    assert.equal(start.observation.route, '/app');
    assert.ok(start.observation.headings.some((h) => /Signed in/.test(h)), JSON.stringify(start.observation.headings));
  } finally {
    results.push(await lab.close());
  }
});

test('auth "fresh" ignores the saved state', async () => {
  const lab = newLab();
  try {
    const start = await lab.start({ project, headed: false, auth: 'fresh' });
    results.push(start); texts.push(formatStart(start)); runDirs.push(start.session.runDir);
    assert.equal(start.session.auth, 'fresh');
    assert.equal(start.observation.route, '/login');
  } finally {
    results.push(await lab.close());
  }
  assert.ok(existsSync(stateFile), 'a fresh session leaves the file alone');
});

test('the cookie value never appears in results, logs, events, the feed or text output', () => {
  assert.ok(events.length && results.length && runDirs.length);
  const feed = new SessionFeed();
  for (const e of events) feed.apply(e);
  const places = {
    results: JSON.stringify(results),
    events: JSON.stringify(events),
    feed: JSON.stringify(feed.snapshot()),
    text: texts.join('\n'),
    actions: runDirs.map((d) => readFileSync(join(d, 'actions.jsonl'), 'utf8')).join('\n'),
  };
  assert.ok(events.some((e) => e.kind === 'auth' && e.action === 'saved'));
  assert.ok(places.actions.includes('auth-save'));
  for (const [where, text] of Object.entries(places)) assert.ok(!text.includes(SECRET), `cookie value found in ${where}`);
});

/** Write the state file with the given content and mode. */
function writeState(content, mode = 0o600) {
  mkdirSync(join(project, '.agentlab', 'auth'), { recursive: true, mode: 0o700 });
  writeFileSync(stateFile, content, { mode });
  chmodSync(stateFile, mode);
}

test('a corrupt state file is auth_invalid and removed; nothing is left running', async () => {
  writeState('{not json');
  const lab = newLab();
  await assert.rejects(lab.start({ project, headed: false }), { code: 'auth_invalid' });
  await lab.close();
  assert.equal(existsSync(stateFile), false);
  await assertFree(5346);
});

test('an expired state file is auth_invalid and removed', async () => {
  writeState(JSON.stringify({
    cookies: [{ name: 'sid', value: 'x', domain: '127.0.0.1', path: '/', expires: Math.floor(Date.now() / 1000) - 3600, httpOnly: true, secure: false, sameSite: 'Lax' }],
    origins: [],
  }));
  const lab = newLab();
  await assert.rejects(lab.start({ project, headed: false }), { code: 'auth_invalid' });
  await lab.close();
  assert.equal(existsSync(stateFile), false);
  await assertFree(5346);
});

test('a state the app no longer accepts (redirect to loginPath) is auth_invalid and removed', async () => {
  assert.ok(validState, 'test 1 saved a state');
  writeState(validState);
  writeFileSync(join(project, 'secret.txt'), 'a-different-secret-456');
  const lab = newLab();
  try {
    await assert.rejects(lab.start({ project, headed: false }), (err) => {
      assert.equal(err.code, 'auth_invalid');
      assert.match(err.message, /\/login/);
      assert.ok(!JSON.stringify(err.toJSON()).includes(SECRET));
      return true;
    });
  } finally {
    await lab.close();
    writeFileSync(join(project, 'secret.txt'), SECRET);
  }
  assert.equal(existsSync(stateFile), false);
  await assertFree(5346);
});

test('a state file readable by others is auth_invalid and is not removed', async () => {
  writeState(validState, 0o644);
  const lab = newLab();
  await assert.rejects(lab.start({ project, headed: false }), { code: 'auth_invalid' });
  await lab.close();
  assert.ok(existsSync(stateFile), 'the file is left for the person to fix');
  rmSync(stateFile);
  await assertFree(5346);
});

test('saveAuth refuses when git would track the file', async () => {
  const unignored = makeProject(false);
  const file = join(unignored, '.agentlab', 'auth', 'state.json');
  const lab = newLab();
  try {
    await lab.start({ project: unignored, headed: false });
    await signIn(lab);
    await assert.rejects(lab.saveAuth(), { code: 'auth_not_ignored' });
  } finally {
    await lab.close();
  }
  assert.equal(existsSync(file), false);
  await assertFree(5346);
});

test('auth "saved" with no file is auth_missing and starts nothing', async () => {
  assert.equal(existsSync(stateFile), false);
  const lab = newLab();
  await assert.rejects(lab.start({ project, headed: false, auth: 'saved' }), { code: 'auth_missing' });
  await lab.close();
  await assertFree(5346);
});
