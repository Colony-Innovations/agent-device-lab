// Regressions from the Web V1 RC validation: a moving marquee is not clipped content, a native
// multi-select is not a sideways scroller, a sweep reports the HTTP status and the settle cause of each
// width, and a killed browser is reported as a disconnect. Test app on port 5398; the browser-kill
// test uses 5399.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lab } from '../dist/core/lab.js';
import { formatSweep } from '../dist/core/format.js';

const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const labs = [];
after(async () => {
  for (const lab of labs) await lab.close().catch(() => undefined);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const head = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>*{box-sizing:border-box}body{margin:0;font:16px sans-serif;padding:16px}a,button{min-height:44px;min-width:44px;display:inline-block}</style>';
const items = ['Hand-Woven Makenge Baskets', 'Copper Jewellery', 'Carved Stools', 'Chitenge Fabric', 'Ebony Masks', 'Soapstone Bowls'];
const strip = (extra) => `<div style="overflow:hidden;width:100%"><div style="display:flex;gap:24px;width:max-content;${extra}">${[...items, ...items].map((t) => `<a href="#" style="white-space:nowrap">${t}</a>`).join('')}</div></div>`;
const pages = {
  // An infinite marquee: the strip translates inside an overflow:hidden band, so its items are always partly cut.
  '/marquee': head + '<style>@keyframes marquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}</style><h1>Marquee</h1>' + strip('animation:marquee 20s linear infinite'),
  // The same strip standing still, shifted left by a static transform: the cut-off is a defect.
  '/static-strip': head + '<h1>Static</h1>' + strip('transform:translateX(-140px)'),
  // Text and a control cut off by a fixed-size band, nothing moving.
  '/static-clipped': head + '<h1>Clipped</h1><div style="overflow:hidden;width:200px"><button style="margin-left:140px;white-space:nowrap">Export the whole report</button></div>' +
    '<div style="width:90px;overflow:hidden;white-space:nowrap">A heading that is far too long for its box</div>',
  '/multiselect': head + '<h1>Filters</h1><label for="s">Regions</label><select id="s" multiple size="3" style="width:120px;overflow:auto">' +
    ['North-Western Province headquarters', 'Copperbelt Province regional office', 'Lusaka'].map((o) => `<option>${o}</option>`).join('') + '</select>',
  // Mutates every 20 ms for as long as the page lives: the DOM never goes quiet.
  '/busy': head + '<h1>Busy</h1><p id="n">0</p><script>let i = 0; setInterval(() => { n.textContent = ++i; }, 20)</script>',
  '/plain': head + '<h1>Plain</h1><p>Nothing to see.</p>',
};

function project(port, extra = {}) {
  const dir = tmp('agentlab-rc-proj-');
  writeFileSync(join(dir, 'server.mjs'), `
import { createServer } from 'node:http';
const pages = ${JSON.stringify(pages)};
createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/health') return res.end('ok');
  const page = pages[path];
  if (!page) return res.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><title>Not found</title><h1>Not found</h1>');
  res.writeHead(200, { 'content-type': 'text/html' }).end(page);
}).listen(${port}, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`);
  writeFileSync(join(dir, 'agentlab.json'), JSON.stringify({
    schemaVersion: 1, name: 'rc-fixes', web: { command: 'node server.mjs', url: `http://127.0.0.1:${port}`, readiness: { path: '/health' } }, startPath: '/plain', ...extra,
  }));
  return dir;
}

/** A session on the test app for the duration of `fn`; the app is stopped afterwards so the next test can reuse the port. */
async function withLab(port, extra, fn) {
  const lab = new Lab({ stateDir: tmp('agentlab-rc-state-') });
  labs.push(lab);
  try {
    await lab.start({ project: project(port, extra), headed: false });
    return await fn(lab);
  } finally {
    await lab.close();
  }
}

const CLIP_KINDS = ['container-clipped', 'text-clipped', 'unreachable-content'];

test('P2: items of an infinite marquee are not clipped content, at any width or moment', () => withLab(5398, { settle: { quietMs: 120, maxMs: 2000 } }, async (lab) => {
  // Twice: the visible share of each item changes over time, so a nondeterministic finding set would show up here.
  for (let run = 0; run < 2; run++) {
    const r = await lab.sweep({ route: '/marquee' });
    assert.deepEqual(r.findings.filter((f) => CLIP_KINDS.includes(f.kind)).map((f) => `${f.kind} ${f.target?.name}`), [], `run ${run}`);
    await sleep(700);
  }
  // The look-alikes that stand still are still reported.
  const stat = await lab.sweep({ route: '/static-strip' });
  assert.ok(stat.findings.some((f) => f.kind === 'container-clipped'), JSON.stringify(stat.findings.map((f) => f.kind)));
  const clipped = await lab.sweep({ route: '/static-clipped' });
  const kinds = new Set(clipped.findings.map((f) => f.kind));
  assert.ok(kinds.has('container-clipped'), [...kinds].join());
  assert.ok(kinds.has('text-clipped'), [...kinds].join());
}));

test('L1: a native multi-select listbox is not a sideways scroller', () => withLab(5398, {}, async (lab) => {
  const r = await lab.sweep({ route: '/multiselect' });
  assert.deepEqual(r.findings.filter((f) => f.kind === 'content-scroll-x').map((f) => f.message), []);
}));

test('P4a: a sweep of a route that answers 404 reports the status, not "ok (quiet)"', () => withLab(5398, {}, async (lab) => {
  const r = await lab.sweep({ route: '/no-such-page' });
  assert.equal(r.devices.length, 4);
  for (const d of r.devices) {
    assert.equal(d.status, 'error', d.device);
    assert.equal(d.httpStatus, 404);
    assert.equal(d.error.code, 'http_status');
    assert.match(d.error.message, /HTTP 404/);
  }
  assert.match(readFileSync(r.report, 'utf8'), /error: http_status GET \/no-such-page answered HTTP 404/);
  assert.match(formatSweep(r), /ERROR http_status: GET \/no-such-page answered HTTP 404/);
  const ok = await lab.sweep({ route: '/plain', devices: ['mobile-390'] });
  assert.equal(ok.devices[0].httpStatus, 200);
  assert.equal(ok.devices[0].status, 'ok');
}));

test('P4b: a width that settled by timeout records its cause in the result, the report and the text', () => withLab(5398, { settle: { quietMs: 120, maxMs: 600 } }, async (lab) => {
  const r = await lab.sweep({ route: '/busy', devices: ['mobile-390', 'desktop-1440'] });
  for (const d of r.devices) {
    assert.equal(d.status, 'ok');
    assert.equal(d.settled, 'timeout');
    assert.equal(d.settleCause, 'dom');
  }
  assert.match(readFileSync(r.report, 'utf8'), /ok \(settle timed out: the DOM kept changing\)/);
  assert.match(formatSweep(r), /settle timed out \(the DOM kept changing\)/);
  assert.equal(JSON.parse(readFileSync(join(r.report, '..', 'result.json'), 'utf8')).devices[0].settleCause, 'dom');
  const quiet = await lab.sweep({ route: '/plain', devices: ['mobile-390'] });
  assert.equal(quiet.devices[0].settled, 'quiet');
  assert.equal(quiet.devices[0].settleCause, undefined);
}));

/** Chromium processes this test process started (direct children whose command line says chrome). */
function browserChildren() {
  const out = [];
  for (const n of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      const stat = readFileSync(`/proc/${n}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(f[1]) !== process.pid) continue;
      const cmd = readFileSync(`/proc/${n}/cmdline`, 'utf8');
      if (/chrom|headless_shell/i.test(cmd)) out.push(Number(n));
    } catch { /* gone */ }
  }
  return out;
}

test('P5: a killed browser ends the session as a disconnect or crash, not as a closed page', () => withLab(5399, {}, async (lab) => {
  const pids = browserChildren();
  assert.equal(pids.length, 1, `the one browser this test launched: ${pids}`);
  process.kill(pids[0], 'SIGKILL');
  for (let i = 0; i < 100 && lab.active; i++) await sleep(100);
  assert.equal(lab.active, false);
  assert.match(lab.status().endedReason, /^browser disconnected or crashed$/);
  await assert.rejects(() => lab.observe(), (err) => err.code === 'browser_closed' && /disconnected or crashed/.test(err.message));
}));
