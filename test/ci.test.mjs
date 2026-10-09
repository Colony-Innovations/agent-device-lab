// CI mode: `agentlab test`, `sweep --project`, `scenario --project` and `report`: exit codes, artifacts, policy,
// suppressions, timeouts, signals and secret handling. Apps use ports 5373 to 5376.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readZip } from '../dist/core/zip.js';
import { parseDuration, xml, resolveCi, failingFindings } from '../dist/core/ci.js';
import { parseProfile } from '../dist/core/profile.js';
import { authStateFromEnv } from '../dist/core/auth.js';
import { describeStep } from '../dist/core/steps.js';

const temps = [];
const home = mkdtempSync(join(tmpdir(), 'agentlab-ci-home-'));
temps.push(home);
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const SERVER = `
import { createServer } from 'node:http';
const port = Number(process.env.PORT);
const delay = Number(process.env.DELAY_MS || 0);
const token = process.env.DEMO_TOKEN || '';
const t0 = Date.now();
const head = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">';
const boot = '<script>console.error("boot " + ' + JSON.stringify(token) + ' + " " + document.cookie);</script>';
const pages = {
  '/': head + '<h1>Home</h1><button>Hello</button>' + boot,
  '/pan': head + '<h1>Wide</h1><div style="width:1000px"><button style="margin-left:700px;height:48px">Far away</button></div>',
  '/login': head + '<h1>Sign in</h1><label>Password <input id="pw" type="password"></label><label>Senha <input id="pw2" type="password"></label><button id="go">Sign in</button>' + boot +
    '<script>go.onclick = () => console.error("login attempt with " + pw.value);</script>',
};
console.log('server starting with token ' + token);
createServer((req, res) => {
  if (req.url === '/health') { if (Date.now() - t0 < delay) return res.writeHead(503).end('starting'); return res.end('ok'); }
  const body = pages[req.url.split('?')[0]];
  if (!body) return res.writeHead(404).end('no');
  res.writeHead(200, { 'content-type': 'text/html' }).end(body);
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`;

/** A temp project serving the demo app on `port`; `extra` is merged into agentlab.json. */
function project({ port = 5373, env = {}, requiredEnv, extra = {}, files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agentlab-ci-proj-'));
  temps.push(dir);
  writeFileSync(join(dir, 'server.mjs'), SERVER);
  writeFileSync(join(dir, 'agentlab.json'), JSON.stringify({
    schemaVersion: 2, name: 'ci-demo',
    services: { web: { command: 'node server.mjs', url: `http://127.0.0.1:${port}`, env: { PORT: String(port), ...env }, readiness: { path: '/health', timeoutMs: 60_000 }, ...(requiredEnv ? { requiredEnv } : {}) } },
    app: { service: 'web' },
    ...extra,
  }));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  return dir;
}

function agentlab(args, { env = {}, cwd, onStderr } = {}) {
  const child = spawn(process.execPath, [join(process.cwd(), 'bin/agentlab.js'), ...args], {
    env: { ...process.env, AGENTLAB_HOME: home, ...env }, stdio: ['ignore', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}),
  });
  const done = new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; onStderr?.(stderr); });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return Object.assign(done, { child });
}
const run = (args, opts) => agentlab(args, opts);

