// A person supervises an MCP session over the dashboard while a client drives it over stdio: refused
// tool calls are structured errors (isError + structuredContent.error), the tool list never changes,
// and a stop is final for the server. The test app runs on 5365; the MCP server starts it from a temp profile.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dir = mkdtempSync(join(tmpdir(), 'agentlab-mcpsup-'));
const home = join(dir, 'home');
writeFileSync(join(dir, 'server.mjs'), `
import { createServer } from 'node:http';
const page = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">' +
  '<h1>Supervised</h1><button id="go" style="height:44px;min-width:88px">Go</button><p id="out" role="status"></p>' +
  '<script>go.onclick = () => { out.textContent = "went"; };</script>';
createServer((req, res) => {
  if (req.url === '/health') return res.end('ok');
  res.writeHead(200, { 'content-type': 'text/html' }).end(page);
}).listen(5365, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`);
writeFileSync(join(dir, 'agentlab.json'), JSON.stringify({
  schemaVersion: 2, name: 'mcpsup',
  services: { web: { command: 'node server.mjs', cwd: dir, url: 'http://127.0.0.1:5365', readiness: { path: '/health', timeoutMs: 15_000 } } },
}));

let client;
let stderr = '';
let controlUrl;
before(async () => {
  client = new Client({ name: 'agentlab-test', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['bin/agentlab.js', 'mcp', '--headless'],
    env: { ...process.env, AGENTLAB_HOME: home }, stderr: 'pipe',
  });
  transport.stderr.on('data', (c) => { stderr += c; });
  await client.connect(transport);
  // The person's URL goes to the MCP client's log (stderr), never into a tool result.
  const t0 = Date.now();
  while (!/dashboard with controls: (\S+)/.test(stderr) && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50));
  controlUrl = new URL(/dashboard with controls: (\S+)/.exec(stderr)[1]);
});
after(async () => {
  await client?.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { ...res, data: res.structuredContent };
};
const tokenOf = (u) => new URLSearchParams(u.hash.slice(1)).get('token');
/** A person's request to the dashboard. */
function control(op, token = tokenOf(controlUrl)) {
  const body = JSON.stringify({ op });
  return new Promise((resolve, reject) => {
    const req = request(`${controlUrl.origin}/api/control`, {
      method: 'POST', agent: false, headers: { authorization: `Bearer ${token}`, origin: controlUrl.origin, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('tool calls during a pause are structured, recoverable errors; the tool list is unchanged; reads still work', async () => {
  const before = (await client.listTools()).tools;
  const start = await call('start', { project: dir });
  assert.ok(!start.isError, start.content?.[0]?.text);
  assert.ok(!JSON.stringify(start).includes(tokenOf(controlUrl)), 'the control token is never in a tool result');
  const viewUrl = new URL(start.data.dashboard.url);
  assert.notEqual(tokenOf(viewUrl), tokenOf(controlUrl), 'agents are given a view-only URL');
  assert.equal((await control('pause', tokenOf(viewUrl))).status, 401, 'the view URL cannot pause');
  const view = await (await fetch(`${viewUrl.origin}/api/state?token=${tokenOf(viewUrl)}`)).json();
  assert.equal(view.canControl, false);

  const paused = await control('pause');
  assert.equal(paused.status, 200);
  assert.equal(paused.json.control.mode, 'paused');

  for (const [name, args] of [['click', { role: 'button', name: 'Go' }], ['fill', { role: 'textbox', name: 'x', value: 'y' }], ['sweep', {}], ['scan', {}], ['stop', {}], ['auth_save', {}], ['back', {}]]) {
    const r = await call(name, args);
    assert.equal(r.isError, true, name);
    assert.equal(r.data.error.code, 'session_paused', name);
    assert.equal(r.data.error.recoverable, true, name);
    assert.ok(r.data.error.hint, name);
    assert.equal(r.data.error.details.control.mode, 'paused');
    assert.match(r.content[0].text, /^error session_paused/);
  }
  assert.deepEqual((await client.listTools()).tools, before, 'refusals do not change the tools');

  const obs = await call('observe');
  assert.ok(!obs.isError, 'observe still works');
  assert.equal(obs.data.route, '/');
  assert.ok(!(await call('inspect')).isError);
  assert.ok(!(await call('tabs')).isError);

  await control('resume');
  const clicked = await call('click', { role: 'button', name: 'Go' });
  assert.ok(!clicked.isError, clicked.content?.[0]?.text);
  assert.deepEqual((await client.listTools()).tools, before);
});

test('a takeover refuses observe too; after the hand-back the agent must observe before it acts', async () => {
  assert.equal((await control('takeover')).json.control.mode, 'human');
  for (const name of ['observe', 'click']) {
    const r = await call(name, name === 'click' ? { role: 'button', name: 'Go' } : {});
    assert.equal(r.isError, true);
    assert.equal(r.data.error.code, 'human_control');
    assert.equal(r.data.error.recoverable, true);
  }
  assert.ok(!(await call('inspect')).isError);
  assert.equal((await control('return')).json.control.observeRequired, true);
  const early = await call('click', { role: 'button', name: 'Go' });
  assert.equal(early.isError, true);
  assert.equal(early.data.error.code, 'observation_required');
  assert.ok(!(await call('observe')).isError);
  const last = await call('click', { role: 'button', name: 'Go' });
  assert.ok(!last.isError, last.content[0].text);
});

test('a person\'s stop is final for this MCP server: start is refused with session_stopped', async () => {
  assert.equal((await control('stop')).status, 200);
  const r = await call('start', { project: dir });
  assert.equal(r.isError, true);
  assert.equal(r.data.error.code, 'session_stopped');
  assert.equal(r.data.error.recoverable, false);
  assert.match(r.data.error.hint, /Ask the user/);
  const obs = await call('observe');
  assert.equal(obs.isError, true);
  assert.ok(['session_stopped', 'browser_closed'].includes(obs.data.error.code), obs.data.error.code);
});
