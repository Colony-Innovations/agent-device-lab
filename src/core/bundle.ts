import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, platform, release } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { redactSecrets, displayUrl } from './feed.js';
import { routePath } from './action-log.js';
import { SECRET_FIELD } from './steps.js';
import { readZip } from './zip.js';
import {
  LabError,
  type BundleConsoleError, type BundleFailedRequest, type BundleFailure, type ConsoleEntry, type FailedRequest, type FailureBundle, type Finding,
  type ProjectProfile, type RecordedAction, type RecordedObservation, type SessionInfo,
} from './schema.js';
import { CONTRACT_VERSIONS, productVersion } from './versions.js';

// Failure bundles: a folder holding bundle.json (what happened, how to replay it), the evidence frames and,
// when recorded and provably clean, a sanitized Playwright trace. The bundle is meant to leave the machine as a
// CI artifact or a bug report, so it never holds commands' environment, request bodies, headers, typed
// passwords or saved sign-in state, and a final pass over everything written refuses to proceed if a secret
// value known to the process is still in it.

export const BUNDLE_KIND = 'agentlab-failure-bundle';
export const BUNDLE_FILE = 'bundle.json';
const REDACTED = '‹redacted›';
const SET = '‹set›';
const DEFAULT_KEEP = 20;
const DEFAULT_DAYS = 14;
const MAX_FRAMES = 60;
const MIN_ENV_SECRET = 6;
/** A declared service env value this long is treated as a secret whatever its name (a token, a URL with credentials). */
const LONG_ENV_VALUE = 16;
const SECRET_ENV_NAME = /secret|token|passw|api[_-]?key|auth|cookie|private|credential|signature|csrf/i;
/** Scenario steps aimed at a field with one of these words in its name or role keep no `value`. */
const SECRETISH = SECRET_FIELD;
const ID = /^b-\d{8}T\d{6}-[0-9a-f]{4}$/;

export interface BundleInput {
  reason: string;
  failure: BundleFailure;
  profile: ProjectProfile;
  session: SessionInfo;
  startRoute: string;
  scenario?: { name: string; device: string };
  route: string;
  actions: RecordedAction[];
  actionsOmitted: number;
  observations: RecordedObservation[];
  findings: readonly Finding[];
  consoleErrors: readonly ConsoleEntry[];
  failedRequests: readonly FailedRequest[];
  /** The run directory: evidence frames are copied from it (and only from it). */
  runDir: string;
  /** Values the agent typed into password-like fields. */
  secrets: readonly string[];
  /** A sanitized trace to include (copied), or why it was left out. */
  trace?: { file: string } | { dropped: string };
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export interface BundleResult {
  id: string;
  /** The bundle's directory. */
  dir: string;
  /** Paths inside it. */
  files: string[];
  counts: { actions: number; observations: number; findings: number; consoleErrors: number; failedRequests: number; frames: number };
  trace: 'included' | 'not-recorded' | { dropped: string };
  pruned: string[];
}

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export function bundleId(now = new Date()): string {
  return `b-${now.toISOString().slice(0, 19).replace(/[-:]/g, '')}-${randomBytes(2).toString('hex')}`;
}

// ---------- what must never be written ----------

/** Values in the process environment that must not appear in a bundle: required and secret-named variables, and long declared service values. */
export function envSecrets(profile: Pick<ProjectProfile, 'services'>, env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>();
  const add = (v: string | undefined, min: number) => { if (v && v.length >= min) out.add(v); };
  for (const svc of profile.services) {
    for (const name of svc.requiredEnv) add(env[name], MIN_ENV_SECRET);
    for (const value of Object.values(svc.env)) add(value, LONG_ENV_VALUE);
  }
  for (const [name, value] of Object.entries(env)) if (SECRET_ENV_NAME.test(name)) add(value, MIN_ENV_SECRET);
  return [...out];
}

const variants = (secret: string): string[] => [...new Set([secret, encodeURIComponent(secret)])].filter((v) => v.length > 0);
const escapedVariants = (secret: string): string[] => [...new Set([...variants(secret), JSON.stringify(secret).slice(1, -1)])];

function replaceAll(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) for (const v of variants(s)) if (out.includes(v)) out = out.split(v).join(REDACTED);
  return out;
}

