// Runtime behaviour found on an independent app (docs/independent-app.md): settling on timer-driven,
// aria-busy and animated UIs; context for repeated labels; toggle state; fixed bars; and owned-only
// cleanup of a wrapper → server process tree. Ports 5334 and 5335.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lab } from '../dist/core/lab.js';
import { probe } from '../dist/core/project-runner.js';

const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const group = (pgid) => { try { return execFileSync('pgrep', ['-g', String(pgid)]).toString().trim().split('\n').map(Number); } catch { return []; } };

const app = tmp('agentlab-runtime-');
writeFileSync(join(app, 'agentlab.json'), JSON.stringify({
  schemaVersion: 1, name: 'runtime', web: { command: 'node server.mjs', url: 'http://127.0.0.1:5334', readiness: { path: '/health' } },
  settle: { maxMs: 3000 },
}));
writeFileSync(join(app, 'server.mjs'), `
import { createServer } from 'node:http';
const page = \`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">
<style>body{margin:0;font:16px sans-serif} @keyframes enter{from{opacity:0}to{opacity:1}} .enter{animation:enter 400ms both} button{min-height:44px}</style>
<main id="app" aria-busy="true"><p>Loading…</p></main>
<nav style="position:fixed;left:0;right:0;bottom:0;height:72px;background:#eee"><a href="#">Tab</a></nav>
<script>
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = document.getElementById('app');
  (async () => {
    await sleep(400);                                  // an in-memory "API": a timer, no network, no DOM change
    app.removeAttribute('aria-busy');
    app.innerHTML = \\\`<h1 class="enter">Ready</h1>
      <article><h3>Uncle J</h3><a href="#j">View profile</a></article>
      <article><h3>North</h3><a href="#n">View profile</a></article>
      <div><strong>Tue 30 Sep</strong><button>09:00 pm</button></div><div><strong>Wed 1 Oct</strong><button>09:00 pm</button></div>
      <button id="d30" aria-pressed="true">30 minutes</button><button id="d60" aria-pressed="false">60 minutes</button>
      <button id="save">Save</button><button id="loop">Start polling</button><button id="fade">Show panel</button>
      <p id="out" role="status"></p><input type="password" aria-label="Password"><input aria-label="Nickname">
      <button id="low" style="position:absolute;left:16px;top:calc(100vh - 50px)">Under the bar</button><div style="height:1600px"></div>\\\`;
    const out = document.getElementById('out');
    for (const b of [d30, d60]) b.onclick = () => { d30.setAttribute('aria-pressed', b === d30); d60.setAttribute('aria-pressed', b === d60); };
    save.onclick = async () => { save.textContent = 'Saving…'; await sleep(450); save.textContent = 'Save'; out.textContent = 'Saved'; };
    loop.onclick = () => { const tick = () => setTimeout(tick, 100); tick(); out.textContent = 'polling'; };
    fade.onclick = () => { const p = document.createElement('div'); p.className = 'enter'; p.innerHTML = '<button>Panel action</button>'; app.append(p); };
    low.onclick = () => { out.textContent = 'reached'; };
  })();
</script>\`;
createServer((req, res) => req.url === '/health' ? res.end('ok') : res.writeHead(200, { 'content-type': 'text/html' }).end(page)).listen(5334, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`);

test('settling waits for aria-busy, short timers and entrance animations, but not for a re-arming loop', async () => {
  const lab = new Lab({ stateDir: tmp('agentlab-runtime-state-') });
  try {
    const start = await lab.start({ project: app, headed: false });
    assert.deepEqual(start.observation.headings, ['h1 Ready'], 'first observation waits past the busy loader and the fade-in');
    const click = (name) => lab.act({ action: 'click', ref: lab.findRef({ role: 'button', name }) });

    const save = await click('Save');
    assert.equal(save.settle.reason, 'quiet');
    assert.deepEqual(save.changes.messagesAdded, [{ role: 'status', text: 'Saved' }], 'the result after a 450 ms timer is reported, not "Saving…"');

    const fade = await click('Show panel');
    assert.ok(fade.changes.added.some((c) => c.name === 'Panel action'), 'a control fading in from opacity 0 is observed');

    const loop = await click('Start polling');
    assert.equal(loop.settle.reason, 'quiet', 'a 100 ms re-arming timeout chain is treated as a loop, not awaited');
    assert.ok(loop.settle.ms < 2000, `settled in ${loop.settle.ms}ms`);
  } finally {
    await lab.close();
  }
});

