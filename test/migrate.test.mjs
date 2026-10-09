import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../dist/core/doctor.js';
import { migrateProfile } from '../dist/core/migrate.js';
import { parseProfile } from '../dist/core/profile.js';
import { CONTRACT_VERSIONS, productVersion } from '../dist/core/versions.js';
import { SCHEMA_VERSION } from '../dist/core/schema.js';

const P = '/repo/app/agentlab.json';
const v1 = {
  schemaVersion: 1, name: 'legacy',
  web: { command: 'npm run dev', cwd: 'web', url: 'http://127.0.0.1:5173/', env: { PORT: '5173' }, readiness: { path: '/health', status: 204, timeoutMs: 30000, intervalMs: 500 }, reuseExisting: false },
  startPath: '/home', device: 'mobile-320', settle: { maxMs: 8000 },
  scan: { devices: ['mobile-320'], policy: { failOn: 'medium' } },
};

/** The parts of a parsed profile that migration must not change. */
const essentials = (p) => ({ service: p.services[0], services: p.services.length, app: p.app, startPath: p.startPath, device: p.device, settle: p.settle, scan: p.scan, name: p.name });

test('contract versions: results derive from the schema constant; the product version is read once', () => {
  assert.equal(CONTRACT_VERSIONS.results, SCHEMA_VERSION);
  assert.equal(CONTRACT_VERSIONS.profile, 2);
  assert.deepEqual(CONTRACT_VERSIONS.profileSupported, [1, 2]);
  assert.match(productVersion(), /^\d+\.\d+\.\d+/);
  assert.equal(productVersion(), JSON.parse(readFileSync('package.json', 'utf8')).version);
});

test('migrating a v1 profile: web becomes services.web, app points at it, the rest is kept in order', () => {
  const m = migrateProfile(v1);
  assert.equal(m.changed, true);
  assert.equal(m.from, 1);
  assert.equal(m.to, 2);
  assert.deepEqual(Object.keys(m.profile), ['schemaVersion', 'name', 'services', 'app', 'startPath', 'device', 'settle', 'scan']);
  assert.equal(m.profile.schemaVersion, 2);
  assert.deepEqual(m.profile.services, { web: v1.web });
  assert.deepEqual(m.profile.app, { service: 'web' });
  assert.deepEqual(m.profile.scan, v1.scan);
  assert.ok(m.notes.length >= 2);
  assert.equal(v1.schemaVersion, 1, 'the input is not modified');
  assert.equal(v1.web.readiness.status, 204);
});

test('the migrated profile parses to an equivalent profile', () => {
  const before = parseProfile(v1, P);
  const after = parseProfile(migrateProfile(v1).profile, P);
  assert.equal(after.schemaVersion, 2);
  assert.equal(after.migration, undefined);
  assert.deepEqual(essentials(after), essentials(before));
  assert.equal(after.services[0].reuseExisting, false);
  assert.deepEqual(after.services[0].readiness, { kind: 'http', url: 'http://127.0.0.1:5173', path: '/health', status: 204, timeoutMs: 30000, intervalMs: 500 });
});

test('minimal v1 profiles round-trip, and only present keys are carried', () => {
  const min = { schemaVersion: 1, web: { command: 'node s.mjs', url: 'http://localhost:3000' } };
  const m = migrateProfile(min);
  assert.deepEqual(m.profile, { schemaVersion: 2, services: { web: min.web }, app: { service: 'web' } });
  assert.deepEqual(essentials(parseProfile(m.profile, P)), essentials(parseProfile(min, P)));
});

test('comments survive, and a v1 "app" (which v1 ignored) is replaced with a note', () => {
  const m = migrateProfile({ $schema: 'x', '// hi': 'there', schemaVersion: 1, web: { command: 'x', url: 'http://127.0.0.1:1', description: 'app' }, app: { url: 'http://127.0.0.1:9' } });
  assert.deepEqual(Object.keys(m.profile), ['$schema', '// hi', 'schemaVersion', 'services', 'app']);
  assert.equal(m.profile.services.web.description, 'app');
  assert.deepEqual(m.profile.app, { service: 'web' });
  assert.ok(m.notes.some((n) => /dropped "app"/.test(n)));
});

test('every schemaVersion 1 profile in the repo migrates and parses to the same thing', () => {
  for (const f of ['fixtures/invoice-app/agentlab.json', 'examples/nextjs/agentlab.json', 'examples/nextjs/attach.agentlab.json']) {
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    assert.equal(raw.schemaVersion, 1, f);
    const path = join(process.cwd(), f);
    assert.deepEqual(essentials(parseProfile(migrateProfile(raw).profile, path)), essentials(parseProfile(raw, path)), f);
  }
});

test('a current profile is unchanged; a newer or invalid one throws', () => {
  const v2 = { schemaVersion: 2, services: { web: { command: 'x', url: 'http://127.0.0.1:1' } } };
  const m = migrateProfile(v2);
  assert.equal(m.changed, false);
  assert.equal(m.from, 2);
  assert.equal(m.profile, v2);
  assert.deepEqual(m.notes, []);
  assert.throws(() => migrateProfile({ schemaVersion: 3 }), { code: 'profile_too_new' });
  assert.throws(() => migrateProfile({ schemaVersion: 1, web: { url: 'nope' } }), { code: 'invalid_profile' });
  assert.throws(() => migrateProfile({ schemaVersion: 1, web: { command: 'x', url: 'http://127.0.0.1:1' }, sevices: {} }), { code: 'invalid_profile' });
  assert.throws(() => migrateProfile('nope'), { code: 'invalid_profile' });
});

