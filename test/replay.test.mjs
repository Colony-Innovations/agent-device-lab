// Replay of failure bundles: reproduction, divergence with expected vs actual, blocked steps (consequential,
// masked secret, a person's interaction), never guessing between duplicates, and the CLI exit codes.
// The app (port 5371) behaves differently depending on the contents of variant.txt, which the test changes
// between runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Lab } from '../dist/core/lab.js';
import { loadBundle } from '../dist/core/bundle.js';
import { replayBundle, replayExitCode, formatReplay } from '../dist/core/replay.js';

const run = promisify(execFile);
const CLI = resolve('bin/agentlab.js');
const PASSWORD = 'Replay-Passw0rd-42';

const project = mkdtempSync(join(tmpdir(), 'agentlab-replay-'));
const stateDir = mkdtempSync(join(tmpdir(), 'agentlab-replay-state-'));
const bundlesDir = join(stateDir, 'bundles');
const variantFile = join(project, 'variant.txt');
const setVariant = (v) => writeFileSync(variantFile, v);
const deletes = () => (existsSync(join(project, 'deletes.log')) ? readFileSync(join(project, 'deletes.log'), 'utf8').split('\n').filter(Boolean).length : 0);
const pwLengths = () => (existsSync(join(project, 'pwlen.log')) ? readFileSync(join(project, 'pwlen.log'), 'utf8').split('\n').filter(Boolean).map(Number) : []);

writeFileSync(join(project, 'agentlab.json'), JSON.stringify({
  schemaVersion: 1, name: 'replay-app', web: { command: 'node server.mjs', url: 'http://127.0.0.1:5371', readiness: { path: '/health' } },
  scan: { scenarios: [{ name: 'cart-continue', route: '/cart', auth: 'fresh', devices: ['mobile-390'], steps: [
    { do: 'fill', role: 'textbox', name: 'Password', value: 'scenario-password-1' }, { do: 'click', role: 'button', name: 'Continue' },
  ] }] },
}));
writeFileSync(join(project, 'server.mjs'), `
import { createServer } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
const head = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">';
const variant = () => { try { return readFileSync('variant.txt', 'utf8').trim(); } catch { return 'base'; } };
createServer((req, res) => {
  const v = variant();
  if (req.url === '/health') return res.end('ok');
  if (req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
    if (req.url === '/api/delete') appendFileSync('deletes.log', 'deleted\\n');
    if (req.url === '/api/pwlen') appendFileSync('pwlen.log', b + '\\n');
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); }); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  if (req.url === '/cart' || req.url === '/basket') {
    const email = v === 'late' ? 'E-mail' : 'Email';
    return res.end(head + '<h1>Cart</h1>' + (v === 'wide' ? '<div style="width:2000px;height:12px;background:#c00"></div>' : '') + '<label>' + email + ' <input type="email"></label><label>Password <input id="pw" type="password"></label>' +
      '<button id="del">Delete account</button><button' + (v === 'fixed' ? '' : ' disabled') + '>Continue</button><script>' +
      'pw.oninput = () => fetch("/api/pwlen", { method: "POST", body: String(pw.value.length) });' +
      'del.onclick = () => fetch("/api/delete", { method: "POST" });</script>');
  }
  if (v === 'dup') {
    return res.end(head + '<h1>Shop</h1><section><h2>North</h2><a href="/cart">Open cart</a></section><section><h2>South</h2><a href="/basket">Open cart</a></section>');
  }
  const label = v === 'rename' ? 'View cart' : 'Open cart';
  return res.end(head + '<h1>Shop</h1><a href="' + (v === 'route' ? '/basket' : '/cart') + '">' + label + '</a>');
}).listen(5371, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`);

const dirs = {};
const step = (lab, action, query, extra = {}) => lab.act({ action, ref: lab.findRef(query), ...extra });

/** Record a session on the base app and write its bundle. */
async function record(name, script, failure, variant = name === 'dup' ? 'dup' : 'base') {
  setVariant(variant);
  const lab = new Lab({ stateDir });
  try {
    await lab.start({ project, headed: false });
    await script(lab);
    const w = await lab.bundle({ reason: `recording ${name}`, failure: typeof failure === 'function' ? failure(lab) : failure, dir: bundlesDir });
    return w.dir;
  } finally {
    await lab.close();
  }
}

