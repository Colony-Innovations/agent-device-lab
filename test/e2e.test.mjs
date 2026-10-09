// Browser end-to-end tests (headless Chromium). Run after `npm run build`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFlow } from '../dist/cli/flow.js';
import { Lab } from '../dist/core/lab.js';
import { probe } from '../dist/core/project-runner.js';

const stateDir = mkdtempSync(join(tmpdir(), 'agentlab-e2e-'));
after(() => rmSync(stateDir, { recursive: true, force: true }));

const fixtureSpec = { url: 'http://127.0.0.1:5199', readiness: { path: '/health', status: 200 } };
let fixtureWasRunning = false;
before(async () => { fixtureWasRunning = (await probe(fixtureSpec)).kind === 'healthy'; });

const discard = () => {};

test('clean flow passes from a fresh run and leaves no owned server behind', async () => {
  const ok = await runFlow('flows/clean.flow.json', { headed: false, json: true, stateDir, write: discard });
  assert.equal(ok, true);
  if (!fixtureWasRunning) assert.equal((await probe(fixtureSpec)).kind, 'down', 'owned fixture server must be stopped');
});

test('mobile defect flow detects the seeded overflow', async () => {
  const ok = await runFlow('flows/mobile-defect.flow.json', { headed: false, json: true, stateDir, write: discard });
  assert.equal(ok, true);
});

// A purpose-built page for the error paths: a covered button, duplicate names and a navigation.
const project = mkdtempSync(join(tmpdir(), 'agentlab-obstruct-'));
after(() => rmSync(project, { recursive: true, force: true }));
writeFileSync(join(project, 'agentlab.json'), JSON.stringify({
  schemaVersion: 1, name: 'obstruct', web: { command: 'node server.mjs', url: 'http://127.0.0.1:5321', readiness: { path: '/', timeoutMs: 10000 } },
}));
writeFileSync(join(project, 'server.mjs'), `
import { createServer } from 'node:http';
const page = (body) => '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><body style="margin:0">' + body;
createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  if (req.url === '/two') return res.end(page('<h1>Two</h1>'));
  res.end(page(\`
    <button id="pay" onclick="document.title='paid'">Pay</button>
    <div id="banner" style="position:fixed;top:0;left:0;right:0;height:120px;background:#eee">Cookie banner</div>
    <div style="margin-top:200px"><button>Same</button> <button>Same</button> <a href="/two">Next</a></div>\`));
}).listen(5321, '127.0.0.1');
`);

test('covered control returns obstructed without clicking; duplicates are ambiguous; navigation makes refs stale', async () => {
  const lab = new Lab({ stateDir });
  try {
    const start = await lab.start({ project, headed: false });
    assert.equal(start.server.owned, true);

    const pay = lab.findRef({ role: 'button', name: 'Pay' });
    const blocked = await lab.act({ action: 'click', ref: pay });
    assert.equal(blocked.outcome, 'error');
    assert.equal(blocked.error.code, 'obstructed');
    assert.match(blocked.error.message, /div#banner/);
    assert.equal(blocked.error.recoverable, true);
    assert.notEqual((await lab.observe()).title, 'paid', 'an obstructed control must not be activated');

    assert.throws(() => lab.findRef({ role: 'button', name: 'Same' }), (err) => err.code === 'ambiguous_target' && err.details.candidates.length === 2);
    assert.throws(() => lab.findRef({ role: 'button', name: 'Missing' }), { code: 'not_found' });

    const next = await lab.act({ action: 'click', ref: lab.findRef({ role: 'link', name: 'Next' }) });
    assert.equal(next.outcome, 'success');
    assert.equal(next.navigated, true);
    assert.deepEqual(next.changes.reset, { reason: 'navigation' });

    const stale = await lab.act({ action: 'click', ref: pay });
    assert.equal(stale.error.code, 'stale_ref');
    assert.match(stale.error.message, /previous page/);
  } finally {
    const closed = await lab.close();
    assert.equal(closed.server.stopped, true);
  }
  assert.equal((await probe({ url: 'http://127.0.0.1:5321', readiness: { path: '/', status: 200 } })).kind, 'down');
});
