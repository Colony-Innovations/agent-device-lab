// `agentlab doctor`: read-only checks of the machine and a project. Port 5341 (the multi-service example's api).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { isMusl, runDoctor } from '../dist/core/doctor.js';

const run = promisify(execFile);
const EX = resolve('examples/multi-service');
const TOKEN = 'doctor-token-value-must-not-appear';
const savedToken = process.env.DEMO_API_TOKEN;
const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  if (savedToken === undefined) delete process.env.DEMO_API_TOKEN; else process.env.DEMO_API_TOKEN = savedToken;
});
const doctor = (opts = {}) => runDoctor({ cwd: process.cwd(), project: EX, stateDir: tmp('agentlab-doctor-state-'), launch: false, ...opts });

test('a missing required env var fails the env check by name, without values', async () => {
  delete process.env.DEMO_API_TOKEN;
  const sentinel = 'doctor-sentinel-value-7c1';
  process.env.AGENTLAB_DOCTOR_SENTINEL = sentinel;
  try {
    const report = await doctor();
    assert.equal(report.ok, false);
    const env = report.checks.filter((c) => c.name.startsWith('env'));
    assert.ok(env.length >= 1);
    for (const c of env) { assert.equal(c.status, 'fail'); assert.match(c.detail, /DEMO_API_TOKEN/); }
    assert.ok(!JSON.stringify(report).includes(sentinel));
  } finally {
    delete process.env.AGENTLAB_DOCTOR_SENTINEL;
  }
});

test('with the token set and nothing running, the project is ready', async () => {
  process.env.DEMO_API_TOKEN = TOKEN;
  const report = await doctor();
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => c.status === 'fail')));
  assert.ok(!JSON.stringify(report).includes(TOKEN));
  assert.equal(report.checks.find((c) => c.name === 'project')?.status, 'ok');
});

test('a server answering 500 on the api port is a port conflict', async () => {
  process.env.DEMO_API_TOKEN = TOKEN;
  const server = createServer((req, res) => res.writeHead(500).end());
  await new Promise((r) => server.listen(5341, '127.0.0.1', r));
  try {
    const report = await doctor();
    assert.equal(report.ok, false);
    const api = report.checks.find((c) => c.name === 'service api');
    assert.equal(api?.status, 'fail');
    assert.match(api.detail, /port conflict/);
    assert.match(api.detail, /500/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a state directory that does not exist yet "will be created" and is not created', async () => {
  const stateDir = join(tmp('agentlab-doctor-parent-'), 'not', 'yet');
  const report = await doctor({ stateDir });
  const check = report.checks.find((c) => c.name === 'state directory');
  assert.equal(check?.status, 'ok');
  assert.match(check.detail, /will be created/);
  assert.equal(existsSync(stateDir), false);
});

test('launch: true proves Chromium starts', async () => {
  const report = await doctor({ launch: true });
  const browser = report.checks.find((c) => c.name === 'browser');
  assert.equal(browser?.status, 'ok', browser?.detail);
  assert.match(browser.detail, /launches headless/);
});

test('musl (Alpine) is told apart from glibc by the diagnostic report', () => {
  assert.equal(isMusl({ glibcVersionRuntime: '2.36' }), false);
  assert.equal(isMusl({}), process.platform === 'linux');
  assert.equal(isMusl(), false, 'the machine running the tests is glibc');
});

test('no project and no agentlab.json in cwd is a project warning', async () => {
  const report = await runDoctor({ cwd: tmp('agentlab-doctor-empty-'), stateDir: tmp('agentlab-doctor-state-'), launch: false });
  const project = report.checks.find((c) => c.name === 'project');
  assert.equal(project?.status, 'warn');
  assert.equal(report.profile, undefined);
});

test('the CLI prints a JSON report and exits 0 when ready', async () => {
  const home = tmp('agentlab-doctor-home-');
  const { stdout } = await run(process.execPath, ['bin/agentlab.js', 'doctor', '--project', 'examples/multi-service', '--no-launch', '--json'], {
    env: { ...process.env, AGENTLAB_HOME: home, DEMO_API_TOKEN: TOKEN }, timeout: 60_000,
  });
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.ok(Array.isArray(report.checks));
  assert.match(report.checks.find((c) => c.name === 'browser').detail, /launch not tested/);
  assert.ok(!stdout.includes(TOKEN));
});