before(async () => {
  const openCart = (lab) => step(lab, 'click', { role: 'link', name: 'Open cart' });
  const fillEmail = (lab) => step(lab, 'fill', { name: 'Email' }, { value: 'agent@example.test' });
  const failContinue = async (lab) => { const r = await step(lab, 'click', { role: 'button', name: 'Continue' }); assert.equal(r.error?.code, 'disabled'); return r; };
  // B: open the cart, fill the email, click a disabled button (step 3 fails).
  dirs.plain = await record('plain', async (lab) => { await openCart(lab); await fillEmail(lab); await failContinue(lab); }, { kind: 'action-error', step: 3, code: 'disabled' });
  // A: as B with a password between (step 4 fails).
  dirs.secret = await record('secret', async (lab) => {
    await openCart(lab); await fillEmail(lab);
    const pw = await step(lab, 'fill', { name: 'Password' }, { value: PASSWORD });
    assert.equal(pw.outcome, 'success');
    await failContinue(lab);
  }, { kind: 'action-error', step: 4, code: 'disabled' });
  // C: a consequential click before the failing step.
  dirs.delete = await record('delete', async (lab) => {
    await openCart(lab);
    assert.equal((await step(lab, 'click', { role: 'button', name: 'Delete account' })).outcome, 'success');
    await failContinue(lab);
  }, { kind: 'action-error', step: 3, code: 'disabled' });
  // Two links with the same name, told apart by their section.
  dirs.dup = await record('dup', async (lab) => {
    const north = lab.lastObservation.controls.filter((c) => c.name === 'Open cart');
    assert.deepEqual(north.map((c) => c.context), ['North', 'South']);
    await lab.act({ action: 'click', ref: north[1].ref });
    assert.equal(lab.lastObservation.route, '/basket');
    await failContinue(lab);
  }, { kind: 'action-error', step: 2, code: 'disabled' });
  // A finding (a page wider than the screen) instead of an action error.
  dirs.wide = await record('wide', async (lab) => {
    await openCart(lab);
    assert.ok(lab.inspect().findings.length > 0, 'the wide cart page has a layout finding');
  }, (lab) => ({ kind: 'findings', fingerprints: lab.inspect().findings.map((f) => f.fingerprint) }), 'wide');
  // A scan scenario whose setup step fails.
  let failed;
  dirs.scenario = await record('scenario', async (lab) => {
    const scan = await lab.scan({ scenarios: ['cart-continue'] });
    failed = scan.runs[0];
    assert.equal(failed.status, 'failed');
  }, () => ({ kind: 'scenario-error', scenario: failed.scenario, device: failed.device, failedAt: failed.failedAt, code: failed.error.code }));
  setVariant('base');
});
after(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

const replay = (bundle, extra = {}) => replayBundle({ bundle, project, stateDir, ...extra });
const serverDown = async () => fetch('http://127.0.0.1:5371/health', { signal: AbortSignal.timeout(1000) }).then(() => false, () => true);

test('the recording carries replayable targets, contexts and the consequential mark', () => {
  const del = loadBundle(dirs.delete).actions[1];
  assert.equal(del.consequential, true);
  assert.deepEqual(del.target, { role: 'button', name: 'Delete account' });
  const dup = loadBundle(dirs.dup).actions[0];
  assert.deepEqual(dup.target, { role: 'link', name: 'Open cart', context: 'South' });
  assert.equal(dup.routeAfter, '/basket');
});

test('the same failure at the same step is reproduced, and the session is closed', async () => {
  setVariant('base');
  const r = await replay(dirs.plain);
  assert.equal(r.outcome, 'reproduced', formatReplay(r));
  assert.deepEqual(r.steps.map((s) => s.status), ['ok', 'ok', 'reproduced']);
  assert.deepEqual(r.warnings, []);
  assert.equal(replayExitCode(r), 0);
  assert.ok(await serverDown(), 'the server the replay started is stopped');
  assert.match(formatReplay(r), /step 3  REPRODUCED/);
});

test('a different agentlab.json only warns, and its commands are the ones that run', async () => {
  const file = join(project, 'agentlab.json');
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(original), startPath: '/' }));
  try {
    const r = await replay(dirs.plain);
    assert.equal(r.outcome, 'reproduced');
    assert.match(r.warnings[0], /agentlab\.json differs/);
  } finally { writeFileSync(file, original); }
});

