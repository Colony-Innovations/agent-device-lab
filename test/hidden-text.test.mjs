// Text that is hidden on purpose is never clipped text: image-replacement links (text moved out of the
// box by text-indent) and the options a native listbox scrolls itself. Test app on port 5391.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lab } from '../dist/core/lab.js';
import { DETECTORS } from '../dist/core/detectors.js';

const project = mkdtempSync(join(tmpdir(), 'agentlab-hidden-'));
const stateDir = mkdtempSync(join(tmpdir(), 'agentlab-hidden-state-'));
const BASE = 'http://127.0.0.1:5391';

writeFileSync(join(project, 'agentlab.json'), JSON.stringify({
  schemaVersion: 1, name: 'hidden-text', web: { command: 'node server.mjs', url: BASE, readiness: { path: '/health' } },
  scan: { devices: ['mobile-390'], scenarios: [{ name: 'icons', route: '/icons' }, { name: 'partial', route: '/partial' }, { name: 'listbox', route: '/listbox' }] },
}));
writeFileSync(join(project, 'server.mjs'), `
import { createServer } from 'node:http';
const head = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>*{box-sizing:border-box}body{margin:0;font:16px sans-serif;padding:16px}a{min-height:44px;min-width:44px}</style>';
const icon = 'display:block;width:44px;height:44px;overflow:hidden;background:#09f;margin:8px 0;';
const pages = {
  // Image replacement: the label is moved out of the box on purpose; the box shows a background icon.
  '/icons': head + '<h1>Icons</h1>' +
    '<a href="#a" style="' + icon + 'text-indent:-3000px;white-space:nowrap">Choose</a>' +
    '<a href="#b" style="' + icon + 'text-indent:100%;white-space:nowrap">Remove</a>',
  // A label that is cut partway through stays a defect.
  '/partial': head + '<h1>Partial</h1><a href="#p" style="display:block;width:70px;overflow:hidden;white-space:nowrap;border:1px solid #999">Choose every item</a>',
  // A native listbox scrolls and clips its own options (here inside a wrapper with overflow hidden, as in Django's widget).
  '/listbox': head + '<h1>Listbox</h1><div style="overflow:hidden;width:200px"><select multiple size="3" style="width:120px">' +
    ['Content Types | content type | Can delete content type', 'Another very long option label that does not fit', 'Third option with an equally long label', 'Fourth option further down the list', 'Fifth option'].map((o) => '<option>' + o + '</option>').join('') + '</select></div>',
};
createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/health') return res.end('ok');
  const page = pages[path];
  if (!page) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/html' }).end(page);
}).listen(5391, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`);

let lab;
let result;
before(async () => {
  lab = new Lab({ stateDir });
  await lab.start({ project, headed: false });
  result = await lab.scan();
});
after(async () => {
  await lab?.close();
  rmSync(project, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});
const of = (scenario) => result.findings.filter((f) => f.scenario === scenario);
const label = (f) => `${f.kind} ${f.severity} ${f.confidence} ${f.target?.name}`;

test('every scenario run completes', () => {
  assert.deepEqual(result.runs.filter((r) => r.status !== 'ok').map((r) => `${r.scenario}: ${r.error?.message}`), []);
});

test('image-replacement links (text moved entirely out of the box) are not clipped text', () => {
  assert.deepEqual(of('icons').map(label), []);
});

test('text cut partway through its box is still text-clipped, confirmed', () => {
  const fs = of('partial').filter((f) => f.kind === 'text-clipped');
  assert.equal(fs.length, 1, JSON.stringify(of('partial').map(label)));
  assert.equal(fs[0].confidence, 'confirmed');
  assert.equal(fs[0].target.name, 'Choose every item');
});

test('options scrolled out of a native listbox are not clipped content', () => {
  assert.deepEqual(of('listbox').filter((f) => f.kind === 'container-clipped' || f.kind === 'text-clipped').map(label), []);
});

test('the changed detectors carry a new version', () => {
  assert.ok(DETECTORS['text-clipped'].version >= 2);
  assert.ok(DETECTORS['container-clipped'].version >= 2);
});
