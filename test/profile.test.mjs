import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertUrlAllowed, didYouMean, isLocalOrPrivateHost, loadProfile, parseProfile } from '../dist/core/profile.js';

const valid = { schemaVersion: 1, name: 'x', web: { command: 'npm run dev', url: 'http://127.0.0.1:5173/' } };

test('applies defaults and resolves cwd against the profile directory', () => {
  const p = parseProfile(valid, '/repo/app/agentlab.json');
  assert.equal(p.web.cwd, '/repo/app');
  assert.equal(p.web.url, 'http://127.0.0.1:5173');
  assert.deepEqual(p.web.readiness, { path: '/', status: 200, timeoutMs: 60000, intervalMs: 250 });
  assert.equal(p.web.reuseExisting, true);
  assert.equal(p.device, 'mobile-390');
});

test('reports every problem at once', () => {
  assert.throws(() => parseProfile({ schemaVersion: 2, web: { url: 'nope', readiness: { path: 'health', timeoutMs: -1 } } }, '/p/agentlab.json'),
    (err) => err.code === 'invalid_profile' && err.details.problems.length === 5);
});

test('external URLs need explicit opt-in', () => {
  assert.throws(() => parseProfile({ ...valid, web: { ...valid.web, url: 'https://example.com' } }, '/p/agentlab.json'), { code: 'url_not_allowed' });
  assert.equal(parseProfile({ ...valid, allowExternalUrl: true, web: { ...valid.web, url: 'https://example.com' } }, '/p/agentlab.json').allowExternalUrl, true);
  assert.throws(() => assertUrlAllowed('file:///etc/passwd', true), { code: 'url_not_allowed' });
});

test('local and private host policy', () => {
  for (const h of ['localhost', 'app.localhost', '127.0.0.1', '10.1.2.3', '192.168.0.4', '172.20.0.1', '[::1]']) assert.ok(isLocalOrPrivateHost(h), h);
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '11.0.0.1']) assert.ok(!isLocalOrPrivateHost(h), h);
});

test('the fixture profile loads from its directory', async () => {
  const p = await loadProfile('fixtures/invoice-app');
  assert.equal(p.web.readiness.path, '/health');
  assert.equal(p.startPath, '/invoices');
});

test('missing profile is a clear error', async () => {
  await assert.rejects(loadProfile('does-not-exist'), { code: 'invalid_profile' });
});

test('settle policy defaults and validation', () => {
  assert.deepEqual(parseProfile(valid, '/p/agentlab.json').settle, { quietMs: 120, maxMs: 5000, backgroundRequests: [], timerMaxMs: 1000 });
  const p = parseProfile({ ...valid, settle: { maxMs: 15000, backgroundRequests: ['/api/poll', '/sse'], timerMaxMs: 0 } }, '/p/agentlab.json');
  assert.deepEqual(p.settle, { quietMs: 120, maxMs: 15000, backgroundRequests: ['/api/poll', '/sse'], timerMaxMs: 0 }, '0 disables timer tracking');
  assert.throws(() => parseProfile({ ...valid, settle: { maxMs: 0, backgroundRequests: [''], timerMaxMs: -1 } }, '/p/agentlab.json'),
    (err) => err.code === 'invalid_profile' && err.details.problems.length === 3);
});

// ---------- strict keys and schemaVersion ----------

const P = '/p/agentlab.json';
const v2 = { schemaVersion: 2, name: 'x', services: { web: { command: 'npm run dev', url: 'http://127.0.0.1:5173' } } };
const problemsOf = (raw) => {
  try { parseProfile(raw, P); } catch (err) { assert.equal(err.code, 'invalid_profile'); return err.details.problems; }
  return [];
};

test('an unknown top-level key is reported with a did-you-mean', () => {
  assert.deepEqual(problemsOf({ ...v2, sevices: {} }), ['unknown key "sevices" at top level (did you mean "services"?)']);
  assert.deepEqual(problemsOf({ ...v2, zzzzzz: 1 }), ['unknown key "zzzzzz" at top level']);
});