test('a failure that no longer happens is not-reproduced', async () => {
  setVariant('fixed');
  const r = await replay(dirs.plain);
  assert.equal(r.outcome, 'not-reproduced');
  assert.equal(r.steps.at(-1).status, 'not-reproduced');
  assert.match(r.reason, /succeeded; the recording failed with disabled/);
  assert.equal(replayExitCode(r), 1);
});

test('a renamed control diverges at that step with expected and actual, and nothing after it runs', async () => {
  setVariant('rename');
  const r = await replay(dirs.plain);
  assert.equal(r.outcome, 'diverged');
  assert.equal(r.divergence.step, 1);
  assert.equal(r.divergence.what, 'target');
  assert.equal(r.divergence.expected, 'link "Open cart"');
  assert.match(r.divergence.actual, /no link "Open cart".*"View cart"/);
  assert.equal(r.steps.length, 1);
  assert.equal(replayExitCode(r), 3);
});

test('a changed route diverges after the step that navigated', async () => {
  setVariant('route');
  const r = await replay(dirs.plain);
  assert.equal(r.outcome, 'diverged');
  assert.deepEqual([r.divergence.step, r.divergence.what, r.divergence.expected, r.divergence.actual], [1, 'route after the step', '/cart', '/basket']);
});

test('a divergence at a later step keeps the earlier steps as ok', async () => {
  setVariant('late');
  const r = await replay(dirs.plain);
  assert.equal(r.outcome, 'diverged');
  assert.deepEqual(r.steps.map((s) => s.status), ['ok', 'diverged']);
  assert.equal(r.divergence.step, 2);
  assert.match(r.divergence.actual, /no textbox "Email".*"E-mail"/);
});

test('duplicate controls: the recorded context picks one; without it the step diverges instead of guessing', async () => {
  setVariant('dup');
  const same = await replay(dirs.dup);
  assert.equal(same.outcome, 'reproduced', formatReplay(same));
  // The plain recording has no context; the page now has two "Open cart" links.
  const r = await replay(dirs.plain);
  assert.equal(r.outcome, 'diverged');
  assert.equal(r.divergence.step, 1);
  assert.match(r.divergence.actual, /2 controls match link "Open cart"; not guessing/);
});

test('a consequential step is blocked unless allowed, and never runs after a divergence', async () => {
  setVariant('base');
  const before = deletes();
  assert.equal(before, 1, 'the recording clicked Delete account once');
  const blocked = await replay(dirs.delete);
  assert.equal(blocked.outcome, 'blocked');
  assert.equal(blocked.blocked.step, 2);
  assert.match(blocked.blocked.reason, /consequential.*--allow-consequential/);
  assert.equal(replayExitCode(blocked), 3);
  assert.equal(deletes(), before, 'the delete did not run');

  const allowed = await replay(dirs.delete, { allowConsequential: true });
  assert.equal(allowed.outcome, 'reproduced', formatReplay(allowed));
  assert.equal(deletes(), before + 1);

  setVariant('rename');
  const diverged = await replay(dirs.delete, { allowConsequential: true });
  assert.equal(diverged.outcome, 'diverged');
  assert.equal(deletes(), before + 1, 'a divergence at step 1 means the delete at step 2 never runs');
  setVariant('base');
});

test('a masked value needs --secret <step>=<ENV_NAME>, and the value never appears in the result', async () => {
  const typedBefore = pwLengths();
  const blocked = await replay(dirs.secret);
  assert.equal(blocked.outcome, 'blocked');
  assert.equal(blocked.blocked.step, 3);
  assert.match(blocked.blocked.reason, /--secret 3=<ENV_NAME>/);
  assert.deepEqual(pwLengths(), typedBefore, 'nothing was typed into the password field');

  const noEnv = await replay(dirs.secret, { secrets: { 3: 'MY_REPLAY_SECRET' }, env: {} });
  assert.equal(noEnv.outcome, 'blocked');
  assert.match(noEnv.blocked.reason, /MY_REPLAY_SECRET.*not set/);

  const ok = await replay(dirs.secret, { secrets: { 3: 'MY_REPLAY_SECRET' }, env: { MY_REPLAY_SECRET: 'Another-Value-99' } });
  assert.equal(ok.outcome, 'reproduced', formatReplay(ok));
  assert.deepEqual(ok.steps.map((s) => s.status), ['ok', 'ok', 'ok', 'reproduced']);
  assert.deepEqual(pwLengths(), [...typedBefore, 'Another-Value-99'.length], 'the value from the environment was typed');
  assert.ok(!JSON.stringify(ok).includes('Another-Value-99') && !formatReplay(ok).includes('Another-Value-99'));
  assert.ok(!readFileSync(join(dirs.secret, 'bundle.json'), 'utf8').includes(PASSWORD));

  await assert.rejects(() => replay(dirs.secret, { secrets: { 1: 'X' } }), { code: 'invalid_request' });
  await assert.rejects(() => replay(dirs.secret, { secrets: { 3: 'not a name' } }), { code: 'invalid_request' });
});

