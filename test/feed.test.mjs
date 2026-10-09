// The dashboard's typed event stream, driven by synthetic Lab events (no browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionFeed, displayUrl, redactSecrets } from '../dist/core/feed.js';

const device = { id: 'mobile-390', label: 'm', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const obs = (gen, over = {}) => ({
  gen, url: 'http://127.0.0.1:5199/reports?session=abc#t=1', route: '/reports', title: 'Reports',
  controls: [], layout: [], omitted: 0, console: { errors: 0 }, network: { failed: 0 }, ...over,
});
const finding = (id, kind, gen) => ({
  id, kind, severity: 'high', source: kind === 'horizontal-pan-required' ? 'interaction' : 'measured-layout', route: '/reports',
  device: 'mobile-390', viewportWidth: 390, target: { role: 'button', name: 'Export CSV' }, message: `${kind} on /reports`,
  evidence: { panPx: 208 }, firstSeen: { gen, at: new Date().toISOString() }, lastSeenGen: gen, occurrences: 1, reproduction: ['open', 'click'],
});
const starting = { kind: 'starting', project: 'fixture', url: 'http://127.0.0.1:5199/invoices?token=secret', device, headed: false };
const start = (id = 's-1') => ({
  kind: 'start', result: {
    session: { id, device, browser: { engine: 'chromium', version: '153', headed: false }, environment: 'emulation' },
    server: { url: 'http://127.0.0.1:5199', owned: true, reused: false, pid: 42, command: 'API_KEY=hunter22 npm run dev', readyMs: 600 },
    observation: obs(1, { route: '/invoices' }),
  },
});
const act = (over = {}) => ({
  kind: 'act', request: { action: 'click', ref: 'e10' },
  result: {
    action: 'click', ref: 'e10', target: { ref: 'e10', role: 'button', name: 'Export CSV' }, outcome: 'success', method: 'tap', elapsedMs: 380,
    settle: { ms: 130, reason: 'quiet', ignored: 0 }, navigated: false, notes: ['view panned sideways 208px'],
    changes: { added: [], removed: [], changed: [], rerendered: [], covered: 0, uncovered: 0, messagesAdded: [{ role: 'status', text: 'Export ready' }], messagesRemoved: [], headingsAdded: [], headingsRemoved: [], layoutAdded: [], layoutResolved: [], none: false },
    newConsoleErrors: [], newFailedRequests: [], newFindings: [finding('F4', 'horizontal-pan-required', 3)], observation: obs(3),
    ...over,
  },
});

test('a session is translated into status, timeline and findings from the Lab events alone', () => {
  const feed = new SessionFeed();
  const seen = [];
  feed.subscribe((m) => seen.push(m));
  feed.apply(starting);
  assert.equal(feed.snapshot().status.state, 'starting');
  assert.equal(feed.snapshot().status.url, 'http://127.0.0.1:5199/invoices', 'query and hash dropped');
  feed.apply({ kind: 'server-log', line: 'listening on 5199' });
  feed.apply(start());
  feed.apply({ kind: 'findings', findings: [finding('F4', 'horizontal-pan-required', 3)], frame: '/runs/s-1/frames/g3-before-pan.jpg' });
  feed.apply(act());
  feed.apply({ kind: 'closed', result: { reason: 'requested', browserClosed: true, server: { owned: true, stopped: true, detail: 'SIGTERM' } } });

  const snap = feed.snapshot();
  assert.equal(snap.status.state, 'ended');
  assert.equal(snap.status.server.command, 'API_KEY=‹redacted› npm run dev');
  assert.deepEqual(snap.timeline.map((e) => e.kind), ['start', 'click', 'stop']);
  const click = snap.timeline[1];
  assert.equal(click.outcome, 'success', 'the click succeeded…');
  assert.deepEqual(click.findings, ['F4'], '…and the pan finding stays attached to it');
  assert.deepEqual(click.target, { ref: 'e10', role: 'button', name: 'Export CSV' });
  assert.equal(click.durationMs, 380);
  assert.deepEqual(click.changes, ['+ status "Export ready"']);
  assert.equal(snap.findings[0].hasFrame, true);
  assert.equal(feed.frameFile('F4'), '/runs/s-1/frames/g3-before-pan.jpg');
  assert.deepEqual(snap.serverLog, ['listening on 5199']);

  // Live messages are ordered, numbered, and the stop entry precedes the final status.
  assert.deepEqual(seen.map((m) => m.seq), seen.map((_, i) => i + 1));
  const tail = seen.slice(-2).map((m) => m.event.type);
  assert.deepEqual(tail, ['timeline', 'status']);
  assert.equal(seen.at(-1).event.status.state, 'ended');
});

test('settle timeouts and errors are carried into the timeline', () => {
  const feed = new SessionFeed();
  feed.apply(starting);
  feed.apply(start());
  feed.apply(act({ newFindings: [], settle: { ms: 1201, reason: 'timeout', cause: 'network', pending: ['GET /api/stream'], ignored: 2 } }));
  feed.apply(act({ outcome: 'error', error: { code: 'stale_ref', message: 'e10 belonged to a previous page', hint: 'Run observe', recoverable: true }, newFindings: [], observation: undefined, changes: undefined, settle: undefined }));
  const [, timeout, error] = feed.snapshot().timeline;
  assert.equal(timeout.outcome, 'success');
  assert.match(timeout.settleText, /settle timed out after 1201ms \(request still open: GET \/api\/stream/);
  assert.equal(error.outcome, 'error');
  assert.deepEqual(error.error, { code: 'stale_ref', message: 'e10 belonged to a previous page', hint: 'Run observe' });
});

test('typed values appear only when the page shows them; passwords and hidden values do not', () => {
  const feed = new SessionFeed();
  feed.apply(starting);
  feed.apply(start());
  const fill = (value, shown) => act({
    action: 'fill', ref: 'e6', target: { ref: 'e6', role: 'textbox', name: 'Field' }, newFindings: [],
    observation: obs(4, { controls: shown === undefined ? [] : [{ ref: 'e6', role: 'textbox', name: 'Field', value: shown, rect: {} }] }),
  });
  for (const [value, shown] of [['Acme Ltd', 'Acme Ltd'], ['hunter22', '••••'], ['s3cr3t-value', undefined]]) {
    const e = fill(value, shown);
    e.request = { action: 'fill', ref: 'e6', value };
    feed.apply(e);
  }
  assert.deepEqual(feed.snapshot().timeline.slice(1).map((e) => e.value), ['Acme Ltd', '••••', '‹12 chars›']);
  assert.ok(!JSON.stringify(feed.snapshot()).includes('hunter22'));
  assert.ok(!JSON.stringify(feed.snapshot()).includes('s3cr3t-value'));
});

test('replay: since(seq) returns only missed messages, or undefined when a snapshot is needed', () => {
  const feed = new SessionFeed({ buffer: 5 });
  feed.apply(starting);
  feed.apply(start());
  const mark = feed.lastSeq;
  feed.apply({ kind: 'server-log', line: 'a' });
  feed.apply({ kind: 'server-log', line: 'b' });
  assert.deepEqual(feed.since(mark).map((m) => m.event.line), ['a', 'b']);
  assert.deepEqual(feed.since(feed.lastSeq), []);
  assert.equal(feed.since(feed.lastSeq + 3), undefined, 'a sequence from the future (another session) needs a snapshot');
  for (let i = 0; i < 10; i++) feed.apply({ kind: 'server-log', line: String(i) });
  assert.equal(feed.since(mark), undefined, 'evicted from the buffer');
});

test('a new session resets the stream and drops the previous session data', () => {
  const feed = new SessionFeed();
  feed.apply(starting);
  feed.apply(start('s-1'));
  feed.apply({ kind: 'findings', findings: [finding('F1', 'horizontal-overflow', 1)], frame: '/x.jpg' });
  const mark = feed.lastSeq;
  const types = [];
  feed.subscribe((m) => types.push(m.event.type));
  feed.apply(starting);
  assert.equal(types[0], 'reset');
  assert.equal(feed.since(mark)[0].event.type, 'reset', 'a client catching up is told to drop what it holds');
  assert.equal(feed.since(mark - 1), undefined, 'older messages are gone');
  const snap = feed.snapshot();
  assert.equal(snap.status.state, 'starting');
  assert.deepEqual([snap.timeline.length, snap.findings.length, feed.frameFile('F1')], [0, 0, undefined]);
});

test('start failures are reported with a redacted log tail and no premature "ended" status', () => {
  const feed = new SessionFeed();
  const states = [];
  feed.subscribe((m) => { if (m.event.type === 'status') states.push(m.event.status.state); });
  feed.apply(starting);
  feed.apply({ kind: 'closed', result: { reason: 'start failed', browserClosed: false, server: { owned: true, stopped: true, detail: 'SIGTERM' } } });
  feed.apply({ kind: 'start-failed', error: {
    code: 'startup_failed', message: 'Server exited with code 1', recoverable: false,
    details: { logTail: ['stderr: Error: DATABASE_PASSWORD=pa55 is wrong', 'stderr: GET https://user:pw@db.local/ failed'] },
  } });
  assert.deepEqual(states, ['starting', 'failed']);
  const s = feed.snapshot().status;
  assert.equal(s.startError.code, 'startup_failed');
  assert.deepEqual(s.startError.details.logTail, ['stderr: Error: DATABASE_PASSWORD=‹redacted› is wrong', 'stderr: GET https://‹redacted›@db.local/ failed']);
});

test('console and network counters are coalesced', async () => {
  const feed = new SessionFeed({ countsIntervalMs: 100 });
  feed.apply(starting);
  feed.apply(start());
  const statuses = [];
  feed.subscribe((m) => { if (m.event.type === 'status') statuses.push(m.event.status); });
  for (let i = 1; i <= 20; i++) feed.apply({ kind: 'counts', consoleErrors: i, failedRequests: 1 });
  assert.equal(statuses.length, 0, 'within the interval of the last status');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].consoleErrors, 20);
});

