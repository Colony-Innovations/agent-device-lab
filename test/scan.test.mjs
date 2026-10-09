// Stateful responsive scan, end to end: isolation, setup and restoration, exploration safety, limits,
// detector correctness on the whole responsive fixture, reports, suppressions and policy.
// The fixture serves 5353 (the Lab starts it from a temp profile; a running copy is reused);
// the inline isolation app uses 5355. Never run this while another run owns those ports.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Lab } from '../dist/core/lab.js';

const FIXTURE = resolve('fixtures/responsive-app');
const FIXTURE_URL = 'http://127.0.0.1:5353';
const fixtureProfile = JSON.parse(readFileSync(join(FIXTURE, 'agentlab.json'), 'utf8'));

const temps = [];
const labs = new Set();
const tmp = (prefix) => { const d = mkdtempSync(join(tmpdir(), `agentlab-scan-${prefix}-`)); temps.push(d); return d; };
after(async () => {
  for (const lab of labs) await lab.close().catch(() => undefined);
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** A temp project for the fixture: its declared scenarios by default, any `scan` section overridden by `scan`. */
function fixtureProject(scan = {}, { scenarios } = {}) {
  const dir = tmp('proj');
  const profile = {
    ...fixtureProfile,
    services: { web: { ...fixtureProfile.services.web, command: 'node server.mjs', cwd: FIXTURE } },
    scan: { ...fixtureProfile.scan, ...scan, ...(scenarios ? { scenarios } : {}) },
  };
  writeFileSync(join(dir, 'agentlab.json'), JSON.stringify(profile));
  return dir;
}
const exploring = (explore = {}) => ({ explore: { enabled: false, maxDepth: 1, maxStates: 30, maxActionsPerState: 30, maxMs: 300000, ...explore } });

async function openLab(project) {
  const lab = new Lab({ stateDir: tmp('state') });
  labs.add(lab);
  await lab.start({ project, headed: false });
  return lab;
}
async function closeLab(lab) {
  await lab.close();
  labs.delete(lab);
}
/** Start a Lab on a project, scan, close it. */
async function scanProject(project, opts) {
  const lab = await openLab(project);
  try {
    return await lab.scan(opts);
  } finally {
    await closeLab(lab);
  }
}
const auditLog = async () => (await fetch(`${FIXTURE_URL}/audit-log`)).json();
const auditReset = async () => { assert.equal((await fetch(`${FIXTURE_URL}/audit-reset`, { method: 'POST' })).status, 204); };
const explored = (run) => run.states.filter((s) => s.depth >= 1);
const stateByLabel = (run, label) => run.states.find((s) => s.label === label);

// ---------------------------------------------------------------------------------------------
describe('isolation between runs (inline app on 5355)', () => {
  const BASE = 'http://127.0.0.1:5355';
  let lab;
  let result;
  let before;
  let sessionHeading;

  const server = `
import { createServer } from 'node:http';
const log = [];
const head = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>body{margin:0;font:16px sans-serif}button{height:44px;min-width:88px}</style>';
const home = head + '<h1>Home</h1><button id="d">Dirty</button><p id="out" role="status"></p><script>' +
  'const v = Number(localStorage.getItem("visits") || 0) + 1; localStorage.setItem("visits", v);' +
  'document.querySelector("h1").textContent = "Home visit " + v;' +
  'fetch("/log?visits=" + v + "&w=" + innerWidth + "&dirty=" + localStorage.getItem("dirty"));' +
  'd.onclick = () => { localStorage.setItem("dirty", "1"); out.textContent = "dirty"; };</script>';
createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return res.end('ok');
  if (url.pathname === '/log') { log.push(Object.fromEntries(url.searchParams)); return res.end(); }
  if (url.pathname === '/visits') return res.end(JSON.stringify(log));
  if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(home);
  res.writeHead(404).end();
}).listen(5355, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`;
  const visits = async () => (await fetch(`${BASE}/visits`)).json();

  test('every run starts from the session storage and no run\'s writes reach another run, device or the session', async () => {
    const project = tmp('iso');
    writeFileSync(join(project, 'server.mjs'), server);
    writeFileSync(join(project, 'agentlab.json'), JSON.stringify({
      schemaVersion: 2, name: 'iso',
      services: { web: { command: 'node server.mjs', cwd: project, url: BASE, env: { PORT: '5355' }, readiness: { path: '/health' } } },
      startPath: '/', device: 'mobile-390',
      scan: {
        devices: ['mobile-320', 'mobile-390'],
        scenarios: [
          { name: 'Make dirty', route: '/', steps: [{ do: 'click', role: 'button', name: 'Dirty', expect: { message: 'dirty' } }] },
          { name: 'Broken setup', route: '/', steps: [{ do: 'click', role: 'button', name: 'Nope' }] },
          { name: 'Clean look', route: '/' },
        ],
      },
    }));
    lab = await openLab(project);
    const initial = await visits();
    assert.deepEqual(initial.map((v) => v.visits), ['1'], 'the session loaded / once before the scan');
    assert.equal(initial[0].dirty, 'null');

    const o = lab.lastObservation;
    before = { gen: o.gen, route: o.route, controls: o.controls.map((c) => `${c.ref} ${c.role} ${c.name}`), headings: o.headings };
    sessionHeading = o.headings[0];
    result = await lab.scan();

    const runsSeen = (await visits()).slice(1);
    // Three scenarios on two devices: every run loads the page exactly once, from a copy of the session's storage.
    assert.equal(runsSeen.length, 6);
    assert.deepEqual(runsSeen.map((v) => v.visits), ['2', '2', '2', '2', '2', '2'], 'never 3 or more: no run sees another run\'s visit count');
    assert.deepEqual(runsSeen.map((v) => v.dirty), Array(6).fill('null'), 'the Dirty write of "Make dirty" never reaches a later run, device or scenario');
    assert.deepEqual(runsSeen.map((v) => Number(v.w)), [320, 390, 320, 390, 320, 390], 'each run\'s viewport matches its device, in scenario then device order');
  });

  test('the run results are per scenario and device, and a failed step is contained', () => {
    assert.deepEqual(result.runs.map((r) => [r.scenario, r.device, r.status]), [
      ['Make dirty', 'mobile-320', 'ok'], ['Make dirty', 'mobile-390', 'ok'],
      ['Broken setup', 'mobile-320', 'failed'], ['Broken setup', 'mobile-390', 'failed'],
      ['Clean look', 'mobile-320', 'ok'], ['Clean look', 'mobile-390', 'ok'],
    ]);
    for (const r of result.runs.filter((x) => x.scenario === 'Broken setup')) {
      assert.equal(r.failedAt, 'setup');
      assert.match(r.error.message, /setup step 1/);
      assert.match(r.error.message, /Nope/, 'the error names the step');
      assert.deepEqual(r.states, [], 'no state was measured');
    }
    for (const r of result.runs.filter((x) => x.status === 'ok')) assert.equal(r.states.length, 1);
    assert.equal(lab.status().active, true, 'a failed scenario does not end the session');
    assert.equal(result.verdict.result, 'pass', 'failOnErrors is off by default');
  });

  test('the session page is untouched and still observable after the scan', async () => {
    const o = lab.lastObservation;
    assert.deepEqual({ gen: o.gen, route: o.route, controls: o.controls.map((c) => `${c.ref} ${c.role} ${c.name}`), headings: o.headings }, before,
      'the session\'s last observation is unchanged');
    const fresh = await lab.observe();
    assert.equal(fresh.route, '/');
    assert.deepEqual(fresh.headings, [sessionHeading], 'the session page was not reloaded or re-run (still visit 1)');
    assert.equal(sessionHeading, 'h1 Home visit 1');
    assert.ok(fresh.controls.some((c) => c.role === 'button' && c.name === 'Dirty'));
    assert.equal(fresh.messages.length, 0, 'the "dirty" status of the scenario never appeared in the session');
    await closeLab(lab);
    assert.equal((await fetch(`${BASE}/health`).catch(() => undefined))?.ok, undefined, 'the lab stopped the app it started');
  });
});

// ---------------------------------------------------------------------------------------------
describe('setup and restoration (fixture)', () => {
  let result;
  let filters;

  test('exploration restores the base state between explored states', async () => {
    const lab = await openLab(fixtureProject(exploring()));
    try {
      result = await lab.scan({ route: '/', explore: true, devices: ['mobile-390'] });
      filters = await lab.scan({ scenarios: ['Filters drawer'], devices: ['mobile-390'], explore: false });
    } finally {
      await closeLab(lab);
    }
    assert.equal(result.runs.length, 1);
    const run = result.runs[0];
    assert.equal(run.status, 'ok');
    assert.ok(run.states.every((s) => s.status === 'measured'), JSON.stringify(run.states.filter((s) => s.status !== 'measured')));

    const menu = stateByLabel(run, 'button "Menu"');
    assert.ok(menu, `states: ${run.states.map((s) => s.label).join(' | ')}`);
    assert.equal(menu.restore, 'toggle');
    const drawer = stateByLabel(run, 'button "Filters"');
    assert.equal(drawer.dialog, 'Refine results');
    assert.ok(['escape', 'toggle'].includes(drawer.restore), `Filters restore was ${drawer.restore}`);
    const specs = stateByLabel(run, 'tab "Specs"');
    assert.equal(specs.restore, 'toggle');
    const reviews = stateByLabel(run, 'tab "Reviews"');
    assert.ok(reviews, 'the Reviews tab was explored after Specs');

    const clipped = result.findings.filter((f) => f.kind === 'text-clipped');
    assert.equal(clipped.length, 1);
    assert.match(clipped[0].target.name, /^Battery/);
    const [f] = clipped;
    assert.ok(specs.findings.includes(f.id), 'the clipped Battery text appears once the Specs tab is selected');
    assert.ok(!run.states.find((s) => s.id === 's0').findings.includes(f.id), 'it is not in the base state');
    assert.ok(!reviews.findings.includes(f.id), 'and it is gone in the state explored after Specs, so the scan returned to the base first');
    assert.ok(!menu.findings.includes(f.id));
    for (const s of run.states) assert.equal(s.depth, s.id === 's0' ? 0 : 1);
  });

  test('a declared scenario\'s setup steps reach their state ("Filters drawer")', () => {
    const run = filters.runs[0];
    assert.equal(run.scenario, 'Filters drawer');
    assert.equal(run.status, 'ok');
    const s0 = run.states[0];
    assert.equal(s0.id, 's0');
    assert.equal(s0.label, 'after setup');
    assert.equal(s0.dialog, 'Refine results');
    assert.deepEqual(explored(run), [], 'explore:false explores nothing');
  });
});

// ---------------------------------------------------------------------------------------------
describe('exploration safety (fixture)', () => {
  const settings = { route: '/settings', explore: true, devices: ['mobile-390'] };

  test('only safe controls are activated; every consequential one is skipped with a reason; the audit log stays empty', async () => {
    // The audit log lives in the fixture server the Lab starts, so it is read before the Lab stops it.
    const lab = await openLab(fixtureProject(exploring({ maxDepth: 2 })));
    let result;
    try {
      await auditReset();
      result = await lab.scan(settings);
      assert.deepEqual(await auditLog(), [], 'nothing consequential was activated');
    } finally {
      await closeLab(lab);
    }
    const run = result.runs[0];
    assert.equal(run.status, 'ok');
    assert.deepEqual(explored(run).map((s) => s.label).sort(), ['button "Account actions"', 'button "Advanced options"', 'button "Notifications"']);
    assert.ok(run.states.every((s) => s.blocked === undefined && s.status === 'measured'), 'no state needed the request guard');
    for (const name of ['Delete workspace', 'Cancel booking', 'Apply changes', 'Help centre', 'Upload avatar', 'More', 'Remove card', 'Rename', 'Delete account', 'Log out']) {
      const d = run.decisions.find((x) => x.name === name);
      assert.ok(d, `a decision for "${name}"`);
      assert.equal(d.verdict, 'skip', `${name} is skipped`);
      assert.ok(d.reason && d.reason.length > 0, `${name} has a reason`);
    }
    assert.match(run.decisions.find((d) => d.name === 'Help centre').reason, /external/i);
    assert.match(run.decisions.find((d) => d.name === 'More').reason, /ambiguous/i);
    assert.equal(run.decisionsOmitted, 0);
    for (const name of ['Account actions', 'Advanced options', 'Notifications']) {
      assert.equal(run.decisions.find((d) => d.name === name).verdict, 'explore');
    }
  });

  test('the request guard blocks a control that was allowed but sends data, and the audit log still stays empty', async () => {
    const lab = await openLab(fixtureProject(exploring({ maxDepth: 2, allow: [{ role: 'button', name: 'More' }] })));
    let result;
    try {
      await auditReset();
      result = await lab.scan(settings);
      assert.deepEqual(await auditLog(), [], 'the POST was blocked before it reached the server');
    } finally {
      await closeLab(lab);
    }
    const run = result.runs[0];
    const more = stateByLabel(run, 'button "More"');
    assert.ok(more, 'the allow-listed control was tried');
    assert.equal(more.status, 'blocked');
    assert.ok(more.blocked.some((b) => b.includes('POST /audit')), JSON.stringify(more.blocked));
    const d = run.decisions.find((x) => x.name === 'More');
    assert.equal(d.verdict, 'skip');
    assert.match(d.reason, /sent/);
    assert.equal(run.status, 'ok', 'a blocked control does not fail the run');
    assert.ok(explored(run).filter((s) => s !== more).every((s) => s.status === 'measured'), 'the other states were still measured');
  });
});

// ---------------------------------------------------------------------------------------------
describe('exploration limits', () => {
  const home = { route: '/', explore: true, devices: ['mobile-390'] };
  const limited = (explore) => scanProject(fixtureProject(exploring(explore)), home);

  test('maxStates', async () => {
    const r = await limited({ maxStates: 2 });
    const run = r.runs[0];
    assert.equal(explored(run).length, 2);
    assert.ok(run.limits.some((l) => l.startsWith('maxStates (2)')), run.limits.join(' / '));
    assert.equal(typeof r.exploreMs, 'number');
    assert.ok(r.exploreMs > 0);
  });

  test('maxActionsPerState', async () => {
    const r = await limited({ maxActionsPerState: 1 });
    const run = r.runs[0];
    assert.ok(run.limits.some((l) => l.startsWith('maxActionsPerState (1)')), run.limits.join(' / '));
    assert.equal(explored(run).length, 1);
    assert.equal(typeof r.exploreMs, 'number');
  });

  test('maxDepth', async () => {
    const r = await limited({ maxDepth: 1 });
    assert.ok(r.runs[0].states.every((s) => s.depth <= 1));
    assert.ok(explored(r.runs[0]).length >= 5, 'depth 1 still explores every candidate of the base state');
    assert.deepEqual(r.runs[0].limits, [], 'nothing was cut short');
    // One level deeper does reach states opened from a state (the drawer's toggles), and none beyond the limit.
    const deeper = await limited({ maxDepth: 2 });
    assert.ok(deeper.runs[0].states.some((s) => s.depth === 2), 'depth 2 reaches states inside the drawer');
    assert.ok(deeper.runs[0].states.every((s) => s.depth <= 2));
  });

  test('maxMs', async () => {
    const r = await limited({ maxMs: 1 });
    const run = r.runs[0];
    assert.ok(run.limits.some((l) => l.startsWith('maxMs')), run.limits.join(' / '));
    assert.ok(explored(run).length <= 1);
    assert.equal(typeof r.exploreMs, 'number');
    assert.equal(run.status, 'ok');
  });
});

// ---------------------------------------------------------------------------------------------
describe('detector correctness on the whole fixture', () => {
  let result;
  let scanMs;

  test('the fixture as shipped produces exactly the seeded findings, and nothing else', async () => {
    const t0 = Date.now();
    result = await scanProject(FIXTURE);
    scanMs = Date.now() - t0;
    assert.equal(result.runs.length, 38, '9 scenarios on 4 devices and "Mobile menu" on 2');
    assert.ok(result.runs.every((r) => r.status === 'ok'), JSON.stringify(result.runs.filter((r) => r.status !== 'ok').map((r) => [r.scenario, r.device, r.error])));
    assert.equal(result.explore, false);

    const all4 = ['desktop-1440', 'mobile-320', 'mobile-390', 'tablet-768'];
    const expected = [
      { kind: 'modal-overflow', name: 'Edit profile', severity: 'high', confidence: 'confirmed', devices: all4 },
      { kind: 'fixed-collision', name: 'Pay now', severity: 'high', confidence: 'confirmed' },
      { kind: 'control-obstructed', name: 'Place order', severity: 'high', confidence: 'confirmed' },
      { kind: 'content-under-fixed', name: /^By placing this order/ },
      { kind: 'tap-target', name: 'Like', severity: 'medium', confidence: 'confirmed' },
      { kind: 'tap-target', name: 'Share', severity: 'medium', confidence: 'confirmed' },
      { kind: 'tap-target', name: 'Save', severity: 'medium', confidence: 'confirmed' },
      { kind: 'text-truncated', name: 'Add to wishlist and notify me when back in stock', severity: 'medium', confidence: 'confirmed' },
      { kind: 'text-truncated', name: 'Waterproof trail running shoes with reinforced toe', severity: 'low', confidence: 'heuristic' },
      { kind: 'text-clipped', name: /^Battery:/, confidence: 'confirmed', scenarios: ['Specs tab'] },
      { kind: 'layout-shift', name: 'layout', confidence: 'confirmed', route: '/news' },
      { kind: 'text-wrap-change', name: 'Show 12 results', severity: 'low', confidence: 'confirmed', devices: ['mobile-320'], scenarios: ['Filters drawer'] },
    ];
    const matches = (g, e) => g.kind === e.kind && (e.name instanceof RegExp ? e.name.test(g.target?.name ?? '') : g.target?.name === e.name);
    const unexpected = result.groups.filter((g) => !expected.some((e) => matches(g, e)));
    assert.deepEqual(unexpected.map((g) => g.title), [], 'no group beyond the seeded defects');
    assert.equal(result.groups.length, expected.length, result.groups.map((g) => g.title).join('\n'));
    for (const e of expected) {
      const found = result.groups.filter((g) => matches(g, e));
      assert.equal(found.length, 1, `exactly one group for ${e.kind} ${e.name}`);
      const [g] = found;
      const at = `${e.kind} ${e.name}`;
      if (e.severity) assert.equal(g.severity, e.severity, `${at}: severity`);
      if (e.confidence) assert.equal(g.confidence, e.confidence, `${at}: confidence`);
      if (e.devices) assert.deepEqual(g.devices, e.devices, `${at}: devices`);
      if (e.scenarios) assert.deepEqual(g.scenarios, e.scenarios, `${at}: scenarios`);
      if (e.route) assert.equal(g.route, e.route, `${at}: route`);
    }
    const shift = result.groups.find((g) => g.kind === 'layout-shift');
    assert.ok(shift.devices.includes('mobile-320'));
  });

  test('the wrap comparison reports the drawer footer with both widths as evidence', () => {
    const f = result.findings.find((x) => x.kind === 'text-wrap-change');
    assert.equal(f.device, 'mobile-320');
    assert.equal(f.evidence.harm, 'cosmetic');
    assert.equal(f.evidence.linesNarrow, 2);
    assert.equal(f.evidence.linesWide, 1);
    assert.equal(f.frames.length, 2);
    assert.deepEqual(f.frames.map((x) => x.device), ['mobile-320', 'mobile-390']);
    for (const fr of f.frames) assert.ok(existsSync(fr.path), fr.path);
    assert.equal(result.findings.filter((x) => x.kind === 'text-wrap-change').length, 1, 'nothing is reported at 390 px, where both buttons fit');
  });

  test('clean scenarios have no findings, intentional patterns are never reported, no heuristic is high', () => {
    for (const name of ['About (clean)', 'Contact form with an error']) {
      const runs = result.runs.filter((r) => r.scenario === name);
      assert.equal(runs.length, 4);
      for (const r of runs) assert.deepEqual(r.findings, [], `${name} @ ${r.device}`);
    }
    const intentional = /Feature|Deal|Sizes chart|Compare|size guide/;
    for (const f of result.findings) {
      const text = `${f.target?.name ?? ''} ${f.message}`;
      assert.doesNotMatch(text, intentional, `${f.id} ${f.kind}: ${text}`);
      assert.ok(!['S', 'M', 'L'].includes(f.target?.name), `${f.id} targets ${f.target?.name}`);
      assert.ok(!(f.confidence === 'heuristic' && f.severity === 'high'), `${f.id} is a high heuristic`);
    }
    // The Featured carousel and the sizes table scroll inside their own regions: nothing about the page being wider than the screen.
    assert.ok(!result.findings.some((f) => ['horizontal-overflow', 'content-scroll-x', 'horizontal-pan-required'].includes(f.kind)));
  });

  test('every finding is complete and reproducible', () => {
    assert.ok(result.findings.length > 0);
    for (const f of result.findings) {
      const at = `${f.id} ${f.kind}`;
      for (const k of ['id', 'device', 'scenario', 'route', 'state', 'severity', 'confidence']) assert.ok(f[k], `${at}: ${k}`);
      assert.equal(typeof f.confidenceScore, 'number', `${at}: confidenceScore`);
      assert.ok(f.confidenceScore > 0 && f.confidenceScore <= 1, `${at}: confidenceScore ${f.confidenceScore}`);
      assert.equal(typeof f.evidence, 'object', `${at}: evidence`);
      assert.ok(f.evidence && Object.keys(f.evidence).length > 0, `${at}: evidence`);
      assert.ok(f.target?.role && f.target?.name, `${at}: target`);
      assert.ok(f.reproduction.length >= 2 && /^open /.test(f.reproduction[0]), `${at}: reproduction starts with the session's open step: ${f.reproduction[0]}`);
      assert.ok(f.frame && existsSync(f.frame), `${at}: frame ${f.frame}`);
      assert.equal(typeof f.detector?.name, 'string', `${at}: detector`);
      assert.equal(typeof f.detector?.version, 'number', `${at}: detector version`);
    }
    for (const g of result.groups) {
      assert.ok(g.id && g.findings.length && g.title, g.id);
      for (const id of g.findings) assert.ok(result.findings.some((f) => f.id === id), `${g.id} refers to ${id}`);
    }
  });

  test('reports: result.json equals the returned result, report.html lists scenarios and both confidence sections', () => {
    const json = JSON.parse(readFileSync(result.reports.json, 'utf8'));
    assert.deepEqual(json.verdict, result.verdict);
    assert.equal(json.id, result.id);
    assert.deepEqual(json.groups, result.groups);
    assert.equal(json.runs.length, result.runs.length);
    assert.deepEqual(json.findings.map((f) => f.id), result.findings.map((f) => f.id));
    assert.ok(existsSync(result.reports.html));
    const html = readFileSync(result.reports.html, 'utf8');
    for (const name of [...new Set(result.runs.map((r) => r.scenario))]) assert.ok(html.includes(name), `report.html mentions "${name}"`);
    assert.ok(html.includes('Confirmed problems'));
    assert.ok(html.includes('Heuristic warnings'));
    assert.ok(scanMs > 0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('suppressions and policy', () => {
  const homeOnly = [{ name: 'Home as loaded', route: '/' }];
  const broken = { name: 'Broken setup', route: '/', steps: [{ do: 'click', role: 'button', name: 'Nope' }] };
  const scanHome = (scan, opts = { devices: ['mobile-390'] }) => scanProject(fixtureProject({ devices: ['mobile-390'], ...scan }, { scenarios: homeOnly }), opts);

  test('documented suppressions are applied, expired, not evaluated or unmatched, and suppressed findings stay reported', async () => {
    const r = await scanHome({
      suppressions: [
        { kind: 'tap-target', target: { name: 'Like' }, reason: 'known', expires: '2999-01-01' },
        { kind: 'tap-target', target: { name: 'Share' }, reason: 'old', expires: '2000-01-01' },
        { kind: 'tap-target', scenario: 'Checkout', reason: 'x' },
        { kind: 'modal-overflow', reason: 'x' },
      ],
    });
    assert.deepEqual(r.suppressions.map((s) => [s.rule, s.status]), [[0, 'applied'], [1, 'expired'], [2, 'not-evaluated'], [3, 'unmatched']]);
    const like = r.findings.find((f) => f.kind === 'tap-target' && f.target.name === 'Like');
    const share = r.findings.find((f) => f.kind === 'tap-target' && f.target.name === 'Share');
    const save = r.findings.find((f) => f.kind === 'tap-target' && f.target.name === 'Save');
    assert.deepEqual(r.suppressions[0].matched, [like.id]);
    assert.equal(like.suppressed.reason, 'known');
    assert.equal(like.suppressed.rule, 0);
    assert.equal(share.suppressed, undefined, 'an expired suppression does not apply');
    assert.equal(save.suppressed, undefined);
    assert.deepEqual(r.suppressions[1].matched, []);
    const group = r.groups.find((g) => g.findings.includes(like.id));
    assert.equal(group.suppressed, true);
    assert.equal(r.groups.find((g) => g.findings.includes(share.id)).suppressed, false);
    assert.ok(r.findings.some((f) => f.id === like.id), 'the suppressed finding is still reported');
    assert.ok(r.runs[0].findings.includes(like.id));
    assert.equal(r.verdict.result, 'pass');
    assert.ok(r.verdict.reasons.some((x) => /suppressed/.test(x)));
  });

  test('default policy passes: only medium confirmed findings and heuristic warnings', async () => {
    const r = await scanHome({});
    assert.equal(r.verdict.result, 'pass');
    assert.deepEqual(r.verdict.policy, { failOn: 'high', failOnErrors: false, failOnHeuristic: false });
    assert.ok(r.findings.length > 0);
    assert.ok(r.findings.every((f) => (f.confidence === 'confirmed' && f.severity === 'medium') || f.confidence === 'heuristic'),
      r.findings.map((f) => `${f.kind} ${f.severity} ${f.confidence}`).join(', '));
    assert.ok(r.findings.some((f) => f.confidence === 'confirmed'));
    assert.ok(r.findings.some((f) => f.confidence === 'heuristic'));
  });

  test('failOn medium fails, listing the finding ids that count and not the suppressed one', async () => {
    const r = await scanHome({
      policy: { failOn: 'medium' },
      suppressions: [{ kind: 'tap-target', target: { name: 'Like' }, reason: 'known', expires: '2999-01-01' }],
    });
    assert.equal(r.verdict.result, 'fail');
    const like = r.findings.find((f) => f.target?.name === 'Like');
    assert.ok(like.suppressed);
    const counted = r.findings.filter((f) => f.confidence === 'confirmed' && f.severity !== 'low' && !f.suppressed);
    assert.ok(counted.length >= 3, 'Share, Save and the wishlist button count');
    const reason = r.verdict.reasons.find((x) => /at or above medium/.test(x));
    assert.ok(reason, r.verdict.reasons.join(' / '));
    for (const f of counted) assert.match(reason, new RegExp(`\\b${f.id}\\b`), `${f.id} (${f.target.name}) is listed`);
    assert.doesNotMatch(reason, new RegExp(`\\b${like.id}\\b`), 'the suppressed Like finding is not listed');
  });

  test('a failed scenario run fails the scan only with failOnErrors', async () => {
    const scenarios = [...homeOnly, broken];
    const strict = await scanProject(fixtureProject({ devices: ['mobile-390'], policy: { failOnErrors: true } }, { scenarios }), { devices: ['mobile-390'] });
    assert.deepEqual(strict.runs.map((r) => [r.scenario, r.status, r.failedAt]), [['Home as loaded', 'ok', undefined], ['Broken setup', 'failed', 'setup']]);
    assert.equal(strict.verdict.result, 'fail');
    assert.ok(strict.verdict.reasons.some((x) => /failed/.test(x) && x.includes('Broken setup')), strict.verdict.reasons.join(' / '));

    const lenient = await scanProject(fixtureProject({ devices: ['mobile-390'], policy: { failOnErrors: false } }, { scenarios }), { devices: ['mobile-390'] });
    assert.equal(lenient.runs[1].status, 'failed');
    assert.equal(lenient.verdict.result, 'pass');
    assert.ok(lenient.verdict.reasons.some((x) => /failed/.test(x) && x.includes('Broken setup')), 'the failed run is still named in the reasons');
    assert.ok(lenient.runs[0].findings.length > 0, 'the other scenario was still checked');
  });
});