test("a person's interaction blocks the replay at that step", async () => {
  setVariant('base');
  const b = loadBundle(dirs.plain);
  const [first, ...rest] = b.actions;
  const edited = { ...b, actions: [first, { index: 2, at: first.at, actor: 'person', description: 'tapped button "Pay"' }, ...rest.map((a) => ({ ...a, index: a.index + 1 }))], failure: { kind: 'action-error', step: 4, code: 'disabled' } };
  const file = join(stateDir, 'person-bundle.json');
  writeFileSync(file, JSON.stringify(edited));
  const r = await replay(file);
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.blocked.step, 2);
  assert.match(r.blocked.reason, /only as a description/);
  assert.deepEqual(r.steps.map((s) => s.status), ['ok', 'blocked']);
});

test('--until stops after a step; dropped log entries, unusable and too-new bundles cannot replay', async () => {
  setVariant('base');
  const r = await replay(dirs.plain, { until: 2 });
  assert.equal(r.outcome, 'not-reproduced');
  assert.equal(r.steps.length, 2);
  assert.match(r.reason, /stopped after step 2 \(--until\)/);

  const b = loadBundle(dirs.plain);
  const write = (name, o) => { const f = join(stateDir, name); writeFileSync(f, JSON.stringify(o)); return f; };
  const dropped = await replay(write('dropped.json', { ...b, actionsOmitted: 7 }));
  assert.equal(dropped.outcome, 'blocked');
  assert.match(dropped.reason, /dropped its first 7/);
  await assert.rejects(() => replay(write('new.json', { ...b, bundleVersion: 9 })), { code: 'bundle_too_new' });
  await assert.rejects(() => replay(write('bad-action.json', { ...b, actions: [{ ...b.actions[0], action: 'evaluate' }] })), { code: 'bundle_invalid' });
  await assert.rejects(() => replay(join(stateDir, 'missing')), { code: 'bundle_invalid' });
});

test('a findings bundle is reproduced when the recorded fingerprints appear again, and not when they do not', async () => {
  setVariant('base');
  const b = loadBundle(dirs.plain);
  const write = (name, o) => { const f = join(stateDir, name); writeFileSync(f, JSON.stringify(o)); return f; };
  const wide = loadBundle(dirs.wide);
  assert.equal(wide.failure.kind, 'findings');
  assert.ok(wide.failure.fingerprints.length > 0);
  setVariant('wide');
  const again = await replay(dirs.wide);
  assert.equal(again.outcome, 'reproduced', formatReplay(again));
  assert.deepEqual(again.findings.missing, []);
  setVariant('base');
  const gone = await replay(dirs.wide);
  assert.equal(gone.outcome, 'not-reproduced');
  assert.deepEqual(gone.findings.missing, wide.failure.fingerprints);
  const invented = await replay(write('f1.json', { ...b, actions: [], failure: { kind: 'findings', fingerprints: ['deadbeefdeadbeef'] } }));
  assert.equal(invented.outcome, 'not-reproduced');
  // A manual bundle is reproduced when the recorded steps run and end where the recording ended.
  assert.equal((await replay(write('f2.json', { ...b, failure: { kind: 'manual' } }))).outcome, 'reproduced');
  assert.equal((await replay(write('f3.json', { ...b, actions: [], failure: { kind: 'manual' } }))).outcome, 'not-reproduced');
});