test('redaction helpers', () => {
  assert.equal(redactSecrets('token=abc123 SECRET_KEY: "x y" password hunter2'), 'token=‹redacted› SECRET_KEY: ‹redacted› password ‹redacted›');
  assert.doesNotMatch(redactSecrets('Authorization: Bearer abcdefghijklmnop'), /abcdefgh/);
  assert.doesNotMatch(redactSecrets('curl -H "x: Bearer abcdefghijklmnop"'), /abcdefgh/);
  assert.equal(redactSecrets('ready on http://localhost:5173/'), 'ready on http://localhost:5173/');
  assert.equal(displayUrl('http://127.0.0.1:5199/a/b?x=1#frag'), 'http://127.0.0.1:5199/a/b');
});

// ---------- stateful scan ----------

const scanFinding = (id, over = {}) => ({
  ...finding(id, 'text-wrap-change', 1), detector: { name: 'text-wrap-change', version: 1 }, source: 'scan', confidence: 'confirmed', confidenceScore: 0.85,
  basis: ['comparison'], scenario: 'Filters drawer', state: 'after setup', states: ['after setup'], fingerprint: 'fp1', frame: '/runs/R1/a.jpg',
  frames: [{ label: '320 px: 2 lines', path: '/runs/R1/a.jpg', device: 'mobile-320' }, { label: '390 px: 1 line', path: '/runs/R1/b.jpg', device: 'mobile-390' }],
  ...over,
});
const plan = [
  { scenario: 'Filters drawer', route: '/brothers', device: 'mobile-320', width: 320, height: 568 },
  { scenario: 'Filters drawer', route: '/brothers', device: 'mobile-390', width: 390, height: 844 },
  { scenario: 'Checkout', route: '/checkout', device: 'mobile-320', width: 320, height: 568 },
];
const st = (id, label, over = {}) => ({ id, label, path: [], depth: 0, status: 'measured', findings: [], ...over });
const run = (i, over = {}) => ({ ...plan[i], status: 'ok', ms: 100 + i, states: [st('s0', 'after setup', { frame: `/runs/R1/${i}.jpg` })], decisions: [], decisionsOmitted: 0, limits: [], findings: [], ...over });
const scanned = () => {
  const feed = new SessionFeed();
  feed.apply(starting);
  feed.apply(start());
  return feed;
};

