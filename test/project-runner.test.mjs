// Project runner lifecycle: start, reuse, startup errors, readiness timeout, ownership.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebServer, probe } from '../dist/core/project-runner.js';

const dir = mkdtempSync(join(tmpdir(), 'agentlab-runner-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// A server that spawns a child (like npm → node) so group cleanup is exercised.
writeFileSync(join(dir, 'serve.mjs'), `
import { createServer } from 'node:http';
const status = Number(process.env.STATUS ?? 200);
createServer((q, s) => s.writeHead(status).end('ok')).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('listening ' + process.env.PORT));
`);
writeFileSync(join(dir, 'crash.mjs'), `console.log('booting'); console.error('Error: DATABASE_URL is not set'); process.exit(3);`);
writeFileSync(join(dir, 'hang.mjs'), `console.log('never ready'); setInterval(() => {}, 1000);`);

const spec = (port, command, over = {}) => ({
  command, cwd: dir, url: `http://127.0.0.1:${port}`, env: { PORT: String(port) },
  readiness: { path: '/', status: 200, timeoutMs: 8000, intervalMs: 100 }, reuseExisting: true, ...over,
});

test('starts the declared command, reports ownership, and stops the whole process group', async () => {
  const s = spec(5311, 'node serve.mjs | cat');
  const server = await WebServer.ensure(s, { logFile: join(dir, 'a.log') });
  assert.equal(server.info.owned, true);
  assert.equal(server.info.reused, false);
  assert.equal((await probe(s)).kind, 'healthy');
  const stopped = await server.stop();
  assert.equal(stopped.stopped, true);
  assert.equal((await probe(s)).kind, 'down');
});

test('reuses a healthy existing server and never stops it', async () => {
  const existing = createServer((q, r) => r.end('ok')).listen(5312, '127.0.0.1');
  await new Promise((r) => existing.once('listening', r));
  try {
    const server = await WebServer.ensure(spec(5312, 'exit 99'));
    assert.deepEqual([server.info.owned, server.info.reused], [false, true]);
    const res = await server.stop();
    assert.equal(res.stopped, false);
    assert.equal((await probe(spec(5312, ''))).kind, 'healthy');
  } finally {
    existing.close();
  }
});

test('captures startup errors with the log tail', async () => {
  await assert.rejects(WebServer.ensure(spec(5313, 'node crash.mjs')), (err) => {
    assert.equal(err.code, 'startup_failed');
    assert.match(err.message, /exit code 3/);
    assert.ok(err.details.logTail.some((l) => l.includes('DATABASE_URL is not set')));
    return true;
  });
});

test('a missing command is a startup failure with a hint', async () => {
  await assert.rejects(WebServer.ensure(spec(5314, 'definitely-not-a-command-xyz')), (err) => err.code === 'startup_failed' && /not found/.test(err.hint));
});

test('readiness timeout stops the process it started', async () => {
  const s = spec(5315, 'node hang.mjs', { readiness: { path: '/', status: 200, timeoutMs: 800, intervalMs: 100 } });
  await assert.rejects(WebServer.ensure(s), (err) => err.code === 'readiness_timeout' && /was stopped/.test(err.message));
});

test('an occupied port with a failing readiness check is a conflict, not a second server', async () => {
  const other = createServer((q, r) => r.writeHead(500).end()).listen(5316, '127.0.0.1');
  await new Promise((r) => other.once('listening', r));
  try {
    await assert.rejects(WebServer.ensure(spec(5316, 'node serve.mjs')), { code: 'port_conflict' });
  } finally {
    other.close();
  }
});

test('reuseExisting=false refuses a server it does not own', async () => {
  const existing = createServer((q, r) => r.end('ok')).listen(5317, '127.0.0.1');
  await new Promise((r) => existing.once('listening', r));
  try {
    await assert.rejects(WebServer.ensure(spec(5317, 'node serve.mjs', { reuseExisting: false })), { code: 'port_conflict' });
  } finally {
    existing.close();
  }
});
