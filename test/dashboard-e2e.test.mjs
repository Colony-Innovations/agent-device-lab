// The dashboard served by a real session daemon (headless Chromium, fixture app on port 5199), and the
// screencast rate cap on a constantly animating page (port 5332).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Lab } from '../dist/core/lab.js';
import { probe } from '../dist/core/project-runner.js';
import { mjpeg, sse, until } from './helpers/stream.mjs';

const run = promisify(execFile);
const home = mkdtempSync(join(tmpdir(), 'agentlab-dash-'));
after(async () => {
  await cli('stop'); // only matters if a test failed midway
  rmSync(home, { recursive: true, force: true });
});

async function cli(...args) {
  try {
    const { stdout } = await run(process.execPath, ['bin/agentlab.js', ...args], { env: { ...process.env, AGENTLAB_HOME: home } });
    return { code: 0, out: stdout };
  } catch (err) {
    return { code: err.code, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const childPids = (pid) => { try { return execFileSync('pgrep', ['-P', String(pid)]).toString().trim().split('\n').map(Number); } catch { return []; } };

test('a daemon session streams its viewport, timeline and findings, survives the viewer leaving, and releases everything on stop', async () => {
  const start = await cli('start', '--project', 'fixtures/invoice-app', '--headless');
  assert.equal(start.code, 0, start.out);
  assert.match(start.out, /dashboard: http:\/\/127\.0\.0\.1:\d+\/#token=/);
  const ui = JSON.parse((await cli('ui', '--no-open', '--json')).out);
  const u = new URL(ui.url);
  const base = u.origin;
  const token = new URLSearchParams(u.hash.slice(1)).get('token');
  assert.equal(ui.opened, false);
  assert.equal(statSync(join(home, 'daemon.json')).mode & 0o777, 0o600, 'the record holding the token is private');
  const daemonPid = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).pid;

  // A person opens the dashboard.
  const events = sse(`${base}/api/events?token=${token}`);
  const snap = await events.next((m) => m.event === 'snapshot');
  assert.equal(snap.json.status.state, 'active');
  assert.equal(snap.json.status.route, '/invoices');
  const view = mjpeg(`${base}/api/viewport?token=${token}`);
  await until(() => view.frames.length >= 1, 5000, 'a live viewport frame');
  assert.ok(view.frames[0].length > 2000, 'a real JPEG of the page');

  // The agent works through the CLI; the dashboard follows.
  assert.equal((await cli('click', '--name', 'Reports')).code, 0);
  const pan = await cli('click', '--name', 'Export CSV');
  assert.equal(pan.code, 0, 'the automated tap succeeds');
  const entry = await events.next((m) => m.json.event?.type === 'timeline' && m.json.event.entry.target?.name === 'Export CSV');
  assert.equal(entry.json.event.entry.outcome, 'success');
  assert.equal(entry.json.event.entry.settle.reason, 'quiet');
  const panFinding = await events.next((m) => m.json.event?.type === 'finding' && m.json.event.finding.kind === 'horizontal-pan-required');
  const f = panFinding.json.event.finding;
  assert.deepEqual(entry.json.event.entry.findings, [f.id], 'the finding is attached to the successful click');
  assert.equal(f.severity, 'high');
  assert.equal(f.hasFrame, true);
  const frame = await fetch(`${base}/api/frames/${f.id}.jpg?token=${token}`);
  assert.equal(frame.headers.get('content-type'), 'image/jpeg');
  assert.ok((await frame.arrayBuffer()).byteLength > 2000);
  await until(() => view.frames.length >= 2, 5000, 'viewport frames after the actions');
  const status = await events.next((m) => m.json.event?.type === 'status' && m.json.event.status.findings >= 4);
  assert.equal(status.json.event.status.route, '/reports');

  // The person closes the dashboard: capture stops, the test carries on.
  events.close();
  view.close();
  const state = async () => (await (await fetch(`${base}/api/state?token=${token}`)).json());
  await until(async () => !(await state()).stats.screencast.running, 5000, 'capture to stop');
  assert.equal((await cli('status')).code, 0);
  assert.equal((await cli('click', '--name', 'Invoices')).code, 0, 'the session keeps working without a viewer');
  const restored = await state();
  assert.deepEqual(restored.timeline.map((e) => e.kind), ['start', 'click', 'click', 'click'], 'a refresh restores the timeline');
  assert.ok(restored.findings.some((x) => x.kind === 'horizontal-pan-required'));

  // Stop: final status reaches a watching viewer, then the dashboard, browser and owned server go away.
  const watcher = sse(`${base}/api/events?token=${token}`);
  await watcher.next((m) => m.event === 'snapshot');
  const browserPids = childPids(daemonPid);
  assert.ok(browserPids.length >= 1, 'the daemon owns browser processes');
  const stop = await cli('stop');
  assert.equal(stop.code, 0, stop.out);
  const final = await watcher.next((m) => m.json.event?.type === 'status' && m.json.event.status.state === 'ended');
  assert.equal(final.json.event.status.endedReason, 'requested');
  await watcher.waitEnd();
  await assert.rejects(fetch(`${base}/api/state?token=${token}`), 'dashboard port released');
  await until(() => !alive(daemonPid) && browserPids.every((p) => !alive(p)), 5000, 'daemon and browser to exit');
  assert.equal((await probe({ url: 'http://127.0.0.1:5199', readiness: { path: '/health', status: 200 } })).kind, 'down', 'owned server stopped');
});

test('--no-ui starts a session without a dashboard', async () => {
  const start = await cli('start', '--project', 'fixtures/invoice-app', '--headless', '--no-ui');
  assert.equal(start.code, 0, start.out);
  assert.doesNotMatch(start.out, /dashboard/);
  const ui = await cli('ui', '--no-open');
  assert.equal(ui.code, 1);
  assert.match(ui.out, /--no-ui/);
  assert.equal((await cli('stop')).code, 0);
});

test('the screencast frame rate and frame size are capped', async () => {
  const project = mkdtempSync(join(tmpdir(), 'agentlab-anim-'));
  writeFileSync(join(project, 'agentlab.json'), JSON.stringify({
    schemaVersion: 1, name: 'anim', web: { command: 'node server.mjs', url: 'http://127.0.0.1:5332', readiness: { path: '/health' } },
  }));
  writeFileSync(join(project, 'server.mjs'), `
import { createServer } from 'node:http';
const page = '<!doctype html><meta name="viewport" content="width=device-width"><p id="t"></p><script>(function f(){document.getElementById("t").textContent=performance.now();requestAnimationFrame(f)})()</script>';
createServer((req, res) => req.url === '/health' ? res.end('ok') : res.writeHead(200, { 'content-type': 'text/html' }).end(page)).listen(5332, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`);
  const lab = new Lab({ stateDir: join(home, 'anim') });
  try {
    await lab.start({ project, headed: false });
    for (const maxFps of [5, 10]) {
      let frames = 0;
      let width = 0;
      const stop = await lab.screencast((jpeg) => { frames++; width ||= jpeg.readUInt16BE(jpeg.indexOf(Buffer.from([0xff, 0xc0])) + 7); }, { maxFps, maxWidth: 390, quality: 60 });
      await new Promise((r) => setTimeout(r, 2000));
      await stop();
      assert.ok(frames >= maxFps && frames <= maxFps * 2 + 1, `${frames} frames in 2 s at maxFps ${maxFps} on a page repainting every animation frame`);
      assert.ok(width > 0 && width <= 390, `frame width ${width} capped`);
    }

    // A watched sweep shows each width in the same stream, then hands it back to the session's page.
    const widths = [];
    const stop = await lab.screencast((jpeg) => { widths.push(jpeg.readUInt16BE(jpeg.indexOf(Buffer.from([0xff, 0xc0])) + 7)); }, { maxFps: 5, maxWidth: 800, quality: 60 });
    const t0 = Date.now();
    await lab.sweep({ route: '/', devices: ['mobile-320', 'tablet-768'] });
    const watched = Date.now() - t0;
    await new Promise((r) => setTimeout(r, 800));
    await stop();
    assert.ok(widths.includes(320) && widths.includes(768), `frames at both sweep widths, got ${[...new Set(widths)]}`);
    assert.equal(widths.at(-1), 390, 'the stream returns to the session page');
    assert.ok(watched >= 2400, `each watched width stays on screen (${watched} ms)`);
  } finally {
    await lab.close();
    rmSync(project, { recursive: true, force: true });
  }
});