test('scan progress: runs pending, then running with the current state, then done', () => {
  const feed = scanned();
  const seen = [];
  feed.subscribe((m) => { if (m.event.type === 'scan') seen.push(m.event.scan); });
  feed.apply({ kind: 'scan', phase: 'start', id: 'R1', explore: true, runs: plan });
  let scan = feed.snapshot().scans[0];
  assert.deepEqual(scan.runs.map((r) => [r.index, r.state]), [[0, 'pending'], [1, 'pending'], [2, 'pending']]);
  assert.equal(scan.state, 'running');
  assert.equal(scan.explore, true);
  assert.equal(scan.current, undefined);

  feed.apply({ kind: 'scan', phase: 'run-start', id: 'R1', scenario: 'Filters drawer', device: 'mobile-320' });
  feed.apply({ kind: 'scan', phase: 'state', id: 'R1', scenario: 'Filters drawer', device: 'mobile-320', state: st('s0', 'after setup', { frame: '/runs/R1/0.jpg' }) });
  scan = feed.snapshot().scans[0];
  assert.deepEqual(scan.runs.map((r) => r.state), ['running', 'pending', 'pending']);
  assert.deepEqual(scan.current, { scenario: 'Filters drawer', device: 'mobile-320', state: 'after setup' });
  assert.equal(scan.runs[0].states.length, 1, 'a state is visible while its run is still going');

  feed.apply({ kind: 'scan', phase: 'run-done', id: 'R1', run: run(0, { findings: ['F1'] }) });
  scan = feed.snapshot().scans[0];
  assert.equal(scan.runs[0].state, 'ok');
  assert.equal(scan.runs[0].ms, 100);
  assert.equal(scan.current, undefined, 'nothing is being measured between runs');
  assert.equal(seen.length, 4, 'every scan event is published');
  assert.equal(seen[0].state, 'running');
});

