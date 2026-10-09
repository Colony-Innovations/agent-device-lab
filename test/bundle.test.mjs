// Failure bundles: what the action log records, that no secret reaches any file of a bundle (including the
// sanitized trace), owner-only files, retention, and the `bundle` command. App on port 5370.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lab } from '../dist/core/lab.js';
import { SessionHost, dispatch, COMMANDS } from '../dist/core/commands.js';
import { ActionLog, recordAction, summariseObservation } from '../dist/core/action-log.js';
import {
  envSecrets, listBundles, loadBundle, parseBundle, pruneBundles, redactTree, leakedSecrets, sanitizeProfile, sanitizeScenarioSteps,
  summariseConsole, summariseRequests, writeBundle,
} from '../dist/core/bundle.js';
import { consequentialWord } from '../dist/core/explore-safety.js';
import { readZip } from '../dist/core/zip.js';

const PASSWORD = 'S3cretPassw0rd!';
const EMAIL = 'agent@example.test';
const BODY_SECRET = 'BODY_SECRET_123';
const SERVICE_SECRET = 'SERVICE_ENV_SECRET_456';
const REQUIRED_SECRET = 'REQUIRED_ENV_SECRET_789';

const project = mkdtempSync(join(tmpdir(), 'agentlab-bundle-'));
const stateDir = mkdtempSync(join(tmpdir(), 'agentlab-bundle-state-'));
const savedToken = process.env.DEMO_TOKEN;
process.env.DEMO_TOKEN = REQUIRED_SECRET;

writeFileSync(join(project, 'agentlab.json'), JSON.stringify({
  schemaVersion: 2, name: 'bundle-app',
  services: {
    web: {
      command: 'node server.mjs --token=CMD_TOKEN_VALUE_1', url: 'http://127.0.0.1:5370', readiness: { path: '/health' },
      env: { SERVICE_VAR: SERVICE_SECRET }, requiredEnv: ['DEMO_TOKEN'],
    },
  },
  app: { service: 'web' },
  auth: { file: '.agentlab/auth/state.json', use: 'auto', loginPath: '/login' },
}));
writeFileSync(join(project, 'server.mjs'), `
import { createServer } from 'node:http';
const page = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">' +
  '<h1>Sign in</h1><label>Email <input id="email" type="email"></label><label>Password <input id="pw" type="password"></label>' +
  '<button id="go">Sign in</button><button disabled>Continue</button><script>' +
  'go.onclick = async () => { await fetch("/api/login?token=QUERY_SECRET_1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: "${BODY_SECRET}", pw: pw.value }) });' +
  '  console.error("login failed for " + email.value + " with " + pw.value + " using ${SERVICE_SECRET}"); };' +
  '</script>';
createServer((req, res) => {
  if (req.url === '/health') return res.end('ok');
  if (req.url.startsWith('/api/login')) { req.resume(); return res.writeHead(500, { 'content-type': 'text/plain' }).end('no'); }
  res.writeHead(200, { 'content-type': 'text/html' }).end(page);
}).listen(5370, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`);

const bundlesDir = join(stateDir, 'bundles');
let lab;
let written;
let result;
before(async () => {
  lab = new Lab({ stateDir, evidenceFrames: true });
  await lab.start({ project, headed: false, trace: true });
  const fill = (name, value) => lab.act({ action: 'fill', ref: lab.findRef({ name }), value });
  assert.equal((await fill('Email', EMAIL)).outcome, 'success');
  assert.equal((await fill('Password', PASSWORD)).outcome, 'success');
  assert.equal((await lab.act({ action: 'click', ref: lab.findRef({ role: 'button', name: 'Sign in' }) })).outcome, 'success');
  result = await lab.act({ action: 'click', ref: lab.findRef({ role: 'button', name: 'Continue' }) });
  assert.equal(result.outcome, 'error', 'the disabled button cannot be clicked');
  written = await lab.bundle({ reason: 'Continue is disabled after signing in', failure: { kind: 'action-error', step: 4, code: result.error.code }, dir: bundlesDir, trace: true });
});
after(async () => {
  await lab?.close();
  rmSync(project, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  if (savedToken === undefined) delete process.env.DEMO_TOKEN; else process.env.DEMO_TOKEN = savedToken;
});

const allFiles = (root, rel = '') => readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? allFiles(root, join(rel, e.name)) : [join(rel, e.name)]);

