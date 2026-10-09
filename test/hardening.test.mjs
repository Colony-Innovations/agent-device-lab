// Operational hardening: private socket and run directories, capped service logs and daemon echo,
// ownership records and orphan cleanup after a crash, an application server or tab that dies, capped
// in-memory history and findings, run pruning, and clean shutdown on signals.
// Ports 5367 (crash, caps), 5368 (service exit, signals) and 5369 (permissions).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Lab } from '../dist/core/lab.js';
import { FindingStore } from '../dist/core/findings.js';
import { identify } from '../dist/core/process-identity.js';
import { Service } from '../dist/core/project-runner.js';
import { appendStep, pushCapped, since } from '../dist/core/reproduction.js';
import { keepRuns, liveSessionIds, pruneRuns, reapOrphans, recordOwnership, releaseOwnership } from '../dist/core/ownership.js';

const run = promisify(execFile);
const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const bystanders = [];
after(() => {
  for (const c of bystanders) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const listening = (port) => new Promise((res) => {
  const s = connect({ host: '127.0.0.1', port });
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => res(false));
});
async function waitPort(port, up, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if ((await listening(port)) === up) return true; await sleep(100); }
  return false;
}
const mode = (path) => statSync(path).mode & 0o777;

/** A project whose one service is a node http server on `port`, plus optional extra profile fields. */
function project(port, { script, extra = {} } = {}) {
  const dir = tmp('agentlab-hard-proj-');
  writeFileSync(join(dir, 'server.mjs'), script ?? `
import { createServer } from 'node:http';
createServer((req, res) => req.url === '/health' ? res.end('ok') : res.writeHead(200, { 'content-type': 'text/html' })
  .end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>t</title><h1>Hello</h1><button>Go</button>'))
  .listen(${port}, '127.0.0.1');
`);
  writeFileSync(join(dir, 'agentlab.json'), JSON.stringify({
    schemaVersion: 1, name: 'hardening', web: { command: 'node server.mjs', url: `http://127.0.0.1:${port}`, readiness: { path: '/health' } }, ...extra,
  }));
  return dir;
}

/** An unrelated process in its own process group. */
function bystander() {
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  child.unref();
  bystanders.push(child);
  return child;
}

const gone = 2 ** 22 + 4321;
const deadOwner = { pid: gone, startTime: '1' };
function writeRecord(state, sessionId, owner, services) {
  mkdirSync(join(state, 'owned'), { recursive: true });
  writeFileSync(join(state, 'owned', `${sessionId}.json`), JSON.stringify({ sessionId, owner, recordedAt: new Date().toISOString(), services }));
}

// ---------- 1. permissions ----------

test('the daemon socket is 0600 and the state and run directories the lab creates are 0700, even under umask 002', async () => {
  const proj = project(5369, { script: `
import { createServer } from 'node:http';
for (let i = 0; i < 3000; i++) console.log('noisy server line ' + i);
createServer((q, s) => s.end('<title>t</title><h1>x</h1>')).listen(5369, '127.0.0.1');
` });
  const state = join(tmp('agentlab-hard-home-'), 'state'); // does not exist: the lab creates it
  const env = { ...process.env, AGENTLAB_HOME: state, AGENTLAB_DAEMON_ECHO_MAX_BYTES: '4000' };
  const cli = (...args) => run('sh', ['-c', 'umask 002; exec "$0" "$@"', process.execPath, 'bin/agentlab.js', ...args], { env, timeout: 120_000 });
  try {
    await cli('start', '--project', proj, '--headless', '--no-ui');
    const daemon = JSON.parse(readFileSync(join(state, 'daemon.json'), 'utf8'));
    assert.equal(mode(daemon.socket), 0o600, 'socket');
    assert.equal(mode(state), 0o700, 'state dir');
    assert.equal(mode(join(state, 'runs')), 0o700, 'runs dir');
    const [runName] = readdirSync(join(state, 'runs'));
    assert.equal(mode(join(state, 'runs', runName)), 0o700, 'run dir');
    assert.equal(mode(join(state, 'owned')), 0o700, 'owned dir');
    assert.equal(mode(join(state, 'daemon.json')), 0o600);
    assert.equal(mode(join(state, 'daemon.log')), 0o600);
    // The daemon's echo of the server's output is capped, with one note.
    const log = readFileSync(join(state, 'daemon.log'), 'utf8');
    assert.ok(log.length < 12_000, `daemon.log is ${log.length} bytes`);
    assert.equal(log.match(/server output in this log stopped/g)?.length, 1);
    assert.equal(readdirSync(join(state, 'owned')).length, 1, 'ownership recorded while the session runs');
  } finally {
    await cli('stop').catch(() => undefined);
  }
  assert.deepEqual(readdirSync(join(state, 'owned')), [], 'ownership released on stop');
  assert.equal(await waitPort(5369, false), true);
});