test('scan frames are served from recorded paths only and never appear as paths in the snapshot', () => {
  const feed = scanned();
  feed.apply({ kind: 'scan', phase: 'start', id: 'R1', explore: false, runs: plan });
  feed.apply({ kind: 'scan', phase: 'run-start', id: 'R1', scenario: 'Filters drawer', device: 'mobile-390' });
  feed.apply({ kind: 'scan', phase: 'state', id: 'R1', scenario: 'Filters drawer', device: 'mobile-390', state: st('s0', 'after setup', { frame: '/runs/R1/1.jpg' }) });
  feed.apply({ kind: 'scan', phase: 'state', id: 'R1', scenario: 'Filters drawer', device: 'mobile-390', state: st('s1', 'menu open', { status: 'blocked', blocked: ['POST /api/x'] }) });
  feed.apply({ kind: 'scan', phase: 'run-done', id: 'R1', run: run(1, { states: [st('s0', 'after setup', { frame: '/runs/R1/1.jpg' }), st('s1', 'menu open', { status: 'blocked', blocked: ['POST /api/x'] })] }) });
  feed.apply({ kind: 'findings', findings: [scanFinding('F1')], frame: '/runs/R1/a.jpg' });

  assert.equal(feed.scanFrameFile('R1', 1, 's0'), '/runs/R1/1.jpg');
  assert.equal(feed.scanFrameFile('R1', 1, 's1'), undefined, 'a state without a frame has none');
  assert.equal(feed.scanFrameFile('R1', 0, 's0'), undefined);
  assert.equal(feed.scanFrameFile('R2', 1, 's0'), undefined);
  assert.equal(feed.frameFile('F1'), '/runs/R1/a.jpg');
  assert.equal(feed.extraFrameFile('F1', 0), '/runs/R1/a.jpg');
  assert.equal(feed.extraFrameFile('F1', 1), '/runs/R1/b.jpg');
  assert.equal(feed.extraFrameFile('F1', 2), undefined);

  const snap = feed.snapshot();
  assert.deepEqual(snap.scans[0].runs[1].states.map((s) => s.hasFrame), [true, false]);
  const f = snap.findings[0];
  assert.equal(f.hasFrame, true);
  assert.deepEqual(f.frames, [{ label: '320 px: 2 lines', device: 'mobile-320' }, { label: '390 px: 1 line', device: 'mobile-390' }]);
  assert.ok(!JSON.stringify(snap).includes('/runs/R1'), 'no file path reaches a client');
  assert.ok(!('frame' in f));
});