// ---------- the CLI (no browser, no daemon) ----------

const run = (args, opts = {}) => spawnSync(process.execPath, ['bin/agentlab.js', ...args], { encoding: 'utf8', ...opts });
const tmp = () => mkdtempSync(join(tmpdir(), 'agentlab-migrate-'));
const original = JSON.stringify(v1);

test('migrate --yes --json rewrites the file, keeps a backup and preserves formatting', () => {
  const dir = tmp();
  const file = join(dir, 'agentlab.json');
  writeFileSync(file, original);
  chmodSync(file, 0o600);
  const r = run(['migrate', '--project', dir, '--yes', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.changed, true);
  assert.equal(out.from, 1);
  assert.equal(out.to, 2);
  assert.equal(out.written, file);
  assert.equal(out.backup, `${file}.v1.bak`);
  assert.equal(readFileSync(out.backup, 'utf8'), original, 'the backup is the original bytes');
  const text = readFileSync(file, 'utf8');
  assert.equal(text, JSON.stringify(migrateProfile(v1).profile, null, 2) + '\n');
  assert.deepEqual(essentials(parseProfile(JSON.parse(text), file)), essentials(parseProfile(v1, file)));
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the file keeps its mode');
  assert.deepEqual(readdirSync(dir).sort(), ['agentlab.json', 'agentlab.json.v1.bak'], 'no temp file is left behind');

  const again = run(['migrate', '--project', dir]);
  assert.equal(again.status, 0);
  assert.equal(again.stdout, 'agentlab.json is already schemaVersion 2; nothing to do\n');
  assert.deepEqual(JSON.parse(run(['migrate', '--project', file, '--json']).stdout), { changed: false, from: 2, to: 2 });
});

test('migrate writes nothing without --yes or with --print, and refuses to overwrite a backup without --force', () => {
  const dir = tmp();
  const file = join(dir, 'agentlab.json');
  writeFileSync(file, original);

  const dry = run(['migrate', '--project', dir]);
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /schemaVersion 1 → 2/);
  assert.match(dry.stdout, /"services"/);
  assert.match(dry.stdout, /Nothing written/);
  const printed = run(['migrate', '--project', dir, '--print', '--json']);
  assert.equal(JSON.parse(printed.stdout).profile.schemaVersion, 2);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(existsSync(`${file}.v1.bak`), false);

  writeFileSync(`${file}.v1.bak`, 'older backup');
  const refused = run(['migrate', '--project', dir, '--yes']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already exists/);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(readFileSync(`${file}.v1.bak`, 'utf8'), 'older backup');

  const forced = run(['migrate', '--project', dir, '--yes', '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(readFileSync(`${file}.v1.bak`, 'utf8'), original);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).schemaVersion, 2);
});

test('migrate reports a newer or invalid profile without touching it', () => {
  const dir = tmp();
  const file = join(dir, 'agentlab.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 3 }));
  const newer = run(['migrate', '--project', dir, '--yes', '--json']);
  assert.equal(newer.status, 1);
  assert.equal(JSON.parse(newer.stdout).error.code, 'profile_too_new');
  writeFileSync(file, '{ not json');
  assert.equal(JSON.parse(run(['migrate', '--project', dir, '--json']).stdout).error.code, 'invalid_profile');
  assert.equal(readFileSync(file, 'utf8'), '{ not json');
  assert.equal(existsSync(`${file}.v1.bak`), false);
});

test('version --json lists the contract versions', () => {
  const info = JSON.parse(run(['version', '--json']).stdout);
  assert.deepEqual(info.contracts, CONTRACT_VERSIONS);
  assert.equal(info.agentlab, productVersion());
  assert.match(run(['version']).stdout, /^contracts: profile 2 \(reads 1–2\), results 1, mcp tools 1, report 1, bundle 1, events 1$/m);
});

test('doctor warns about a schemaVersion 1 profile and fails on a newer one', async () => {
  const dir = tmp();
  const doctor = () => runDoctor({ cwd: dir, project: dir, stateDir: join(dir, 'state'), launch: false });
  writeFileSync(join(dir, 'agentlab.json'), JSON.stringify({ schemaVersion: 1, web: { command: 'node s.mjs', url: 'http://127.0.0.1:59871' } }));
  const old = (await doctor()).checks.find((c) => c.name === 'profile version');
  assert.equal(old.status, 'warn');
  assert.match(old.hint, /agentlab migrate/);

  writeFileSync(join(dir, 'agentlab.json'), JSON.stringify({ schemaVersion: 3 }));
  const report = await doctor();
  const newer = report.checks.find((c) => c.name === 'profile version');
  assert.equal(newer.status, 'fail');
  assert.match(newer.detail, /schemaVersion 3; this agentlab .* reads schemaVersion 1–2/);
  assert.equal(report.ok, false);
});
