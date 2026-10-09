// The scan through the CLI (`scan --project`, exit codes, --json) and through MCP (scan, inspect).
// The responsive fixture is started by the lab from a temp profile on 5353.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const FIXTURE = resolve('fixtures/responsive-app');
const fixtureProfile = JSON.parse(readFileSync(join(FIXTURE, 'agentlab.json'), 'utf8'));
const home = mkdtempSync(join(tmpdir(), 'agentlab-scan-cli-home-'));
const temps = [home];
const homeOnly = [{ name: 'Home as loaded', route: '/' }];

after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function project(scan = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agentlab-scan-cli-proj-'));
  temps.push(dir);
  writeFileSync(join(dir, 'agentlab.json'), JSON.stringify({
    ...fixtureProfile,
    services: { web: { ...fixtureProfile.services.web, command: 'node server.mjs', cwd: FIXTURE } },
    scan: { ...fixtureProfile.scan, devices: ['mobile-390'], scenarios: homeOnly, ...scan },
  }));
  return dir;
}

/** Run the CLI and collect its output; nothing is written to the repo because state goes under AGENTLAB_HOME. */
function agentlab(args) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['bin/agentlab.js', ...args], { env: { ...process.env, AGENTLAB_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}
const keysDeep = (v, out = new Set()) => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
};

test('scan --project passes under the default policy: exit 0 and a PASS first line', async () => {
  const r = await agentlab(['scan', '--project', project(), '--scenario', 'Home as loaded', '--devices', 'mobile-390']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout.split('\n')[0], /^scan R1: PASS/);
  assert.match(r.stdout, /Home as loaded @ mobile-390: ok/);
  assert.match(r.stdout, /report: .*report\.html/);
});

test('scan --project exits 1 when the policy fails', async () => {
  const r = await agentlab(['scan', '--project', project({ policy: { failOn: 'medium' } }), '--scenario', 'Home as loaded', '--devices', 'mobile-390']);
  assert.equal(r.code, 1, r.stderr + r.stdout);
  assert.match(r.stdout.split('\n')[0], /^scan R1: FAIL/);
});

test('an unknown scenario exits 2 and names the declared ones', async () => {
  const r = await agentlab(['scan', '--project', project(), '--scenario', 'No such', '--devices', 'mobile-390']);
  assert.equal(r.code, 2, r.stderr + r.stdout);
  assert.match(r.stderr, /No such/);
  assert.match(r.stderr, /Home as loaded/, 'the error lists the declared scenario names');
});

test('--json prints a compact summary without frames', async () => {
  const r = await agentlab(['scan', '--project', project(), '--scenario', 'Home as loaded', '--devices', 'mobile-390', '--json']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.ok(Buffer.byteLength(r.stdout) < 20_000, `${Buffer.byteLength(r.stdout)} bytes`);
  const s = JSON.parse(r.stdout);
  for (const k of ['verdict', 'runs', 'groups', 'reports']) assert.ok(k in s, `summary has ${k}`);
  assert.equal(s.verdict.result, 'pass');
  assert.equal(s.runs.length, 1);
  assert.equal(s.runs[0].status, 'ok');
  assert.ok(s.groups.length > 0);
  const keys = keysDeep(s);
  assert.ok(!keys.has('frame') && !keys.has('frames'), 'no frame keys');
  assert.ok(s.reports.html.endsWith('report.html') && s.reports.json.endsWith('result.json'));
});

// ---- MCP ----------------------------------------------------------------------------------
let client;
before(async () => {
  client = new Client({ name: 'agentlab-scan-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ['bin/agentlab.js', 'mcp', '--headless', '--no-ui'],
    env: { ...process.env, AGENTLAB_HOME: home }, stderr: 'pipe',
  }));
});
after(async () => { await client?.close(); });

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { ...res, data: res.structuredContent };
};

test('an MCP client scans, inspects a finding by id and stops', async () => {
  try {
    const start = await call('start', { project: project() });
    assert.ok(!start.isError, start.content?.[0]?.text);

    const scan = await call('scan', { scenarios: 'Home as loaded', devices: 'mobile-390' });
    assert.ok(!scan.isError, scan.content?.[0]?.text);
    const s = scan.data;
    assert.equal(s.verdict.result, 'pass');
    assert.match(scan.content[0].text, /^scan R1: PASS/);
    assert.ok(s.groups.length > 0);
    assert.ok(s.groups.every((g) => g.findings.length > 0 && g.findings.every((id) => /^F\d+$/.test(id))));
    const keys = keysDeep(s);
    assert.ok(!keys.has('frame') && !keys.has('frames'), 'no frame keys in the MCP result');
    const paths = JSON.stringify({ ...s, reports: undefined });
    assert.doesNotMatch(paths, /\.jpe?g/, 'no frame paths outside reports');
    assert.match(s.reports.html, /report\.html$/);

    const id = s.groups[0].findings[0];
    const inspected = await call('inspect', { id });
    assert.ok(!inspected.isError, inspected.content?.[0]?.text);
    const f = inspected.data.findings.find((x) => x.id === id);
    assert.ok(f, JSON.stringify(inspected.data).slice(0, 400));
    assert.equal(f.scenario, 'Home as loaded');
    assert.ok(f.state);
    assert.equal(f.device, 'mobile-390');
  } finally {
    const stop = await call('stop');
    assert.ok(!stop.isError, stop.content?.[0]?.text);
  }
});