test('unknown keys are reported at every level', () => {
  const svc = { command: 'x', url: 'http://127.0.0.1:1' };
  const cases = [
    [{ ...v2, services: { web: { ...svc, reuseExistng: true } } }, 'unknown key "reuseExistng" in "services.web" (did you mean "reuseExisting"?)'],
    [{ ...v2, services: { web: { ...svc, readiness: { path: '/', timeoutMz: 5 } } } }, 'unknown key "timeoutMz" in "services.web.readiness" (did you mean "timeoutMs"?)'],
    [{ ...v2, services: { web: { ...svc, shutdown: { signl: 'SIGTERM' } } } }, 'unknown key "signl" in "services.web.shutdown" (did you mean "signal"?)'],
    [{ ...v2, app: { servce: 'web' } }, 'unknown key "servce" in "app" (did you mean "service"?)'],
    [{ ...v2, devices: { phone: { extends: 'mobile-390', hasTuch: true } } }, 'unknown key "hasTuch" in "devices.phone" (did you mean "hasTouch"?)'],
    [{ ...v2, settle: { quietMS: 100 } }, 'unknown key "quietMS" in "settle" (did you mean "quietMs"?)'],
    [{ ...v2, auth: { loginpath: '/login' } }, 'unknown key "loginpath" in "auth" (did you mean "loginPath"?)'],
    [{ ...v2, uploads: { allow: [], deny: [] } }, 'unknown key "deny" in "uploads"'],
    [{ ...v2, scan: { device: ['mobile-390'] } }, 'unknown key "device" in "scan" (did you mean "devices"?)'],
    [{ ...v2, scan: { checks: { enabel: [] } } }, 'unknown key "enabel" in "scan.checks" (did you mean "enable"?)'],
    [{ ...v2, scan: { tapTargets: { standard: 'wcag22-aa', level: 1 } } }, 'unknown key "level" in "scan.tapTargets"'],
    [{ ...v2, scan: { explore: { maxDepht: 2 } } }, 'unknown key "maxDepht" in "scan.explore" (did you mean "maxDepth"?)'],
    [{ ...v2, scan: { scenarios: [{ name: 'a', route: '/', step: [] }] } }, 'unknown key "step" in "scan.scenarios[0]" (did you mean "steps"?)'],
    [{ ...v2, scan: { scenarios: [{ name: 'a', route: '/', steps: [{ do: 'click', name: 'Go', nme: 'x' }] }] } }, 'unknown key "nme" in "scan.scenarios[0].steps[0]" (did you mean "name"?)'],
    [{ ...v2, scan: { scenarios: [{ name: 'a', route: '/', steps: [{ do: 'click', name: 'Go', expect: { hedaing: 'x' } }] }] } }, 'unknown key "hedaing" in "scan.scenarios[0].steps[0].expect" (did you mean "heading"?)'],
    [{ ...v2, scan: { suppressions: [{ kind: 'overflow', reason: 'r', expire: '2027-01-01' }] } }, 'unknown key "expire" in "scan.suppressions[0]" (did you mean "expires"?)'],
    [{ ...v2, scan: { suppressions: [{ kind: 'overflow', reason: 'r', target: { rol: 'button' } }] } }, 'unknown key "rol" in "scan.suppressions[0].target" (did you mean "role"?)'],
    [{ ...v2, scan: { policy: { failon: 'high' } } }, 'unknown key "failon" in "scan.policy" (did you mean "failOn"?)'],
  ];
  for (const [raw, expected] of cases) assert.ok(problemsOf(raw).includes(expected), `${expected}\n  got: ${problemsOf(raw).join(' | ') || 'no problems'}`);
});

test('a schemaVersion 1 web section is checked too', () => {
  assert.deepEqual(problemsOf({ schemaVersion: 1, web: { command: 'x', url: 'http://127.0.0.1:1', reuseExistng: true, readiness: { pth: '/' } } }), [
    'unknown key "reuseExistng" in "web" (did you mean "reuseExisting"?)',
    'unknown key "pth" in "web.readiness" (did you mean "path"?)',
  ]);
});

test('$schema, description, comment and // keys are allowed for comments', () => {
  const svc = { command: 'x', url: 'http://127.0.0.1:1', description: 'the app', '// why': 'because', readiness: { path: '/', comment: 'health' } };
  const p = parseProfile({
    $schema: './agentlab.schema.json', ...v2, description: 'top', comment: 'c', '//': 'x',
    services: { web: svc },
    scan: { '// note': 1, description: 'd', scenarios: [{ name: 'a', route: '/', comment: 'c', steps: [{ do: 'click', name: 'Go', comment: 'c' }] }] },
  }, P);
  assert.equal(p.services[0].command, 'x');
});

test('the ci section is parsed strictly', () => {
  assert.deepEqual(parseProfile({ ...v2, ci: { flows: ['a.flow.json'], failOn: 'medium' } }, P).ci, { flows: ['a.flow.json'], failOn: 'medium' });
  assert.deepEqual(parseProfile(v2, P).ci, {});
  assert.throws(() => parseProfile({ ...v2, ci: { anything: { goes: true } } }, P), /unknown key "anything" in "ci"/);
});

test('did-you-mean uses distance 2 and never suggests for unrelated keys', () => {
  assert.equal(didYouMean('reuseExistng', ['reuseExisting', 'required']), 'reuseExisting');
  assert.equal(didYouMean('SERVICES', ['services']), 'services');
  assert.equal(didYouMean('command', ['cwd', 'url']), undefined);
  assert.equal(didYouMean('x', ['to', 'do']), undefined);
});

test('schemaVersion is required, and a newer one is refused before anything else is read', () => {
  const { schemaVersion, ...noVersion } = v2;
  assert.deepEqual(problemsOf(noVersion), ['"schemaVersion" is required (2 for this version of agentlab)']);
  for (const bad of ['2', 1.5, 0, null]) assert.match(problemsOf({ ...v2, schemaVersion: bad })[0], /"schemaVersion" must be a whole number from 1 to 2/);
  assert.throws(() => parseProfile({ schemaVersion: 3, sevices: 1, services: 'nonsense' }, P), (err) =>
    err.code === 'profile_too_new' && /agentlab.json has schemaVersion 3; this agentlab \d+\.\d+\.\d+\S* reads schemaVersion 1–2/.test(err.message)
    && /Upgrade agentlab/.test(err.hint));
});

test('a schemaVersion 1 profile parses and carries a migration note; schemaVersion 2 does not', () => {
  const p = parseProfile(valid, P);
  assert.equal(p.schemaVersion, 1);
  assert.equal(p.migration, 'schemaVersion 1 profile: run `agentlab migrate` to rewrite it as schemaVersion 2');
  assert.equal(parseProfile(v2, P).migration, undefined);
});