test('bundle.json has the contract fields and the recorded session', () => {
  const b = loadBundle(written.dir);
  assert.equal(b.kind, 'agentlab-failure-bundle');
  assert.equal(b.bundleVersion, 1);
  assert.match(b.id, /^b-\d{8}T\d{6}-[0-9a-f]{4}$/);
  assert.ok(b.product.version && b.product.contracts.bundle === 1);
  for (const k of ['node', 'platform', 'arch', 'osRelease', 'playwright', 'chromium']) assert.ok(b.environment[k], `environment.${k}`);
  assert.equal(b.environment.headed, false);
  assert.equal(typeof b.environment.ci, 'boolean');
  assert.equal(b.reason, 'Continue is disabled after signing in');
  assert.deepEqual(b.failure, { kind: 'action-error', step: 4, code: 'disabled' });
  assert.equal(b.project.name, 'bundle-app');
  assert.match(b.project.profileSha256, /^[0-9a-f]{64}$/);
  assert.equal(b.session.device.length > 0, true);
  assert.equal(b.session.auth, 'fresh');
  assert.equal(b.session.startRoute, '/');
  assert.equal(b.route, '/');
  assert.equal(b.actions.length, 4);
  assert.equal(b.actionsOmitted, 0);
  assert.ok(b.observations.length >= 1 && b.observations.length <= 10);
  assert.ok(b.retention.createdAt && Date.parse(b.retention.expiresAt) - Date.parse(b.retention.createdAt) === 14 * 86_400_000);
  assert.match(b.retention.policy, /14 days/);
  assert.equal(b.trace, 'trace.zip');
});

test('the action log records replayable targets, masks the password and keeps the email', () => {
  const [email, password, click, failed] = loadBundle(written.dir).actions;
  assert.equal(email.actor, 'agent');
  assert.equal(email.action, 'fill');
  assert.deepEqual(email.target, { role: 'textbox', name: 'Email' });
  assert.equal(email.args.value, EMAIL, 'a non-secret value is needed to reproduce');
  assert.equal(password.args.value, '‹secret›');
  assert.equal(password.secret, true);
  assert.equal(click.target.name, 'Sign in');
  assert.equal(click.routeBefore, '/');
  assert.equal(click.consequential, false);
  assert.equal(failed.outcome, 'error');
  assert.equal(failed.error.code, 'disabled');
  assert.deepEqual([failed.index, failed.target.name], [4, 'Continue']);
  for (const a of [email, password, click, failed]) assert.ok(!('ref' in (a.target ?? {})), 'refs are never recorded');
});

test('failed requests and console errors are recorded without query, body or secrets', () => {
  const b = loadBundle(written.dir);
  const post = b.failedRequests.find((r) => r.method === 'POST');
  assert.ok(post, JSON.stringify(b.failedRequests));
  assert.equal(post.url, 'http://127.0.0.1:5370/api/login');
  assert.equal(post.status, 500);
  assert.deepEqual(Object.keys(post).sort(), ['method', 'status', 'url']);
  assert.ok(b.consoleErrors.some((e) => e.text.includes('login failed for')), JSON.stringify(b.consoleErrors));
  assert.ok(b.consoleErrors.every((e) => e.count >= 1 && e.text.length <= 300));
});

test('the sanitized profile keeps names, never env values or credentials', () => {
  const { profile } = loadBundle(written.dir).project;
  assert.deepEqual(profile.services.web.env, { SERVICE_VAR: '‹set›' });
  assert.deepEqual(profile.services.web.requiredEnv, ['DEMO_TOKEN']);
  assert.match(profile.services.web.command, /--token=‹redacted›/);
  assert.deepEqual(profile.auth, { use: 'auto', loginPath: '/login', file: '.agentlab/auth/state.json' });
});

test('no secret appears in any bundle file, including the sanitized trace', () => {
  const files = allFiles(written.dir);
  assert.ok(files.includes('bundle.json') && files.includes('trace.zip'));
  const secrets = [PASSWORD, BODY_SECRET, SERVICE_SECRET, REQUIRED_SECRET, 'QUERY_SECRET_1', 'CMD_TOKEN_VALUE_1'];
  const scan = (label, buf) => {
    for (const s of secrets) {
      for (const enc of ['utf8', 'latin1']) assert.ok(!buf.includes(Buffer.from(s, enc)), `${s} found in ${label}`);
      assert.ok(!buf.includes(Buffer.from(s).toString('base64')), `${s} (base64) found in ${label}`);
    }
  };
  for (const f of files) {
    const buf = readFileSync(join(written.dir, f));
    if (f === 'trace.zip') {
      const entries = readZip(buf);
      assert.ok(entries.length > 3);
      for (const e of entries) scan(`trace.zip:${e.name}`, e.data);
    } else scan(f, buf);
  }
  assert.equal(written.trace, 'included');
});