test('a scenario failure is reproduced by re-running that scenario on that device', async () => {
  const b = loadBundle(dirs.scenario);
  assert.deepEqual(b.failure, { kind: 'scenario-error', scenario: 'cart-continue', device: 'mobile-390', failedAt: 'setup', code: 'disabled' });
  assert.equal(b.scenario.name, 'cart-continue');
  assert.deepEqual(b.scenario.steps.map((x) => x.value), ['‹secret›', undefined], 'the password step keeps no value');
  assert.ok(!readFileSync(join(dirs.scenario, 'bundle.json'), 'utf8').includes('scenario-password-1'), 'not in the sanitized profile either');
  setVariant('base');
  const again = await replay(dirs.scenario);
  assert.equal(again.outcome, 'reproduced', formatReplay(again));
  setVariant('fixed');
  const fixed = await replay(dirs.scenario);
  assert.equal(fixed.outcome, 'not-reproduced');
  assert.match(fixed.reason, /passed/);
  setVariant('base');
});

// ---------- CLI ----------

async function cli(args, env = {}) {
  try {
    const { stdout } = await run(process.execPath, [CLI, 'replay', ...args], { env: { ...process.env, AGENTLAB_HOME: stateDir, ...env }, timeout: 120_000 });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('CLI exit codes: 0 reproduced, 1 not reproduced, 2 could not run, 3 diverged or blocked', async () => {
  setVariant('base');
  const ok = await cli([dirs.plain, '--project', project, '--json']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).outcome, 'reproduced');

  const text = await cli([dirs.plain, '--project', project]);
  assert.match(text.stdout, /step 1  ok .*click link "Open cart"/);
  assert.match(text.stdout, /reproduced: step 3 failed with disabled again/);

  setVariant('fixed');
  const notReproduced = await cli([dirs.plain, '--project', project, '--json']);
  assert.equal(notReproduced.code, 1);
  assert.equal(JSON.parse(notReproduced.stdout).outcome, 'not-reproduced');

  setVariant('rename');
  const diverged = await cli([dirs.plain, '--project', project, '--json']);
  assert.equal(diverged.code, 3);
  assert.equal(JSON.parse(diverged.stdout).divergence.step, 1);
  setVariant('base');

  const blockedSecret = await cli([dirs.secret, '--project', project, '--json']);
  assert.equal(blockedSecret.code, 3);
  assert.equal(JSON.parse(blockedSecret.stdout).outcome, 'blocked');
  const withSecret = await cli([dirs.secret, '--project', project, '--json', '--secret', '3=MY_ENV'], { MY_ENV: 'Cli-Secret-Value-1' });
  assert.equal(withSecret.code, 0, withSecret.stdout + withSecret.stderr);
  assert.ok(!withSecret.stdout.includes('Cli-Secret-Value-1'));

  const blockedDelete = await cli([dirs.delete, '--project', project, '--json']);
  assert.equal(blockedDelete.code, 3);
  const allowedDelete = await cli([dirs.delete, '--project', project, '--json', '--allow-consequential']);
  assert.equal(allowedDelete.code, 0, allowedDelete.stdout);

  const missing = await cli([join(stateDir, 'nope'), '--project', project]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /bundle_invalid/);
  const tooNew = join(stateDir, 'too-new.json');
  writeFileSync(tooNew, JSON.stringify({ ...loadBundle(dirs.plain), bundleVersion: 9 }));
  assert.equal((await cli([tooNew, '--project', project])).code, 2);
  const noProject = await cli([dirs.plain, '--project', join(stateDir, 'no-such-project')]);
  assert.equal(noProject.code, 2);
});

test('agentlab bundles lists, shows, removes and prunes bundles', async () => {
  const bundles = async (...args) => {
    const { stdout } = await run(process.execPath, [CLI, 'bundles', ...args], { env: { ...process.env, AGENTLAB_HOME: stateDir } });
    return stdout;
  };
  const listed = JSON.parse(await bundles('list', '--json'));
  assert.equal(listed.bundles.length, readdirSync(bundlesDir).length);
  const id = loadBundle(dirs.plain).id;
  const shown = await bundles('show', id);
  assert.match(shown, /reason: recording plain/);
  assert.match(shown, /2  fill textbox "Email"/);
  assert.match(shown, /3  click button "Continue".*ERROR disabled/);
  assert.match(await bundles('rm', id), /removed/);
  assert.ok(!existsSync(dirs.plain));
  assert.match(await bundles('prune', '--older-than', '0'), /removed \d+ bundle/);
});
