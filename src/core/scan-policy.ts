import type { Finding, FindingGroup, FindingKind, ScanPolicy, ScanVerdict, ScenarioDeviceRun, Suppression, SuppressionStatus } from './schema.js';

// Pure scan policy: suppression matching, grouping by fingerprint and the pass/fail verdict.

export const DEFAULT_POLICY: ScanPolicy = { failOn: 'high', failOnErrors: false, failOnHeuristic: false };

export const KIND_TITLES: Record<FindingKind, string> = {
  'horizontal-overflow': 'Page is wider than the screen',
  'control-clipped': 'Control cut off by the screen edge',
  'horizontal-pan-required': 'Sideways scrolling needed to reach a control',
  'control-obstructed': 'Control covered by another element',
  'container-clipped': 'Clipped by its container',
  'text-clipped': 'Text cut off',
  'text-truncated': 'Text truncated',
  'fixed-collision': 'Fixed elements collide',
  'content-under-fixed': 'Content hidden behind a fixed bar',
  'modal-overflow': 'Dialog or drawer overflows the screen',
  'unreachable-content': 'Content cannot be scrolled to',
  'outside-container': 'Control sticks out of its container',
  'content-scroll-x': 'Unexpected horizontal scrolling',
  'tap-target': 'Tap target too small or too close',
  'layout-shift': 'Layout shifts while the state settles',
  'text-wrap-change': 'Label wraps at a narrower width',
};

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 } as const;

function globToRegExp(glob: string): RegExp {
  const body = glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*');
  return new RegExp(`^${body}$`);
}

/** Exact, or a glob where `*` matches any run of characters (including `/`), anchored at both ends. */
function globMatch(pattern: string, value: string): boolean {
  return pattern.includes('*') ? globToRegExp(pattern).test(value) : pattern === value;
}

function ruleMatches(rule: Suppression, f: Finding): boolean {
  if (rule.kind !== undefined) {
    const kinds = Array.isArray(rule.kind) ? rule.kind : [rule.kind];
    if (!kinds.includes(f.kind)) return false;
  }
  if (rule.fingerprint !== undefined && rule.fingerprint !== f.fingerprint) return false;
  if (rule.route !== undefined && !globMatch(rule.route, f.route)) return false;
  if (rule.target?.role !== undefined && f.target?.role !== rule.target.role) return false;
  if (rule.target?.name !== undefined && (f.target === undefined || !globMatch(rule.target.name, f.target.name))) return false;
  if (rule.scenario !== undefined && f.scenario !== rule.scenario) return false;
  if (rule.device !== undefined && f.device !== rule.device) return false;
  return true;
}

export function matchSuppressions(
  findings: readonly Finding[],
  rules: readonly Suppression[],
  ctx: { today: string; scenarios: readonly string[]; devices: readonly string[] },
): { statuses: SuppressionStatus[]; applied: Map<string, NonNullable<Finding['suppressed']>> } {
  const applied = new Map<string, NonNullable<Finding['suppressed']>>();
  const statuses: SuppressionStatus[] = [];
  rules.forEach((rule, index) => {
    const base = { rule: index, reason: rule.reason, ...(rule.expires ? { expires: rule.expires } : {}) };
    if (rule.expires !== undefined && rule.expires < ctx.today) {
      statuses.push({ ...base, status: 'expired', matched: [] });
      return;
    }
    const matched: string[] = [];
    for (const f of findings) {
      if (!ruleMatches(rule, f)) continue;
      matched.push(f.id);
      if (!applied.has(f.id)) applied.set(f.id, { ...base, rule: index });
    }
    if (matched.length) { statuses.push({ ...base, status: 'applied', matched }); return; }
    const outOfScope = (rule.scenario !== undefined && !ctx.scenarios.includes(rule.scenario))
      || (rule.device !== undefined && !ctx.devices.includes(rule.device));
    statuses.push({ ...base, status: outOfScope ? 'not-evaluated' : 'unmatched', matched });
  });
  return { statuses, applied };
}

const idNumber = (id: string) => Number.parseInt(id.replace(/\D+/g, ''), 10) || 0;