test('frames are copied into the bundle and findings point at them', () => {
  const b = loadBundle(written.dir);
  assert.ok(b.frames.length >= 1);
  for (const f of b.frames) {
    assert.match(f, /^frames\/[\w.-]+\.jpg$/);
    assert.ok(statSync(join(written.dir, f)).size > 100);
  }
  const text = readFileSync(join(written.dir, 'bundle.json'), 'utf8');
  assert.ok(!text.includes(stateDir) && !text.includes(project), 'no absolute paths of this machine');
});

test('files are 0600 in 0700 directories', () => {
  for (const f of allFiles(written.dir)) assert.equal(statSync(join(written.dir, f)).mode & 0o777, 0o600, f);
  for (const d of [written.dir, join(written.dir, 'frames'), bundlesDir]) assert.equal(statSync(d).mode & 0o777, 0o700, d);
});

test('retention: prune keeps the newest N and removes bundles past the age limit', () => {
  const input = () => ({
    reason: 'again', failure: { kind: 'manual' }, profile: lab['profile'], session: lab['session'], startRoute: '/', route: '/', actions: [], actionsOmitted: 0,
    observations: [], findings: [], consoleErrors: [], failedRequests: [], runDir: lab['session'].runDir, secrets: [],
  });
  const dir = join(stateDir, 'prune');
  const base = Date.parse('2026-09-01T00:00:00Z');
  const ids = [0, 1, 2, 3].map((i) => writeBundle({ ...input(), now: new Date(base + i * 1000), env: { AGENTLAB_KEEP_BUNDLES: '99', AGENTLAB_BUNDLE_DAYS: '9999' } }, dir).id);
  assert.equal(listBundles(dir).length, 4);
  assert.deepEqual(pruneBundles(dir, { keep: 2, now: new Date(base + 5000) }).sort(), [ids[0], ids[1]].sort());
  assert.deepEqual(listBundles(dir).map((b) => b.id), [ids[3], ids[2]]);
  assert.deepEqual(pruneBundles(dir, { keep: 20, maxAgeDays: 14, now: new Date(base + 20 * 86_400_000) }).sort(), [ids[2], ids[3]].sort());
  assert.equal(listBundles(dir).length, 0);
  // Writing prunes by itself, honouring the environment overrides.
  const first = writeBundle({ ...input(), now: new Date(), env: { AGENTLAB_KEEP_BUNDLES: '1' } }, dir);
  const second = writeBundle({ ...input(), now: new Date(Date.now() + 2000), env: { AGENTLAB_KEEP_BUNDLES: '1' } }, dir);
  assert.deepEqual(listBundles(dir).map((b) => b.id), [second.id]);
  assert.deepEqual(second.pruned, [first.id]);
});

test('a secret that reaches the bundle through the page is redacted, and writing refuses if one survives', () => {
  const input = {
    reason: 'x', failure: { kind: 'manual' }, profile: lab['profile'], session: lab['session'], startRoute: '/', route: '/', actions: [], actionsOmitted: 0,
    observations: [], findings: [], failedRequests: [], runDir: lab['session'].runDir, secrets: ['hunter2hunter2'],
    consoleErrors: [{ type: 'console.error', text: 'typed hunter2hunter2 into the box', at: 1 }],
  };
  const w = writeBundle(input, join(stateDir, 'safety'));
  const text = readFileSync(join(w.dir, 'bundle.json'), 'utf8');
  assert.ok(!text.includes('hunter2hunter2') && text.includes('typed ‹redacted› into the box'));
  // The same value as a key of the JSON cannot be removed by a value pass: writing must refuse.
  const sneaky = { ...input, observations: [{ gen: 1, route: '/', title: '', headings: [], controls: [], omitted: 0, hunter2hunter2: 1 }] };
  assert.throws(() => writeBundle(sneaky, join(stateDir, 'safety2')), { code: 'bundle_unsafe' });
  assert.ok(!existsSync(join(stateDir, 'safety2')), 'nothing is written when the check fails');
});

