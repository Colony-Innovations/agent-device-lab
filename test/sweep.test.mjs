// Responsive sweep: isolated contexts per width, finding attribution, confirmed vs heuristic, and no
// false high findings for intentional scroll regions or fixed bars. Test app on port 5333.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lab } from '../dist/core/lab.js';

const project = mkdtempSync(join(tmpdir(), 'agentlab-sweep-'));
const stateDir = mkdtempSync(join(tmpdir(), 'agentlab-sweep-state-'));
const BASE = 'http://127.0.0.1:5333';

writeFileSync(join(project, 'agentlab.json'), JSON.stringify({
  schemaVersion: 1, name: 'sweep', web: { command: 'node server.mjs', url: BASE, readiness: { path: '/health' } },
}));
writeFileSync(join(project, 'server.mjs'), `
import { createServer } from 'node:http';
const log = [];
const head = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>body{margin:0;font:16px sans-serif}button{height:44px}</style>';
// Every page load reports the visit count it saw and its own width, so the test can check isolation.
const track = '<script>const v = Number(localStorage.getItem("visits") || 0) + 1; localStorage.setItem("visits", v); fetch("/log?visits=" + v + "&w=" + innerWidth + "&path=" + location.pathname);</script>';
const pages = {
  '/': head + track + '<h1>Home</h1><button id="go">Go</button><p id="out" role="status"></p><script>go.onclick = () => { out.textContent = "went" }</script>',
  '/toolbar': head + track + '<h1>Reports</h1><div style="display:flex;gap:12px;white-space:nowrap;padding:16px"><label>From <input value="2026-09-01" style="width:170px"></label><label>To <input value="2026-09-30" style="width:170px"></label><button>Export CSV</button></div>',
  '/carousel': head + track + '<h1>Featured</h1><div style="display:flex;gap:8px;overflow-x:auto;padding:8px">' +
    Array.from({ length: 8 }, (_, i) => '<button style="flex:0 0 150px">Item ' + (i + 1) + '</button>').join('') + '</div>' +
    // Fully inside the first screen, but its centre sits under the fixed tab bar until scrolled a little.
    '<button style="position:absolute;left:16px;top:calc(100vh - 50px)">Last</button><div style="height:1600px"></div>' +
    '<nav style="position:fixed;left:0;right:0;bottom:0;height:72px;background:#eee"><a href="/">Tab</a></nav>',
  '/covered': head + track + '<h1>Covered</h1><div style="height:900px"></div><button>Hidden action</button><div style="height:900px"></div>' +
    '<div style="position:fixed;left:0;right:0;top:25vh;height:50vh;background:rgba(0,0,0,.4)">Promo</div>',
};
createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return res.end('ok');
  if (url.pathname === '/log') { log.push(Object.fromEntries(url.searchParams)); return res.end(); }
  if (url.pathname === '/visits') return res.end(JSON.stringify(log));
  const page = pages[url.pathname];
  if (!page) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/html' }).end(page);
}).listen(5333, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`);

