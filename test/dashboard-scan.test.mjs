// The dashboard's scan views (rendered in Chromium): the scenario × device matrix, run detail, finding
// filters, grouping, suppressed findings and side-by-side evidence, driven by synthetic Lab events
// through the real feed and server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { SessionFeed } from '../dist/core/feed.js';
import { Dashboard } from '../dist/dashboard/server.js';

const dir = mkdtempSync(join(tmpdir(), 'agentlab-dash-scan-'));
let browser, page, dash, feed, base, token;

const d390 = { id: 'mobile-390', label: 'm', viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
const plan = [
  { scenario: 'Filters drawer', route: '/brothers', device: 'mobile-320', width: 320, height: 568 },
  { scenario: 'Filters drawer', route: '/brothers', device: 'mobile-390', width: 390, height: 844 },
  { scenario: 'Checkout', route: '/checkout', device: 'mobile-320', width: 320, height: 568 },
  { scenario: 'Checkout', route: '/checkout', device: 'mobile-390', width: 390, height: 844 },
];
const img = (name) => join(dir, `${name}.jpg`);
const st = (id, label, over = {}) => ({ id, label, path: [], depth: 0, status: 'measured', findings: [], ...over });
const run = (i, over = {}) => ({ ...plan[i], status: 'ok', ms: 1000 + i, states: [st('s0', 'after setup', { frame: img(`r${i}-s0`), route: plan[i].route })], decisions: [], decisionsOmitted: 0, limits: [], findings: [], ...over });
const runs = [
  run(0, {
    states: [
      st('s0', 'after setup', { frame: img('r0-s0'), route: '/brothers', findings: ['F1', 'F4'], path: ['click button "Filters"'] }),
      st('s1', 'menu open', { frame: img('r0-s1'), route: '/brothers', path: ['click button "Filters"', 'click button "Sort"'], depth: 1, restore: 'escape', dialog: 'Sort by', blocked: ['POST /api/orders'] }),
    ],
    decisions: [
      { role: 'button', name: 'Delete account', context: 'Danger zone', verdict: 'skip', reason: 'the name says it deletes something' },
      { role: 'button', name: 'Sort', verdict: 'explore', kind: 'menu', reason: 'opens a menu' },
    ],
    decisionsOmitted: 3, limits: ['maxStates (12): 4 candidates not explored'], findings: ['F1', 'F4'],
  }),
  run(1, { findings: ['F1', 'F2'] }),
  run(2, { status: 'failed', failedAt: 'setup', error: { code: 'no_such_target', message: 'no button "Pay now" to click', recoverable: true }, states: [] }),
  run(3, { findings: ['F3', 'F5'] }),
];
const base_ = (id, kind, device, width, scenario, over = {}) => ({
  id, kind, detector: { name: kind, version: 1 }, severity: 'medium', source: 'scan', confidence: 'heuristic', confidenceScore: 0.4, basis: ['geometry'],
  route: '/brothers', device, viewportWidth: width, scenario, state: 'after setup', states: ['after setup'], target: { role: 'button', name: 'Show 3 results' },
  message: `${kind} at ${width}`, evidence: { panPx: 1 }, fingerprint: `fp-${kind}`, firstSeen: { gen: 1, at: new Date().toISOString() }, lastSeenGen: 1, occurrences: 1,
  reproduction: ['open /brothers'], ...over,
});
const F1 = base_('F1', 'text-wrap-change', 'mobile-320', 320, 'Filters drawer', {
  severity: 'high', confidence: 'confirmed', confidenceScore: 0.85, basis: ['comparison', 'clipping'], frame: img('r0-s0'),
  message: 'button "Show 3 results" wraps to 2 lines at 320 px but fits on 1 line at 390 px',
  evidence: { harm: 'functional', linesNarrow: 2, linesWide: 1, widthNarrow: 320, widthWide: 390, comparedWith: 'mobile-390', heightNarrow: 88, heightWide: 44, rowNeighbourHeight: 44 },
  frames: [{ label: '320 px: 2 lines', path: img('r0-s0'), device: 'mobile-320' }, { label: '390 px: 1 line', path: img('r1-s0'), device: 'mobile-390' }],
});
const F2 = base_('F2', 'text-wrap-change', 'mobile-390', 390, 'Filters drawer');
const F3 = base_('F3', 'tap-target', 'mobile-390', 390, 'Checkout', { fingerprint: 'fp-tap' });
const F4 = base_('F4', 'container-clipped', 'mobile-320', 320, 'Filters drawer', { fingerprint: 'fp-clip' });
const F5 = base_('F5', 'layout-shift', 'mobile-390', 390, 'Checkout', {
  fingerprint: 'fp-shift', frame: img('r3-s0'),
  frames: [{ label: 'before it settled', path: img('before') }, { label: 'after it settled', path: img('r3-s0') }],
});
const SUPPRESSED = { rule: 0, reason: 'accepted: legacy footer', expires: '2027-01-01' };

const cell = (scenario, device) => page.locator(`#scan-matrix tbody tr:has(th:text-is("${scenario}")) button[data-run="${plan.findIndex((r) => r.scenario === scenario && r.device === device)}"]`);
const listed = () => page.locator('#findings li.item .kind').allInnerTexts();
const groups = () => page.locator('#findings li.group > .group-head .kind').allInnerTexts();

before(async () => {
  browser = await chromium.launch();
  const shot = await (await browser.newPage({ viewport: { width: 40, height: 40 } })).screenshot({ type: 'jpeg' });
  for (const n of ['r0-s0', 'r0-s1', 'r1-s0', 'r2-s0', 'r3-s0', 'before']) writeFileSync(img(n), shot);

  feed = new SessionFeed();
  dash = await Dashboard.listen({ feed, source: () => undefined });
  ({ origin: base } = new URL(dash.url));
  token = new URLSearchParams(new URL(dash.url).hash.slice(1)).get('token');
  feed.apply({ kind: 'starting', project: 'p', url: 'http://127.0.0.1:1/', device: d390, headed: false });
  feed.apply({ kind: 'start', result: {
    session: { id: 's-1', device: d390, browser: { engine: 'chromium', version: '153', headed: false }, environment: 'e' },
    server: { url: 'http://127.0.0.1:1', owned: false, reused: true, readyMs: 1 },
    observation: { gen: 1, url: 'http://127.0.0.1:1/brothers', route: '/brothers', title: 't', controls: [], layout: [], omitted: 0, console: { errors: 0 }, network: { failed: 0 } },
  } });
  feed.apply({ kind: 'scan', phase: 'start', id: 'R1', explore: true, runs: plan });
  feed.apply({ kind: 'scan', phase: 'run-start', id: 'R1', scenario: 'Filters drawer', device: 'mobile-320' });
  feed.apply({ kind: 'scan', phase: 'state', id: 'R1', scenario: 'Filters drawer', device: 'mobile-320', state: runs[0].states[0] });
  // The viewer opens the page while the first run is still measuring.
  page = await browser.newPage({ viewport: { width: 1360, height: 1200 } });
  page.setDefaultTimeout(5000);
  await page.goto(dash.url);
  await page.locator('#scan-matrix button').first().waitFor();
});

after(async () => {
  await browser?.close();
  await dash?.close();
  rmSync(dir, { recursive: true, force: true });
});

test('while running the header names the current state and the matrix shows pending and running cells', async () => {
  assert.equal(await page.locator('#scan').isVisible(), true);
  assert.match(await page.locator('#scan-caption').textContent(), /^R1 · running \(Filters drawer @ mobile-320 — after setup\)$/);
  assert.equal(await page.locator('#scan-verdict').innerText(), 'exploration on');
  assert.equal(await page.locator('#scan-verdict .verdict').count(), 0, 'no verdict yet');
  assert.equal(await cell('Filters drawer', 'mobile-320').innerText(), 'running…');
  assert.equal(await cell('Checkout', 'mobile-390').innerText(), 'pending');
  assert.deepEqual(await page.locator('#scan-matrix thead th').allInnerTexts(), ['Scenario', 'mobile-320 · 320px', 'mobile-390 · 390px'], 'narrowest first');
});

test('the matrix updates live and a failed setup reads "failed before checks completed"', async () => {
  feed.apply({ kind: 'findings', findings: [F1, F2, F3, F4, F5].map((f) => structuredClone(f)) });
  for (const [i, r] of runs.entries()) {
    if (i) feed.apply({ kind: 'scan', phase: 'run-start', id: 'R1', scenario: r.scenario, device: r.device });
    for (const s of r.states) feed.apply({ kind: 'scan', phase: 'state', id: 'R1', scenario: r.scenario, device: r.device, state: s });
    feed.apply({ kind: 'scan', phase: 'run-done', id: 'R1', run: r });
  }
  await cell('Filters drawer', 'mobile-320').getByText('ok · 2 states · 2 findings').waitFor();
  assert.equal(await cell('Filters drawer', 'mobile-390').innerText(), 'ok · 1 state · 2 findings');
  assert.equal(await cell('Checkout', 'mobile-390').innerText(), 'ok · 1 state · 2 findings');
  const failed = await cell('Checkout', 'mobile-320').innerText();
  assert.match(failed, /^failed before checks completed\nno_such_target: no button "Pay now" to click$/);
  assert.match(await cell('Checkout', 'mobile-320').getAttribute('class'), /cell-before/);
  assert.doesNotMatch(await cell('Checkout', 'mobile-390').getAttribute('class'), /cell-before/);

  const result = { schemaVersion: 1, id: 'R1', startedAt: new Date().toISOString(), ms: 4321, devices: ['mobile-320', 'mobile-390'], explore: true, runs,
    findings: [F1, F2, F3, F4, F5].map((f) => structuredClone(f.id === 'F4' ? { ...f, suppressed: SUPPRESSED } : f)),
    groups: [{ id: 'G1', fingerprint: 'fp-text-wrap-change', kind: 'text-wrap-change', title: 'Label wraps at a narrower width: button "Show 3 results"', severity: 'high', confidence: 'confirmed', route: '/brothers', scenarios: ['Filters drawer'], devices: ['mobile-320', 'mobile-390'], findings: ['F1', 'F2'], suppressed: false }],
    suppressions: [{ rule: 0, reason: SUPPRESSED.reason, status: 'applied', matched: ['F4'] }],
    verdict: { result: 'fail', reasons: ['1 confirmed high finding', 'Checkout @ mobile-320 could not complete its checks'], policy: { failOn: 'high', failOnErrors: true, failOnHeuristic: false } },
    reports: { html: '', json: '' }, exploreMs: 10 };
  feed.apply({ kind: 'scan', phase: 'done', id: 'R1', result });
  await page.locator('#scan-caption', { hasText: 'done in 4321 ms' }).waitFor();
  assert.equal(await page.locator('#scan-verdict .verdict').innerText(), 'FAIL');
  const reasons = await page.locator('#scan-verdict .reasons li').allInnerTexts();
  assert.deepEqual(reasons, ['1 confirmed high finding', 'Checkout @ mobile-320 could not complete its checks']);
  assert.match(await page.locator('#timeline').innerText(), /scan R1: FAIL · 4 runs \(1 failed\) · 1 problems/);
  assert.match(await page.locator('#timeline').innerText(), /Checkout @ mobile-320: failed at setup/);
});

test('findings are grouped by problem by default; the suppressed one is only in the Suppressed list', async () => {
  assert.equal(await page.locator('#group-toggle').getAttribute('aria-pressed'), 'true');
  const g = await groups();
  assert.equal(g.length, 3, 'wrap (two devices), tap target, layout shift');
  const wrap = page.locator('#findings li.group[data-fingerprint="fp-text-wrap-change"]');
  assert.match(await wrap.innerText(), /Label wraps at a narrower width/);
  assert.match(await wrap.innerText(), /text-wrap-change · 2 findings · mobile-320, mobile-390 · Filters drawer/);
  assert.match(await wrap.innerText(), /1 confirmed/i);
  assert.match(await wrap.innerText(), /1 heuristic/i);
  assert.equal(await wrap.locator('.sev').first().textContent(), 'high', 'the group shows its highest severity');
  assert.equal(await wrap.locator('li.item').count(), 0, 'collapsed');
  await wrap.locator('.group-head').click();
  assert.equal(await wrap.locator('li.item').count(), 2);

  assert.doesNotMatch(await page.locator('#findings').innerText(), /F4|container-clipped/);
  assert.equal(await page.locator('#suppressed').isVisible(), true);
  assert.equal(await page.locator('#suppressed').evaluate((el) => el.open), false, 'collapsed');
  assert.equal(await page.locator('#suppressed-summary').textContent(), 'Suppressed (1)');
  await page.locator('#suppressed-summary').click();
  const item = page.locator('#suppressed-list li.item');
  assert.equal(await item.count(), 1);
  assert.match(await item.innerText(), /F4 container-clipped/);
  assert.match(await item.innerText(), /suppressed by rule 0: accepted: legacy footer \(until 2027-01-01\)/);
  await page.locator('#suppressed-summary').click();

  // Ungrouped, every unsuppressed finding is its own row.
  await page.locator('#group-toggle').click();
  assert.deepEqual((await listed()).map((t) => t.split(' ')[0]), ['F1', 'F2', 'F3', 'F5']);
  await page.locator('#group-toggle').click();
  assert.equal((await groups()).length, 3);
});

test('the confidence filter hides heuristic findings, and the scenario filter narrows to one scenario', async () => {
  await page.locator('#confidence-filter button', { hasText: 'Confirmed' }).click();
  assert.deepEqual(await page.locator('#confidence-filter button[aria-pressed="true"]').allInnerTexts(), ['Confirmed (1)']);
  assert.equal((await groups()).length, 1);
  const wrap = page.locator('#findings li.group[data-fingerprint="fp-text-wrap-change"]');
  assert.match(await wrap.innerText(), /1 finding\b/, 'F2 (heuristic) is filtered out of the group');
  assert.deepEqual((await listed()).map((t) => t.split(' ')[0]), ['F1']);
  await page.locator('#confidence-filter button', { hasText: 'Heuristic' }).click();
  assert.equal((await groups()).length, 3, 'wrap (F2), tap target, layout shift');
  assert.doesNotMatch(await page.locator('#findings').innerText(), /F1 /);
  await page.locator('#confidence-filter button', { hasText: 'All' }).click();

  assert.deepEqual(await page.locator('#scenario-filter button').allInnerTexts(), ['All scenarios', 'Filters drawer (3)', 'Checkout (2)']);
  await page.locator('#scenario-filter button', { hasText: 'Checkout' }).click();
  assert.equal((await groups()).length, 2);
  assert.doesNotMatch(await page.locator('#findings').innerText(), /Label wraps/);
  await page.locator('#scenario-filter button', { hasText: 'All scenarios' }).click();
  assert.equal((await groups()).length, 3);
});

test('selecting a run cell filters findings to that scenario and device and shows its states and skipped controls', async () => {
  await cell('Filters drawer', 'mobile-320').click();
  assert.equal(await cell('Filters drawer', 'mobile-320').getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('#run-filter').innerText(), /Showing Filters drawer @ mobile-320 only/);
  assert.equal((await groups()).length, 1);
  assert.deepEqual((await listed()).map((t) => t.split(' ')[0]), ['F1'], 'the 390 finding of the same problem is not in this run');
  assert.equal(await page.locator('#suppressed-summary').textContent(), 'Suppressed (1)', 'F4 belongs to this run and stays listed');

  const detail = page.locator('#scan-run');
  await detail.waitFor();
  assert.doesNotMatch(await detail.innerText(), /null|undefined/);
  assert.match(await detail.locator('h3').innerText(), /Filters drawer @ mobile-320\s+320×568 · ok · 2 states · 2 findings · 1000 ms/);
  const states = detail.locator('li.state');
  assert.equal(await states.count(), 2);
  const s0 = await states.nth(0).innerText();
  assert.match(s0, /s0 · after setup/);
  assert.match(s0, /click button "Filters"/);
  assert.match(s0, /F1 high text-wrap-change/);
  const s1 = await states.nth(1).innerText();
  assert.match(s1, /s1 · menu open/);
  assert.match(s1, /click button "Filters" → click button "Sort"/, 'path joined with arrows');
  assert.match(s1, /restore: escape/);
  assert.match(s1, /dialog: Sort by/);
  assert.match(s1, /blocked requests: POST \/api\/orders/);
  await states.nth(0).locator('img.thumb').waitFor();
  assert.equal(await states.nth(0).locator('img.thumb').evaluate((i) => i.naturalWidth > 0), true, 'thumbnail fetched with the token');

  // Cells read structurally: innerText only separates cells with tabs while the row is laid out, and
  // the detail can re-render under load between the wait and the read.
  const skipped = await detail.locator('table.skipped tbody tr').evaluateAll((rows) => rows.map((r) => [...r.cells].map((c) => c.textContent.trim())));
  assert.deepEqual(skipped, [['button', 'Delete account', 'Danger zone', 'the name says it deletes something']]);
  assert.match(await detail.innerText(), /Skipped controls \(1 shown, 3 more not listed\)/i);
  assert.match(await detail.locator('ul.explored').innerText(), /button "Sort" \(menu\) — opens a menu/);
  assert.match(await detail.locator('ul.limits').innerText(), /maxStates \(12\): 4 candidates not explored/);

  // A run that failed before its checks: distinct message, and its error in the detail.
  await cell('Checkout', 'mobile-320').click();
  assert.match(await page.locator('#scan-run .run-error').innerText(), /no button "Pay now" to click/);
  assert.match(await page.locator('#scan-run .run-error').getAttribute('class'), /before/);
  assert.match(await page.locator('#findings').innerText(), /No findings match these filters/);
  await cell('Checkout', 'mobile-320').click(); // again → cleared
  assert.equal(await page.locator('#scan-run').isHidden(), true);
  assert.equal((await groups()).length, 3);
});

test('a wrapped-label finding shows both widths side by side, the measurements and the harm in words', async () => {
  await page.locator('#findings li.item[data-id="F1"]').click(); // the group was expanded earlier
  const box = page.locator('#finding-detail');
  const text = await box.innerText();
  assert.match(text, /scenario\s+Filters drawer/);
  assert.match(text, /state\s+after setup/);
  assert.match(text, /detector\s+text-wrap-change@1/);
  assert.match(text, /confidence\s+confirmed \(score 0\.85; basis: comparison, clipping\)/);

  const pair = box.locator('.pair').first();
  await pair.locator('figure img').nth(1).waitFor();
  assert.deepEqual(await pair.locator('figcaption').allInnerTexts(), ['320 px: 2 lines', '390 px: 1 line']);
  const boxes = await pair.locator('figure').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
  assert.ok(Math.abs(boxes[0].top - boxes[1].top) < 2 && boxes[0].right <= boxes[1].left + 1, 'side by side, not stacked');

  const rows = await box.locator('table.measure tbody tr').evaluateAll((trs) => trs.map((r) => [...r.cells].map((c) => c.textContent.trim())));
  assert.deepEqual(rows, [
    ['mobile-320', '320 px', '2', '88 px', '44 px'],
    ['mobile-390', '390 px', '1', '44 px', '–'],
  ]);
  assert.match(text, /Harm: functional\. Functional harm: the label is cut off/);
  assert.match(text, /At 320 px it takes 2 lines \(88 px tall\); at 390 px it takes 1 line \(44 px tall\)/);

  const widths = box.locator('.pair.widths');
  await widths.locator('figure img').nth(1).waitFor();
  assert.deepEqual(await widths.locator('figcaption').allInnerTexts(), ['mobile-320 · 320px', 'mobile-390 · 390px']);
  assert.match(text, /Same state at other widths/i);
});

test('a layout shift shows its before and after frames as a pair', async () => {
  await page.locator('#findings li.group[data-fingerprint="fp-shift"] .group-head').click();
  await page.locator('#findings li.item[data-id="F5"]').click();
  assert.equal(await page.locator('#findings li.item[data-id="F5"]').getAttribute('aria-selected'), 'true');
  const pair = page.locator('#finding-detail .pair.before-after');
  await pair.locator('figure img').nth(1).waitFor();
  assert.deepEqual(await pair.locator('figcaption').allInnerTexts(), ['before it settled', 'after it settled']);
  assert.match(await page.locator('#finding-detail').innerText(), /Before and after it settled/i);
});

test('scan frame routes need the token and answer 404 for anything the feed did not record', async () => {
  const get = (path, withToken = true) => fetch(`${base}${path}${withToken ? `?token=${token}` : ''}`);
  assert.equal((await get('/api/scans/R1/0/s0.jpg', false)).status, 401);
  assert.equal((await get('/api/frames/F1-0.jpg', false)).status, 401);
  const ok = await get('/api/scans/R1/0/s1.jpg');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
  assert.equal((await get('/api/frames/F1-1.jpg')).status, 200);
  assert.equal((await get('/api/frames/F1.jpg')).status, 200, 'the main frame still works');
  for (const path of [
    '/api/scans/R1/0/s9.jpg', '/api/scans/R9/0/s0.jpg', '/api/scans/R1/2/s0.jpg', '/api/scans/R1/9/s0.jpg', '/api/scans/R1/x/s0.jpg',
    '/api/scans/R1/0/..%2Fs0.jpg', '/api/frames/F1-2.jpg', '/api/frames/F9-0.jpg', '/api/frames/F3-0.jpg',
  ]) assert.equal((await get(path)).status, 404, path);
  // No path leaves the server: neither the snapshot nor the events carry one.
  const state = await (await get('/api/state')).text();
  assert.ok(!state.includes(dir), 'no frame path in the snapshot');
});