test('a run that failed before its checks keeps failedAt and a redacted error', () => {
  const feed = scanned();
  feed.apply({ kind: 'scan', phase: 'start', id: 'R1', explore: false, runs: plan });
  feed.apply({ kind: 'scan', phase: 'run-start', id: 'R1', scenario: 'Checkout', device: 'mobile-320' });
  feed.apply({ kind: 'scan', phase: 'state', id: 'R1', scenario: 'Checkout', device: 'mobile-320', state: st('s0', 'after setup', {
    status: 'failed', error: { code: 'no_such_target', message: 'no button "Pay" (token=abc123)', recoverable: true, hint: 'password: hunter2' },
  }) });
  feed.apply({ kind: 'scan', phase: 'run-done', id: 'R1', run: run(2, {
    status: 'failed', failedAt: 'setup', error: { code: 'no_such_target', message: 'no button "Pay" (token=abc123)', recoverable: true, hint: 'api_key=zzz999' },
    states: [st('s0', 'after setup', { status: 'failed', error: { code: 'x', message: 'Authorization: Bearer abcdefghijklmnop', recoverable: false } })],
  }) });
  const r = feed.snapshot().scans[0].runs[2];
  assert.equal(r.state, 'failed');
  assert.equal(r.failedAt, 'setup');
  assert.match(r.error, /no_such_target: no button "Pay" \(token=‹redacted›/);
  assert.match(r.error, /api_key=‹redacted›/);
  assert.doesNotMatch(JSON.stringify(feed.snapshot()), /abc123|hunter2|zzz999|abcdefgh/);
  assert.equal(typeof r.states[0].error, 'string');
  assert.equal(r.states[0].hasFrame, false);
});

const finishScan = (feed, over = {}) => feed.apply({ kind: 'scan', phase: 'done', id: 'R1', result: {
  schemaVersion: 1, id: 'R1', startedAt: new Date().toISOString(), ms: 4321, devices: ['mobile-320', 'mobile-390'], explore: false,
  runs: [run(0), run(1), run(2, { status: 'failed', failedAt: 'load', error: { code: 'navigation_failed', message: 'boom', recoverable: true }, states: [] })],
  findings: [], groups: [{ id: 'G1', fingerprint: 'fp1', kind: 'text-wrap-change', title: 'Label wraps', severity: 'high', confidence: 'confirmed', route: '/brothers', scenarios: ['Filters drawer'], devices: ['mobile-320'], findings: ['F1'], suppressed: false }],
  suppressions: [{ rule: 0, reason: 'known', status: 'applied', matched: ['F2'] }], verdict: { result: 'fail', reasons: ['1 confirmed high finding'], policy: { failOn: 'high', failOnErrors: false, failOnHeuristic: false } },
  reports: { html: '/x/report.html', json: '/x/result.json' }, exploreMs: 0, ...over,
} });

test('a finished scan carries groups, verdict and suppressions; changed suppression is re-published; the timeline gets an entry', () => {
  const feed = scanned();
  feed.apply({ kind: 'scan', phase: 'start', id: 'R1', explore: false, runs: plan });
  feed.apply({ kind: 'findings', findings: [scanFinding('F1'), scanFinding('F2', { fingerprint: 'fp2' })] });
  const seen = [];
  feed.subscribe((m) => seen.push(m.event));
  const sup = { rule: 0, reason: 'known', expires: '2027-01-01' };
  finishScan(feed, { findings: [scanFinding('F1'), scanFinding('F2', { fingerprint: 'fp2', suppressed: sup })] });

  const snap = feed.snapshot();
  const scan = snap.scans[0];
  assert.equal(scan.state, 'done');
  assert.equal(scan.ms, 4321);
  assert.equal(scan.verdict.result, 'fail');
  assert.deepEqual(scan.groups.map((g) => g.id), ['G1']);
  assert.deepEqual(scan.suppressions.map((s) => s.status), ['applied']);
  assert.equal(scan.current, undefined);

  const republished = seen.filter((e) => e.type === 'finding').map((e) => e.finding);
  assert.deepEqual(republished.map((f) => f.id), ['F2'], 'only the finding whose suppression changed');
  assert.deepEqual(republished[0].suppressed, sup);
  assert.deepEqual(snap.findings.find((f) => f.id === 'F2').suppressed, sup);
  assert.equal(snap.findings.find((f) => f.id === 'F1').suppressed, undefined);
  assert.ok(republished[0].frames.length === 2 && !('frame' in republished[0]));

  const entry = snap.timeline.at(-1);
  assert.equal(entry.kind, 'scan');
  assert.equal(entry.summary, 'scan R1: FAIL · 3 runs (1 failed) · 1 problems');
  assert.deepEqual(entry.changes, ['Checkout @ mobile-320: failed at load']);
  assert.deepEqual(entry.findings, ['F1', 'F2']);
  assert.equal(entry.outcome, 'error');
  const types = seen.map((e) => e.type);
  assert.ok(types.indexOf('timeline') < types.lastIndexOf('scan'), 'the final scan view follows the timeline entry');
});

test('a passing scan is summarised as PASS; only the last five scans are kept', () => {
  const feed = scanned();
  for (let i = 1; i <= 6; i++) {
    feed.apply({ kind: 'scan', phase: 'start', id: `R${i}`, explore: false, runs: [] });
    if (i === 6) feed.apply({ kind: 'scan', phase: 'done', id: 'R6', result: {
      schemaVersion: 1, id: 'R6', startedAt: '', ms: 1, devices: [], explore: false, runs: [], findings: [], groups: [], suppressions: [],
      verdict: { result: 'pass', reasons: [], policy: { failOn: 'high', failOnErrors: false, failOnHeuristic: false } }, reports: { html: '', json: '' }, exploreMs: 0,
    } });
  }
  const snap = feed.snapshot();
  assert.deepEqual(snap.scans.map((s) => s.id), ['R2', 'R3', 'R4', 'R5', 'R6']);
  assert.equal(snap.timeline.at(-1).summary, 'scan R6: PASS · 0 runs (0 failed) · 0 problems');
});

test('a new session clears scans and their frames', () => {
  const feed = scanned();
  feed.apply({ kind: 'scan', phase: 'start', id: 'R1', explore: false, runs: plan });
  feed.apply({ kind: 'scan', phase: 'run-start', id: 'R1', scenario: 'Filters drawer', device: 'mobile-320' });
  feed.apply({ kind: 'scan', phase: 'state', id: 'R1', scenario: 'Filters drawer', device: 'mobile-320', state: st('s0', 'after setup', { frame: '/runs/R1/0.jpg' }) });
  feed.apply({ kind: 'findings', findings: [scanFinding('F1')] });
  assert.equal(feed.scanFrameFile('R1', 0, 's0'), '/runs/R1/0.jpg');
  assert.equal(feed.extraFrameFile('F1', 1), '/runs/R1/b.jpg');
  feed.apply(starting);
  assert.deepEqual(feed.snapshot().scans, []);
  assert.equal(feed.scanFrameFile('R1', 0, 's0'), undefined);
  assert.equal(feed.extraFrameFile('F1', 1), undefined);
  assert.equal(feed.frameFile('F1'), undefined);
});
