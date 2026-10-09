// A service's shell wrapper (the process-group leader) dying while the real server survives: the lab
// stops the server by the identity recorded for it, and only that. Port 5396.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Lab } from '../dist/core/lab.js';
import { readOwnership, reapOrphans, stopRecordedServices } from '../dist/core/ownership.js';

const PORT = 5396;
const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const pids = [];
after(() => {
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return !readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z'); } catch { return false; } };
const listening = (port) => new Promise((res) => {
  const s = connect({ host: '127.0.0.1', port });
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => res(false));
});
async function portFree(port, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!(await listening(port))) return true; await sleep(100); }
  return false;
}
async function until(fn, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(100); }
  return false;
}
const comm = (pid) => readFileSync(`/proc/${pid}/comm`, 'utf8').trim();

/** `; exit 0` keeps the shell as the process-group leader and the server as its child. */
function project() {
  const dir = tmp('agentlab-pg-proj-');
  writeFileSync(join(dir, 'server.mjs'), `
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
createServer((req, res) => {
  if (req.url === '/spawn') {
    const c = spawn('sleep', ['301'], { stdio: 'ignore' });
    return res.end(String(c.pid));
  }
  res.writeHead(200, { 'content-type': 'text/html' })
    .end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>t</title><h1>Hello</h1><button>Go</button>');
}).listen(${PORT}, '127.0.0.1');
`);
  writeFileSync(join(dir, 'agentlab.json'), JSON.stringify({
    schemaVersion: 1, name: 'pg', web: { command: 'node server.mjs; exit 0', url: `http://127.0.0.1:${PORT}`, readiness: { path: '/', timeoutMs: 20000 } },
  }));
  return dir;
}

test('the wrapper is killed in a running session: the session ends and the surviving server is stopped', async () => {
  const lab = new Lab({ stateDir: tmp('agentlab-pg-state-') });
  try {
    await lab.start({ project: project(), headed: false });
    const [rec] = lab.serviceRecords();
    const leader = rec.identity.pid;
    assert.match(comm(leader), /sh$/, 'the leader is the shell wrapper');
    assert.ok(rec.members?.length >= 1, JSON.stringify(rec));
    const server = rec.members.find((m) => /server\.mjs/.test(m.command));
    assert.ok(server, `the server is recorded as a member: ${JSON.stringify(rec.members)}`);
    pids.push(server.pid);
    process.kill(leader, 'SIGKILL');
    assert.equal(await until(() => !lab.active), true, 'the session ended');
    assert.match(lab.status().endedReason, /exited unexpectedly/);
    assert.equal(await portFree(PORT), true, 'the port was freed');
    assert.equal(alive(server.pid), false, 'the server process is gone');
  } finally {
    const closed = await lab.close();
    const detail = closed.services[0].detail;
    assert.match(detail, /stopped recorded member node server\.mjs/, detail);
    assert.equal(closed.services[0].stopped, true, detail);
  }
});

/** A child process that runs a Lab and prints its service records, so the test can crash it. */
async function labProcess(stateDir, dir) {
  const script = join(tmp('agentlab-pg-script-'), 'lab.mjs');
  writeFileSync(script, `
import { Lab } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/core/lab.js')).href)};
const lab = new Lab({ stateDir: ${JSON.stringify(stateDir)} });
await lab.start({ project: ${JSON.stringify(dir)}, headed: false });
console.log('RECORDS ' + JSON.stringify(lab.serviceRecords()));
setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  pids.push(child.pid);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  assert.equal(await until(() => out.includes('RECORDS '), 60_000), true, 'the lab started');
  const records = JSON.parse(out.split('RECORDS ')[1].split('\n')[0]);
  return { child, record: records[0] };
}

async function crash(child, leader) {
  const exited = new Promise((r) => child.once('exit', r));
  process.kill(child.pid, 'SIGKILL');
  process.kill(leader, 'SIGKILL');
  await exited;
  assert.equal(await until(() => !alive(leader)), true, 'the leader is gone');
}

test('the lab and the wrapper are both SIGKILLed: reapOrphans stops the recorded server by identity', async () => {
  const stateDir = tmp('agentlab-pg-state-');
  const { child, record } = await labProcess(stateDir, project());
  const server = record.members.find((m) => /server\.mjs/.test(m.command));
  assert.ok(server);
  pids.push(server.pid);
  await crash(child, record.identity.pid);
  assert.equal(await listening(PORT), true, 'the orphaned server still holds the port');
  assert.equal(readOwnership(stateDir).length, 1);
  const notes = await reapOrphans(stateDir);
  assert.match(notes.join('\n'), /had already exited; stopped recorded member node server\.mjs/, notes.join('\n'));
  assert.equal(await portFree(PORT), true, 'the port was freed');
  assert.equal(readOwnership(stateDir).length, 0, 'the record is released');
});

test('a process in the group that was never recorded is reported, not signalled', async () => {
  const stateDir = tmp('agentlab-pg-state-');
  const { child, record } = await labProcess(stateDir, project());
  const server = record.members.find((m) => /server\.mjs/.test(m.command));
  pids.push(server.pid);
  // Spawned after the snapshot was taken, into the same process group.
  const later = Number(await (await fetch(`http://127.0.0.1:${PORT}/spawn`)).text());
  pids.push(later);
  assert.equal(record.members.some((m) => m.pid === later), false, "not part of the snapshot");
  await crash(child, record.identity.pid);
  const notes = (await reapOrphans(stateDir)).join('\n');
  assert.match(notes, /stopped recorded member node server\.mjs/, notes);
  assert.match(notes, new RegExp(`1 process remains in the group unverified and was not signalled: sleep 301 \\(pid ${later}\\)`), notes);
  assert.equal(await portFree(PORT), true);
  assert.equal(alive(later), true, 'the unrecorded process was left alone');
  process.kill(later, 'SIGKILL');
});

test('a reused leader pid is never signalled and recorded members still match by their own identity', async () => {
  const bystander = spawn('sleep', ['302'], { detached: true, stdio: 'ignore' });
  bystander.unref();
  pids.push(bystander.pid);
  const notes = await stopRecordedServices([{ name: 'web', owned: true, mode: 'process', pid: bystander.pid, identity: { pid: bystander.pid, startTime: '1' }, members: [] }]);
  assert.match(notes.join('\n'), /now belongs to another process; not signalled/);
  assert.equal(alive(bystander.pid), true);
});
