// Process identity: a stale daemon record must never cause the CLI to signal an unrelated process.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkIdentity, identify } from '../dist/core/process-identity.js';

const run = promisify(execFile);
const home = mkdtempSync(join(tmpdir(), 'agentlab-stale-'));
after(() => rmSync(home, { recursive: true, force: true }));

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** An unrelated process in its own process group, like a random program that inherited a reused pid. */
function bystander() {
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

async function cli(...args) {
  try {
    const { stdout, stderr } = await run(process.execPath, ['bin/agentlab.js', ...args], { env: { ...process.env, AGENTLAB_HOME: home } });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    return { code: err.code, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

test('identify returns a stable identity for a live process and nothing for a dead one', () => {
  const me = identify(process.pid);
  assert.ok(me?.startTime);
  assert.deepEqual(identify(process.pid), me);
  assert.equal(checkIdentity(me), 'same');
  assert.equal(identify(2 ** 22 + 12345), undefined);
});

test('checkIdentity distinguishes reused, gone and unverifiable records', () => {
  const me = identify(process.pid);
  assert.equal(checkIdentity({ ...me, startTime: '1' }), 'reused');
  assert.equal(checkIdentity({ ...me, bootId: 'another-boot' }), me.bootId ? 'reused' : 'same');
  assert.equal(checkIdentity({ pid: 2 ** 22 + 12345, startTime: '1' }), 'gone');
  assert.equal(checkIdentity({ pid: process.pid }), 'unverifiable');
  assert.equal(checkIdentity(undefined), 'unverifiable');
});

test('stop with a stale record (pid reused by another process) signals nothing and clears the record', async () => {
  const other = bystander();
  try {
    const real = identify(other.pid);
    const fake = { ...real, startTime: String(Number(real.startTime) - 1000) }; // what the dead daemon recorded
    writeFileSync(join(home, 'daemon.json'), JSON.stringify({
      pid: other.pid, daemon: fake, socket: join(home, 'daemon.sock'), startedAt: new Date().toISOString(),
      server: { url: 'http://127.0.0.1:5399', owned: true, pid: other.pid, identity: fake },
    }));
    const res = await cli('stop');
    assert.equal(res.code, 0);
    assert.match(res.out, /stale record: pid \d+ now belongs to another process/);
    assert.match(res.out, /owned server pid \d+ now belongs to another process; not signalled/);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(alive(other.pid), 'the unrelated process must survive');
    assert.equal(existsSync(join(home, 'daemon.json')), false);
  } finally {
    other.kill('SIGKILL');
  }
});

test('an older record without identity is never trusted or signalled', async () => {
  const other = bystander();
  try {
    writeFileSync(join(home, 'daemon.json'), JSON.stringify({
      pid: other.pid, socket: join(home, 'daemon.sock'), startedAt: new Date().toISOString(),
      server: { url: 'http://127.0.0.1:5399', owned: true, pid: other.pid },
    }));
    const status = await cli('status');
    assert.equal(status.code, 1);
    assert.match(status.out, /no_session/);

    writeFileSync(join(home, 'daemon.json'), JSON.stringify({
      pid: other.pid, socket: join(home, 'daemon.sock'), startedAt: new Date().toISOString(),
      server: { url: 'http://127.0.0.1:5399', owned: true, pid: other.pid },
    }));
    const res = await cli('stop');
    assert.match(res.out, /no process identity \(older format\); nothing was signalled/);
    assert.match(res.out, /cannot be verified; not signalled/);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(alive(other.pid));
  } finally {
    other.kill('SIGKILL');
  }
});

test('a live verified daemon is stopped normally and its owned server with it', async () => {
  const start = await cli('start', '--project', 'fixtures/invoice-app', '--headless');
  assert.equal(start.code, 0, start.out);
  const stop = await cli('stop');
  assert.equal(stop.code, 0, stop.out);
  assert.match(stop.out, /server stopped/);
  assert.equal(existsSync(join(home, 'daemon.json')), false);
});
