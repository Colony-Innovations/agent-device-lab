import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatProposal, proposeProfile, writeProposal } from '../dist/core/init.js';
import { parseProfile } from '../dist/core/profile.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

/** A temp project from a map of relative path → contents (objects are written as JSON). */
function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'agentlab-init-'));
  temps.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

/** Every path with its size and mtime, recursively. */
function listing(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const s = statSync(p);
      out.push(`${relative(dir, p)} ${s.size} ${s.mtimeMs}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

const parses = (p) => parseProfile(p.profile, join(p.dir, 'agentlab.json'));

test('vite + bun single app becomes one web service', async () => {
  const dir = project({
    'bun.lock': '',
    'package.json': { name: 'vite-app', scripts: { dev: 'vite', build: 'vite build' }, devDependencies: { vite: '^6' } },
  });
  const p = await proposeProfile(dir);
  assert.deepEqual(Object.keys(p.profile.services), ['web']);
  assert.equal(p.profile.services.web.command, 'bun run dev');
  assert.equal(p.profile.services.web.url, 'http://localhost:5173');
  assert.equal(p.profile.services.web.cwd, undefined);
  assert.deepEqual(p.profile.app, { service: 'web' });
  assert.equal(p.profile.name, 'vite-app');
  assert.ok(p.detections.some((d) => d.kind === 'package-script' && d.detail === 'scripts.dev = "vite"'));
  parses(p);
});

test('examples/multi-service: api, worker and web with dependencies and required env names', async () => {
  const dir = join(repo, 'examples/multi-service');
  const before = listing(dir);
  const p = await proposeProfile(dir);
  assert.deepEqual(listing(dir), before);
  const s = p.profile.services;
  // The example's compose.yaml (an optional redis on 5349) is proposed too, so every service also waits for it.
  assert.deepEqual(Object.keys(s), ['compose', 'api', 'worker', 'web']);
  assert.deepEqual(s.compose.readiness, { tcp: '127.0.0.1:5349', timeoutMs: 120000 });
  assert.equal(s.api.url, 'http://localhost:5341');
  assert.equal(s.api.cwd, 'api');
  assert.equal(s.api.readiness.path, '/health', 'a health route in the server code beats "/"');
  assert.deepEqual(s.worker.readiness, { alive: 2000 });
  assert.deepEqual(s.worker.dependsOn, ['compose', 'api']);
  assert.equal(s.web.url, 'http://localhost:5342');
  assert.deepEqual(s.web.dependsOn, ['compose', 'api']);
  for (const name of ['api', 'worker', 'web']) assert.ok(s[name].requiredEnv.includes('DEMO_API_TOKEN'), name);
  assert.deepEqual(p.profile.app, { service: 'web' });
  assert.ok(p.existing);
  parses(p);
});

test('docker compose + next: a oneshot compose service the web service depends on', async () => {
  const dir = project({
    'package-lock.json': '{}',
    'package.json': { name: 'next-app', scripts: { dev: 'next dev' }, dependencies: { next: '15' } },
    'compose.yaml': [
      'services:',
      '  db:',
      '    image: postgres:16',
      '    ports:',
      '      - "5432:5432"',
      '  cache:',
      '    image: redis:7',
      '    ports:',
      '      - "127.0.0.1:6379:6379"',
      'volumes:',
      '  data: {}',
      '',
    ].join('\n'),
  });
  const p = await proposeProfile(dir);
  const s = p.profile.services;
  assert.deepEqual(Object.keys(s), ['compose', 'web']);
  assert.equal(s.compose.command, 'docker compose up -d');
  assert.equal(s.compose.mode, 'oneshot');
  assert.deepEqual(s.compose.readiness, { tcp: '127.0.0.1:5432', timeoutMs: 120000 });
  assert.deepEqual(s.compose.shutdown, { command: 'docker compose stop' });
  assert.equal(s.web.command, 'npm run dev');
  assert.equal(s.web.url, 'http://localhost:3000');
  assert.equal(s.web.readiness.timeoutMs, 120000);
  assert.deepEqual(s.web.dependsOn, ['compose']);
  assert.ok(p.detections.some((d) => d.kind === 'compose-service' && d.detail === 'cache publishes 6379'));
  parses(p);
});

test('playwright webServer sets the web command and url', async () => {
  const dir = project({
    'package.json': { name: 'pw-app', scripts: { dev: 'vite', preview: 'vite preview' }, devDependencies: { vite: '6', '@playwright/test': '1' } },
    'playwright.config.ts': [
      "import { defineConfig } from '@playwright/test';",
      'export default defineConfig({',
      "  use: { baseURL: 'http://127.0.0.1:4173' },",
      "  webServer: { command: 'npm run preview', url: 'http://127.0.0.1:4173' },",
      '});',
    ].join('\n'),
  });
  const p = await proposeProfile(dir);
  assert.equal(p.profile.services.web.url, 'http://127.0.0.1:4173');
  assert.equal(p.profile.services.web.command, 'npm run preview');
  assert.ok(p.detections.some((d) => d.kind === 'playwright-config'));
  parses(p);
});

test('env: only names from the example file; .env values never appear', async () => {
  const dir = project({
    'package.json': { name: 'secrets-app', scripts: { dev: 'vite' }, devDependencies: { vite: '6' } },
    '.env': 'SECRET_KEY=hunter2\n',
    '.env.example': 'SECRET_KEY=\nMODE=mock\n',
  });
  const p = await proposeProfile(dir);
  assert.deepEqual(p.profile.services.web.requiredEnv, ['SECRET_KEY']);
  for (const text of [JSON.stringify(p), formatProposal(p)]) {
    assert.ok(!text.includes('hunter2'));
    assert.ok(!text.includes('mock'));
  }
  assert.ok(p.detections.some((d) => d.detail === 'MODE has example default'));
  assert.ok(p.warnings.some((w) => w.includes('SECRET_KEY')));
});

test('proposing writes nothing; writing is explicit, refuses to overwrite, and is idempotent for .gitignore', async () => {
  const dir = project({ 'package.json': { name: 'w', scripts: { dev: 'vite' }, devDependencies: { vite: '6' } }, '.gitignore': 'node_modules/' });
  const before = listing(dir);
  const p = await proposeProfile(dir);
  assert.deepEqual(listing(dir), before);
  assert.deepEqual(p.gitignore, { file: join(dir, '.gitignore'), exists: true, ignoresState: false });
  assert.match(formatProposal(p), /Nothing has been written/);

  const r = await writeProposal(p);
  assert.equal(r.profilePath, join(dir, 'agentlab.json'));
  assert.equal(r.gitignoreUpdated, true);
  assert.deepEqual(JSON.parse(readFileSync(r.profilePath, 'utf8')), p.profile);
  assert.ok(readFileSync(r.profilePath, 'utf8').endsWith('}\n'));
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'node_modules/\n\n# Agent Device Lab: local runs, logs and saved sign-in state\n.agentlab/\n');

  await assert.rejects(writeProposal(p), { code: 'invalid_request' });
  const again = await writeProposal(p, { force: true });
  assert.equal(again.gitignoreUpdated, false);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8').match(/^\.agentlab\/$/gm).length, 1);
  const reproposed = await proposeProfile(dir);
  assert.equal(reproposed.existing, true);
  assert.equal(reproposed.gitignore.ignoresState, true);
});

test('empty directory gets a placeholder proposal with a prominent warning', async () => {
  const dir = project({});
  const p = await proposeProfile(dir);
  assert.deepEqual(p.profile.services, { web: { command: 'npm run dev', url: 'http://localhost:3000', readiness: { path: '/', timeoutMs: 60000 } } });
  assert.match(p.warnings[0], /NOTHING RUNNABLE/);
  assert.equal(p.gitignore.exists, false);
  parses(p);
  assert.deepEqual(readdirSync(dir), []);
});

test('a Django project (manage.py) gets a runserver service with its virtualenv python and a TCP readiness check', async () => {
  const dir = project({ 'manage.py': '', 'mysite/settings.py': '', '.venv/pyvenv.cfg': 'home = /usr/bin', '.venv/bin/python': '' });
  const before = listing(dir);
  const p = await proposeProfile(dir);
  assert.equal(p.profile.services.web.command, '.venv/bin/python manage.py runserver 127.0.0.1:8000 --noreload');
  assert.deepEqual(p.profile.services.web.readiness, { tcp: '127.0.0.1:8000', timeoutMs: 60_000 });
  assert.ok(!p.warnings.some((w) => w.startsWith('NOTHING RUNNABLE')), 'not a placeholder');
  assert.ok(p.detections.some((d) => d.kind === 'django'));
  parseProfile(p.profile, join(dir, 'agentlab.json'));
  assert.deepEqual(listing(dir), before, 'read-only');
});

test('a Django project without a virtualenv falls back to python3 and says so; a Node project is not treated as Django', async () => {
  const bare = await proposeProfile(project({ 'manage.py': '' }));
  assert.match(bare.profile.services.web.command, /^python3 manage\.py runserver/);
  assert.ok(bare.warnings.some((w) => /no virtualenv/.test(w)));
  const node = await proposeProfile(project({ 'manage.py': '', 'package.json': { name: 'x', scripts: { dev: 'vite' }, devDependencies: { vite: '7' } } }));
  assert.doesNotMatch(node.profile.services.web.command, /manage\.py/);
});