test('the bundle command returns where the bundle is, never its contents', async () => {
  await lab.close();
  const host = new SessionHost({ stateDir }, { headless: true });
  const started = await dispatch(host, 'cli', 'start', { project });
  assert.ok(started.ok, JSON.stringify(started.error));
  try {
    const out = await dispatch(host, 'mcp', 'bundle', { note: 'checking the command' });
    assert.ok(out.ok, JSON.stringify(out.error));
    const r = out.output.result;
    assert.deepEqual(Object.keys(r).sort(), ['counts', 'dir', 'files', 'id', 'trace']);
    assert.ok(r.files.includes('bundle.json'));
    assert.equal(r.counts.actions, 0);
    assert.ok(!JSON.stringify(out.output).includes('checking the command'), 'the reason is not echoed back');
    const b = loadBundle(r.dir);
    assert.equal(b.reason, 'checking the command');
    assert.deepEqual(b.failure, { kind: 'manual' });
    assert.equal(b.trace, undefined, 'no trace was recorded for this session');
    assert.ok(COMMANDS.find((c) => c.name === 'bundle' && c.kind === 'read' && c.surfaces.includes('mcp') && c.surfaces.includes('cli')));
  } finally {
    await dispatch(host, 'cli', 'stop', {});
  }
});

// ---------- pure pieces ----------

const control = (over) => ({ ref: 'e1', role: 'button', name: 'Save', rect: { x: 0, y: 0, w: 1, h: 1 }, ...over });
const obs = (over = {}) => ({ gen: 1, route: '/a?token=abc#x', title: 'T', headings: ['h1 A'], dialog: undefined, controls: [control()], omitted: 0, ...over });
const okResult = (over = {}) => ({ outcome: 'success', newFindings: [], ...over });

test('recordAction: targets from the pre-action observation, secrets masked, consequential by name', () => {
  const before = obs({ controls: [control({ ref: 'e1', role: 'textbox', name: 'Password', value: '' }), control({ ref: 'e2', name: 'Delete account', context: 'Danger zone' })] });
  const fill = recordAction({ request: { action: 'fill', ref: 'e1', value: 'pw-value-1' }, before, result: okResult({ observation: obs() }), secret: true, index: 1 });
  assert.equal(fill.args.value, '‹secret›');
  assert.equal(fill.secret, true);
  assert.equal(fill.routeBefore, '/a', 'query and hash are dropped');
  const click = recordAction({ request: { action: 'click', ref: 'e2' }, before, result: okResult({ observation: obs({ dialog: 'Sure?' }) }), secret: false, index: 2 });
  assert.deepEqual(click.target, { role: 'button', name: 'Delete account', context: 'Danger zone' });
  assert.equal(click.consequential, true);
  assert.equal(click.dialogAfter, 'Sure?');
  const failed = recordAction({ request: { action: 'fill', ref: 'e1', value: 'typed-anyway' }, before, secret: false, index: 3,
    result: { outcome: 'error', error: { code: 'not_found', message: 'x', recoverable: true }, newFindings: [] } });
  assert.equal(failed.args.value, '‹secret›', 'a failed fill into a secret-looking field is masked too');
  const press = recordAction({ request: { action: 'press', key: 'Enter' }, before, result: okResult(), secret: false, index: 4 });
  assert.equal(press.args.key, 'Enter');
  assert.equal(consequentialWord('Sign out'), 'Sign out');
  assert.equal(consequentialWord('Open filters'), undefined);
});

