// The dashboard page itself (rendered in Chromium): sweep progress, per-device findings and device
// selection, driven by synthetic Lab events through the real feed and server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { SessionFeed } from '../dist/core/feed.js';
import { Dashboard } from '../dist/dashboard/server.js';

const dir = mkdtempSync(join(tmpdir(), 'agentlab-dash-ui-'));
let browser, page, dash, feed;

const device = (id, width, height) => ({ id, label: id, viewport: { width, height }, deviceScaleFactor: 1, isMobile: width < 700, hasTouch: width < 1000 });
const finding = (id, dev, width, kind, confidence) => ({
  id, kind, severity: 'high', source: confidence === 'confirmed' ? 'sweep-reachability' : 'measured-layout', confidence, route: '/reports',
  device: dev, viewportWidth: width, target: { role: 'button', name: 'Export CSV' }, message: `${kind} at ${width}`, evidence: { panPx: 208 },
  firstSeen: { gen: 1, at: new Date().toISOString() }, lastSeenGen: 1, occurrences: 1, reproduction: ['open', `sweep S1 at ${dev}`],
});

before(async () => {
  browser = await chromium.launch();
  const shot = await (await browser.newPage({ viewport: { width: 40, height: 40 } })).screenshot({ type: 'jpeg' });
  writeFileSync(join(dir, 'mobile-320.jpg'), shot);
  writeFileSync(join(dir, 'tablet-768.jpg'), shot);

  feed = new SessionFeed();
  dash = await Dashboard.listen({ feed, source: () => undefined });
  const d390 = device('mobile-390', 390, 844);
  feed.apply({ kind: 'starting', project: 'p', url: 'http://127.0.0.1:1/', device: d390, headed: false });
  feed.apply({ kind: 'start', result: {
    session: { id: 's-1', device: d390, browser: { engine: 'chromium', version: '153', headed: false }, environment: 'e' },
    server: { url: 'http://127.0.0.1:1', owned: false, reused: true, readyMs: 1 },
    observation: { gen: 1, url: 'http://127.0.0.1:1/reports', route: '/reports', title: 't', controls: [], layout: [], omitted: 0, console: { errors: 0 }, network: { failed: 0 } },
  } });
  const devices = [{ id: 'mobile-320', width: 320, height: 568 }, { id: 'tablet-768', width: 768, height: 1024 }];
  feed.apply({ kind: 'sweep', phase: 'start', id: 'S1', route: '/reports', devices });
  feed.apply({ kind: 'sweep', phase: 'device-start', id: 'S1', device: 'mobile-320' });
  feed.apply({ kind: 'findings', findings: [finding('F1', 'mobile-320', 320, 'horizontal-pan-required', 'confirmed'), finding('F2', 'mobile-320', 320, 'horizontal-overflow', 'heuristic')], frame: join(dir, 'mobile-320.jpg') });
  const result = (id, width, findings) => ({ device: id, label: id, width, height: 1, route: '/reports', status: 'ok', ms: 900, settled: 'quiet', documentWidth: 598, controls: 5, reachChecked: 5, findings, frame: join(dir, `${id}.jpg`) });
  feed.apply({ kind: 'sweep', phase: 'device-done', id: 'S1', result: result('mobile-320', 320, ['F1', 'F2']) });
  feed.apply({ kind: 'sweep', phase: 'device-start', id: 'S1', device: 'tablet-768' });
  // The tablet is still measuring when the viewer opens the page.

  page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  await page.goto(dash.url);
  await page.locator('#sweep-devices button').first().waitFor();
});

after(async () => {
  await browser?.close();
  await dash?.close();
  rmSync(dir, { recursive: true, force: true });
});

const listed = () => page.locator('#findings li.item .kind').allInnerTexts();

