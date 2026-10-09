import path from 'node:path';
import type { Finding, FindingGroup, ScanResult, ScenarioDeviceRun } from './schema.js';

// The scan's HTML report: one self-contained document, no scripts, no external resources.
// Everything that came from the app under test is untrusted, so every string goes through esc().

export const esc = (v: unknown): string =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export const CSS = `
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--card:#fff;--high:#b91c1c;--med:#b45309;--low:#57534e;--ok:#15803d;--warn-bg:#fef3c7}
@media (prefers-color-scheme:dark){:root{--bg:#171717;--fg:#e7e5e4;--muted:#a8a29e;--line:#3f3f46;--card:#202020;--high:#f87171;--med:#fbbf24;--low:#a8a29e;--ok:#4ade80;--warn-bg:#3a2f0b}}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto}
h1{margin:0 0 4px;font-size:24px}h2{margin:32px 0 8px;font-size:18px;border-bottom:1px solid var(--line);padding-bottom:4px}h3{margin:0 0 4px;font-size:15px}
table{border-collapse:collapse;width:100%;margin:8px 0;background:var(--card)}
th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top;font-size:13px}th{color:var(--muted);font-weight:600}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.verdict{display:inline-block;padding:2px 12px;border-radius:4px;font-weight:700;font-size:20px;color:#fff}
.verdict.pass{background:var(--ok)}.verdict.fail{background:var(--high)}
.muted{color:var(--muted)}
.group{border:1px solid var(--line);border-radius:6px;background:var(--card);padding:12px;margin:12px 0}
.group.quiet{opacity:.85;border-style:dashed}
.badge{display:inline-block;padding:0 6px;border-radius:3px;font-size:12px;font-weight:600;border:1px solid currentColor}
.badge.high{color:var(--high)}.badge.medium{color:var(--med)}.badge.low{color:var(--low)}
.frames{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
figure{margin:0;flex:0 1 220px;max-width:100%}figure img{max-width:100%;height:auto;border:1px solid var(--line);display:block}
figcaption{font-size:12px;color:var(--muted);overflow-wrap:anywhere}
td.failed{background:var(--warn-bg);color:var(--high)}td.ok{color:var(--ok)}
ol{margin:4px 0;padding-left:24px}
details{margin:6px 0}
`;

/** Path relative to the run directory, or undefined when the file is outside it. */
function relInside(dir: string, file: string): string | undefined {
  const rel = path.relative(dir, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).map(encodeURIComponent).join('/');
}

function figure(dir: string, file: string | undefined, caption: string): string {
  if (!file) return '';
  const rel = relInside(dir, file);
  if (!rel) return '';
  return `<figure><img src="${esc(rel)}" alt="${esc(caption)}" loading="lazy"><figcaption>${esc(caption)}</figcaption></figure>`;
}

export const badge = (sev: string) => `<span class="badge ${esc(sev)}">${esc(sev)}</span>`;
const evidenceText = (e: Finding['evidence']) => Object.entries(e).map(([k, v]) => `${k}=${v}`).join(' ');

