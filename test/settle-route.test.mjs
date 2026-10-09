// A client-side route change whose new page is rendered later, off any timer or request: the way
// React Router 7 renders a navigation inside a transition, with React's scheduler yielding through
// MessageChannel. The URL changes at once; the DOM changes only when the render commits. Settling
// must not return in between. Test app on port 5361.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lab } from '../dist/core/lab.js';

const project = mkdtempSync(join(tmpdir(), 'agentlab-route-'));
const stateDir = mkdtempSync(join(tmpdir(), 'agentlab-route-state-'));

writeFileSync(join(project, 'agentlab.json'), JSON.stringify({
  schemaVersion: 1, name: 'route', web: { command: 'node server.mjs', url: 'http://127.0.0.1:5361', readiness: { path: '/health' } },
}));
writeFileSync(join(project, 'server.mjs'), `
import { createServer } from 'node:http';
const page = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">' +
  '<main id="app"><h1>Sign in</h1><button id="go">Sign in</button><button id="same">Filter</button></main><script>' +
  // Work in slices through MessageChannel (no timers, no requests, no DOM changes) for about 400 ms.
  'function render(ms, done) { const ch = new MessageChannel(); const end = performance.now() + ms;' +
  '  ch.port1.onmessage = () => { const t = performance.now() + 8; while (performance.now() < t) {} if (performance.now() < end) ch.port2.postMessage(0); else done(); };' +
  '  ch.port2.postMessage(0); }' +
  // Like the real app, the busy label is reset (a text-only change) as the address changes, before the render.
  'go.onclick = () => { go.textContent = "Signing in…"; history.pushState({}, "", "/app/discover"); go.textContent = "Sign in";' +
  '  render(400, () => { app.innerHTML = "<h1>Discover</h1><a href=\\\\"/b/north\\\\">View profile</a>"; }); };' +
  // A pushState to the same path (a query change) whose view never changes must not hold settling.
  'same.onclick = () => { history.replaceState({}, "", location.pathname + "?sort=new"); };' +
  '</script>';
createServer((req, res) => {
  if (req.url === '/health') return res.end('ok');
  res.writeHead(200, { 'content-type': 'text/html' }).end(page);
}).listen(5361, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`);

let lab;
before(async () => {
  lab = new Lab({ stateDir });
  await lab.start({ project, headed: false });
});
after(async () => {
  await lab?.close();
  rmSync(project, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

test('a route change settles only after the new page is rendered, not while the old one is still shown', async () => {
  const r = await lab.act({ action: 'click', ref: lab.findRef({ role: 'button', name: 'Sign in' }) });
  assert.equal(r.outcome, 'success', JSON.stringify(r.error));
  assert.equal(r.observation.route, '/app/discover');
  assert.deepEqual(r.observation.headings, ['h1 Discover'], `settled after ${r.settle.ms} ms (${r.settle.reason})`);
  assert.ok(r.observation.controls.some((c) => c.name === 'View profile'));
  assert.equal(r.settle.reason, 'quiet');
});

test('a URL change on the same path with no view change settles normally', async () => {
  await lab.act({ action: 'back' });
  await lab.act({ action: 'forward' });
  const home = await lab.act({ action: 'open_tab', path: '/' });
  assert.equal(home.outcome, 'success');
  const r = await lab.act({ action: 'click', ref: lab.findRef({ role: 'button', name: 'Filter' }) });
  assert.equal(r.outcome, 'success');
  assert.equal(r.settle.reason, 'quiet');
  assert.ok(r.settle.ms < 1000, `held for ${r.settle.ms} ms`);
});