// ---------- 2. capped service log ----------

test('a service log stops at the cap with one note, while readiness matching and the tail keep seeing every line', async () => {
  const dir = tmp('agentlab-hard-log-');
  writeFileSync(join(dir, 'noisy.mjs'), `for (let i = 0; i < 5000; i++) console.log('line ' + i);\nconsole.log('LATE-MARKER');\nsetInterval(() => {}, 1000);\n`);
  process.env.AGENTLAB_SERVICE_LOG_MAX_BYTES = '4096';
  const seen = [];
  let svc;
  try {
    svc = await Service.ensure({
      name: 'noisy', command: 'node noisy.mjs', cwd: dir, env: {}, requiredEnv: [], readiness: { kind: 'log', pattern: 'LATE-MARKER', timeoutMs: 15_000, intervalMs: 100 },
      dependsOn: [], reuseExisting: false, required: true, mode: 'process', shutdown: { signal: 'SIGTERM', graceMs: 2000 },
    }, { logFile: join(dir, 'noisy.log'), onLog: (l) => seen.push(l) });
    assert.ok(seen.includes('LATE-MARKER'), 'readiness matched a line written after the cap');
    await svc.stop();
    const text = readFileSync(join(dir, 'noisy.log'), 'utf8');
    const note = '… output truncated at 4096 bytes; later output discarded';
    assert.equal(text.split(note).length - 1, 1, 'one note');
    assert.ok(!text.includes('LATE-MARKER'));
    assert.ok(statSync(join(dir, 'noisy.log')).size <= 4096 + note.length + 4, `log is ${statSync(join(dir, 'noisy.log')).size} bytes`);
  } finally {
    delete process.env.AGENTLAB_SERVICE_LOG_MAX_BYTES;
    await svc?.stop();
  }
});

// ---------- 3. ownership records and orphan cleanup ----------

