import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { scanReportHtml } from '../dist/core/scan-report.js';
import { formatScan } from '../dist/core/format.js';
import { groupFindings, evaluatePolicy, DEFAULT_POLICY } from '../dist/core/scan-policy.js';

const DIR = '/tmp/agentlab-run/R1';
const XSS = '<script>alert(1)</script>';
const QUOTE = '"onerror=alert(2) x="';
let n = 0;
const finding = (over = {}) => {
  n += 1;
  return {
    id: `F${n}`, kind: 'tap-target', detector: { name: 'tap-target', version: 2 }, severity: 'high', source: 'scan',
    confidence: 'confirmed', confidenceScore: 0.876, basis: ['standard'], route: '/orders', device: 'mobile-390', viewportWidth: 390,
    scenario: 'Orders', state: 's0', target: { role: 'button', name: 'Delete', selector: 'main > button.del' },
    message: 'too small', evidence: { w: 20, h: 18 }, fingerprint: `fp${n}`, firstSeen: { gen: 1, at: 't' }, lastSeenGen: 1, occurrences: 1,
    reproduction: ['open /orders', 'click button "Delete"'], ...over,
  };
};
const run = (over = {}) => ({ scenario: 'Orders', device: 'mobile-390', width: 390, height: 844, status: 'ok', ms: 5, states: [{ id: 's0', label: 'base', path: [], depth: 0, status: 'measured', findings: [] }], decisions: [], decisionsOmitted: 0, limits: [], findings: [], ...over });

function build({ findings, runs, suppressions = [], devices = ['mobile-390', 'mobile-320'], explore = false, policy = DEFAULT_POLICY }) {
  const groups = groupFindings(findings);
  return {
    schemaVersion: 1, id: 'R1', startedAt: '2026-09-29T10:00:00Z', ms: 1234, devices, explore, runs, findings, groups, suppressions,
    verdict: evaluatePolicy(findings, runs, policy), reports: { html: `${DIR}/report.html`, json: `${DIR}/report.json` }, exploreMs: 0,
  };
}

