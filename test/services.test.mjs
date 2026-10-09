// Profile v2 and the multi-service lifecycle: dependency order, reuse, owned-only stop, startup
// failure and abort, missing env, graceful shutdown, one-shot services, the Lab and crash recovery.
// Ports 5341 and 5342 (the multi-service example) and 5343–5345.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadProfile, parseProfile, startOrder } from '../dist/core/profile.js';
import { ServiceGroup } from '../dist/core/services.js';
import { Lab } from '../dist/core/lab.js';

const run = promisify(execFile);
const EX = resolve('examples/multi-service');
const TOKEN = 'test-token-for-services';
const savedToken = process.env.DEMO_API_TOKEN;
process.env.DEMO_API_TOKEN = TOKEN;

const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const children = [];
after(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  if (savedToken === undefined) delete process.env.DEMO_API_TOKEN; else process.env.DEMO_API_TOKEN = savedToken;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const listening = (port) => new Promise((res) => {
  const s = connect({ host: '127.0.0.1', port });
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => res(false));
});
async function assertFree(...ports) {
  for (const port of ports) {
    let busy = true;
    for (let i = 0; i < 50 && busy; i++) { busy = await listening(port); if (busy) await sleep(100); }
    assert.equal(busy, false, `port ${port} should be free`);
  }
}
async function health(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); await r.body?.cancel(); return r.status; } catch { return 0; }
}
async function waitHealthy(url, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await health(url) === 200) return; await sleep(100); }
  throw new Error(`${url} not healthy`);
}
/** A process the test itself owns (not the lab). */
function own(file, port, extra = {}) {
  const c = spawn(process.execPath, [file], { cwd: EX, env: { ...process.env, PORT: String(port), ...extra }, stdio: 'ignore' });
  children.push(c);
  return c;
}
async function killOwn(c) {
  if (c.exitCode !== null || c.signalCode !== null) return;
  const done = new Promise((r) => c.once('exit', r));
  c.kill('SIGKILL');
  await done;
}
/** A schemaVersion 2 profile in a temp dir. */
async function tempProfile(services, extra = {}) {
  const dir = tmp('agentlab-svc-profile-');
  writeFileSync(join(dir, 'agentlab.json'), JSON.stringify({ schemaVersion: 2, name: 'tmp', services, ...extra }));
  return loadProfile(dir);
}
const api = (port = 5341, extra = {}) => ({
  command: `node ${join(EX, 'api/server.mjs')}`, url: `http://127.0.0.1:${port}`, env: { PORT: String(port) },
  requiredEnv: ['DEMO_API_TOKEN'], readiness: { path: '/health', timeoutMs: 20000 }, ...extra,
});
const web = (extra = {}) => ({
  command: `node ${join(EX, 'web/server.mjs')}`, url: 'http://127.0.0.1:5342', env: { PORT: '5342', API_URL: 'http://127.0.0.1:5341' },
  requiredEnv: ['DEMO_API_TOKEN'], readiness: { path: '/health', timeoutMs: 20000 }, dependsOn: ['api'], ...extra,
});

// ---------- 1. parsing ----------

const P = '/proj/agentlab.json';
const v2 = (services, extra = {}) => parseProfile({ schemaVersion: 2, services, ...extra }, P);
const problems = (fn) => { try { fn(); } catch (err) { assert.equal(err.code, 'invalid_profile'); return err.details.problems.join('\n'); } assert.fail('expected invalid_profile'); };