test('a SIGKILLed session leaves its server running; reapOrphans stops it and removes the record', async () => {
  const proj = project(5367);
  const state = tmp('agentlab-hard-state-');
  const script = join(tmp('agentlab-hard-child-'), 'child.mjs');
  writeFileSync(script, `
import { Lab } from ${JSON.stringify(pathToFileURL(resolve('dist/core/lab.js')).href)};
const lab = new Lab({ stateDir: ${JSON.stringify(state)} });
await lab.start({ project: ${JSON.stringify(proj)}, headed: false });
console.log('READY');
setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const end = Date.now() + 60_000;
  while (!out.includes('READY') && Date.now() < end && child.exitCode === null) await sleep(100);
  assert.ok(out.includes('READY'), 'child session started');
  const files = readdirSync(join(state, 'owned'));
  assert.equal(files.length, 1);
  assert.equal(mode(join(state, 'owned', files[0])), 0o600);
  const record = JSON.parse(readFileSync(join(state, 'owned', files[0]), 'utf8'));
  assert.equal(record.owner.pid, child.pid);
  assert.equal(record.services[0].owned, true);

  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  assert.equal(await listening(5367), true, 'the orphaned server is still running');

  // A live owner is left alone: this test process owns a second record, and it survives the reap.
  recordOwnership(state, 's-live-0001', []);
  const notes = await reapOrphans(state);
  assert.ok(notes.some((n) => /stopped owned server process group \d+/.test(n)), notes.join('\n'));
  assert.equal(await waitPort(5367, false), true, 'port released');
  assert.deepEqual(readdirSync(join(state, 'owned')), ['s-live-0001.json']);
  releaseOwnership(state, 's-live-0001');
  assert.deepEqual(readdirSync(join(state, 'owned')), []);
});

test('reapOrphans never touches a live owner, a reused pid, or a one-shot service', async () => {
  const state = tmp('agentlab-hard-reap-');
  const live = bystander();
  const reused = bystander();
  const oneshotMarker = join(state, 'stop-ran');
  const real = identify(live.pid);
  const fake = { ...identify(reused.pid), startTime: '12345' };

  // Owner alive (this process): even a verified service identity is not signalled.
  recordOwnership(state, 's-alive', [{ name: 'web', owned: true, mode: 'process', pid: live.pid, identity: real }]);
  // Owner gone: a reused pid is not signalled; a one-shot's stop command is named, not run.
  writeRecord(state, 's-dead', deadOwner, [
    { name: 'cache', owned: true, mode: 'oneshot', stopCommand: `touch ${oneshotMarker}`, cwd: state },
    { name: 'web', owned: true, mode: 'process', pid: reused.pid, identity: fake },
  ]);
  const notes = await reapOrphans(state);
  assert.ok(notes.some((n) => /now belongs to another process; not signalled/.test(n)), notes.join('\n'));
  assert.ok(notes.some((n) => n.includes(`touch ${oneshotMarker}`) && /to stop it, run/.test(n)));
  assert.ok(alive(reused.pid), 'a reused pid must survive');
  assert.ok(alive(live.pid), 'a live owner’s service must survive');
  assert.equal(existsSync(oneshotMarker), false, 'the stop command was not run');
  assert.deepEqual(readdirSync(join(state, 'owned')), ['s-alive.json'], 'the dead owner’s record is removed, the live one kept');
  assert.deepEqual([...liveSessionIds(state)], ['s-alive']);

  // Owner gone and the identity still matches: the group is stopped.
  writeRecord(state, 's-dead2', deadOwner, [{ name: 'web', owned: true, mode: 'process', pid: live.pid, identity: real }]);
  await reapOrphans(state);
  for (let i = 0; i < 50 && alive(live.pid); i++) await sleep(50);
  assert.equal(alive(live.pid), false, 'a verified orphan is stopped');
});

// ---------- 4. server and tab crash ----------

test('a required service that exits after it was ready ends the session; the other services are stopped', async () => {
  const dir = tmp('agentlab-hard-exit-');
  writeFileSync(join(dir, 'serve.mjs'), `
import { createServer } from 'node:http';
const port = Number(process.env.PORT);
createServer((q, s) => s.end('<!doctype html><title>t</title><h1>Up</h1><button>Go</button>')).listen(port, '127.0.0.1', () => {
  if (process.env.EXIT_AFTER) setTimeout(() => { console.log('token=hunter2secret dying'); process.exit(3); }, Number(process.env.EXIT_AFTER));
});
`);
  const profile = (required) => ({
    schemaVersion: 2, name: 'exit', app: { service: 'web' }, startPath: '/',
    services: {
      web: { command: 'node serve.mjs', cwd: '.', url: 'http://127.0.0.1:5368', env: { PORT: '5368' }, readiness: { path: '/', status: 200, timeoutMs: 15000 } },
      api: { command: 'node serve.mjs', cwd: '.', url: 'http://127.0.0.1:5367', env: { PORT: '5367', EXIT_AFTER: '3000' }, required, readiness: { path: '/', status: 200, timeoutMs: 15000 } },
    },
  });
  writeFileSync(join(dir, 'agentlab.json'), JSON.stringify(profile(true)));
  const lines = [];
  const lab = new Lab({ stateDir: tmp('agentlab-hard-state-'), onEvent: (e) => { if (e.kind === 'server-log') lines.push(e.line); } });
  try {
    await lab.start({ project: dir, headed: false });
    assert.equal(lab.active, true);
    for (let i = 0; i < 100 && lab.active; i++) await sleep(100);
    assert.equal(lab.active, false, 'the session ended');
    const reason = 'service "api" exited unexpectedly (code 3)';
    assert.equal(lab.status().endedReason, reason);
    await assert.rejects(() => lab.observe(), (err) => err.code === 'browser_closed' && err.message.includes(reason));
    assert.ok(lines.some((l) => l.includes(reason)));
    const afterReason = lines.slice(lines.findIndex((l) => l.includes(reason)) + 1);
    assert.ok(afterReason.some((l) => l.includes('dying')), 'the last output is reported with the exit');
    assert.ok(!afterReason.some((l) => l.includes('hunter2secret')), 'the reported tail is redacted');
    assert.equal(await waitPort(5368, false), true, 'the other service was stopped');
  } finally {
    await lab.close();
  }

  // An optional service that exits only produces the log line.
  writeFileSync(join(dir, 'agentlab.json'), JSON.stringify(profile(false)));
  lines.length = 0;
  const lab2 = new Lab({ stateDir: tmp('agentlab-hard-state-'), onEvent: (e) => { if (e.kind === 'server-log') lines.push(e.line); } });
  try {
    await lab2.start({ project: dir, headed: false });
    for (let i = 0; i < 60 && !lines.some((l) => l.includes('exited unexpectedly')); i++) await sleep(100);
    assert.ok(lines.some((l) => /service "api" exited unexpectedly \(code 3\); it is optional/.test(l)), lines.join('\n'));
    assert.equal(lab2.active, true);
    assert.ok((await lab2.observe()).headings.length >= 1);
  } finally {
    await lab2.close();
  }
  assert.equal(await waitPort(5368, false), true);
});

test('a crashed browser tab ends the session and stops the services', async () => {
  const lab = new Lab({ stateDir: tmp('agentlab-hard-state-') });
  try {
    await lab.start({ project: project(5367), headed: false });
    // Chromium's own crash page kills the renderer of this tab.
    await lab.activePage.goto('chrome://crash').catch(() => undefined);
    for (let i = 0; i < 100 && lab.active; i++) await sleep(100);
    assert.equal(lab.active, false);
    assert.equal(lab.status().endedReason, 'browser tab crashed');
    await assert.rejects(() => lab.observe(), (err) => err.code === 'browser_closed' && err.message.includes('browser tab crashed'));
    assert.equal(await waitPort(5367, false), true, 'services stopped');
  } finally {
    await lab.close();
  }
});

// ---------- 5. retention ----------

test('history keeps the first step and the latest 200 with one omitted line', () => {
  const h = [];
  for (let i = 0; i < 500; i++) appendStep(h, i === 0 ? 'open /' : `step ${i}`);
  assert.equal(h.length, 202);
  assert.equal(h[0], 'open /');
  assert.equal(h[1], '… 299 earlier steps omitted');
  assert.equal(h[2], 'step 300');
  assert.equal(h.at(-1), 'step 499');
  const small = ['open /'];
  for (let i = 1; i < 50; i++) appendStep(small, `step ${i}`);
  assert.equal(small.length, 50, 'nothing omitted below the cap');
});

test('capped event lists keep true totals and report only what they still hold', () => {
  const list = [];
  let total = 0;
  const add = (x) => { total++; pushCapped(list, x, 500); };
  for (let i = 0; i < 10; i++) add(i);
  const mark = total;
  for (let i = 10; i < 700; i++) add(i);
  assert.equal(total, 700);
  assert.equal(list.length, 500);
  assert.equal(list[0], 200);
  assert.deepEqual(since(list, total, mark), list, 'more new entries than the cap: all that remain');
  assert.deepEqual(since(list, total, 698), [698, 699]);
  assert.deepEqual(since(list, total, total), []);
});

test('the finding store keeps what it has, counts new findings past its cap, and still updates known ones', () => {
  const store = new FindingStore('mobile-390', 2);
  const control = (n) => ({ ref: `e${n}`, role: 'button', name: `Button ${n}`, rect: { x: 400, y: 10, w: 100, h: 44 }, clip: { side: 'right', px: 60 } });
  const obs = (n, gen) => ({
    route: '/r', gen, viewport: { width: 390, height: 844 }, documentWidth: 390, controls: [control(n)],
    layout: [{ kind: 'control-clipped', severity: 'high', key: `c${n}`, ref: `e${n}`, message: `button ${n} clipped`, evidence: { pastEdgePx: 60 } }],
  });
  assert.equal(store.recordObservation(obs(1, 1), []).length, 1);
  assert.equal(store.recordObservation(obs(2, 2), []).length, 1);
  assert.equal(store.recordObservation(obs(3, 3), []).length, 0, 'not kept, not reported as new');
  assert.equal(store.recordObservation(obs(4, 4), []).length, 0);
  assert.equal(store.size, 2);
  assert.equal(store.omitted, 2);
  assert.deepEqual(store.list().map((f) => f.target.name), ['Button 1', 'Button 2'], 'earlier findings survive');
  assert.equal(store.recordObservation(obs(1, 5), []).length, 0);
  assert.equal(store.get('F1').occurrences, 2, 'a known finding still updates');
  assert.equal(store.omitted, 2);
});

test('the runs directory is pruned to the latest N, never a protected run, and 0 keeps everything', () => {
  const state = tmp('agentlab-hard-prune-');
  const names = Array.from({ length: 25 }, (_, i) => `s-2026010100${String(i).padStart(4, '0')}-abcd`);
  for (const n of names) mkdirSync(join(state, 'runs', n), { recursive: true });
  assert.deepEqual(pruneRuns(state, 0, new Set()), []);
  assert.equal(readdirSync(join(state, 'runs')).length, 25);
  const removed = pruneRuns(state, 20, new Set([names[0]]));
  assert.deepEqual(removed, names.slice(1, 5), 'the five oldest, except the protected one');
  assert.deepEqual(readdirSync(join(state, 'runs')).sort(), [names[0], ...names.slice(5)]);
  assert.equal(keepRuns({}), 20);
  assert.equal(keepRuns({ AGENTLAB_KEEP_RUNS: '0' }), 0);
  assert.equal(keepRuns({ AGENTLAB_KEEP_RUNS: '7' }), 7);
  assert.equal(keepRuns({ AGENTLAB_KEEP_RUNS: 'x' }), 20);
});

test('a page that logs hundreds of console errors keeps exact counters and a bounded list', async () => {
  const dir = project(5367, { script: `
import { createServer } from 'node:http';
createServer((q, s) => s.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>t</title><h1>Noisy</h1><button style="min-height:44px;margin-top:16px" onclick="for (let i = 0; i < 600; i++) console.error(\\'boom \\' + i)">Spam</button>'))
  .listen(5367, '127.0.0.1');
` });
  const lab = new Lab({ stateDir: tmp('agentlab-hard-state-') });
  try {
    await lab.start({ project: dir, headed: false });
    const r = await lab.act({ action: 'click', ref: lab.findRef({ role: 'button', name: 'Spam' }) });
    assert.equal(r.outcome, 'success', JSON.stringify(r.error));
    assert.equal(r.observation.console.errors, 600, 'the counter is the true total');
    assert.equal(r.newConsoleErrors.length, 500, 'the list is bounded to the latest 500');
    assert.equal(r.newConsoleErrors.at(-1).text, 'boom 599');
    assert.equal((await lab.observe()).console.errors, 600);
  } finally {
    await lab.close();
  }
});

// ---------- 6. signals ----------

test('SIGTERM during scan --project stops the services, releases the port and exits 143', async () => {
  const proj = project(5368);
  const home = tmp('agentlab-hard-sig-');
  const child = spawn(process.execPath, ['bin/agentlab.js', 'scan', '--project', proj, '--devices', 'mobile-390'], {
    env: { ...process.env, AGENTLAB_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  assert.equal(await waitPort(5368, true), true, 'the service started');
  child.kill('SIGTERM');
  const result = await Promise.race([exited, sleep(60_000).then(() => 'timeout')]);
  if (result === 'timeout') child.kill('SIGKILL');
  assert.deepEqual(result, { code: 143, signal: null }, output);
  assert.equal(await waitPort(5368, false, 10_000), true, 'port released');
  assert.deepEqual(existsSync(join(home, 'owned')) ? readdirSync(join(home, 'owned')) : [], [], 'ownership released');
});