test('sweep progress shows each width with its state, counts and frame', async () => {
  assert.match(await page.locator('#sweep-caption').textContent(), /S1 · \/reports · 1\/2 widths/);
  const rows = await page.locator('#sweep-devices button').allInnerTexts();
  assert.match(rows[0], /mobile-320 320×568\n2 findings \(1 confirmed\)/);
  assert.match(rows[1], /tablet-768 768×1024\nmeasuring…/);
  await page.locator('#sweep-devices button[data-device="mobile-320"] img').waitFor();

  // Live update: the tablet finishes clean and the sweep completes.
  feed.apply({ kind: 'findings', findings: [finding('F3', 'mobile-390', 390, 'control-clipped', 'heuristic')] });
  feed.apply({ kind: 'sweep', phase: 'device-done', id: 'S1', result: { device: 'tablet-768', label: 't', width: 768, height: 1024, route: '/reports', status: 'ok', ms: 800, settled: 'quiet', documentWidth: 768, controls: 5, reachChecked: 5, findings: [], frame: join(dir, 'tablet-768.jpg') } });
  const done = [{ device: 'mobile-320', width: 320, status: 'ok', findings: ['F1', 'F2'] }, { device: 'tablet-768', width: 768, status: 'ok', findings: [] }];
  feed.apply({ kind: 'sweep', phase: 'done', id: 'S1', result: { id: 'S1', route: '/reports', ms: 1700, devices: done, findings: [finding('F1', 'mobile-320', 320, 'horizontal-pan-required', 'confirmed'), finding('F2', 'mobile-320', 320, 'horizontal-overflow', 'heuristic')] } });
  await page.locator('#sweep-caption', { hasText: 'done in 1700 ms' }).waitFor();
  assert.match(await page.locator('#sweep-devices button[data-device="tablet-768"]').innerText(), /clean/);
  assert.match(await page.locator('#timeline').innerText(), /sweep S1 of \/reports at 320, 768 px/);
});

test('selecting a device filters findings to that width, and selecting it again shows all', async () => {
  await page.locator('#device-filter button', { hasText: 'All (3)' }).waitFor();
  assert.deepEqual(await page.locator('#device-filter button').allInnerTexts(), ['All (3)', 'mobile-320 (2)', 'mobile-390 (1)', 'tablet-768 (0)']);
  assert.equal((await listed()).length, 3);

  await page.locator('#device-filter button[data-device="mobile-320"]').click();
  assert.deepEqual((await listed()).map((t) => t.split(' ')[0]), ['F1', 'F2']);
  assert.equal(await page.locator('#sweep-devices button[data-device="mobile-320"]').getAttribute('aria-pressed'), 'true', 'the sweep row follows the selection');
  assert.match((await listed())[0], /CONFIRMED/i);
  assert.match((await listed())[1], /HEURISTIC/i);

  await page.locator('#findings li.item', { hasText: 'F1' }).click();
  const detail = await page.locator('#finding-detail').innerText();
  assert.match(detail, /confirmed \(measured reach problem\)/);
  assert.match(detail, /mobile-320 \(320px wide\)/);

  await page.locator('#sweep-devices button[data-device="tablet-768"]').click();   // a sweep row selects too
  assert.equal((await listed()).length, 0);
  assert.match(await page.locator('#findings').innerText(), /None recorded at tablet-768/);
  assert.equal(await page.locator('#finding-detail').isHidden(), true, 'a finding from another width is deselected');

  await page.locator('#sweep-devices button[data-device="tablet-768"]').click();   // again → all
  assert.equal((await listed()).length, 3);
});

test('sweep frames need the token like every other data route', async () => {
  const u = new URL(dash.url);
  const token = new URLSearchParams(u.hash.slice(1)).get('token');
  assert.equal((await fetch(`${u.origin}/api/sweeps/S1/mobile-320.jpg`)).status, 401);
  const ok = await fetch(`${u.origin}/api/sweeps/S1/mobile-320.jpg?token=${token}`);
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(`${u.origin}/api/sweeps/S1/..%2F..%2Fx.jpg?token=${token}`)).status, 404);
  assert.equal((await fetch(`${u.origin}/api/sweeps/S1/desktop-1440.jpg?token=${token}`)).status, 404, 'no frame recorded');
});
