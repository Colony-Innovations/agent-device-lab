// An MCP client drives the fixture over stdio: clean flow, then the seeded defect via inspect.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { probe } from '../dist/core/project-runner.js';

const home = mkdtempSync(join(tmpdir(), 'agentlab-mcp-'));
const project = resolve('fixtures/invoice-app');
const fixture = { url: 'http://127.0.0.1:5199', readiness: { path: '/health', status: 200 } };
let client;

before(async () => {
  client = new Client({ name: 'agentlab-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ['bin/agentlab.js', 'mcp', '--headless'],
    env: { ...process.env, AGENTLAB_HOME: home }, stderr: 'pipe',
  }));
});
after(async () => {
  await client?.close();
  rmSync(home, { recursive: true, force: true });
});

const results = [];
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  results.push(res);
  return { ...res, data: res.structuredContent };
};
/** What an agent does: read the latest observation and pick the control by role and name. */
const refOf = (observation, role, name) => {
  const matches = observation.controls.filter((c) => c.role === role && (typeof name === 'string' ? c.name === name : name.test(c.name)));
  assert.equal(matches.length, 1, `exactly one ${role} ${name} in ${observation.controls.map((c) => c.name).join(' | ')}`);
  return matches[0].ref;
};

test('lists exactly the MCP surface with JSON schemas from the command table', async () => {
  const { tools } = await client.listTools();
  // The original surface keeps its order; Web V1 actions, tabs and auth_save follow it.
  assert.deepEqual(tools.map((t) => t.name), ['start', 'observe', 'click', 'fill', 'inspect', 'sweep', 'scan', 'bundle', 'stop',
    'press', 'select', 'check', 'uncheck', 'scroll', 'swipe', 'back', 'forward', 'hover', 'upload', 'drag', 'tabs', 'open_tab', 'switch_tab', 'close_tab', 'auth_save']);
  const fill = tools.find((t) => t.name === 'fill');
  assert.deepEqual(fill.inputSchema.required, ['value']);
  assert.ok(fill.inputSchema.properties.ref);
});

test('an MCP client completes the clean invoice flow', async () => {
  const start = await call('start', { project });
  assert.ok(!start.isError, start.content?.[0]?.text);
  let obs = start.data.observation;
  assert.equal(obs.route, '/invoices');
  assert.match(start.content[0].text, /controls \(5\)/, 'text content is the concise rendering');
  // The start result links the live dashboard; the dashboard follows this MCP session.
  const url = new URL(start.data.dashboard.url);
  assert.equal(url.hostname, '127.0.0.1');
  const state = await (await fetch(`${url.origin}/api/state?token=${new URLSearchParams(url.hash.slice(1)).get('token')}`)).json();
  assert.equal(state.status.sessionId, start.data.session.id);
  assert.equal(state.status.state, 'active');

  let r = await call('click', { ref: refOf(obs, 'button', 'New invoice') });
  assert.equal(r.data.changes.dialog.to, 'Create invoice');
  obs = r.data.observation;

  r = await call('fill', { ref: refOf(obs, 'textbox', 'Customer'), value: 'Acme Ltd' });
  r = await call('fill', { role: 'textbox', name: 'Amount', value: '120' });           // role+name addressing
  r = await call('click', { role: 'button', name: 'Save' });
  assert.equal(r.data.outcome, 'success');
  assert.deepEqual(r.data.changes.messagesAdded, [{ role: 'status', text: 'Invoice INV-003 created' }]);
  obs = r.data.observation;

  r = await call('click', { ref: refOf(obs, 'link', /^INV-003 Acme Ltd/) });
  assert.equal(r.data.navigated, true);
  assert.equal(r.data.observation.route, '/invoices/INV-003');

  r = await call('click', { role: 'button', name: 'Mark as paid' });
  assert.ok(r.data.changes.changed.some((c) => c.name === 'Mark as paid' && c.fields.some((f) => f.field === 'disabled' && f.to === true)));

  const stale = await call('click', { ref: 'e3' });
  assert.equal(stale.isError, true, 'action errors are flagged to the model');
  assert.equal(stale.data.error.code, 'stale_ref');
  assert.equal(stale.data.error.recoverable, true);

  const findings = await call('inspect');
  assert.deepEqual(findings.data.findings, [], 'the clean flow has no findings');

  const stop = await call('stop');
  assert.equal(stop.data.server.stopped, true);
});

test('an MCP client retrieves the seeded mobile defect finding', async () => {
  const start = await call('start', { project });                                   // a fresh session after stop
  assert.ok(!start.isError, start.content?.[0]?.text);
  let r = await call('click', { role: 'link', name: 'Reports' });
  assert.ok(r.data.newFindings.some((f) => f.kind === 'control-clipped' && f.target.name === 'Export CSV'));
  r = await call('click', { role: 'button', name: 'Export CSV' });
  assert.equal(r.data.outcome, 'success', 'the automated tap succeeds…');
  const pan = r.data.newFindings.find((f) => f.kind === 'horizontal-pan-required');
  assert.ok(pan, '…but the sideways pan is recorded as a finding');

  const list = await call('inspect');
  assert.deepEqual(list.data.findings.map((f) => f.kind).sort(), ['control-clipped', 'control-clipped', 'horizontal-overflow', 'horizontal-pan-required']);

  const one = await call('inspect', { id: pan.id });
  const f = one.data.findings[0];
  assert.equal(f.severity, 'high');
  assert.equal(f.route, '/reports');
  assert.equal(f.evidence.panPx, 208);
  assert.deepEqual(f.reproduction.slice(1), ['click link "Reports"', 'click button "Export CSV"']);
  assert.match(one.content[0].text, /reproduce:\n\s+1\. open http:\/\/127\.0\.0\.1:5199\/invoices/);

  const missing = await call('inspect', { id: 'F99' });
  assert.equal(missing.isError, true);
  assert.equal(missing.data.error.code, 'not_found');

  await call('stop');
  assert.equal((await probe(fixture)).kind, 'down');
});

test('frames stay out of tool results, and each session gets a fresh dashboard token', async () => {
  const JPEG_BASE64 = '/9j/';
  for (const r of results) {
    assert.ok(r.content.every((c) => c.type === 'text'), 'no image content');
    assert.ok(!JSON.stringify(r).includes(JPEG_BASE64), 'no encoded frames');
  }
  const [first, second] = results.filter((r) => r.structuredContent?.dashboard).map((r) => new URL(r.structuredContent.dashboard.url));
  assert.equal(first.port, second.port, 'one dashboard per MCP server');
  assert.notEqual(first.hash, second.hash, 'a new session revokes the previous link');
  const old = await fetch(`${first.origin}/api/state?token=${new URLSearchParams(first.hash.slice(1)).get('token')}`);
  assert.equal(old.status, 401);
});