export function findingsTable(fs: Finding[]): string {
  const rows = fs.map((f) => `<tr><td>${esc(f.id)}</td><td>${esc(f.device)}</td><td>${esc(f.viewportWidth)}</td><td>${esc(f.scenario ?? 'session')}</td>` +
    `<td>${esc(f.state ?? '')}${f.states && f.states.length > 1 ? ` <span class="muted">(${esc(f.states.join(', '))})</span>` : ''}</td>` +
    `<td>${badge(f.severity)}</td><td>${esc(f.confidence)}</td><td>${esc(f.confidenceScore.toFixed(2))}</td>` +
    `<td><code>${esc(evidenceText(f.evidence))}</code></td><td>${esc(f.message)}</td>` +
    (f.suppressed ? `<td>rule ${esc(f.suppressed.rule)}: ${esc(f.suppressed.reason)}${f.suppressed.expires ? ` (expires ${esc(f.suppressed.expires)})` : ''}</td>` : '') + '</tr>');
  const suppressed = fs.some((f) => f.suppressed);
  return `<table><thead><tr><th>Id</th><th>Device</th><th>Width</th><th>Scenario</th><th>State</th><th>Severity</th><th>Confidence</th><th>Score</th><th>Evidence</th><th>Message</th>${suppressed ? '<th>Suppression</th>' : ''}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function framesRow(dir: string, fs: Finding[]): string {
  const items: string[] = [];
  for (const f of fs) {
    items.push(figure(dir, f.frame, `${f.device} · ${f.state ?? 'session'}`));
    for (const fr of f.frames ?? []) items.push(figure(dir, fr.path, fr.label));
  }
  const html = items.join('');
  return html ? `<div class="frames">${html}</div>` : '';
}

export function groupHtml(dir: string, g: FindingGroup, byId: Map<string, Finding>, quiet: boolean): string {
  const fs = g.findings.map((id) => byId.get(id)).filter((f): f is Finding => !!f);
  const first = fs[0];
  const det = first ? `${first.detector.name} v${first.detector.version}` : '';
  const steps = first ? `<details><summary>Reproduction steps (${esc(first.id)})</summary><ol>${first.reproduction.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></details>` : '';
  return `<div class="group${quiet ? ' quiet' : ''}" id="${esc(g.id)}">` +
    `<h3>${esc(g.id)} · ${esc(g.title)} ${badge(g.severity)}</h3>` +
    `<div class="muted">kind <code>${esc(g.kind)}</code> · detector <code>${esc(det)}</code> · route <code>${esc(g.route)}</code></div>` +
    `<div class="muted">scenarios: ${esc(g.scenarios.join(', '))} · devices: ${esc(g.devices.join(', '))}</div>` +
    (g.target?.selector ? `<div class="muted">target <code>${esc(g.target.selector)}</code></div>` : '') +
    findingsTable(fs) + framesRow(dir, fs) + steps + '</div>';
}

function matrix(r: ScanResult): string {
  const scenarios = [...new Set(r.runs.map((x) => x.scenario))];
  const cell = (run: ScenarioDeviceRun | undefined): string => {
    if (!run) return '<td class="muted">not run</td>';
    if (run.status === 'ok') return `<td class="ok">ok · ${esc(run.states.length)} states · ${esc(run.findings.length)} findings</td>`;
    const early = run.failedAt === 'context' || run.failedAt === 'load' || run.failedAt === 'setup';
    return `<td class="failed"><strong>failed at ${esc(run.failedAt ?? 'unknown')}</strong>${early ? ' · failed before checks completed' : ''}: ${esc(run.error?.message ?? 'no message')}</td>`;
  };
  const rows = scenarios.map((s) => `<tr><th>${esc(s)}</th>${r.devices.map((d) => cell(r.runs.find((x) => x.scenario === s && x.device === d))).join('')}</tr>`);
  return `<table><thead><tr><th>Scenario</th>${r.devices.map((d) => `<th>${esc(d)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function exploration(r: ScanResult): string {
  const runs = r.runs.filter((x) => x.states.some((s) => s.id !== 's0') || x.decisions.length);
  if (!runs.length) return '';
  const parts = runs.map((run) => {
    const states = run.states.map((s) => `<tr><td>${esc(s.id)}</td><td>${esc(s.label)}</td><td>${esc(s.path.join(' → '))}</td><td>${esc(s.status)}</td><td>${esc(s.restore ?? '')}</td><td>${esc(s.findings.join(', '))}</td><td>${esc((s.blocked ?? []).join(', '))}</td></tr>`).join('');
    const skipped = run.decisions.filter((d) => d.verdict === 'skip').map((d) => `<tr><td>${esc(d.role)}</td><td>${esc(d.name)}</td><td>${esc(d.context ?? '')}</td><td>${esc(d.reason)}</td></tr>`).join('');
    return `<h3>${esc(run.scenario)} @ ${esc(run.device)}</h3>` +
      `<table><thead><tr><th>State</th><th>Label</th><th>Path</th><th>Status</th><th>Restore</th><th>Findings</th><th>Blocked requests</th></tr></thead><tbody>${states}</tbody></table>` +
      (skipped ? `<p class="muted">Skipped controls${run.decisionsOmitted ? ` (${esc(run.decisionsOmitted)} more decisions omitted)` : ''}</p><table><thead><tr><th>Role</th><th>Name</th><th>Context</th><th>Reason</th></tr></thead><tbody>${skipped}</tbody></table>` : '') +
      (run.limits.length ? `<ul>${run.limits.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '');
  });
  return `<h2>Exploration</h2>${parts.join('')}`;
}

export function scanReportHtml(result: ScanResult, dir: string): string {
  const r = result;
  const byId = new Map(r.findings.map((f) => [f.id, f]));
  const confirmed = r.groups.filter((g) => !g.suppressed && g.confidence === 'confirmed');
  const heuristic = r.groups.filter((g) => !g.suppressed && g.confidence === 'heuristic');
  const suppressed = r.groups.filter((g) => g.suppressed);
  const failedRuns = r.runs.filter((x) => x.status === 'failed').length;
  const p = r.verdict.policy;
  const list = (gs: FindingGroup[], quiet: boolean, none: string) => gs.length ? gs.map((g) => groupHtml(dir, g, byId, quiet)).join('') : `<p class="muted">${esc(none)}</p>`;

  const suppressedFindings = r.findings.filter((f) => f.suppressed);
  const suppressedSection = suppressed.length
    ? suppressed.map((g) => groupHtml(dir, g, byId, true)).join('')
    : '<p class="muted">No group is fully suppressed.</p>';
  // A partly suppressed group appears above with its live members; list its suppressed findings here too.
  const partial = suppressedFindings.filter((f) => !suppressed.some((g) => g.findings.includes(f.id)));
  const partialHtml = partial.length ? `<h3>Suppressed findings in groups that are still reported</h3>${findingsTable(partial)}` : '';

  const supRows = r.suppressions.map((s) => {
    const label = s.status === 'applied' ? `applied to ${s.matched.length} findings (${s.matched.join(', ')})`
      : s.status === 'unmatched' ? 'stale — matched nothing in this run'
        : s.status === 'expired' ? `expired on ${s.expires ?? 'an earlier date'}`
          : 'not evaluated (scope not in this run)';
    return `<tr><td>${esc(s.rule)}</td><td>${esc(s.reason)}</td><td>${esc(label)}</td><td>${esc(s.expires ?? '')}</td></tr>`;
  }).join('');

  const jsonRel = relInside(dir, r.reports.json) ?? r.reports.json;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scan ${esc(r.id)}</title><style>${CSS}</style></head><body><main>
<h1>Scan ${esc(r.id)} <span class="verdict ${r.verdict.result === 'pass' ? 'pass' : 'fail'}">${r.verdict.result.toUpperCase()}</span></h1>
<ul>${r.verdict.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
<p class="muted">Policy: failOn=${esc(p.failOn)}, failOnErrors=${esc(p.failOnErrors)}, failOnHeuristic=${esc(p.failOnHeuristic)}<br>
Started ${esc(r.startedAt)} · ${esc(r.ms)} ms · devices: ${esc(r.devices.join(', '))} · exploration ${r.explore ? 'on' : 'off'}<br>
${esc(confirmed.length)} confirmed, ${esc(heuristic.length)} heuristic, ${esc(suppressed.length)} suppressed groups · ${esc(failedRuns)} failed runs</p>
<h2>Scenario matrix</h2>${matrix(r)}
<h2>Confirmed problems</h2>${list(confirmed, false, 'None.')}
<h2>Heuristic warnings</h2>${list(heuristic, true, 'None.')}
<h2>Suppressed findings</h2>${suppressedSection}${partialHtml}
<h2>Suppressions</h2>${r.suppressions.length ? `<table><thead><tr><th>Rule</th><th>Reason</th><th>Status</th><th>Expires</th></tr></thead><tbody>${supRows}</tbody></table>` : '<p class="muted">No suppressions configured.</p>'}
${exploration(r)}
<p class="muted">Full data, including every measurement and reproduction, is in the JSON report: <code>${esc(jsonRel)}</code></p>
</main></body></html>
`;
}