/** A copy of a JSON value with every secret replaced inside its strings. */
export function redactTree<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === 'string') return replaceAll(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => redactTree(v, secrets)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactTree(v, secrets)])) as T;
  return value;
}

/** Names of the secrets still in `text`, as a count only: the values are never reported. */
export function leakedSecrets(text: string, secrets: readonly string[]): number {
  return secrets.filter((s) => escapedVariants(s).some((v) => text.includes(v))).length;
}

// ---------- the profile, sanitized ----------

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * agentlab.json as it can leave the machine: every service env value becomes ‹set› (names kept), requiredEnv
 * names stay, strings pass through `redactSecrets` (commands, URLs, everything), and the auth section keeps
 * only `use`, `loginPath` and the state file relative to the project root. Scenario steps aimed at a
 * secret-looking field keep no `value`.
 */
export function sanitizeProfile(raw: unknown, root: string): Record<string, unknown> {
  if (!isRec(raw)) return {};
  const copy = structuredClone(raw);
  const mask = (svc: unknown) => {
    if (isRec(svc) && isRec(svc.env)) svc.env = Object.fromEntries(Object.keys(svc.env).map((k) => [k, SET]));
  };
  mask(copy.web);
  if (isRec(copy.services)) for (const svc of Object.values(copy.services)) mask(svc);
  if (isRec(copy.auth)) {
    const { use, loginPath, file } = copy.auth;
    const rel = typeof file === 'string' ? relative(root, resolve(root, file)) : undefined;
    copy.auth = { ...(use !== undefined ? { use } : {}), ...(loginPath !== undefined ? { loginPath } : {}), ...(rel !== undefined ? { file: rel } : {}) };
  }
  // Sign-in steps in declared scenarios carry test credentials: same rule as the bundle's scenario section.
  const scenarios = isRec(copy.scan) && Array.isArray(copy.scan.scenarios) ? copy.scan.scenarios : [];
  for (const sc of scenarios) {
    if (!isRec(sc)) continue;
    for (const key of ['steps', 'cleanup']) if (Array.isArray(sc[key])) sc[key] = sanitizeScenarioSteps(sc[key].filter(isRec));
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactSecrets(v);
    if (Array.isArray(v)) return v.map(walk);
    if (isRec(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(copy) as Record<string, unknown>;
}

/** A declared scenario for the bundle: the `value` of a step aimed at a secret-looking field is masked. */
export function sanitizeScenarioSteps(steps: readonly object[]): Record<string, unknown>[] {
  return steps.map((step) => {
    const s = { ...step } as Record<string, unknown>;
    if (s.value !== undefined && SECRETISH.test(`${s.name ?? ''} ${s.nameContains ?? ''} ${s.role ?? ''}`)) s.value = '‹secret›';
    return s;
  });
}

export function summariseConsole(entries: readonly ConsoleEntry[], limit = 50): BundleConsoleError[] {
  const seen = new Map<string, BundleConsoleError>();
  for (const e of entries) {
    const text = redactSecrets(e.text).slice(0, 300);
    const key = `${e.type}\u0001${text}`;
    const prev = seen.get(key);
    seen.delete(key); // re-inserted last: order is by most recent occurrence
    seen.set(key, { type: e.type, text, count: (prev?.count ?? 0) + 1 });
  }
  return [...seen.values()].slice(-limit);
}

export function summariseRequests(entries: readonly FailedRequest[], limit = 50): BundleFailedRequest[] {
  return entries.slice(-limit).map((r) => ({
    method: r.method, url: displayUrl(r.url), ...(r.status !== undefined ? { status: r.status } : {}),
    ...(r.failure !== undefined ? { failure: redactSecrets(r.failure).slice(0, 200) } : {}),
  }));
}

// ---------- frames ----------

/** Frames inside the run directory that belong in the bundle, by the name they get there. Nothing outside the run directory is copied. */
function planFrames(runDir: string, findings: readonly Finding[]): { copies: Map<string, string>; omitted: number } {
  const copies = new Map<string, string>(); // absolute source → name in frames/
  const taken = new Set<string>();
  let omitted = 0;
  let root: string;
  try { root = realpathSync(runDir); } catch { return { copies, omitted }; }
  const add = (src: string): string | undefined => {
    let real: string;
    try { real = realpathSync(src); } catch { return undefined; }
    if (!real.startsWith(root + sep) || !statSync(real).isFile()) return undefined;
    const known = copies.get(real);
    if (known) return known;
    if (copies.size >= MAX_FRAMES) { omitted++; return undefined; }
    let name = basename(real);
    for (let n = 2; taken.has(name); n++) name = `${n}-${basename(real)}`;
    taken.add(name);
    copies.set(real, name);
    return name;
  };
  const direct = join(runDir, 'frames');
  if (existsSync(direct)) for (const f of readdirSync(direct).sort()) if (/\.jpe?g$/i.test(f)) add(join(direct, f));
  for (const f of findings) {
    if (f.frame) add(f.frame);
    for (const x of f.frames ?? []) add(x.path);
  }
  return { copies, omitted };
}

function withFramePaths(findings: readonly Finding[], copies: Map<string, string>): Finding[] {
  const nameOf = (p: string): string | undefined => {
    try { const n = copies.get(realpathSync(p)); return n ? `frames/${n}` : undefined; } catch { return undefined; }
  };
  return findings.map((f) => {
    const { frame, frames, ...rest } = structuredClone(f);
    const inBundle = frame ? nameOf(frame) : undefined;
    const extra = (frames ?? []).flatMap((x) => { const p = nameOf(x.path); return p ? [{ ...x, path: p }] : []; });
    return { ...rest, ...(inBundle ? { frame: inBundle } : {}), ...(extra.length ? { frames: extra } : {}) };
  });
}

// ---------- assembling and writing ----------

function playwrightVersion(): string {
  try { return (createRequire(import.meta.url)('playwright/package.json') as { version: string }).version; } catch { return 'unknown'; }
}

const envInt = (name: string, env: NodeJS.ProcessEnv): number | undefined => {
  const n = Number(env[name]);
  return env[name] !== undefined && env[name] !== '' && Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** The retention limits: AGENTLAB_KEEP_BUNDLES and AGENTLAB_BUNDLE_DAYS override the defaults. */
export function retentionLimits(env: NodeJS.ProcessEnv = process.env): { keep: number; maxAgeDays: number } {
  return { keep: envInt('AGENTLAB_KEEP_BUNDLES', env) ?? DEFAULT_KEEP, maxAgeDays: envInt('AGENTLAB_BUNDLE_DAYS', env) ?? DEFAULT_DAYS };
}

function ensureDir(dir: string): void {
  const fresh = !existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fresh) chmodSync(dir, 0o700);
}

/**
 * Write `<dir>/<id>/bundle.json`, `frames/*.jpg` and `trace.zip` (owner-only: files 0600, directories 0700),
 * after a final pass that replaces, then verifies the absence of, every secret value known to the process.
 * Throws `bundle_unsafe` (writing nothing) when one is still present. Prunes old bundles afterwards.
 */
export function writeBundle(input: BundleInput, dir: string): BundleResult {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const { profile, session } = input;
  const limits = retentionLimits(env);
  const id = bundleId(now);
  // Longest first, so a secret that contains another is replaced whole.
  const secrets = [...new Set([...input.secrets, ...envSecrets(profile, env)])].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);

  const profileBytes = readFileSync(profile.profilePath);
  let rawProfile: unknown = {};
  try { rawProfile = JSON.parse(profileBytes.toString('utf8')); } catch { /* the sanitized copy is then empty */ }
  const declared = profile.scan.scenarios.find((s) => s.name === input.scenario?.name);
  const frames = planFrames(input.runDir, input.findings);
  const trace = input.trace && 'file' in input.trace ? checkTrace(input.trace.file, secrets) : undefined;
  const traceDropped = input.trace && 'dropped' in input.trace ? input.trace.dropped : trace && 'dropped' in trace ? trace.dropped : undefined;

  const bundle: FailureBundle = {
    kind: BUNDLE_KIND,
    bundleVersion: CONTRACT_VERSIONS.bundle,
    id,
    product: { version: productVersion(), contracts: { ...CONTRACT_VERSIONS } },
    environment: {
      node: process.version, platform: platform(), arch: arch(), osRelease: release(), playwright: playwrightVersion(),
      chromium: session.browser.version, headed: session.browser.headed, ci: Boolean(process.env.CI),
    },
    reason: redactSecrets(input.reason).slice(0, 500),
    failure: input.failure,
    project: { name: profile.name, profileSha256: sha256(profileBytes), profile: sanitizeProfile(rawProfile, profile.root) },
    session: { id: session.id, device: session.device.id, auth: session.auth ?? 'fresh', startRoute: routePath(input.startRoute) ?? '/' },
    ...(declared && input.scenario ? { scenario: { name: declared.name, device: input.scenario.device, route: declared.route, steps: sanitizeScenarioSteps(declared.steps) } } : {}),
    route: routePath(input.route) ?? '/',
    actions: input.actions,
    actionsOmitted: input.actionsOmitted,
    observations: input.observations,
    findings: withFramePaths(input.findings, frames.copies),
    consoleErrors: summariseConsole(input.consoleErrors),
    failedRequests: summariseRequests(input.failedRequests),
    frames: [...frames.copies.values()].map((n) => `frames/${n}`),
    framesOmitted: frames.omitted,
    ...(trace && 'file' in trace ? { trace: 'trace.zip' } : {}),
    ...(traceDropped ? { traceDropped } : {}),
    retention: {
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + limits.maxAgeDays * 86_400_000).toISOString(),
      policy: `Kept locally for ${limits.maxAgeDays} days, and only the newest ${limits.keep} bundles are kept; agentlab never uploads a bundle.`,
    },
  };

  const safe = redactTree(bundle, secrets);
  const text = JSON.stringify(safe, null, 2) + '\n';
  const leaked = leakedSecrets(text, secrets);
  if (leaked) throw new LabError('bundle_unsafe', `The bundle still contained ${leaked} secret value(s) after redaction; nothing was written`, { hint: 'This is a bug in agentlab: report it without attaching the run.' });

  const bundleDir = join(resolve(dir), id);
  ensureDir(resolve(dir));
  ensureDir(bundleDir);
  const files: string[] = [];
  const put = (rel: string, write: (to: string) => void) => {
    const to = join(bundleDir, rel);
    ensureDir(dirname(to));
    write(to);
    chmodSync(to, 0o600);
    files.push(rel);
  };
  try {
    put(BUNDLE_FILE, (to) => writeFileSync(to, text, { mode: 0o600 }));
    for (const [src, name] of frames.copies) put(`frames/${name}`, (to) => copyFileSync(src, to));
    if (trace && 'file' in trace) put('trace.zip', (to) => copyFileSync(trace.file, to));
  } catch (err) {
    rmSync(bundleDir, { recursive: true, force: true });
    throw err;
  }

  const pruned = pruneBundles(dir, { ...limits, now });
  return {
    id, dir: bundleDir, files,
    counts: {
      actions: bundle.actions.length, observations: bundle.observations.length, findings: bundle.findings.length,
      consoleErrors: bundle.consoleErrors.length, failedRequests: bundle.failedRequests.length, frames: bundle.frames.length,
    },
    trace: trace && 'file' in trace ? 'included' : traceDropped ? { dropped: traceDropped } : 'not-recorded',
    pruned,
  };
}

/** A last look at a sanitized trace: a secret still in any entry means it is left out (the sanitizer should have made this impossible). */
function checkTrace(file: string, secrets: readonly string[]): { file: string } | { dropped: string } {
  try {
    for (const entry of readZip(readFileSync(file))) {
      const text = entry.data.toString('latin1');
      if (leakedSecrets(text, secrets)) return { dropped: 'a secret value was still present in the trace after sanitizing' };
    }
    return { file };
  } catch {
    return { dropped: 'the trace could not be verified' };
  }
}

// ---------- reading, listing, pruning ----------

/** `<bundle dir>` or `bundle.json`: the path of the file. */
export function resolveBundleFile(path: string): string {
  const p = resolve(path);
  const file = existsSync(p) && statSync(p).isDirectory() ? join(p, BUNDLE_FILE) : p;
  if (!existsSync(file)) throw new LabError('bundle_invalid', `No bundle at ${path}`, { hint: `Pass a bundle directory or its ${BUNDLE_FILE}.` });
  return file;
}

/** Parse and validate a bundle. Its content is untrusted: the shape is checked before anything uses it. */
export function parseBundle(raw: unknown): FailureBundle {
  const bad = (why: string): never => { throw new LabError('bundle_invalid', `Not a usable failure bundle: ${why}`); };
  if (!isRec(raw) || raw.kind !== BUNDLE_KIND) return bad('missing kind "agentlab-failure-bundle"');
  if (typeof raw.bundleVersion !== 'number' || !Number.isInteger(raw.bundleVersion) || raw.bundleVersion < 1) return bad('bundleVersion must be a positive integer');
  if (raw.bundleVersion > CONTRACT_VERSIONS.bundle) {
    throw new LabError('bundle_too_new', `This bundle is version ${raw.bundleVersion}; this agentlab reads up to ${CONTRACT_VERSIONS.bundle}`, { hint: 'Upgrade agentlab to replay it.' });
  }
  for (const k of ['actions', 'observations', 'findings', 'frames'] as const) if (!Array.isArray(raw[k])) bad(`"${k}" must be a list`);
  if (!isRec(raw.failure) || typeof raw.failure.kind !== 'string') bad('"failure" is missing');
  if (!isRec(raw.session) || typeof raw.session.device !== 'string') bad('"session.device" is missing');
  if (!isRec(raw.project) || typeof raw.project.profileSha256 !== 'string') bad('"project.profileSha256" is missing');
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) bad('"id" is malformed');
  return raw as unknown as FailureBundle;
}