test('repeated labels carry their card or group, toggles report pressed, and a control under a fixed bar is reachable', async () => {
  const lab = new Lab({ stateDir: tmp('agentlab-runtime-state-') });
  try {
    const { observation: o } = await lab.start({ project: app, headed: false });
    const ctx = (name) => o.controls.filter((c) => c.name === name).map((c) => c.context);
    assert.deepEqual(ctx('View profile'), ['Uncle J', 'North'], 'nearest card heading');
    assert.deepEqual(ctx('09:00 pm'), ['Tue 30 Sep', 'Wed 1 Oct'], 'a label in the group when there is no heading');
    assert.equal(o.controls.find((c) => c.name === 'Save').context, undefined, 'unique names get no context');
    assert.equal(o.controls.find((c) => c.name === '30 minutes').pressed, true);

    const toggle = await lab.act({ action: 'click', ref: lab.findRef({ role: 'button', name: '60 minutes' }) });
    const fields = Object.fromEntries(toggle.changes.changed.map((c) => [c.name, c.fields.map((f) => `${f.field}:${f.to}`)]));
    assert.deepEqual(fields, { '30 minutes': ['pressed:false'], '60 minutes': ['pressed:true'] });

    const low = await lab.act({ action: 'click', ref: lab.findRef({ role: 'button', name: 'Under the bar' }) });
    assert.equal(low.outcome, 'success', low.error?.message);
    assert.ok(low.notes.some((n) => /not under a fixed bar/.test(n)), low.notes.join('; '));
    assert.deepEqual(low.newFindings, [], 'scrolling past a tab bar is normal, not a finding');
  } finally {
    await lab.close();
  }
});

test('values typed into password fields never reach history, logs or reproduction steps', async () => {
  const lab = new Lab({ stateDir: tmp('agentlab-runtime-state-') });
  try {
    const { session } = await lab.start({ project: app, headed: false });
    await lab.act({ action: 'fill', ref: lab.findRef({ role: 'textbox', name: 'Password' }), value: 'hunter2-SECRET' });
    await lab.act({ action: 'fill', ref: lab.findRef({ role: 'textbox', name: 'Nickname' }), value: 'Bongani' });
    const files = execFileSync('grep', ['-rl', 'hunter2-SECRET', session.runDir, '--include=*'], { encoding: 'utf8' }).trim();
    assert.fail(`secret written to ${files}`);
  } catch (err) {
    if (err.code === 'ERR_ASSERTION') throw err;
    assert.equal(err.status, 1, 'grep finds nothing in the run directory');
  } finally {
    const history = lab['history'];
    assert.ok(history.some((h) => h === 'fill textbox "Password" with ‹secret› (14 characters)'), history.join(' | '));
    assert.ok(history.some((h) => h === 'fill textbox "Nickname" with "Bongani"'), 'ordinary values stay readable');
    await lab.close();
  }
});

// A wrapper that runs the real server as a child, like `bun run dev` → vite.
const tree = tmp('agentlab-tree-');
writeFileSync(join(tree, 'agentlab.json'), JSON.stringify({
  schemaVersion: 1, name: 'tree', web: { command: 'node wrapper.mjs', url: 'http://127.0.0.1:5335', readiness: { path: '/health' } },
}));
writeFileSync(join(tree, 'wrapper.mjs'), `import { spawn } from 'node:child_process'; spawn(process.execPath, ['server.mjs'], { stdio: 'inherit' });`);
writeFileSync(join(tree, 'server.mjs'), `import { createServer } from 'node:http'; createServer((q, s) => s.end(q.url === '/health' ? 'ok' : '<!doctype html><button>Hi</button>')).listen(5335, '127.0.0.1');`);
const spec = { url: 'http://127.0.0.1:5335', readiness: { path: '/health', status: 200 } };

test('a cold start owns the whole wrapper → server tree and stops all of it', async () => {
  const lab = new Lab({ stateDir: tmp('agentlab-tree-state-') });
  const { server } = await lab.start({ project: tree, headed: false });
  assert.equal(server.owned, true);
  const members = group(server.pid);
  assert.ok(members.length >= 3, `shell, wrapper and server in group ${server.pid}: ${members}`);
  await lab.close();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(members.filter(alive), [], 'no member of the owned group survives');
  assert.equal((await probe(spec)).kind, 'down');
});

test('attaching to a running instance never stops it', async () => {
  const theirs = spawn(process.execPath, ['wrapper.mjs'], { cwd: tree, detached: true, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && (await probe(spec)).kind !== 'healthy'; i++) await new Promise((r) => setTimeout(r, 50));
    const lab = new Lab({ stateDir: tmp('agentlab-tree-state-') });
    const { server } = await lab.start({ project: tree, headed: false });
    assert.deepEqual([server.owned, server.reused, server.pid], [false, true, undefined]);
    const close = await lab.close();
    assert.deepEqual(close.server, { owned: false, stopped: false, detail: 'not owned by the lab; left running' });
    assert.ok(alive(theirs.pid));
    assert.equal((await probe(spec)).kind, 'healthy', 'the attached instance still serves');
  } finally {
    process.kill(-theirs.pid, 'SIGTERM');
  }
});