test('report has every section heading, verdict and relative json path', () => {
  const conf = finding({ frame: `${DIR}/frames/a.jpg`, frames: [{ label: 'before', path: `${DIR}/frames/b.jpg` }], states: ['s0', 's1'], state: 's0' });
  const heur = finding({ confidence: 'heuristic', severity: 'low', kind: 'text-wrap-change', fingerprint: 'h' });
  const sup = finding({ suppressed: { rule: 0, reason: 'known issue', expires: '2027-01-01' }, kind: 'text-clipped' });
  const r = build({ findings: [conf, heur, sup], runs: [run(), run({ device: 'mobile-320' })], suppressions: [{ rule: 0, reason: 'known issue', status: 'applied', matched: [sup.id], expires: '2027-01-01' }], explore: true });
  const html = scanReportHtml(r, DIR);
  assert.ok(html.startsWith('<!doctype html>'));
  for (const h of ['Scan R1', 'FAIL', 'Scenario matrix', 'Confirmed problems', 'Heuristic warnings', 'Suppressed findings', 'Suppressions']) assert.ok(html.includes(h), h);
  assert.ok(html.includes('0.88'));
  assert.ok(html.includes('w=20 h=18'));
  assert.ok(html.includes('tap-target v2'));
  assert.ok(html.includes('known issue'));
  assert.ok(html.includes('<code>report.json</code>'));
  assert.ok(html.includes('open /orders'));
  assert.ok(!/<script/i.test(html));
  assert.ok(!/(src|href)="https?:/i.test(html));
  const order = ['Confirmed problems', 'Heuristic warnings', 'Suppressed findings', 'Suppressions'].map((h) => html.indexOf(`<h2>${h}`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(!order.includes(-1));
});

test('suppressed findings are listed in their own section, not among confirmed problems', () => {
  const sup = finding({ message: 'SUPPRESSED-MSG', suppressed: { rule: 3, reason: 'accepted debt' } });
  const r = build({ findings: [sup], runs: [run()] });
  const html = scanReportHtml(r, DIR);
  const at = html.indexOf('SUPPRESSED-MSG');
  assert.ok(at > html.indexOf('<h2>Suppressed findings'));
  assert.ok(html.slice(html.indexOf('<h2>Confirmed problems'), html.indexOf('<h2>Heuristic')).indexOf('SUPPRESSED-MSG') === -1);
  assert.ok(html.includes('rule 3: accepted debt'));
  assert.ok(html.includes('PASS'));
});

test('page-derived strings are escaped everywhere', () => {
  const f = finding({
    message: `${XSS} ${QUOTE}`, target: { role: 'button', name: XSS, selector: `a[title="${XSS}"]` }, evidence: { text: XSS },
    state: XSS, scenario: XSS, reproduction: [XSS], route: `/x?${QUOTE}`, frame: `${DIR}/frames/${QUOTE}.jpg`,
  });
  const r = build({
    findings: [f], runs: [run({ scenario: XSS, status: 'failed', failedAt: 'checks', error: { code: 'x', message: `${XSS} ${QUOTE}` }, states: [{ id: 's1', label: XSS, path: [XSS], depth: 1, status: 'measured', findings: [], blocked: [XSS] }], decisions: [{ role: 'button', name: XSS, context: XSS, verdict: 'skip', reason: XSS }], limits: [XSS] })],
    suppressions: [{ rule: 0, reason: XSS, status: 'unmatched', matched: [] }], explore: true,
  });
  r.verdict.reasons.push(XSS);
  const html = scanReportHtml(r, DIR);
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('"onerror='));
  assert.ok(!/<[a-z][^>]*\sonerror=/i.test(html));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&quot;onerror=alert(2) x=&quot;'));
});

test('setup failures say the checks did not complete; stale and expired suppressions are labelled', () => {
  const r = build({
    findings: [],
    runs: [run(), run({ device: 'mobile-320', status: 'failed', failedAt: 'setup', error: { code: 'not_found', message: 'no such button' } }), run({ scenario: 'Late', status: 'failed', failedAt: 'checks', error: { code: 'x', message: 'boom' } })],
    suppressions: [
      { rule: 0, reason: 'a', status: 'unmatched', matched: [] },
      { rule: 1, reason: 'b', status: 'expired', matched: [], expires: '2026-01-01' },
      { rule: 2, reason: 'c', status: 'not-evaluated', matched: [] },
    ],
  });
  const html = scanReportHtml(r, DIR);
  assert.ok(html.includes('failed at setup'));
  assert.equal(html.split('failed before checks completed').length - 1, 1);
  assert.ok(html.includes('no such button'));
  assert.ok(html.includes('failed at checks'));
  assert.ok(html.includes('stale — matched nothing in this run'));
  assert.ok(html.includes('expired on 2026-01-01'));
  assert.ok(html.includes('not evaluated (scope not in this run)'));
});

test('frame images use paths relative to the run directory; outside paths are omitted', () => {
  const f = finding({ frame: path.join(DIR, 'frames', 'inside.jpg'), frames: [{ label: 'outer', path: '/etc/outside.jpg' }, { label: 'up', path: path.join(DIR, '..', 'other', 'x.jpg') }, { label: 'other width', path: path.join(DIR, 'frames', 'w320.jpg') }] });
  const html = scanReportHtml(build({ findings: [f], runs: [run()] }), DIR);
  assert.ok(html.includes('<img src="frames/inside.jpg"'));
  assert.ok(html.includes('src="frames/w320.jpg"'));
  assert.ok(html.includes('loading="lazy"'));
  assert.ok(html.includes('mobile-390 · s0'));
  assert.ok(html.includes('other width'));
  assert.ok(!html.includes('outside.jpg'));
  assert.ok(!html.includes('other/x.jpg'));
  assert.equal(html.split('<img ').length - 1, 2);
});

test('exploration section only when there is exploration', () => {
  const plain = scanReportHtml(build({ findings: [], runs: [run()] }), DIR);
  assert.ok(!plain.includes('<h2>Exploration'));
  const explored = scanReportHtml(build({ findings: [], explore: true, runs: [run({ states: [
    { id: 's0', label: 'base', path: [], depth: 0, status: 'measured', findings: [] },
    { id: 's1', label: 'menu open', path: ['click "Menu"'], depth: 1, status: 'measured', restore: 'escape', findings: ['F1'], blocked: ['POST /api/x'] },
  ], decisions: [{ role: 'button', name: 'Delete account', verdict: 'skip', reason: 'destructive name' }, { role: 'button', name: 'Menu', verdict: 'explore', reason: 'menu' }], limits: ['maxStates (12): 4 candidates not explored'] })] }), DIR);
  assert.ok(explored.includes('<h2>Exploration'));
  assert.ok(explored.includes('Delete account'));
  assert.ok(!explored.includes('>Menu</td><td></td><td>menu'));
  assert.ok(explored.includes('click &quot;Menu&quot;'));
  assert.ok(explored.includes('POST /api/x'));
  assert.ok(explored.includes('maxStates (12)'));
});

test('formatScan first line, reasons, runs, groups and paths', () => {
  const conf = finding();
  const heur = finding({ confidence: 'heuristic', severity: 'low', kind: 'text-wrap-change', fingerprint: 'h' });
  const sup = finding({ suppressed: { rule: 0, reason: 'r' } });
  const r = build({ findings: [conf, heur, sup], runs: [run(), run({ device: 'mobile-320', status: 'failed', failedAt: 'load', error: { code: 'x', message: 'nope' } })] });
  const lines = formatScan(r).split('\n');
  assert.equal(lines[0], 'scan R1: FAIL · 2 scenario runs (1 failed) · 3 problems (1 confirmed, 1 heuristic, 1 suppressed) · 1234 ms');
  assert.ok(lines.includes('  Orders @ mobile-390: ok, 1 states, 0 findings'));
  assert.ok(lines.includes('  Orders @ mobile-320: FAILED at load: nope'));
  assert.ok(lines.some((l) => l.startsWith('  G1 high confirmed Tap target too small or too close: button "Delete" [mobile-390] (')));
  assert.ok(!lines.some((l) => l.startsWith('  G3')));
  assert.equal(lines.at(-2), `report: ${DIR}/report.html`);
  assert.equal(lines.at(-1), `json: ${DIR}/report.json`);
  for (const reason of r.verdict.reasons) assert.ok(lines.includes(reason));
});

test('formatScan caps groups at 12', () => {
  const fs = Array.from({ length: 15 }, () => finding());
  const out = formatScan(build({ findings: fs, runs: [run()] }));
  assert.equal(out.split('\n').filter((l) => /^ {2}G\d+ /.test(l)).length, 12);
  assert.ok(out.includes('  … 3 more'));
});