const files = (root, rel = '') => readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(root, join(rel, e.name)) : [join(rel, e.name)]);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const portOpen = (port) => new Promise((resolve) => {
  const s = createConnection({ port, host: '127.0.0.1' }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});
const outDir = () => { const d = mkdtempSync(join(tmpdir(), 'agentlab-ci-out-')); temps.push(d); return join(d, 'results'); };

/** A minimal well-formedness check: balanced tags, every `&` an entity, one root. */
function assertWellFormed(text) {
  assert.match(text, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.doesNotMatch(text, /&(?!(amp|lt|gt|quot|apos);)/, 'unescaped ampersand');
  const stack = [];
  let roots = 0;
  for (const m of text.replace(/^<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([A-Za-z][\w.-]*)((?:\s+[\w.-]+="[^"<]*")*)\s*(\/?)>/g)) {
    const [, close, name, , selfClose] = m;
    if (close) assert.equal(stack.pop(), name, `closing ${name}`);
    else if (!selfClose) { if (!stack.length) roots++; stack.push(name); } else if (!stack.length) roots++;
  }
  assert.equal(stack.length, 0, 'unclosed tags');
  assert.equal(roots, 1, 'one root element');
  // Every `<` in the text is part of a tag matched above.
  const stripped = text.replace(/<[^>]*>/g, '');
  assert.doesNotMatch(stripped, /[<>]/, 'stray angle bracket');
}

const PAN_SUPPRESSION = { kind: 'horizontal-pan-required', reason: 'known wide layout (TEST-1)' };
const PAN = { ci: { routes: ['/pan'], devices: ['mobile-320'] } };

// ---------- pure parts ----------

test('a step label never carries a fill value, whatever the field is called', () => {
  for (const name of ['Senha', 'Password', 'Email']) {
    const label = describeStep({ do: 'fill', role: 'textbox', name, value: 'Zq9hunter2' });
    assert.equal(label, `fill textbox ${JSON.stringify(name)}`);
  }
  assert.equal(describeStep({ do: 'press', role: 'textbox', name: 'Senha', key: 'x' }), 'press a character in textbox "Senha"');
  assert.equal(describeStep({ do: 'press', key: 'Enter' }), 'press Enter');
});

test('durations, XML escaping and the ci section parse strictly', () => {
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('15m'), 900_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('1500ms'), 1500);
  assert.equal(parseDuration('soon'), undefined);
  assert.equal(xml('a<b>&"c\'\u0001'), 'a&lt;b&gt;&amp;&quot;c&apos;');
  const base = { schemaVersion: 2, name: 'p', services: { web: { command: 'x', url: 'http://127.0.0.1:1', readiness: { path: '/' } } }, app: { service: 'web' } };
  const p = parseProfile({ ...base, ci: { flows: ['a.json'], scenarios: 'all', failOn: 'medium', trace: 'always', timeoutMs: 5000, auth: 'env' } }, '/tmp/x/agentlab.json');
  assert.deepEqual(p.ci.flows, ['a.json']);
  assert.equal(p.ci.scenarios, 'all');
  assert.throws(() => parseProfile({ ...base, ci: { flow: ['a.json'] } }, '/tmp/x/agentlab.json'), /unknown key "flow" in "ci" \(did you mean "flows"\?\)/);
  assert.throws(() => parseProfile({ ...base, ci: { failOn: 'sometimes', routes: ['x'] } }, '/tmp/x/agentlab.json'), /ci\.routes.*ci\.failOn/);
});

test('selection: defaults, flags over profile, and every problem listed', () => {
  const base = { schemaVersion: 2, name: 'p', services: { web: { command: 'x', url: 'http://127.0.0.1:1', readiness: { path: '/' } } }, app: { service: 'web' }, startPath: '/start' };
  const withScenarios = { ...base, scan: { scenarios: [{ name: 'A', route: '/a' }, { name: 'B', route: '/b' }] } };
  const at = (raw) => parseProfile(raw, '/tmp/x/agentlab.json');
  assert.deepEqual(resolveCi(at(base), { command: 'test', positionals: [] }, {}).selections.routes, ['/start'], 'nothing selected: the start path');
  const s = resolveCi(at(withScenarios), { command: 'test', positionals: [] }, {}).selections;
  assert.deepEqual([s.scenarios, s.routes, s.auth, s.evidence, s.trace, s.scenarioErrors], [['A', 'B'], [], 'fresh', 'on-failure', 'off', 'fail']);
  assert.equal(resolveCi(at(withScenarios), { command: 'test', positionals: [] }, { AGENTLAB_AUTH_STATE: '{}' }).selections.auth, 'env');
  const flagged = resolveCi(at({ ...withScenarios, ci: { scenarios: ['A'], failOn: 'low' } }), { command: 'test', positionals: [], scenarios: 'B', failOn: 'none', timeout: '15m' }, {});
  assert.deepEqual([flagged.selections.scenarios, flagged.selections.failOn, flagged.selections.timeoutMs], [['B'], 'none', 900_000]);
  const bad = resolveCi(at(withScenarios), { command: 'scenario', positionals: ['Nope'], devices: 'mobile-1', failOn: 'x', timeout: 'soon' }, {});
  assert.equal(bad.problems.length, 4, bad.problems.join(' | '));
  assert.match(bad.problems.join('\n'), /Nope.*declared: A, B/);
});

test('failing findings: confirmed at or above failOn, heuristics only on request, suppressed never', () => {
  const f = (id, severity, confidence, suppressed) => ({ id, severity, confidence, ...(suppressed ? { suppressed: { rule: 0, reason: 'x' } } : {}) });
  const all = [f('F1', 'high', 'confirmed'), f('F2', 'medium', 'confirmed'), f('F3', 'high', 'heuristic'), f('F4', 'high', 'confirmed', true)];
  assert.deepEqual(failingFindings(all, { failOn: 'high', failOnHeuristic: false }).map((x) => x.id), ['F1']);
  assert.deepEqual(failingFindings(all, { failOn: 'medium', failOnHeuristic: true }).map((x) => x.id), ['F1', 'F2', 'F3']);
  assert.deepEqual(failingFindings(all, { failOn: 'none', failOnHeuristic: true }), []);
});

test('an auth state from the environment is checked like a saved one and never quotes its input', () => {
  const state = { cookies: [{ name: 'sid', value: 'v'.repeat(12), domain: '127.0.0.1', path: '/', expires: -1 }], origins: [] };
  assert.equal(authStateFromEnv(JSON.stringify(state)).cookies[0].name, 'sid');
  assert.equal(authStateFromEnv(Buffer.from(JSON.stringify(state)).toString('base64')).cookies.length, 1);
  const expired = { cookies: [{ name: 'sid', value: 'v'.repeat(12), domain: '127.0.0.1', path: '/', expires: 1 }], origins: [] };
  assert.throws(() => authStateFromEnv(JSON.stringify(expired)), /past its expiry/);
  assert.throws(() => authStateFromEnv('{"cookies": SECRET_TOKEN_9999'), (e) => !e.message.includes('SECRET_TOKEN_9999') && /neither JSON nor base64/.test(e.message));
  assert.throws(() => authStateFromEnv('{"cookies":[]}'), /needs "cookies" and "origins"/);
});

// ---------- runs ----------

test('a clean app passes: exit 0, every artifact, well-formed JUnit, the summary printed', async () => {
  const dir = project({ extra: { ci: { routes: ['/'], devices: ['mobile-390'] }, scan: { scenarios: [{ name: 'Home', route: '/', devices: ['mobile-390'] }] } } });
  const out = outDir();
  const r = await run(['test', '--project', dir, '--out', out]);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^agentlab test: PASS \(exit 0\)/);
  for (const f of ['ci-result.json', 'summary.txt', 'report.html', 'junit.xml', 'scan/report.html']) {
    assert.ok(existsSync(join(out, f)), `${f} exists`);
    assert.equal(statSync(join(out, f)).mode & 0o777, 0o600, `${f} is owner-only`);
  }
  assert.equal(statSync(out).mode & 0o777, 0o700);
  assertWellFormed(readFileSync(join(out, 'junit.xml'), 'utf8'));
  const result = readJson(join(out, 'ci-result.json'));
  assert.equal(result.schema, 'agentlab.ci-result');
  assert.equal(result.version, 1);
  assert.equal(result.verdict.result, 'pass');
  assert.equal(result.verdict.exitCode, 0);
  assert.equal(result.sweeps[0].devices[0].status, 'ok');
  assert.equal(result.environment.auth, 'fresh');
  assert.ok(!existsSync(join(out, 'frames')), 'no frames are copied when passing');
  assert.equal(readFileSync(join(out, 'summary.txt'), 'utf8'), r.stdout.split('results: ')[0]);
  assert.ok(!(await portOpen(5373)), 'the service was stopped');
});

test('a confirmed defect fails the policy: exit 1, a bundle, evidence frames and a JUnit failure', async () => {
  const dir = project({ extra: PAN });
  const out = outDir();
  const r = await run(['sweep', '--project', dir, '--out', out]);
  assert.equal(r.code, 1, r.stderr + r.stdout);
  assert.match(r.stdout, /agentlab sweep: FAIL \(exit 1\)/);
  assert.match(r.stdout, /confirmed finding.* at or above high severity/);
  const result = readJson(join(out, 'ci-result.json'));
  assert.equal(result.verdict.result, 'fail');
  assert.ok(result.verdict.failingFindings.length >= 1);
  assert.ok(result.groups.some((g) => g.kind === 'horizontal-pan-required' && result.verdict.failingGroups.includes(g.id)));
  // Bundle for the findings, replayable metadata inside.
  assert.equal(result.bundles.length, 1);
  const bundle = readJson(join(out, result.bundles[0].dir, 'bundle.json'));
  assert.equal(bundle.failure.kind, 'findings');
  assert.ok(bundle.failure.fingerprints.length >= 1);
  // Frames are copied and the findings point at the copies by relative path.
  const framed = result.findings.filter((f) => f.frame);
  assert.ok(framed.length >= 1);
  for (const f of framed) { assert.match(f.frame, /^frames\/\d{3}-[\w.-]+\.jpg$/); assert.ok(statSync(join(out, f.frame)).size > 100); }
  assert.match(readFileSync(join(out, 'report.html'), 'utf8'), /<img src="frames\/\d{3}-/);
  // JUnit: a failing testcase for the width, well-formed.
  const junit = readFileSync(join(out, 'junit.xml'), 'utf8');
  assertWellFormed(junit);
  assert.match(junit, /<testsuite name="agentlab\.sweeps" tests="1" failures="1"/);
  assert.match(junit, /<failure message="F\d+ \[high, confirmed\]/);
  assert.ok(!(await portOpen(5373)));
});

test('--fail-on none passes the same run; a suppression passes it and is listed as suppressed', async () => {
  const dir = project({ extra: PAN });
  const none = await run(['sweep', '--project', dir, '--out', outDir(), '--fail-on', 'none']);
  assert.equal(none.code, 0, none.stderr + none.stdout);
  assert.match(none.stdout, /agentlab sweep: PASS/);
  assert.match(none.stdout, /not counted \(failOn is none\)/);

  const suppressed = project({ extra: { ...PAN, scan: { suppressions: [PAN_SUPPRESSION] } } });
  const out = outDir();
  const r = await run(['sweep', '--project', suppressed, '--out', out]);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const result = readJson(join(out, 'ci-result.json'));
  assert.equal(result.verdict.result, 'pass');
  assert.ok(result.findings.some((f) => f.kind === 'horizontal-pan-required' && f.suppressed?.reason.includes('TEST-1')));
  assert.equal(result.suppressions[0].status, 'applied');
  assert.match(r.stdout, /suppressed finding.* not counted/);
  assert.match(readFileSync(join(out, 'report.html'), 'utf8'), /Suppressed findings in groups that are still reported/);
});

const BROKEN_SCENARIO = { scan: { scenarios: [{ name: 'Broken', route: '/', devices: ['mobile-390'], steps: [{ do: 'click', role: 'button', name: 'No such button' }] }] } };

test('a scenario that cannot run fails the run by default and is only reported with --scenario-errors report', async () => {
  const dir = project({ extra: BROKEN_SCENARIO });
  const failing = await run(['scenario', '--project', dir, '--out', outDir()]);
  assert.equal(failing.code, 1, failing.stderr + failing.stdout);
  assert.match(failing.stdout, /scenario run failed: "Broken" on mobile-390 \(setup\)/);
  const out = outDir();
  const reported = await run(['scenario', '--project', dir, '--out', out, '--scenario-errors', 'report']);
  assert.equal(reported.code, 0, reported.stderr + reported.stdout);
  assert.match(reported.stdout, /failed but failOnErrors is off/);
  const junit = readFileSync(join(out, 'junit.xml'), 'utf8');
  assertWellFormed(junit);
  assert.match(junit, /<skipped message="failed at setup/);
});

const FLOW = (name, expectHeading) => ({
  name, project: '.', device: 'mobile-390',
  steps: [{ label: 'open', expect: { heading: expectHeading } }, { do: 'click', role: 'button', name: 'Hello' }],
});

test('a failing flow exits 1 with a bundle and a JUnit failure; a passing one is listed', async () => {
  const dir = project({ extra: { ci: { flows: ['good.flow.json', 'bad.flow.json'] } }, files: { 'good.flow.json': FLOW('good flow', 'Home'), 'bad.flow.json': FLOW('bad flow', 'Missing heading') } });
  const out = outDir();
  const r = await run(['test', '--project', dir, '--out', out]);
  assert.equal(r.code, 1, r.stderr + r.stdout);
  assert.match(r.stdout, /PASS good flow/);
  assert.match(r.stdout, /FAIL bad flow: step 1 "open"/);
  const result = readJson(join(out, 'ci-result.json'));
  assert.deepEqual(result.flows.map((f) => [f.name, f.passed]), [['good flow', true], ['bad flow', false]]);
  assert.equal(result.flows[1].failedStep.kind, 'expectation');
  assert.ok(result.flows[1].bundle);
  const bundle = readJson(join(out, result.flows[1].bundle, 'bundle.json'));
  assert.equal(bundle.failure.kind, 'expectation');
  assert.equal(bundle.failure.step, 1);
  const junit = readFileSync(join(out, 'junit.xml'), 'utf8');
  assertWellFormed(junit);
  assert.match(junit, /<testsuite name="agentlab\.flows" tests="2" failures="1"/);
  assert.ok(!(await portOpen(5373)));
});

test('could not run: unknown selections, a missing required variable and --validate-only exit 2', async () => {
  const unknown = await run(['scenario', '--project', project({ extra: BROKEN_SCENARIO }), '--out', outDir(), '--scenarios', 'Nope']);
  assert.equal(unknown.code, 2, unknown.stderr);
  assert.match(unknown.stderr, /unknown scenario "Nope" \(declared: Broken\)/);

  const gated = project({ requiredEnv: ['DEMO_TOKEN'] });
  const env = { DEMO_TOKEN: '' };
  const out = outDir();
  const missing = await run(['test', '--project', gated, '--out', out], { env });
  assert.equal(missing.code, 2, missing.stderr);
  assert.match(missing.stderr, /required variable not set: DEMO_TOKEN/);
  const result = readJson(join(out, 'ci-result.json'));
  assert.equal(result.verdict.result, 'error');
  assert.equal(result.verdict.exitCode, 2);

  const validate = await run(['test', '--project', gated, '--validate-only'], { env });
  assert.equal(validate.code, 2, validate.stderr + validate.stdout);
  assert.match(validate.stdout, /FAIL environment for service "web": required variable not set: DEMO_TOKEN/);
  assert.match(validate.stdout, /^ok   profile/m);

  const okProject = project({ extra: { ci: { flows: ['f.json'] } }, files: { 'f.json': FLOW('f', 'Home') } });
  const valid = await run(['test', '--project', okProject, '--validate-only'], { env });
  assert.equal(valid.code, 0, valid.stdout + valid.stderr);
  assert.match(valid.stdout, /ok   flow f\.json: found and parsed/);
  assert.match(valid.stdout, /valid:/);
  assert.ok(!(await portOpen(5373)), '--validate-only starts nothing');

  const badFlow = await run(['test', '--project', project({ extra: { ci: { flows: ['nope.json'] } } }), '--validate-only']);
  assert.equal(badFlow.code, 2);
  assert.match(badFlow.stdout, /FAIL flow nope\.json: the file does not exist/);
  const badAuth = await run(['test', '--project', project(), '--validate-only', '--auth', 'env'], { env: { AGENTLAB_AUTH_STATE: 'not json' } });
  assert.equal(badAuth.code, 2);
  assert.doesNotMatch(badAuth.stdout + badAuth.stderr, /not json/);
  const badProfile = await run(['test', '--project', project({ extra: { ci: { flow: [] } } }), '--validate-only']);
  assert.equal(badProfile.code, 2);
  assert.match(badProfile.stdout, /unknown key "flow"/);
});

test('--timeout ends a slow run with exit 3, a partial result and the port released', async () => {
  const dir = project({ port: 5374, env: { DELAY_MS: '60000' } });
  const out = outDir();
  const started = Date.now();
  const r = await run(['test', '--project', dir, '--out', out, '--timeout', '4s']);
  assert.equal(r.code, 3, r.stderr + r.stdout);
  assert.ok(Date.now() - started < 30_000, 'it did not wait for the service');
  const result = readJson(join(out, 'ci-result.json'));
  assert.equal(result.verdict.result, 'error');
  assert.equal(result.verdict.exitCode, 3);
  assert.equal(result.timedOut, true);
  assert.match(result.verdict.reasons[0], /^timed out after 4s/);
  assert.match(r.stdout, /agentlab test: ERROR \(exit 3\)/);
  assertWellFormed(readFileSync(join(out, 'junit.xml'), 'utf8'));
  assert.ok(!(await portOpen(5374)), 'the service was stopped');
});

test('SIGTERM mid-run exits 143, stops the service and marks the partial result cancelled', async () => {
  const dir = project({ port: 5375, env: { DELAY_MS: '60000' } });
  const out = outDir();
  let sent = false;
  const p = run(['test', '--project', dir, '--out', out], {
    // The service is still starting (readiness takes a minute): the run is in flight, with no browser open yet.
    onStderr: (text) => { if (!sent && /agentlab: starting/.test(text)) { sent = true; setTimeout(() => p.child.kill('SIGTERM'), 1500); } },
  });
  const r = await p;
  assert.equal(r.code, 143, r.stderr + r.stdout);
  const result = readJson(join(out, 'ci-result.json'));
  assert.equal(result.verdict.result, 'error');
  assert.equal(result.verdict.exitCode, 143);
  assert.equal(result.cancelled, 'cancelled by SIGTERM');
  assert.ok(!(await portOpen(5375)), 'the service was stopped');
});

test('SIGINT with the browser open, on three services, exits 130 with a partial result and leaves nothing running (×3)', async () => {
  // Playwright's own SIGINT handler used to exit the process as soon as the browser closed, before the
  // lab stopped the services, removed its ownership record or wrote the result.
  const ports = { web: 5373, api: 5374, worker: 5376 };
  const dir = project({ port: ports.web });
  const profile = readJson(join(dir, 'agentlab.json'));
  for (const name of ['api', 'worker']) {
    profile.services[name] = { command: 'node server.mjs', url: `http://127.0.0.1:${ports[name]}`, env: { PORT: String(ports[name]) }, readiness: { path: '/health', timeoutMs: 60_000 } };
  }
  profile.services.web.dependsOn = ['api', 'worker'];
  writeFileSync(join(dir, 'agentlab.json'), JSON.stringify(profile));
  const owned = () => files(home).concat(existsSync(join(dir, '.agentlab')) ? files(join(dir, '.agentlab')) : []).filter((f) => /(^|\/)owned\/[^/]+\.json$/.test(f));

  for (let round = 1; round <= 3; round++) {
    const out = outDir();
    let sent = false;
    const p = run(['sweep', '--project', dir, '/', '--out', out], {
      onStderr: (text) => { if (!sent && /agentlab: sweep \//.test(text)) { sent = true; p.child.kill('SIGINT'); } },
    });
    const r = await p;
    assert.equal(sent, true, `round ${round}: the sweep began`);
    assert.equal(r.code, 130, `round ${round}: ${r.stderr}${r.stdout}`);
    const result = readJson(join(out, 'ci-result.json'));
    assert.equal(result.verdict.exitCode, 130, `round ${round}`);
    assert.equal(result.cancelled, 'cancelled by SIGINT');
    for (const [name, port] of Object.entries(ports)) assert.ok(!(await portOpen(port)), `round ${round}: ${name} was stopped`);
    assert.deepEqual(owned(), [], `round ${round}: no ownership record left`);
  }
});

test('report re-renders text, JUnit and HTML from a saved result, and refuses a newer version', async () => {
  const dir = project({ extra: PAN });
  const out = outDir();
  const r = await run(['sweep', '--project', dir, '--out', out]);
  assert.equal(r.code, 1, r.stderr);
  for (const [format, file] of [['junit', 'junit.xml'], ['text', 'summary.txt'], ['html', 'report.html'], ['json', 'ci-result.json']]) {
    const again = await run(['report', out, '--format', format]);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.stdout, readFileSync(join(out, file), 'utf8'), `${format} reproduces ${file}`);
  }
  const target = join(tmpdir(), `agentlab-ci-report-${process.pid}.xml`);
  temps.push(target);
  assert.equal((await run(['report', join(out, 'ci-result.json'), '--format', 'junit', '--out', target])).code, 0);
  assert.equal(readFileSync(target, 'utf8'), readFileSync(join(out, 'junit.xml'), 'utf8'));
  assert.equal(statSync(target).mode & 0o777, 0o600);

  const newer = { ...readJson(join(out, 'ci-result.json')), version: 99 };
  const newerFile = join(out, 'newer.json');
  writeFileSync(newerFile, JSON.stringify(newer));
  const refused = await run(['report', newerFile]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /version 99; this agentlab .* reads up to 1/);
});

// ---------- secrets ----------

test('no secret reaches any artifact, the trace, stdout or stderr', async () => {
  const TOKEN = 'CI_SECRET_ABC123';
  const COOKIE = 'CI_COOKIE_XYZ789';
  const PASSWORD = 'CI_PASSWORD_Q1W2E3';
  // A password field whose name has no English secret word in it: only its type says it is secret.
  const SENHA = 'Zq9hunter2Senha';
  const authState = JSON.stringify({ cookies: [{ name: 'sid', value: COOKIE, domain: '127.0.0.1', path: '/', expires: -1 }], origins: [] });
  const flow = {
    name: 'sign in', project: '.', device: 'mobile-390',
    steps: [
      { label: 'sign-in page', expect: { heading: 'Sign in' } },
      { do: 'fill', role: 'textbox', name: 'Password', value: PASSWORD },
      { do: 'fill', role: 'textbox', name: 'Senha', value: SENHA },
      { do: 'click', role: 'button', name: 'Sign in', expect: { heading: 'Welcome back' } },
    ],
  };
  const dir = project({ port: 5376, requiredEnv: ['DEMO_TOKEN'], extra: { startPath: '/login', ci: { flows: ['signin.flow.json'], routes: ['/', '/pan'], devices: ['mobile-320'] } }, files: { 'signin.flow.json': flow } });
  const out = outDir();
  const r = await run(['test', '--project', dir, '--out', out, '--trace', 'on-failure', '--auth', 'env'], { env: { DEMO_TOKEN: TOKEN, AGENTLAB_AUTH_STATE: authState } });
  assert.equal(r.code, 1, r.stderr + r.stdout);
  const result = readJson(join(out, 'ci-result.json'));
  assert.equal(result.environment.auth, 'saved-state');
  assert.equal(result.flows[0].passed, false);
  assert.ok(result.bundles.some((b) => b.trace === 'included'), JSON.stringify(result.bundles));

  const secrets = [TOKEN, COOKIE, PASSWORD, SENHA, authState];
  const scan = (label, buf) => {
    for (const [i, s] of secrets.entries()) {
      for (const enc of ['utf8', 'latin1']) assert.ok(!buf.includes(Buffer.from(s, enc)), `secret #${i} is in ${label}`);
      assert.ok(!buf.includes(Buffer.from(s).toString('base64')), `secret #${i} (base64) is in ${label}`);
    }
  };
  const all = files(out);
  assert.ok(all.some((f) => f.endsWith('trace.zip')), 'a trace was written');
  for (const f of all) {
    const buf = readFileSync(join(out, f));
    if (f.endsWith('.zip')) for (const e of readZip(buf)) scan(`${f}:${e.name}`, e.data);
    else scan(f, buf);
  }
  scan('stdout', Buffer.from(r.stdout));
  scan('stderr', Buffer.from(r.stderr));
  const flowResults = [home, join(dir, '.agentlab')].filter(existsSync).flatMap((root) => files(root).filter((f) => f.endsWith('flow-result.json')).map((f) => join(root, f)));
  assert.ok(flowResults.length > 0, 'the flow wrote its result');
  for (const f of flowResults) scan(f, readFileSync(f));
  // The values were really in play: the app printed them to the console, so redaction had work to do.
  assert.match(readFileSync(join(out, result.bundles[0].dir, 'bundle.json'), 'utf8'), /‹redacted›/);
});