test('ActionLog keeps the last 500 entries, counts the omitted ones and remembers typed secrets in memory only', () => {
  const log = new ActionLog();
  const before = obs({ controls: [control({ ref: 'e1', role: 'textbox', name: 'Password' })] });
  log.agent({ request: { action: 'fill', ref: 'e1', value: 'topsecret-1' }, before, result: okResult(), secret: true });
  for (const k of ['a', 'b', 'c', 'd']) log.agent({ request: { action: 'press', key: k }, before, result: okResult(), secret: true });
  assert.deepEqual(log.secretValues().sort(), ['abcd', 'topsecret-1']);
  for (let i = 0; i < 600; i++) log.person('tapped');
  assert.equal(log.actions.length, 500);
  assert.equal(log.actionsOmitted, 105);
  assert.equal(log.actions[0].index, 106);
  assert.ok(!JSON.stringify(log.actions).includes('topsecret-1'));
  for (let i = 0; i < 12; i++) log.observation(obs({ gen: i }));
  assert.deepEqual(log.observations.map((o) => o.gen), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('summariseObservation keeps 40 controls and reports the rest', () => {
  const s = summariseObservation(obs({ controls: Array.from({ length: 45 }, (_, i) => control({ ref: `e${i}`, name: `B${i}`, value: i === 0 ? '••••' : undefined })), omitted: 3 }));
  assert.equal(s.controls.length, 40);
  assert.equal(s.omitted, 8);
  assert.equal(s.controls[0].value, '••••');
  assert.equal(s.route, '/a');
});

test('sanitizeProfile, scenario steps, console and request summaries', () => {
  const raw = {
    schemaVersion: 1, name: 'p', web: { command: 'node s.js --api_key=abc123', url: 'https://user:pw@example.com/x', env: { A: 'one', B: 'two' } },
    auth: { file: '/proj/.agentlab/auth/state.json', use: 'auto', extra: 'dropped' }, scan: { note: 'kept' },
  };
  const p = sanitizeProfile(raw, '/proj');
  assert.deepEqual(p.web.env, { A: '‹set›', B: '‹set›' });
  assert.ok(!JSON.stringify(p).includes('abc123') && !JSON.stringify(p).includes('user:pw'));
  assert.deepEqual(p.auth, { use: 'auto', file: '.agentlab/auth/state.json' });
  assert.deepEqual(p.scan, { note: 'kept' });
  const withScenario = sanitizeProfile({ scan: { scenarios: [{ name: 's', steps: [{ do: 'fill', role: 'textbox', name: 'Password', value: 'pw-in-profile' }, { do: 'click', name: 'Go' }] }] } }, '/proj');
  assert.deepEqual(withScenario.scan.scenarios[0].steps, [{ do: 'fill', role: 'textbox', name: 'Password', value: '‹secret›' }, { do: 'click', name: 'Go' }]);
  assert.equal(raw.web.env.A, 'one', 'the input is not modified');

  const steps = sanitizeScenarioSteps([
    { do: 'fill', role: 'textbox', name: 'Password', value: 'x1' }, { do: 'fill', role: 'textbox', name: 'Search', value: 'shoes' }, { do: 'fill', role: 'textbox', name: 'One-time code (OTP)', value: '123456' },
  ]);
  assert.deepEqual(steps.map((s) => s.value), ['‹secret›', 'shoes', '‹secret›']);

  const errors = summariseConsole([
    ...Array.from({ length: 60 }, (_, i) => ({ type: 'console.error', text: `e${i}`, at: i })),
    { type: 'console.error', text: 'e0', at: 99 }, { type: 'pageerror', text: 'password=hunter22', at: 100 },
  ]);
  assert.equal(errors.length, 50);
  assert.equal(errors.find((e) => e.text === 'e0').count, 2);
  assert.ok(errors.at(-1).text.includes('‹redacted›') && !errors.at(-1).text.includes('hunter22'));
  const reqs = summariseRequests([{ method: 'GET', url: 'http://x/y?token=1', status: 404, at: 1 }, { method: 'POST', url: 'http://x/z', failure: 'net::ERR_FAILED', at: 2 }]);
  assert.deepEqual(reqs, [{ method: 'GET', url: 'http://x/y', status: 404 }, { method: 'POST', url: 'http://x/z', failure: 'net::ERR_FAILED' }]);
});

test('envSecrets takes required and secret-named variables and long declared values, redactTree and leakedSecrets agree', () => {
  const profile = { services: [{ requiredEnv: ['NEED'], env: { LONG: 'x'.repeat(20), SHORT: 'abc' } }] };
  const found = envSecrets(profile, { NEED: 'needed-value', MY_API_TOKEN: 'tok-123456', MY_TOKEN_SHORT: 'abc', OTHER: 'not-secret-value' });
  assert.deepEqual(found.sort(), ['needed-value', 'tok-123456', 'x'.repeat(20)].sort());
  const tree = redactTree({ a: ['see needed-value here', { b: 'tok%2D123456 tok-123456' }] }, ['needed-value', 'tok-123456']);
  assert.equal(tree.a[0], 'see ‹redacted› here');
  assert.equal(leakedSecrets(JSON.stringify(tree), ['needed-value', 'tok-123456']), 0);
  assert.equal(leakedSecrets('has needed-value', ['needed-value']), 1);
});

test('parseBundle rejects malformed and too-new bundles', () => {
  const good = loadBundle(written.dir);
  assert.throws(() => parseBundle({ ...good, kind: 'other' }), { code: 'bundle_invalid' });
  assert.throws(() => parseBundle({ ...good, bundleVersion: 2 }), { code: 'bundle_too_new' });
  assert.throws(() => parseBundle({ ...good, actions: 'nope' }), { code: 'bundle_invalid' });
  assert.throws(() => parseBundle({ ...good, id: '../../etc' }), { code: 'bundle_invalid' });
});
