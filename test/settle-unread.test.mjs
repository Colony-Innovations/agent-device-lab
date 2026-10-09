// Create-then-reload: a POST whose response body the page never reads, followed by a GET of the same
// URL. Chromium then never reports the POST as finished, although its whole body has arrived. Settling
// must not wait for it until maxMs, while a stream that keeps sending is still awaited (settle.test.mjs).
// Found on examples/multi-service; this test fails without the body-idle rule in lab.ts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lab } from '../dist/core/lab.js';

const dir = mkdtempSync(join(tmpdir(), 'agentlab-unread-'));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, 'agentlab.json'), JSON.stringify({
  schemaVersion: 2, name: 'unread', services: { web: { command: 'node server.mjs', url: 'http://127.0.0.1:5352', readiness: { path: '/' } } },
}));
writeFileSync(join(dir, 'server.mjs'), `
import { createServer } from 'node:http';
createServer((q, s) => {
  if (q.url === '/save') {
    s.writeHead(q.method === 'POST' ? 201 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    s.end(q.method === 'POST' ? '{"id":1}' : '[{"id":1}]');
    return;
  }
  s.end('<!doctype html><meta name=viewport content="width=device-width"><button id=b>Save</button><p role=status id=o></p>' +
    '<script>b.onclick = async () => { const res = await fetch("/save", { method: "POST", body: "{}" }); if (!res.ok) return; const list = await fetch("/save"); if (list.ok) await list.json(); o.textContent = "Saved"; };</script>');
}).listen(5352, '127.0.0.1');`);

test('an unread, chunked POST response does not hold settling to maxMs', async () => {
  const lab = new Lab({ stateDir: join(dir, 'state') });
  try {
    await lab.start({ project: dir, headed: false });
    const r = await lab.act({ action: 'click', ref: lab.findRef({ role: 'button', name: 'Save' }) });
    assert.equal(r.outcome, 'success');
    assert.equal(r.settle.reason, 'quiet', JSON.stringify(r.settle));
    assert.ok(r.settle.ms < 2000, `settled in ${r.settle.ms}ms`);
    assert.ok(r.observation.messages.some((m) => m.text === 'Saved'));
  } finally {
    await lab.close();
  }
});