let lab;
const events = [];
before(async () => {
  lab = new Lab({ stateDir, onEvent: (e) => events.push(e) });
  await lab.start({ project, headed: false });
});
after(async () => {
  await lab?.close();
  rmSync(project, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});
const visits = async () => (await (await fetch(`${BASE}/visits`)).json());

test('each width runs in its own correctly sized context, starting from the session storage, without touching the session page', async () => {
  const goRef = lab.findRef({ role: 'button', name: 'Go' });
  const before = { gen: lab.lastObservation.gen, route: lab.lastObservation.route };
  const r = await lab.sweep({ route: '/' });
  assert.deepEqual(r.devices.map((d) => [d.device, d.width, d.status]), [
    ['mobile-320', 320, 'ok'], ['mobile-390', 390, 'ok'], ['tablet-768', 768, 'ok'], ['desktop-1440', 1440, 'ok'],
  ], 'serial, labelled results in the declared order');
  const sweepVisits = (await visits()).filter((v) => v.path === '/').slice(1);   // first is the session's own load
  assert.deepEqual(sweepVisits.map((v) => Number(v.w)), [320, 390, 768, 1440], 'each context has its own viewport');
  assert.deepEqual(sweepVisits.map((v) => Number(v.visits)), [2, 2, 2, 2], 'each starts from the session storage (1) and sees no other width\'s writes');
  assert.ok(r.devices.every((d) => d.findings.length === 0), 'a plain page is clean at every width');
  assert.ok(existsSync(r.report));

  // The session is exactly where it was: same generation, same route, refs still valid.
  assert.deepEqual({ gen: lab.lastObservation.gen, route: lab.lastObservation.route }, before);
  const click = await lab.act({ action: 'click', ref: goRef });
  assert.equal(click.outcome, 'success');
  assert.deepEqual(click.changes.messagesAdded, [{ role: 'status', text: 'went' }]);
});

test('findings are attributed to the width, route and control where they were measured', async () => {
  const r = await lab.sweep({ route: '/toolbar' });
  const byDevice = Object.fromEntries(r.devices.map((d) => [d.device, d.findings.map((id) => r.findings.find((f) => f.id === id))]));
  for (const device of ['mobile-320', 'mobile-390']) {
    const fs = byDevice[device];
    assert.ok(fs.every((f) => f.device === device && f.route === '/toolbar'), `${device} findings carry their device and route`);
    const pan = fs.find((f) => f.kind === 'horizontal-pan-required' && f.target.name === 'Export CSV');
    assert.ok(pan, `${device}: Export CSV needs a sideways pan`);
    assert.equal(pan.confidence, 'confirmed');
    assert.equal(pan.viewportWidth, Number(device.split('-')[1]));
    assert.equal(pan.target.ref, undefined, 'sweep refs are not actionable in the session, so they are not reported');
    assert.ok(fs.some((f) => f.kind === 'horizontal-overflow' && f.confidence === 'heuristic'));
    assert.match(pan.reproduction.at(-2), new RegExp(`sweep ${r.id}: open ${BASE}/toolbar in a new ${device} context`));
    assert.equal(pan.reproduction.at(-1), 'scroll button "Export CSV" into view');
  }
  assert.notEqual(byDevice['mobile-320'][0].id, byDevice['mobile-390'][0].id, 'the same defect at two widths is two findings');
  assert.deepEqual([byDevice['tablet-768'].length, byDevice['desktop-1440'].length], [0, 0], 'fits at 768 and 1440');

  // The session's own inspect is unchanged: sweep findings at other widths are not attributed to its controls.
  assert.ok(lab.inspect().findings.length >= 6);
  const frames = events.filter((e) => e.kind === 'findings' && e.findings.some((f) => f.route === '/toolbar'));
  assert.ok(frames.every((e) => e.frame && existsSync(e.frame)), 'every sweep finding has an evidence frame');
  const report = readFileSync(r.report, 'utf8');
  assert.match(report, /## mobile-320 \(320×568\) · \/toolbar/);
  assert.match(report, /\| F\d+ \| confirmed \| high \| horizontal-pan-required/);
  assert.match(report, /## tablet-768 \(768×1024\) · \/toolbar\n\nNo findings\./);
});

test('an intentional scroll region and a fixed bottom bar do not create findings on a clean route', async () => {
  const r = await lab.sweep({ route: '/carousel' });
  for (const d of r.devices) assert.deepEqual(d.findings, [], `${d.device}: carousel items and the button near the tab bar are reachable`);
  assert.ok(r.devices.every((d) => d.reachChecked >= 9));
});

test('a control covered even after scrolling is a confirmed obstruction', async () => {
  const r = await lab.sweep({ route: '/covered', devices: ['mobile-390', 'desktop-1440'] });
  for (const d of r.devices) {
    const f = r.findings.find((x) => d.findings.includes(x.id) && x.kind === 'control-obstructed');
    assert.ok(f, `${d.device}: obstruction found`);
    assert.equal(f.confidence, 'confirmed');
    assert.equal(f.severity, 'high');
    assert.match(f.evidence.coveredBy, /Promo/);
  }
  assert.ok(r.findings.every((f) => f.kind === 'control-obstructed'), 'no layout warnings on a page that fits');
});

test('unknown devices and non-path routes are rejected before any context opens', async () => {
  await assert.rejects(lab.sweep({ route: '/', devices: ['phone-9000'] }), { code: 'unknown_device' });
  await assert.rejects(lab.sweep({ route: 'http://elsewhere.example/' }), { code: 'invalid_request' });
});
