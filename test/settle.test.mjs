// Settling policy on a page with long-polling, an EventSource stream, a streaming fetch and a ticking clock.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lab } from '../dist/core/lab.js';

const project = mkdtempSync(join(tmpdir(), 'agentlab-settle-'));
const stateDir = mkdtempSync(join(tmpdir(), 'agentlab-settle-state-'));
after(() => { rmSync(project, { recursive: true, force: true }); rmSync(stateDir, { recursive: true, force: true }); });

writeFileSync(join(project, 'agentlab.json'), JSON.stringify({
  schemaVersion: 1, name: 'settle',
  web: { command: 'node server.mjs', url: 'http://127.0.0.1:5331', readiness: { path: '/health', timeoutMs: 10000 } },
  settle: { quietMs: 100, maxMs: 1200, backgroundRequests: ['/api/poll'] },
}));
writeFileSync(join(project, 'server.mjs'), `
import { createServer } from 'node:http';
const page = \`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">
<button id="load">Load</button> <button id="poll">Poll again</button> <button id="stream">Stream</button> <button id="clock">Clock</button>
<p id="out" role="status"></p><p id="time"></p>
<script>
  const out = document.getElementById('out');
  const poll = () => fetch('/api/poll').then(poll, () => {});
  poll();                                        // long-poll open from page load
  new EventSource('/api/events');                // server-sent events, never finishes
  document.getElementById('load').onclick = async () => { await fetch('/api/data'); out.textContent = 'loaded'; };
  document.getElementById('poll').onclick = () => { fetch('/api/poll'); out.textContent = 'polling'; };
  document.getElementById('stream').onclick = async () => {
    out.textContent = 'streaming';
    const res = await fetch('/api/stream'); const reader = res.body.getReader();
    while (!(await reader.read()).done) {}
  };
  document.getElementById('clock').onclick = () => setInterval(() => { document.getElementById('time').textContent = String(performance.now()); }, 40);
</script>\`;
createServer((req, res) => {
  if (req.url === '/health') return res.end('ok');
  if (req.url === '/api/poll') return setTimeout(() => res.end('{}'), 30000);
  if (req.url === '/api/data') return setTimeout(() => res.end('{}'), 300);
  if (req.url === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); const t = setInterval(() => res.write('data: tick\\\\n\\\\n'), 200); req.on('close', () => clearInterval(t)); return; }
  if (req.url === '/api/stream') { res.writeHead(200, { 'content-type': 'text/plain' }); const t = setInterval(() => res.write('chunk\\\\n'), 100); setTimeout(() => { clearInterval(t); res.end(); }, 10000); req.on('close', () => clearInterval(t)); return; }
  res.writeHead(200, { 'content-type': 'text/html' }).end(page);
}).listen(5331, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`);

test('settling ignores background requests, waits for action requests, and reports timeouts without failing', async () => {
  const lab = new Lab({ stateDir });
  try {
    await lab.start({ project, headed: false });
    const click = (name) => lab.act({ action: 'click', ref: lab.findRef({ role: 'button', name }) });

    const load = await click('Load');
    assert.equal(load.outcome, 'success');
    assert.equal(load.settle.reason, 'quiet', 'the 300 ms request started by the action is awaited, the long-poll and SSE are not');
    assert.ok(load.settle.ms >= 250 && load.settle.ms < 1200, `waited for /api/data (${load.settle.ms}ms)`);
    assert.ok(load.settle.ignored >= 2, `long-poll and EventSource ignored (${load.settle.ignored})`);
    assert.deepEqual(load.changes.messagesAdded, [{ role: 'status', text: 'loaded' }]);

    const poll = await click('Poll again');
    assert.equal(poll.settle.reason, 'quiet', 'a new request matching settle.backgroundRequests is not awaited');

    const stream = await click('Stream');
    assert.equal(stream.outcome, 'success', 'a settle timeout is not an action failure');
    assert.equal(stream.settle.reason, 'timeout');
    assert.equal(stream.settle.cause, 'network');
    assert.deepEqual(stream.settle.pending, ['GET /api/stream']);
    assert.ok(stream.settle.ms >= 1100 && stream.settle.ms < 2500, `bounded by settle.maxMs (${stream.settle.ms}ms)`);

    const clock = await click('Clock');
    assert.equal(clock.outcome, 'success');
    assert.equal(clock.settle.reason, 'timeout');
    assert.equal(clock.settle.cause, 'dom');
  } finally {
    await lab.close();
  }
});