export function loadBundle(path: string): FailureBundle {
  const file = resolveBundleFile(path);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new LabError('bundle_invalid', `${file} is not valid JSON`); }
  return parseBundle(raw);
}

export interface BundleSummary { id: string; dir: string; createdAt: string; reason: string; failure: string; actions: number; findings: number; trace: boolean }

/** Bundles under `dir`, newest first. Only directories holding a valid bundle.json count; nothing else is ever touched. */
export function listBundles(dir: string): BundleSummary[] {
  const root = resolve(dir);
  if (!existsSync(root)) return [];
  const out: BundleSummary[] = [];
  for (const name of readdirSync(root)) {
    if (!ID.test(name)) continue;
    try {
      const b = parseBundle(JSON.parse(readFileSync(join(root, name, BUNDLE_FILE), 'utf8')));
      out.push({
        id: b.id, dir: join(root, name), createdAt: b.retention?.createdAt ?? statSync(join(root, name)).mtime.toISOString(), reason: b.reason,
        failure: b.failure.kind, actions: b.actions.length, findings: b.findings.length, trace: existsSync(join(root, name, 'trace.zip')),
      });
    } catch { /* not ours, or unreadable: left alone */ }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export function removeBundle(dir: string, id: string): void {
  if (!ID.test(id)) throw new LabError('invalid_request', `"${id.slice(0, 40)}" is not a bundle id`, { hint: 'List them with `agentlab bundles`.' });
  const target = join(resolve(dir), id);
  if (!existsSync(join(target, BUNDLE_FILE))) throw new LabError('not_found', `No bundle ${id} in ${resolve(dir)}`);
  rmSync(target, { recursive: true, force: true });
}

/** Remove bundles beyond the newest `keep` and older than `maxAgeDays`. Returns the ids removed. */
export function pruneBundles(dir: string, opts: { keep?: number; maxAgeDays?: number; now?: Date } = {}): string[] {
  const limits = retentionLimits();
  const keep = opts.keep ?? limits.keep;
  const maxAgeDays = opts.maxAgeDays ?? limits.maxAgeDays;
  const cutoff = (opts.now ?? new Date()).getTime() - maxAgeDays * 86_400_000;
  const removed: string[] = [];
  listBundles(dir).forEach((b, i) => {
    if (i >= keep || Date.parse(b.createdAt) < cutoff) {
      try { removeBundle(dir, b.id); removed.push(b.id); } catch { /* already gone */ }
    }
  });
  return removed;
}
