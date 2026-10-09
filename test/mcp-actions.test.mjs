// An MCP client drives the Web V1 actions over stdio against the interaction fixture (port 5351):
// role+name addressing, action errors flagged to the model, and a typed PIN kept out of every result.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const home = mkdtempSync(join(tmpdir(), 'agentlab-mcp-actions-'));
const project = resolve('fixtures/interaction-app');
const PIN = '4321';
let client;

before(async () => {
  client = new Client({ name: 'agentlab-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ['bin/agentlab.js', 'mcp', '--headless', '--no-ui'],
    env: { ...process.env, AGENTLAB_HOME: home }, stderr: 'pipe',
  }));
});
after(async () => {
  await client?.callTool({ name: 'stop', arguments: {} }).catch(() => undefined);
  await client?.close();
  rmSync(home, { recursive: true, force: true });
});

const results = [];
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  results.push(res);
  return { ...res, data: res.structuredContent };
};
/** A successful action: not flagged as an error, and the page's #status text. */
const done = (r) => {
  assert.ok(!r.isError, r.content?.[0]?.text);
  assert.equal(r.data.outcome, 'success');
  return r.data.observation.messages.find((m) => m.role === 'status')?.text;
};

test('an MCP client drives select, check, press, back, tabs and upload by role and name', async () => {
  const start = await call('start', { project });
  assert.ok(!start.isError, start.content?.[0]?.text);
  assert.equal(start.data.observation.route, '/');

  let r = await call('click', { name: 'Form controls' });
  done(r);
  assert.equal(r.data.observation.route, '/form');
  assert.equal(done(await call('select', { name: 'Plan', values: ['Pro'] })), 'Plan: Pro');
  r = await call('check', { name: 'Email me updates' });
  assert.equal(done(r), 'Email updates on');
  assert.equal(r.data.method, 'tap');

  r = await call('back');
  done(r);
  assert.equal(r.data.observation.route, '/');
  assert.equal(r.data.changes.reset?.reason, 'navigation');

  done(await call('click', { name: 'Keyboard' }));
  done(await call('fill', { name: 'PIN', value: PIN }));
  assert.equal(done(await call('press', { name: 'PIN', key: 'Enter' })), 'PIN entered (4 digits)');
  done(await call('fill', { name: 'Search', value: 'lamps' }));
  assert.equal(done(await call('press', { name: 'Search', key: 'Enter' })), 'Searched for: lamps');

  const tabs = await call('tabs');
  assert.ok(!tabs.isError, tabs.content?.[0]?.text);
  assert.deepEqual(tabs.data.tabs.map((t) => [t.id, t.active]), [['t1', true]]);

  done(await call('click', { name: 'Home' }));
  done(await call('click', { name: 'Upload' }));
  r = await call('upload', { name: 'Attachments', files: ['uploads/notes.txt'] });
  assert.equal(done(r), 'Attached: notes.txt (79 bytes)');
  assert.equal(r.data.method, 'set-files');

  const outside = await call('upload', { name: 'Attachments', files: ['package.json'] });
  assert.equal(outside.isError, true, 'action errors are flagged to the model');
  assert.equal(outside.data.outcome, 'error');
  assert.equal(outside.data.error.code, 'upload_not_allowed');
  assert.equal(outside.data.error.recoverable, true);

  const stop = await call('stop');
  assert.equal(stop.data.server.stopped, true);
});

test('no tool result carries the PIN typed into the password field', () => {
  assert.ok(results.length > 10);
  for (const res of results) {
    const text = JSON.stringify(res.content) + JSON.stringify(res.structuredContent);
    assert.ok(!text.includes(PIN), `a result contains the PIN: ${text.slice(0, 200)}`);
  }
});