test('parseProfile v2: readiness forms and oneshot default', () => {
  const p = v2({
    web: { command: 'a', url: 'http://127.0.0.1:5342/', readiness: { path: '/health' } },
    abs: { command: 'b', readiness: { url: 'http://127.0.0.1:9000/ready?x=1', status: 204 } },
    tcp: { command: 'c', readiness: { tcp: '127.0.0.1:6379', timeoutMs: 5000 } },
    log: { command: 'd', readiness: { log: 'ready' } },
    alive: { command: 'e', readiness: { alive: 1500 } },
    once: { command: 'f', mode: 'oneshot' },
    plain: { command: 'g', url: 'http://127.0.0.1:5343' },
  });
  const r = Object.fromEntries(p.services.map((s) => [s.name, s.readiness]));
  assert.deepEqual(r.web, { kind: 'http', url: 'http://127.0.0.1:5342', path: '/health', status: 200, timeoutMs: 60000, intervalMs: 250 });
  assert.deepEqual(r.abs, { kind: 'http', url: 'http://127.0.0.1:9000', path: '/ready?x=1', status: 204, timeoutMs: 60000, intervalMs: 250 });
  assert.deepEqual(r.tcp, { kind: 'tcp', host: '127.0.0.1', port: 6379, timeoutMs: 5000, intervalMs: 250 });
  assert.deepEqual(r.log, { kind: 'log', pattern: 'ready', timeoutMs: 60000 });
  assert.deepEqual(r.alive, { kind: 'alive', ms: 1500 });
  assert.deepEqual(r.once, { kind: 'exit', timeoutMs: 60000 });
  assert.deepEqual(r.plain, { kind: 'http', url: 'http://127.0.0.1:5343', path: '/', status: 200, timeoutMs: 60000, intervalMs: 250 });
  assert.equal(p.services.find((s) => s.name === 'once').mode, 'oneshot');
});