export function groupFindings(findings: readonly Finding[]): FindingGroup[] {
  const byFingerprint = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byFingerprint.get(f.fingerprint);
    if (list) list.push(f); else byFingerprint.set(f.fingerprint, [f]);
  }
  const groups: Omit<FindingGroup, 'id'>[] = [];
  for (const [fingerprint, members] of byFingerprint) {
    const live = members.filter((f) => !f.suppressed);
    const counted = live.length ? live : members;
    const severity = counted.reduce<Finding['severity']>((max, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[max] ? f.severity : max), 'low');
    const confidence: FindingGroup['confidence'] = counted.some((f) => f.confidence === 'confirmed') ? 'confirmed' : 'heuristic';
    // The most severe member (confirmed first, then input order) speaks for the group.
    const lead = members.reduce((best, f) => {
      const a = SEVERITY_RANK[f.severity] * 2 + (f.confidence === 'confirmed' ? 1 : 0);
      const b = SEVERITY_RANK[best.severity] * 2 + (best.confidence === 'confirmed' ? 1 : 0);
      return a > b ? f : best;
    });
    const target = lead.target ? (({ ref: _ref, ...rest }) => rest)(lead.target) : undefined;
    groups.push({
      fingerprint,
      kind: lead.kind,
      title: `${KIND_TITLES[lead.kind]}: ${target ? `${target.role} "${target.name}"` : lead.route}`,
      severity,
      confidence,
      route: lead.route,
      ...(target ? { target } : {}),
      scenarios: [...new Set(members.map((f) => f.scenario ?? 'session'))].sort(),
      devices: [...new Set(members.map((f) => f.device))].sort(),
      findings: members.map((f) => f.id),
      suppressed: members.every((f) => f.suppressed !== undefined),
    });
  }
  groups.sort((a, b) =>
    Number(a.suppressed) - Number(b.suppressed)
    || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    || Number(b.confidence === 'confirmed') - Number(a.confidence === 'confirmed')
    || idNumber(a.findings[0] ?? '') - idNumber(b.findings[0] ?? ''));
  return groups.map((g, i) => ({ id: `G${i + 1}`, ...g }));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function evaluatePolicy(findings: readonly Finding[], runs: readonly ScenarioDeviceRun[], policy: ScanPolicy): ScanVerdict {
  const live = findings.filter((f) => !f.suppressed);
  const suppressedCount = findings.length - live.length;
  const threshold = policy.failOn === 'none' ? Infinity : SEVERITY_RANK[policy.failOn];
  const eligible = live.filter((f) => policy.failOnHeuristic || f.confidence === 'confirmed');
  const failing = eligible.filter((f) => SEVERITY_RANK[f.severity] >= threshold);
  const failedRuns = runs.filter((r) => r.status === 'failed');
  const errorsFail = policy.failOnErrors && failedRuns.length > 0;

  const reasons: string[] = [];
  if (failing.length) {
    const noun = policy.failOnHeuristic ? plural(failing.length, 'finding', 'findings') : plural(failing.length, 'confirmed finding', 'confirmed findings');
    reasons.push(`${noun} at or above ${policy.failOn} severity (${failing.map((f) => f.id).join(', ')})`);
  }
  if (failedRuns.length) {
    const list = failedRuns.map((r) => `"${r.scenario}" on ${r.device}${r.failedAt ? ` (${r.failedAt})` : ''}`).join(', ');
    reasons.push(policy.failOnErrors
      ? `${plural(failedRuns.length, 'scenario run', 'scenario runs')} failed: ${list}`
      : `${plural(failedRuns.length, 'scenario run', 'scenario runs')} failed but failOnErrors is off: ${list}`);
  }
  const notFailing = eligible.filter((f) => !failing.includes(f));
  if (notFailing.length) {
    reasons.push(policy.failOn === 'none'
      ? `${plural(notFailing.length, 'finding', 'findings')} not counted (failOn is none)`
      : `${policy.failOnHeuristic ? plural(notFailing.length, 'finding', 'findings') : plural(notFailing.length, 'confirmed finding', 'confirmed findings')} below ${policy.failOn} severity ${notFailing.length === 1 ? 'does' : 'do'} not fail the scan (failOn is ${policy.failOn})`);
  }
  const heuristic = live.filter((f) => f.confidence === 'heuristic');
  if (!policy.failOnHeuristic && heuristic.length) {
    reasons.push(`${plural(heuristic.length, 'heuristic warning', 'heuristic warnings')} ${heuristic.length === 1 ? 'is' : 'are'} not counted (failOnHeuristic is off)`);
  }
  if (suppressedCount) reasons.push(`${plural(suppressedCount, 'suppressed finding', 'suppressed findings')} ${suppressedCount === 1 ? 'is' : 'are'} not counted`);
  if (!reasons.length) reasons.push('no findings and no failed scenario runs');

  return { result: failing.length || errorsFail ? 'fail' : 'pass', reasons, policy };
}
