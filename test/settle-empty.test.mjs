// An initial document whose app root is still empty while its scripts run is not settled. A Vite dev
// server serves every module separately, so a lazy route renders only after a chain of dynamic
// imports, each one discovered when the previous module has been fetched and evaluated. Between the
// last module response and the render commit there is no request, timer or DOM change for longer than
// the default quiet window. Test app on port 5392.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lab } from '../dist/core/lab.js';

const project = mkdtempSync(join(tmpdir(), 'agentlab-empty-'));
const stateDir = mkdtempSync(join(tmpdir(), 'agentlab-empty-state-'));

writeFileSync(join(project, 'agentlab.json'), JSON.stringify({
  schemaVersion: 1, name: 'empty', web: { command: 'node server.mjs', url: 'http://127.0.0.1:5392', readiness: { path: '/health' } },
  settle: { maxMs: 2500 },
}));
writeFileSync(join(project, 'server.mjs'), `
import { createServer } from 'node:http';
const head = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">';
// Yield to the event loop for ms without a timer, request or DOM change: React-style slices through MessageChannel.
const spin = 'const spin = (ms) => new Promise((done) => { const ch = new MessageChannel(); const end = performance.now() + ms;' +
  ' ch.port1.onmessage = () => { if (performance.now() < end) ch.port2.postMessage(0); else done(); }; ch.port2.postMessage(0); });';
const modules = {
  // The entry imports a lazy route, which imports its view; each hop is a fresh request.
  '/route.js': "await import('/view.js');",
  '/view.js': spin + " await spin(260); document.getElementById('root').innerHTML = '<h1>Shop</h1><button>Buy</button>';",
};
const pages = {
  '/': head + '<div id="root"></div><script type="module">await import("/route.js");</script>',
  // Scripts that never render anything: the page stays empty.
  '/blank': head + '<div id="root"></div><script type="module">const x = 1;</script>',
  // Server-rendered content with a script: nothing to wait for.
  '/static': head + '<div id="root"><h1>Static</h1><button>Go</button></div><script type="module">const x = 1;</script>',
  // No scripts at all and nothing in the body: an empty document is simply empty.
  '/bare': head + '<div id="root"></div>',
};
createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/health') return res.end('ok');
  if (modules[path]) return setTimeout(() => res.writeHead(200, { 'content-type': 'text/javascript' }).end(modules[path]), 70);
  if (!pages[path]) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/html' }).end(pages[path]);
}).listen(5392, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`);

let lab;
let first;
before(async () => {
  lab = new Lab({ stateDir });
  first = await lab.start({ project, headed: false });
});
after(async () => {
  await lab?.close();
  rmSync(project, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

test('the first observation waits for a lazily rendered app root instead of returning an empty page', () => {
  assert.deepEqual(first.observation.headings, ['h1 Shop']);
  assert.ok(first.observation.controls.some((c) => c.name === 'Buy'), JSON.stringify(first.observation.controls));
});

test('a page that stays empty times out, names the cause, and is not thrown', async () => {
  const r = await lab.act({ action: 'open_tab', path: '/blank' });
  assert.equal(r.outcome, 'success');
  assert.equal(r.settle.reason, 'timeout');
  assert.equal(r.settle.cause, 'empty');
  assert.ok(r.settle.ms >= 2000 && r.settle.ms < 4000, `${r.settle.ms} ms`);
});

test('a page with content and scripts settles quickly', async () => {
  const r = await lab.act({ action: 'open_tab', path: '/static' });
  assert.equal(r.settle.reason, 'quiet');
  assert.ok(r.settle.ms < 1000, `${r.settle.ms} ms`);
});

test('a scriptless empty document settles quickly: nothing can render into it', async () => {
  const r = await lab.act({ action: 'open_tab', path: '/bare' });
  assert.equal(r.settle.reason, 'quiet');
  assert.ok(r.settle.ms < 1000, `${r.settle.ms} ms`);
});