test('parseProfile v2: invalid services, dependencies and cycles are problems', () => {
  assert.match(problems(() => v2({ worker: { command: 'x' } })), /"services\.worker" has no url, so it needs a readiness check/);
  assert.match(problems(() => v2({ web: { command: 'x', url: 'http://127.0.0.1:1', dependsOn: ['db'] } })), /depends on unknown service "db"/);
  assert.match(problems(() => v2({ web: { command: 'x', url: 'http://127.0.0.1:1', dependsOn: ['web'] } })), /"web" depends on itself/);
  const cycle = problems(() => v2({
    web: { command: 'x', url: 'http://127.0.0.1:1', dependsOn: ['a'] },
    a: { command: 'x', readiness: { alive: 1 }, dependsOn: ['b'] },
    b: { command: 'x', readiness: { alive: 1 }, dependsOn: ['a'] },
  }));
  assert.match(cycle, /dependency cycle: .*a → b → a/);
  assert.match(problems(() => v2({ web: { command: 'x', url: 'http://127.0.0.1:1' } }, { uploads: { allow: ['../x'] } })), /"uploads.allow" entry "\.\.\/x" must be inside the project/);
  assert.match(problems(() => v2({ web: { command: 'x', url: 'http://127.0.0.1:1', shutdown: { command: 'stop-it' } } })), /shutdown\.command" is only for mode "oneshot"/);
});

test('parseProfile v2: the app defaults to "web", else the only service with a url', () => {
  const both = { api: { command: 'a', url: 'http://127.0.0.1:1' }, web: { command: 'w', url: 'http://127.0.0.1:2' } };
  assert.deepEqual(v2(both).app, { url: 'http://127.0.0.1:2', service: 'web' });
  assert.deepEqual(v2({ api: { command: 'a', url: 'http://127.0.0.1:1' }, worker: { command: 'w', readiness: { log: 'x' } } }).app,
    { url: 'http://127.0.0.1:1', service: 'api' });
  assert.match(problems(() => v2({ api: { command: 'a', url: 'http://127.0.0.1:1' }, ui: { command: 'u', url: 'http://127.0.0.1:2' } })), /set "app"/);
  // An app URL no declared service serves: used as given, with no service.
  assert.deepEqual(v2(both, { app: { url: 'http://127.0.0.1:9/' } }).app, { url: 'http://127.0.0.1:9' });
  assert.deepEqual(v2(both, { app: { url: 'http://127.0.0.1:1' } }).app, { url: 'http://127.0.0.1:1', service: 'api' });
  assert.match(problems(() => v2(both, { app: { service: 'nope' } })), /unknown service "nope"/);
});

test('schemaVersion 1 profiles still produce web and one service named "web"', () => {
  const p = parseProfile({ schemaVersion: 1, name: 'x', web: { command: 'npm run dev', url: 'http://127.0.0.1:5173/' } }, '/repo/app/agentlab.json');
  assert.deepEqual(p.web, {
    command: 'npm run dev', cwd: '/repo/app', url: 'http://127.0.0.1:5173', env: {},
    readiness: { path: '/', status: 200, timeoutMs: 60000, intervalMs: 250 }, reuseExisting: true,
  });
  assert.equal(p.services.length, 1);
  assert.equal(p.services[0].name, 'web');
  assert.equal(p.services[0].url, 'http://127.0.0.1:5173');
  assert.deepEqual(p.app, { url: 'http://127.0.0.1:5173', service: 'web' });
});

test('startOrder puts dependencies first and keeps declaration order otherwise', () => {
  assert.deepEqual(startOrder([
    { name: 'web', dependsOn: ['api'] }, { name: 'docs', dependsOn: [] }, { name: 'api', dependsOn: ['db'] }, { name: 'db', dependsOn: [] }, { name: 'z', dependsOn: [] },
  ]), ['db', 'api', 'web', 'docs', 'z']);
  assert.throws(() => startOrder([{ name: 'a', dependsOn: ['b'] }, { name: 'b', dependsOn: ['a'] }]), /cycle: a → b → a/);
});

// ---------- 2–10. ServiceGroup ----------

test('cold start of the example: api first, all owned; stop is dependents first and frees the ports', async () => {
  const profile = await loadProfile('examples/multi-service/agentlab.json');
  const runDir = tmp('agentlab-svc-run-');
  const group = await ServiceGroup.start(profile.services, { runDir });
  try {
    const infos = group.infos();
    assert.equal(infos.length, 3);
    for (const i of infos) { assert.equal(i.owned, true, i.name); assert.equal(i.status, 'started', i.name); }
    const order = infos.map((i) => i.name);
    assert.equal(order[0], 'api');
    assert.deepEqual([...order].sort(), ['api', 'web', 'worker']);
    for (const s of group.services) {
      assert.equal(typeof s.identity?.pid, 'number', `${s.spec.name} identity pid`);
      assert.ok(s.identity.startTime, `${s.spec.name} identity startTime`);
      assert.equal(s.identity.pid, s.info.pid);
    }
    assert.equal(await health('http://127.0.0.1:5342/health'), 200);
  } finally {
    const stopped = await group.stop();
    const names = stopped.map((s) => s.name);
    assert.equal(names.at(-1), 'api', `stop order ${names.join(',')}`);
    for (const s of stopped) assert.equal(s.stopped, true, `${s.name}: ${s.detail}`);
  }
  await assertFree(5341, 5342);
  await sleep(100);
  assert.match(readFileSync(join(runDir, 'worker.log'), 'utf8'), /worker: shutting down/);
});

test('partial reuse: an api the test started is reused and left running', async () => {
  const mine = own('api/server.mjs', 5341);
  await waitHealthy('http://127.0.0.1:5341/health');
  try {
    const profile = await loadProfile('examples/multi-service/agentlab.json');
    const group = await ServiceGroup.start(profile.services, { runDir: tmp('agentlab-svc-run-') });
    const by = Object.fromEntries(group.infos().map((i) => [i.name, i]));
    assert.equal(by.api.status, 'reused');
    assert.equal(by.api.owned, false);
    assert.equal(by.api.pid, undefined);
    assert.equal(by.worker.status, 'started');
    assert.equal(by.web.status, 'started');
    const stopped = await group.stop();
    assert.equal(stopped.find((s) => s.name === 'api').stopped, false);
    assert.equal(await health('http://127.0.0.1:5341/health'), 200, 'the reused api still answers');
    assert.ok(alive(mine.pid));
    await assertFree(5342);
  } finally {
    await killOwn(mine);
  }
  await assertFree(5341);
});

test('complete reuse: nothing is owned and stop leaves both running', async () => {
  const myApi = own('api/server.mjs', 5341);
  const myWeb = own('web/server.mjs', 5342, { API_URL: 'http://127.0.0.1:5341' });
  try {
    await waitHealthy('http://127.0.0.1:5341/health');
    await waitHealthy('http://127.0.0.1:5342/health');
    const profile = await tempProfile({ api: api(), web: web() });
    const group = await ServiceGroup.start(profile.services, { runDir: tmp('agentlab-svc-run-') });
    for (const i of group.infos()) { assert.equal(i.status, 'reused', i.name); assert.equal(i.owned, false, i.name); }
    const stopped = await group.stop();
    for (const s of stopped) assert.equal(s.stopped, false, s.name);
    assert.equal(await health('http://127.0.0.1:5341/health'), 200);
    assert.equal(await health('http://127.0.0.1:5342/health'), 200);
  } finally {
    await killOwn(myWeb);
    await killOwn(myApi);
  }
  await assertFree(5341, 5342);
});

test('startup failure: the crashing api is named, its dependents are skipped', async () => {
  const profile = await loadProfile('examples/multi-service/broken.agentlab.json');
  await assert.rejects(ServiceGroup.start(profile.services, { runDir: tmp('agentlab-svc-run-') }), (err) => {
    assert.equal(err.code, 'startup_failed');
    assert.match(err.message, /service "api"/);
    assert.ok(err.details.logTail.some((l) => l.includes('simulated startup crash')), JSON.stringify(err.details.logTail));
    const by = Object.fromEntries(err.details.services.map((s) => [s.name, s]));
    assert.equal(by.api.status, 'failed');
    assert.equal(by.worker.status, 'skipped');
    assert.equal(by.web.status, 'skipped');
    return true;
  });
  await assertFree(5341, 5342);
});

test('failure after a sibling started: the started api is stopped and reported', async () => {
  const profile = await tempProfile({
    api: api(5343),
    web: { command: `node -e "console.error('boom'); process.exit(4)"`, url: 'http://127.0.0.1:5344', dependsOn: ['api'] },
  }, { app: { service: 'web' } });
  await assert.rejects(ServiceGroup.start(profile.services, { runDir: tmp('agentlab-svc-run-') }), (err) => {
    assert.equal(err.code, 'startup_failed');
    assert.match(err.message, /service "web"/);
    const by = Object.fromEntries(err.details.services.map((s) => [s.name, s]));
    assert.equal(by.web.status, 'failed');
    assert.equal(by.api.status, 'ready');
    assert.equal(typeof by.api.stopped, 'string', JSON.stringify(by.api));
    return true;
  });
  await assertFree(5343);
});

test('a failure aborts an independent service still starting and stops its process', async () => {
  const profile = await tempProfile({
    slow: { command: `node -e "console.log('pid=' + process.pid); setInterval(() => {}, 1000)"`, readiness: { alive: 20000 } },
    crash: { command: `node -e "setTimeout(() => process.exit(1), 500)"`, readiness: { alive: 5000 } },
  }, { app: { url: 'http://127.0.0.1:5345' } });
  const lines = [];
  const t0 = Date.now();
  await assert.rejects(ServiceGroup.start(profile.services, { runDir: tmp('agentlab-svc-run-'), onLog: (s, l) => lines.push(`${s} ${l}`) }), (err) => {
    assert.equal(err.code, 'startup_failed');
    assert.match(err.message, /service "crash"/);
    const by = Object.fromEntries(err.details.services.map((s) => [s.name, s]));
    assert.equal(by.slow.status, 'aborted');
    return true;
  });
  assert.ok(Date.now() - t0 < 5000, `rejected after ${Date.now() - t0}ms`);
  const pid = Number(/slow pid=(\d+)/.exec(lines.join('\n'))?.[1]);
  assert.ok(pid > 0, `slow service printed its pid: ${lines.join(' | ')}`);
  await sleep(100);
  assert.equal(alive(pid), false, `slow service pid ${pid} is gone`);
});

test('missing env is reported by name before anything starts, never with values', async () => {
  const profile = await loadProfile('examples/multi-service/agentlab.json');
  profile.services[0].requiredEnv.push('AGENTLAB_TEST_SENTINEL');
  const sentinel = 'sentinel-value-must-not-leak-9f3';
  delete process.env.DEMO_API_TOKEN;
  process.env.AGENTLAB_TEST_SENTINEL = sentinel;
  try {
    await assert.rejects(ServiceGroup.start(profile.services, { runDir: tmp('agentlab-svc-run-') }), (err) => {
      assert.equal(err.code, 'missing_env');
      const by = Object.fromEntries(err.details.missing.map((m) => [m.service, m.names]));
      assert.deepEqual(by, { api: ['DEMO_API_TOKEN'], worker: ['DEMO_API_TOKEN'], web: ['DEMO_API_TOKEN'] });
      assert.ok(!JSON.stringify(err.toJSON()).includes(sentinel));
      assert.ok(!JSON.stringify(err.toJSON()).includes(TOKEN));
      return true;
    });
  } finally {
    process.env.DEMO_API_TOKEN = TOKEN;
    delete process.env.AGENTLAB_TEST_SENTINEL;
  }
  await assertFree(5341, 5342);
});

test('shutdown.graceMs: a service that ignores SIGTERM is killed after the grace period', async () => {
  const profile = await tempProfile({ api: api(), web: web({ env: { PORT: '5342', API_URL: 'http://127.0.0.1:5341', WEB_SLOW_SHUTDOWN: '1' }, shutdown: { graceMs: 500 } }) });
  const group = await ServiceGroup.start(profile.services, { runDir: tmp('agentlab-svc-run-') });
  const stopped = await group.stop();
  assert.match(stopped.find((s) => s.name === 'web').detail, /SIGKILL after 500ms/);
  assert.equal(stopped.find((s) => s.name === 'api').detail, 'SIGTERM');
  await assertFree(5341, 5342);
});

test('one-shot service: started and stopped by its commands; a running one is reused and never stopped', async () => {
  const dir = tmp('agentlab-svc-oneshot-');
  writeFileSync(join(dir, 'server.mjs'), `
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
createServer((s) => s.end()).listen(5345, '127.0.0.1', () => writeFileSync(new URL('./server.pid', import.meta.url), String(process.pid)));
`);
  writeFileSync(join(dir, 'up.mjs'), `
import { spawn } from 'node:child_process';
spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], { detached: true, stdio: 'ignore' }).unref();
`);
  writeFileSync(join(dir, 'down.mjs'), `
import { readFileSync } from 'node:fs';
process.kill(Number(readFileSync(new URL('./server.pid', import.meta.url), 'utf8')), 'SIGTERM');
`);
  writeFileSync(join(dir, 'agentlab.json'), JSON.stringify({
    schemaVersion: 2, name: 'oneshot',
    services: { cache: { command: 'node up.mjs', mode: 'oneshot', readiness: { tcp: '127.0.0.1:5345', timeoutMs: 10000 }, shutdown: { command: 'node down.mjs' } } },
    app: { url: 'http://127.0.0.1:5345' },
  }));
  const profile = await loadProfile(dir);

  const group = await ServiceGroup.start(profile.services, { runDir: tmp('agentlab-svc-run-') });
  const [info] = group.infos();
  assert.equal(info.owned, true);
  assert.equal(info.status, 'started');
  assert.equal(info.pid, undefined);
  const [stop] = await group.stop();
  assert.equal(stop.stopped, true, stop.detail);
  await assertFree(5345);

  // Already running: reused, and the stop command is not run.
  rmSync(join(dir, 'server.pid'), { force: true });
  const mine = spawn(process.execPath, [join(dir, 'server.mjs')], { stdio: 'ignore' });
  children.push(mine);
  try {
    for (let i = 0; i < 50 && !(await listening(5345)); i++) await sleep(100);
    const again = await ServiceGroup.start(profile.services, { runDir: tmp('agentlab-svc-run-') });
    assert.equal(again.infos()[0].status, 'reused');
    assert.equal(again.infos()[0].owned, false);
    const [s] = await again.stop();
    assert.equal(s.stopped, false);
    await sleep(300);
    assert.ok(await listening(5345), 'the reused server is still up');
    assert.ok(alive(mine.pid));
  } finally {
    await killOwn(mine);
  }
  await assertFree(5345);
});

// ---------- 11. Lab ----------

test('Lab start and close with the multi-service example (headless)', async () => {
  const lab = new Lab({ stateDir: tmp('agentlab-svc-state-') });
  let closed;
  try {
    const start = await lab.start({ project: 'examples/multi-service', headed: false });
    assert.equal(start.services.length, 3);
    assert.equal(start.server.url, 'http://127.0.0.1:5342');
    assert.equal(start.server.owned, true);
    assert.ok(start.observation.headings.some((h) => /Tasks/.test(h)), JSON.stringify(start.observation.headings));
  } finally {
    closed = await lab.close();
  }
  assert.equal(closed.services.length, 3);
  for (const s of closed.services) assert.equal(s.stopped, true, `${s.name}: ${s.detail}`);
  assert.equal(closed.server.stopped, true);
  await assertFree(5341, 5342);
});

// ---------- 12. crash recovery through the CLI ----------

test('after the daemon is killed, stop cleans up the owned services by process group', async () => {
  const home = tmp('agentlab-svc-home-');
  const env = { ...process.env, AGENTLAB_HOME: home, DEMO_API_TOKEN: TOKEN };
  const cli = async (...args) => {
    try {
      const { stdout, stderr } = await run(process.execPath, ['bin/agentlab.js', ...args], { env, timeout: 120_000 });
      return { code: 0, out: stdout + stderr };
    } catch (err) {
      return { code: err.code, out: (err.stdout ?? '') + (err.stderr ?? '') };
    }
  };
  const start = await cli('start', '--headless', '--no-ui', '--project', 'examples/multi-service');
  assert.equal(start.code, 0, start.out);
  const state = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8'));
  assert.equal(state.services?.length, 3, JSON.stringify(state.services));
  for (const s of state.services) {
    assert.equal(s.owned, true, s.name);
    assert.ok(s.identity?.pid && s.identity.startTime, `${s.name} has an identity`);
  }
  // Only the daemon: its services (own process groups) and Chromium are left behind. Chromium is not
  // tracked here; it normally exits when its pipe to the dead daemon closes.
  process.kill(state.pid, 'SIGKILL');
  for (let i = 0; i < 50 && alive(state.pid); i++) await sleep(100);
  const stop = await cli('stop');
  assert.equal(stop.code, 0, stop.out);
  assert.match(stop.out, /had already exited/);
  // web writes nothing unprompted, so it is still running and is stopped by process group. api and
  // worker log continuously; with the daemon (the reader of their stdout pipe) gone they may already
  // have died of EPIPE, which recovery reports as "had already exited".
  assert.match(stop.out, /stopped owned service "web" process group \d+/);
  for (const name of ['api', 'worker']) {
    assert.match(stop.out, new RegExp(`(stopped owned service "${name}" process group \\d+|owned service "${name}" had already exited)`));
  }
  await assertFree(5341, 5342);
  assert.equal(existsSync(join(home, 'daemon.json')), false);
});
