// Scan detectors on small synthetic pages, each holding one defect and the intentional look-alike that
// must stay quiet. Test app on port 5354.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lab } from '../dist/core/lab.js';

const project = mkdtempSync(join(tmpdir(), 'agentlab-scandet-'));
const stateDir = mkdtempSync(join(tmpdir(), 'agentlab-scandet-state-'));
const BASE = 'http://127.0.0.1:5354';

const scenario = (name, route, extra = {}) => ({ name, route, ...extra });
writeFileSync(join(project, 'agentlab.json'), JSON.stringify({
  schemaVersion: 1, name: 'scan-detectors', web: { command: 'node server.mjs', url: BASE, readiness: { path: '/health' } },
  scan: {
    devices: ['mobile-320', 'mobile-390'],
    scenarios: [
      scenario('unreachable', '/unreachable'), scenario('outside', '/outside'), scenario('scrollx', '/scrollx'),
      scenario('clean', '/clean'), scenario('intentional', '/intentional'), scenario('shift', '/shift'),
      scenario('wrap expected', '/wrap', { devices: ['mobile-320', 'mobile-390'] }),
    ],
    noWrap: [{ role: 'button', name: 'Continue to payment' }],
  },
}));
writeFileSync(join(project, 'server.mjs'), `
import { createServer } from 'node:http';
const head = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>*{box-sizing:border-box}body{margin:0;font:16px sans-serif;padding:16px}button,a{min-height:44px;min-width:44px}</style>';
const pages = {
  // A centred flex row wider than its scroller: its left part sits before the scroll origin.
  '/unreachable': head + '<h1>Unreachable</h1><div style="display:flex;justify-content:center;overflow-x:auto;width:100%"><button style="flex:0 0 200px">Alpha</button><button style="flex:0 0 200px">Beta</button><button style="flex:0 0 200px">Gamma</button></div>',
  // A control wider than its bordered card; an absolutely placed corner badge does not count.
  '/outside': head + '<h1>Outside</h1><div style="border:1px solid #999;padding:8px;width:200px;position:relative"><p>Card</p><button style="width:230px">Too wide button</button><button style="position:absolute;top:-10px;right:-10px">×</button></div>',
  // An ordinary text section scrolling sideways because of one long unbroken word.
  '/scrollx': head + '<h1>Scroll</h1><section style="overflow-x:auto"><p>Supercalifragilisticexpialidocious_and_even_longer_unbroken_identifier</p></section>',
  // Must stay quiet: screen-reader-only text, a closed off-canvas drawer, a sticky header that is not
  // stuck, and an inline link wrapped over two lines.
  '/clean': head + '<header style="position:sticky;top:0;background:#fff">Head</header><h1>Clean</h1>' +
    '<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">Skip to content, screen reader only text</span>' +
    '<nav style="position:fixed;top:0;left:0;width:280px;height:100vh;transform:translateX(-100%);background:#eee"><a href="/">Home</a><a href="/x">Other</a></nav>' +
    '<p style="width:200px">Please read the <a href="#terms" id="t" onclick="document.getElementById(\\'out\\').textContent=\\'terms opened\\'">full terms and conditions of service</a> before you continue.</p>' +
    '<p id="out" role="status"></p><div style="height:1200px"></div>',
  // Must stay quiet: a snap carousel, a chip row, a wide table and a code block, each scrolling in its own region.
  '/intentional': head + '<h1>Intentional</h1>' +
    '<div style="display:flex;overflow-x:auto;scroll-snap-type:x mandatory;gap:8px">' + [1,2,3,4].map((i) => '<button style="flex:0 0 80%">Slide ' + i + '</button>').join('') + '</div>' +
    '<div style="display:flex;overflow-x:auto;gap:8px;white-space:nowrap">' + ['Red','Green','Blue','Yellow','Purple','Orange'].map((c) => '<button>' + c + ' shoes</button>').join('') + '</div>' +
    '<div style="overflow-x:auto"><table style="width:700px"><tr><td>A wide table</td><td>with columns</td></tr></table></div>' +
    '<pre style="overflow-x:auto">const aVeryLongLineOfCode = computeSomethingWithAVeryLongName(argumentOne, argumentTwo);</pre>',
  // Content pushed down 700 ms after load, with no input.
  '/shift': head + '<h1>Shift</h1><main id="m">' + [1,2,3,4,5].map((i) => '<p>Paragraph ' + i + ' of the article, which the late banner pushes down the page.</p>').join('') + '<a href="/">Read more</a></main>' +
    '<script>setTimeout(() => { const d = document.createElement("div"); d.style.height = "200px"; d.textContent = "Late banner"; m.prepend(d); }, 700)</script>',
  // A label the project declared must never wrap; it wraps at 320 but not at 390, with no other harm.
  '/wrap': head + '<h1>Pay</h1><div style="display:flex;gap:8px"><button style="flex:1;font-weight:700">Back</button><button style="flex:1;font-weight:700;min-height:44px">Continue to payment</button></div>',
};
createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/health') return res.end('ok');
  const page = pages[path];
  if (!page) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/html' }).end(page);
}).listen(5354, '127.0.0.1');
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

test('every scenario run completes on both widths', () => {
  assert.deepEqual(result.runs.filter((r) => r.status !== 'ok').map((r) => `${r.scenario}@${r.device}: ${r.error?.message}`), []);
});

test('content before a scroll origin is unreachable (confirmed; high when the control centre is cut)', () => {
  const fs = of('unreachable');
  assert.ok(fs.length >= 2, JSON.stringify(fs.map((f) => f.kind)));
  const alpha = fs.filter((f) => f.kind === 'unreachable-content' && f.target.name === 'Alpha');
  assert.equal(alpha.length, 2, 'both widths');
  for (const f of alpha) {
    assert.equal(f.confidence, 'confirmed');
    assert.equal(f.severity, 'high');
    assert.ok(f.evidence.hiddenPx > 0);
  }
  assert.equal(new Set(alpha.map((f) => f.fingerprint)).size, 1, 'one problem across widths');
});

test('a control wider than its card is a heuristic outside-container finding; a corner badge is not', () => {
  const fs = of('outside');
  assert.deepEqual([...new Set(fs.map((f) => `${f.kind} ${f.target.name}`))], ['outside-container Too wide button']);
  for (const f of fs) {
    assert.equal(f.confidence, 'heuristic');
    assert.notEqual(f.severity, 'high');
  }
});

test('an ordinary section scrolling sideways is a heuristic warning, never high', () => {
  const fs = of('scrollx');
  assert.ok(fs.some((f) => f.kind === 'content-scroll-x'));
  for (const f of fs) assert.ok(f.confidence === 'heuristic' && f.severity !== 'high', `${f.kind} ${f.severity} ${f.confidence}`);
});

test('screen-reader text, a closed off-canvas drawer, an unstuck sticky header and a wrapped inline link stay clean', () => {
  assert.deepEqual(of('clean').map((f) => `${f.device} ${f.kind} ${f.target?.name}`), []);
});

test('carousels, chip rows, wide tables and code blocks scrolling in their own regions produce no findings', () => {
  assert.deepEqual(of('intentional').map((f) => `${f.device} ${f.kind} ${f.target?.name}`), []);
});

test('content moved after load without input is a layout shift, with a before frame', () => {
  const fs = of('shift').filter((f) => f.kind === 'layout-shift');
  assert.ok(fs.length >= 1, JSON.stringify(of('shift').map((f) => f.kind)));
  const f = fs[0];
  assert.ok(f.evidence.score >= 0.05);
  assert.deepEqual(f.basis, ['browser-metric']);
  assert.ok(f.frames?.some((x) => x.label === 'before it settled'), JSON.stringify(f.frames));
});

test('a label that wraps only at the narrower width violates a declared noWrap expectation', () => {
  const fs = of('wrap expected').filter((f) => f.kind === 'text-wrap-change');
  assert.equal(fs.length, 1, JSON.stringify(of('wrap expected').map((f) => `${f.device} ${f.kind}`)));
  assert.equal(fs[0].device, 'mobile-320');
  assert.equal(fs[0].target.name, 'Continue to payment');
  assert.equal(fs[0].evidence.harm, 'expectation');
  assert.equal(fs[0].confidence, 'confirmed');
  assert.equal(fs[0].severity, 'medium');
  assert.deepEqual(fs[0].frames.map((x) => x.device), ['mobile-320', 'mobile-390']);
});

test('clicking an inline link wrapped over two lines reaches it (the tap aims at one of its line boxes)', async () => {
  await lab.act({ action: 'open_tab', path: '/clean' });
  const ref = lab.findRef({ role: 'link', name: 'full terms and conditions of service' });
  const r = await lab.act({ action: 'click', ref });
  assert.equal(r.outcome, 'success', JSON.stringify(r.error));
  assert.ok(r.observation.messages.some((m) => m.text === 'terms opened'));
});
