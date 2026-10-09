import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isIP } from 'node:net';
import { SWEEP_DEVICES } from './devices.js';
import { DETECTORS } from './detectors.js';
import { DEFAULT_POLICY } from './scan-policy.js';
import {
  LabError, SCHEMA_VERSION,
  type AuthPolicy, type CiConfig, type ChecksConfig, type ControlMatcher, type DeviceOverride, type ExploreConfig, type FindingKind, type ProjectProfile, type ReadinessSpec,
  type ScanConfig, type ScanScenario, type ScenarioStep, type ServiceSpec, type SettlePolicy, type ShutdownSignal, type Suppression, type WebServerSpec,
} from './schema.js';
import { CONTRACT_VERSIONS, productVersion } from './versions.js';

export const PROFILE_FILE = 'agentlab.json';
export const DEFAULT_SETTLE: Readonly<SettlePolicy> = { quietMs: 120, maxMs: 5000, backgroundRequests: [], timerMaxMs: 1000 };
export const DEFAULT_AUTH_FILE = '.agentlab/auth/state.json';
const SIGNALS: readonly ShutdownSignal[] = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const MIGRATION_NOTE = 'schemaVersion 1 profile: run `agentlab migrate` to rewrite it as schemaVersion 2';

// The keys each object may carry. Anything else is reported, so a typo is never silently reinterpreted.
// `description`, `comment` and keys starting with `//` are always allowed, for comments.
const TOP_KEYS = ['$schema', 'schemaVersion', 'name', 'web', 'services', 'app', 'startPath', 'device', 'devices', 'allowExternalUrl', 'settle', 'auth', 'uploads', 'scan', 'ci'];
const WEB_KEYS = ['command', 'cwd', 'url', 'env', 'readiness', 'reuseExisting'];
const WEB_READINESS_KEYS = ['path', 'status', 'timeoutMs', 'intervalMs'];
const SERVICE_KEYS = ['command', 'cwd', 'url', 'env', 'requiredEnv', 'readiness', 'dependsOn', 'reuseExisting', 'required', 'mode', 'shutdown'];
const READINESS_KEYS = ['tcp', 'log', 'alive', 'url', 'path', 'status', 'timeoutMs', 'intervalMs'];
const SHUTDOWN_KEYS = ['signal', 'graceMs', 'command'];
const APP_KEYS = ['url', 'service'];
const DEVICE_KEYS = ['extends', 'label', 'viewport', 'deviceScaleFactor', 'isMobile', 'hasTouch', 'userAgent'];
const SETTLE_KEYS = ['quietMs', 'maxMs', 'backgroundRequests', 'timerMaxMs'];
const AUTH_KEYS = ['file', 'use', 'loginPath'];
const SCAN_KEYS = ['devices', 'checks', 'tapTargets', 'noWrap', 'wrapNearbyRatio', 'layoutShiftMin', 'explore', 'scenarios', 'suppressions', 'policy'];
const CHECKS_KEYS = ['enable', 'disable'];
const EXPLORE_KEYS = ['enabled', 'maxDepth', 'maxStates', 'maxActionsPerState', 'maxMs', 'allow', 'deny'];
const SCENARIO_KEYS = ['name', 'route', 'auth', 'explore', 'devices', 'steps', 'cleanup', 'checks'];
// The keys a step reads (FlowStep in steps.ts), and those of its expectation (Expectation).
const STEP_KEYS = ['do', 'role', 'name', 'nameContains', 'value', 'key', 'values', 'direction', 'amount', 'to', 'dx', 'dy', 'files', 'tab', 'path', 'label', 'expect'];
const TARGET_KEYS = ['role', 'name', 'nameContains'];
const EXPECT_KEYS = ['route', 'heading', 'dialog', 'message', 'control', 'noControl', 'layout', 'note', 'navigated', 'tab', 'findings'];
const SUPPRESSION_KEYS = ['kind', 'fingerprint', 'route', 'target', 'scenario', 'device', 'reason', 'expires'];
const POLICY_KEYS = ['failOn', 'failOnErrors', 'failOnHeuristic'];
const CI_KEYS = ['flows', 'routes', 'scenarios', 'devices', 'failOn', 'failOnHeuristic', 'scenarioErrors', 'out', 'trace', 'evidence', 'timeoutMs', 'auth'];

const isCommentKey = (k: string) => k === 'description' || k === 'comment' || k.startsWith('//');

/** Levenshtein distance. Pure. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length]!;
}

/** The candidate closest to `key` within distance 2 (and shorter than the key itself), if any. */
export function didYouMean(key: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = c.toLowerCase() === key.toLowerCase() ? 0 : editDistance(key, c);
    if (d < bestDistance) { best = c; bestDistance = d; }
  }
  return best !== undefined && bestDistance <= 2 && bestDistance < key.length ? best : undefined;
}

/** Report keys of `obj` that are neither in `allowed` nor comment keys. `at` names the object ("" for the top level). */
function checkKeys(obj: unknown, allowed: readonly string[], at: string, problems: string[]): void {
  if (!isRecord(obj)) return;
  for (const k of Object.keys(obj)) {
    if (allowed.includes(k) || isCommentKey(k)) continue;
    const near = didYouMean(k, allowed);
    problems.push(`unknown key "${k}" ${at ? `in "${at}"` : 'at top level'}${near ? ` (did you mean "${near}"?)` : ''}`);
  }
}

/**
 * The declared schemaVersion. A newer file throws before anything else is read, so it is never
 * partially interpreted; a missing or malformed one is a problem.
 */
function readVersion(obj: Record<string, unknown>, problems: string[]): 1 | 2 | undefined {
  const v = obj.schemaVersion;
  const [min, max] = [CONTRACT_VERSIONS.profileSupported[0], CONTRACT_VERSIONS.profile];
  if (v === undefined) problems.push(`"schemaVersion" is required (${max} for this version of agentlab)`);
  else if (typeof v !== 'number' || !Number.isInteger(v) || v < min) problems.push(`"schemaVersion" must be a whole number from ${min} to ${max}`);
  else if (v > max) {
    throw new LabError('profile_too_new', `agentlab.json has schemaVersion ${v}; this agentlab ${productVersion()} reads schemaVersion ${min}–${max}`, {
      hint: 'Upgrade agentlab (see docs/install.md), or use a profile written for this version.',
    });
  } else return v as 1 | 2;
  return undefined;
}

/** Resolve `target` (a directory or a path to agentlab.json) and load the project profile. */
export async function loadProfile(target: string): Promise<ProjectProfile> {
  let profilePath = resolve(target);
  const info = await stat(profilePath).catch(() => undefined);
  if (!info) throw new LabError('invalid_profile', `No project profile at ${profilePath}`, { hint: 'Run `agentlab init` in the project to propose one.' });
  if (info.isDirectory()) profilePath = join(profilePath, PROFILE_FILE);

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(profilePath, 'utf8'));
  } catch (err) {
    throw new LabError('invalid_profile', `Cannot read ${profilePath}: ${(err as Error).message}`, {
      hint: `Run \`agentlab init\` to propose ${PROFILE_FILE}, or write one declaring services (see README).`,
    });
  }
  return parseProfile(raw, profilePath);
}

/**
 * Validate a parsed profile. Pure; exported for tests. Two shapes are accepted: schemaVersion 1 with a
 * single `web` section (it becomes one service named "web"), and schemaVersion 2 with named `services`.
 */
export function parseProfile(raw: unknown, profilePath: string): ProjectProfile {
  const problems: string[] = [];
  const obj = isRecord(raw) ? raw : (problems.push('profile must be a JSON object'), {});
  const root = dirname(profilePath);
  const num = numberReader(problems);
  const declared = readVersion(obj, problems);
  checkKeys(obj, TOP_KEYS, '', problems);

  let services: ServiceSpec[];
  let web: WebServerSpec | undefined;
  let app: ProjectProfile['app'];
  if (obj.services === undefined) {
    // schemaVersion 1: one web server.
    if (declared !== undefined && declared !== 1) problems.push(`"schemaVersion" must be 1 for a profile with a "web" section (or 2 with "services")`);
    web = parseWeb(obj.web, root, problems, num);
    services = [{
      name: 'web', command: web.command, cwd: web.cwd, url: web.url, env: web.env, requiredEnv: [],
      readiness: { kind: 'http', url: web.url, ...web.readiness }, dependsOn: [], reuseExisting: web.reuseExisting,
      required: true, mode: 'process', shutdown: { signal: 'SIGTERM', graceMs: 5000 },
    }];
    app = { url: web.url, service: 'web' };
  } else {
    if (declared !== undefined && declared !== 2) problems.push('"schemaVersion" must be 2 for a profile with "services"');
    if (obj.web !== undefined) problems.push('use either "web" (schemaVersion 1) or "services" (schemaVersion 2), not both');
    services = [];
    if (!isRecord(obj.services) || !Object.keys(obj.services).length) problems.push('"services" must map at least one name to a service');
    else for (const [name, spec] of Object.entries(obj.services)) services.push(parseService(name, spec, root, problems, num));
    for (const s of services) {
      for (const dep of s.dependsOn) {
        if (dep === s.name) problems.push(`service "${s.name}" depends on itself`);
        else if (!services.some((o) => o.name === dep)) problems.push(`service "${s.name}" depends on unknown service "${dep}"`);
      }
    }
    if (!problems.length) {
      try { startOrder(services); } catch (err) { problems.push((err as Error).message); }
    }
    app = parseApp(obj.app, services, problems);
  }

  const settle = isRecord(obj.settle) ? obj.settle : {};
  if (obj.settle !== undefined && !isRecord(obj.settle)) problems.push('"settle" must be an object');
  checkKeys(settle, SETTLE_KEYS, 'settle', problems);
  const background = settle.backgroundRequests ?? [];
  if (!Array.isArray(background) || !background.every((b) => typeof b === 'string' && b.length > 0)) {
    problems.push('"settle.backgroundRequests" must be a list of non-empty strings');
  }
  const startPath = obj.startPath ?? '/';
  if (typeof startPath !== 'string' || !startPath.startsWith('/')) problems.push('"startPath" must start with "/"');

  const profile: ProjectProfile = {
    schemaVersion: obj.services === undefined ? 1 : 2,
    name: typeof obj.name === 'string' ? obj.name : 'project',
    root,
    profilePath,
    services,
    app,
    ...(web ? { web } : {}),
    startPath: String(startPath),
    device: typeof obj.device === 'string' ? obj.device : 'mobile-390',
    devices: parseDevices(obj.devices, problems),
    allowExternalUrl: obj.allowExternalUrl === true,
    settle: {
      quietMs: num(settle.quietMs, 'settle.quietMs', DEFAULT_SETTLE.quietMs),
      maxMs: num(settle.maxMs, 'settle.maxMs', DEFAULT_SETTLE.maxMs),
      backgroundRequests: Array.isArray(background) ? (background as string[]) : [],
      timerMaxMs: settle.timerMaxMs === 0 ? 0 : num(settle.timerMaxMs, 'settle.timerMaxMs', DEFAULT_SETTLE.timerMaxMs),
    },
    auth: parseAuth(obj.auth, root, problems),
    uploads: { allow: parseUploads(obj.uploads, root, problems) },
    scan: parseScan(obj.scan, problems),
    ci: parseCi(obj.ci, problems),
    ...(obj.services === undefined ? { migration: MIGRATION_NOTE } : {}),
  };

  if (problems.length) {
    throw new LabError('invalid_profile', `Invalid profile ${profilePath}: ${problems.join('; ')}`, { details: { problems } });
  }
  assertUrlAllowed(profile.app.url, profile.allowExternalUrl);
  for (const s of services) if (s.url) assertUrlAllowed(s.url, profile.allowExternalUrl);
  return profile;
}

/**
 * Names in a safe start order: every service after its dependencies, otherwise in declaration order.
 * Throws on a dependency cycle. Pure.
 */
export function startOrder(services: readonly Pick<ServiceSpec, 'name' | 'dependsOn'>[]): string[] {
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const byName = new Map(services.map((s) => [s.name, s]));
  const visit = (name: string, path: string[]) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') throw new Error(`services have a dependency cycle: ${[...path, name].join(' → ')}`);
    state.set(name, 'visiting');
    for (const dep of byName.get(name)?.dependsOn ?? []) if (byName.has(dep)) visit(dep, [...path, name]);
    state.set(name, 'done');
    order.push(name);
  };
  for (const s of services) visit(s.name, []);
  return order;
}

type NumberReader = (v: unknown, name: string, fallback: number) => number;

function numberReader(problems: string[]): NumberReader {
  return (v, name, fallback) => {
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) problems.push(`"${name}" must be a positive number`);
    return v as number;
  };
}

function parseWeb(raw: unknown, root: string, problems: string[], num: NumberReader): WebServerSpec {
  const web = isRecord(raw) ? raw : (problems.push('"web" section is required'), {} as Record<string, unknown>);
  const readiness = isRecord(web.readiness) ? web.readiness : {};
  checkKeys(web, WEB_KEYS, 'web', problems);
  checkKeys(readiness, WEB_READINESS_KEYS, 'web.readiness', problems);
  if (typeof web.command !== 'string' || !web.command.trim()) problems.push('"web.command" must be a non-empty string');
  if (typeof web.url !== 'string' || !URL.canParse(web.url)) problems.push('"web.url" must be an absolute URL');
  if (web.env !== undefined && (!isRecord(web.env) || !Object.values(web.env).every((v) => typeof v === 'string'))) {
    problems.push('"web.env" must map names to strings');
  }
  const readyPath = readiness.path ?? '/';
  if (typeof readyPath !== 'string' || !readyPath.startsWith('/')) problems.push('"web.readiness.path" must start with "/"');
  return {
    command: String(web.command ?? ''),
    cwd: resolve(root, typeof web.cwd === 'string' ? web.cwd : '.'),
    url: String(web.url ?? '').replace(/\/+$/, ''),
    env: (isRecord(web.env) ? web.env : {}) as Record<string, string>,
    readiness: {
      path: String(readyPath),
      status: num(readiness.status, 'web.readiness.status', 200),
      timeoutMs: num(readiness.timeoutMs, 'web.readiness.timeoutMs', 60_000),
      intervalMs: num(readiness.intervalMs, 'web.readiness.intervalMs', 250),
    },
    reuseExisting: web.reuseExisting !== false,
  };
}

function parseService(name: string, raw: unknown, root: string, problems: string[], num: NumberReader): ServiceSpec {
  const at = `services.${name}`;
  if (!SERVICE_NAME.test(name)) problems.push(`service name "${name}" must be letters, digits, "-" or "_"`);
  const s = isRecord(raw) ? raw : (problems.push(`"${at}" must be an object`), {} as Record<string, unknown>);
  checkKeys(s, SERVICE_KEYS, at, problems);
  if (typeof s.command !== 'string' || !s.command.trim()) problems.push(`"${at}.command" must be a non-empty string`);
  let url: string | undefined;
  if (s.url !== undefined) {
    if (typeof s.url !== 'string' || !URL.canParse(s.url)) problems.push(`"${at}.url" must be an absolute URL`);
    else url = s.url.replace(/\/+$/, '');
  }
  if (s.env !== undefined && (!isRecord(s.env) || !Object.values(s.env).every((v) => typeof v === 'string'))) {
    problems.push(`"${at}.env" must map names to strings`);
  }
  const requiredEnv = s.requiredEnv ?? [];
  if (!Array.isArray(requiredEnv) || !requiredEnv.every((n) => typeof n === 'string' && ENV_NAME.test(n))) {
    problems.push(`"${at}.requiredEnv" must be a list of environment variable names`);
  }
  const dependsOn = s.dependsOn ?? [];
  if (!Array.isArray(dependsOn) || !dependsOn.every((n) => typeof n === 'string')) problems.push(`"${at}.dependsOn" must be a list of service names`);
  const mode = s.mode ?? 'process';
  if (mode !== 'process' && mode !== 'oneshot') problems.push(`"${at}.mode" must be "process" or "oneshot"`);

  const sd = isRecord(s.shutdown) ? s.shutdown : {};
  if (s.shutdown !== undefined && !isRecord(s.shutdown)) problems.push(`"${at}.shutdown" must be an object`);
  checkKeys(sd, SHUTDOWN_KEYS, `${at}.shutdown`, problems);
  const signal = sd.signal ?? 'SIGTERM';
  if (!SIGNALS.includes(signal as ShutdownSignal)) problems.push(`"${at}.shutdown.signal" must be one of ${SIGNALS.join(', ')}`);
  if (sd.command !== undefined && (typeof sd.command !== 'string' || !sd.command.trim())) problems.push(`"${at}.shutdown.command" must be a non-empty string`);
  if (sd.command !== undefined && mode !== 'oneshot') problems.push(`"${at}.shutdown.command" is only for mode "oneshot"; a process is stopped by signal`);

  return {
    name,
    command: String(s.command ?? ''),
    cwd: resolve(root, typeof s.cwd === 'string' ? s.cwd : '.'),
    ...(url ? { url } : {}),
    env: (isRecord(s.env) ? s.env : {}) as Record<string, string>,
    requiredEnv: Array.isArray(requiredEnv) ? (requiredEnv as string[]) : [],
    readiness: parseReadiness(s.readiness, url, mode === 'oneshot', at, problems, num),
    dependsOn: Array.isArray(dependsOn) ? (dependsOn as string[]) : [],
    reuseExisting: s.reuseExisting !== false,
    required: s.required !== false,
    mode: mode === 'oneshot' ? 'oneshot' : 'process',
    shutdown: {
      signal: signal as ShutdownSignal,
      graceMs: num(sd.graceMs, `${at}.shutdown.graceMs`, 5000),
      ...(typeof sd.command === 'string' ? { command: sd.command } : {}),
    },
  };
}

function parseReadiness(raw: unknown, url: string | undefined, oneshot: boolean, at: string, problems: string[], num: NumberReader): ReadinessSpec {
  if (raw !== undefined && !isRecord(raw)) {
    problems.push(`"${at}.readiness" must be an object`);
    return { kind: 'alive', ms: 1 };
  }
  const r = (raw ?? {}) as Record<string, unknown>;
  checkKeys(r, READINESS_KEYS, `${at}.readiness`, problems);
  const timeoutMs = num(r.timeoutMs, `${at}.readiness.timeoutMs`, 60_000);
  const intervalMs = num(r.intervalMs, `${at}.readiness.intervalMs`, 250);
  const kinds = ['tcp', 'log', 'alive', 'url', 'path'].filter((k) => r[k] !== undefined);
  if (kinds.length > 1 && !(kinds.length === 2 && kinds.includes('url') && kinds.includes('path'))) {
    problems.push(`"${at}.readiness" declares more than one check (${kinds.join(', ')})`);
  }
  if (r.tcp !== undefined) {
    const m = typeof r.tcp === 'string' ? /^(.+):(\d{1,5})$/.exec(r.tcp) : null;
    if (!m) {
      problems.push(`"${at}.readiness.tcp" must be "host:port"`);
      return { kind: 'tcp', host: '127.0.0.1', port: 0, timeoutMs, intervalMs };
    }
    return { kind: 'tcp', host: m[1]!.replace(/^\[|\]$/g, ''), port: Number(m[2]), timeoutMs, intervalMs };
  }
  if (r.log !== undefined) {
    if (typeof r.log !== 'string' || !r.log) problems.push(`"${at}.readiness.log" must be a non-empty pattern`);
    else {
      try { new RegExp(r.log); } catch { problems.push(`"${at}.readiness.log" is not a valid regular expression`); }
    }
    return { kind: 'log', pattern: String(r.log ?? ''), timeoutMs };
  }
  if (r.alive !== undefined) return { kind: 'alive', ms: num(r.alive, `${at}.readiness.alive`, 1000) };
  const status = num(r.status, `${at}.readiness.status`, 200);
  if (r.url !== undefined) {
    if (typeof r.url !== 'string' || !URL.canParse(r.url)) problems.push(`"${at}.readiness.url" must be an absolute URL`);
    const u = URL.canParse(String(r.url)) ? new URL(String(r.url)) : undefined;
    return { kind: 'http', url: u ? u.origin : '', path: u ? u.pathname + u.search : '/', status, timeoutMs, intervalMs };
  }
  if (r.path !== undefined || url) {
    const path = r.path ?? '/';
    if (typeof path !== 'string' || !path.startsWith('/')) problems.push(`"${at}.readiness.path" must start with "/"`);
    if (!url) problems.push(`"${at}.readiness.path" needs "${at}.url"`);
    return { kind: 'http', url: url ?? '', path: String(path), status, timeoutMs, intervalMs };
  }
  if (oneshot) return { kind: 'exit', timeoutMs };
  problems.push(`"${at}" has no url, so it needs a readiness check: {"tcp": "host:port"}, {"log": "pattern"} or {"alive": ms}`);
  return { kind: 'alive', ms: 1 };
}

function parseApp(raw: unknown, services: ServiceSpec[], problems: string[]): ProjectProfile['app'] {
  if (raw !== undefined && !isRecord(raw)) {
    problems.push('"app" must be an object: {"service": name} or {"url": url}');
    return { url: '' };
  }
  const a = (raw ?? {}) as Record<string, unknown>;
  checkKeys(a, APP_KEYS, 'app', problems);
  if (a.url !== undefined) {
    if (typeof a.url !== 'string' || !URL.canParse(a.url)) problems.push('"app.url" must be an absolute URL');
    const url = String(a.url).replace(/\/+$/, '');
    const owner = services.find((s) => s.url === url);
    return { url, ...(owner ? { service: owner.name } : {}) };
  }
  let name = typeof a.service === 'string' ? a.service : undefined;
  if (a.service !== undefined && typeof a.service !== 'string') problems.push('"app.service" must be a service name');
  if (!name) {
    const withUrl = services.filter((s) => s.url);
    name = services.find((s) => s.name === 'web' && s.url)?.name ?? (withUrl.length === 1 ? withUrl[0]!.name : undefined);
    if (!name) {
      if (services.length) problems.push('set "app": {"service": name} or {"url": url} to say which URL is the application');
      return { url: '' };
    }
  }
  const svc = services.find((s) => s.name === name);
  if (!svc) {
    problems.push(`"app.service" names unknown service "${name}"`);
    return { url: '' };
  }
  if (!svc.url) {
    problems.push(`"app.service" "${name}" has no url`);
    return { url: '' };
  }
  return { url: svc.url, service: name };
}

function parseDevices(raw: unknown, problems: string[]): Record<string, DeviceOverride> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    problems.push('"devices" must map ids to device profiles');
    return {};
  }
  const out: Record<string, DeviceOverride> = {};
  for (const [id, d] of Object.entries(raw)) {
    if (!isRecord(d)) { problems.push(`"devices.${id}" must be an object`); continue; }
    checkKeys(d, DEVICE_KEYS, `devices.${id}`, problems);
    const vp = d.viewport;
    checkKeys(vp, ['width', 'height'], `devices.${id}.viewport`, problems);
    if (vp !== undefined &&!(isRecord(vp) && [vp.width, vp.height].every((n) => typeof n === 'number' && n >= 100 && n <= 4000))) {
      problems.push(`"devices.${id}.viewport" must be {width, height} between 100 and 4000`);
    }
    if (d.extends === undefined && vp === undefined) problems.push(`"devices.${id}" needs "extends" or "viewport"`);
    if (d.extends !== undefined && typeof d.extends !== 'string') problems.push(`"devices.${id}.extends" must be a device id`);
    if (d.deviceScaleFactor !== undefined && !(typeof d.deviceScaleFactor === 'number' && d.deviceScaleFactor > 0 && d.deviceScaleFactor <= 4)) {
      problems.push(`"devices.${id}.deviceScaleFactor" must be between 0 and 4`);
    }
    for (const flag of ['isMobile', 'hasTouch'] as const) {
      if (d[flag] !== undefined && typeof d[flag] !== 'boolean') problems.push(`"devices.${id}.${flag}" must be true or false`);
    }
    out[id] = d as DeviceOverride;
  }
  return out;
}

function parseAuth(raw: unknown, root: string, problems: string[]): AuthPolicy {
  if (raw !== undefined && !isRecord(raw)) problems.push('"auth" must be an object');
  const a = isRecord(raw) ? raw : {};
  checkKeys(a, AUTH_KEYS, 'auth', problems);
  const file = a.file ?? DEFAULT_AUTH_FILE;
  if (typeof file !== 'string' || !file) problems.push('"auth.file" must be a path');
  const use = a.use ?? 'auto';
  if (use !== 'auto' && use !== 'never') problems.push('"auth.use" must be "auto" or "never"');
  if (a.loginPath !== undefined && (typeof a.loginPath !== 'string' || !a.loginPath.startsWith('/'))) problems.push('"auth.loginPath" must start with "/"');
  return {
    file: resolve(root, String(file)),
    use: use === 'never' ? 'never' : 'auto',
    ...(typeof a.loginPath === 'string' ? { loginPath: a.loginPath } : {}),
  };
}

function parseUploads(raw: unknown, root: string, problems: string[]): string[] {
  if (raw === undefined) return [];
  checkKeys(raw, ['allow'], 'uploads', problems);
  const allow = isRecord(raw) ? raw.allow : undefined;
  if (!Array.isArray(allow) || !allow.every((p) => typeof p === 'string' && p.length > 0)) {
    problems.push('"uploads.allow" must be a list of project-relative paths');
    return [];
  }
  return (allow as string[]).map((p) => {
    const abs = resolve(root, p);
    const rel = relative(root, abs);
    if (isAbsolute(p) || rel.startsWith('..')) problems.push(`"uploads.allow" entry "${p}" must be inside the project`);
    return abs;
  });
}

export const DEFAULT_EXPLORE: Readonly<ExploreConfig> = { enabled: false, maxDepth: 1, maxStates: 12, maxActionsPerState: 8, maxMs: 120_000, allow: [], deny: [] };

export function defaultScan(): ScanConfig {
  return {
    devices: [...SWEEP_DEVICES], checks: {}, tapTargets: { standard: 'wcag22-aa' }, noWrap: [], wrapNearbyRatio: 1.35, layoutShiftMin: 0.05,
    explore: { ...DEFAULT_EXPLORE, allow: [], deny: [] }, scenarios: [], suppressions: [], policy: { ...DEFAULT_POLICY },
  };
}

const ACTIONS = ['click', 'fill', 'press', 'select', 'check', 'uncheck', 'scroll', 'swipe', 'back', 'forward', 'hover', 'upload', 'drag', 'open_tab', 'switch_tab', 'close_tab'];
const TARGETED = ['click', 'fill', 'select', 'check', 'uncheck', 'hover', 'upload', 'drag'];
const SEVERITIES = ['high', 'medium', 'low', 'none'];

/** The `scan` section: devices, checks, stateful scenarios, exploration, suppressions and the result policy. */
function parseScan(raw: unknown, problems: string[]): ScanConfig {
  const scan = defaultScan();
  if (raw === undefined) return scan;
  if (!isRecord(raw)) { problems.push('"scan" must be an object'); return scan; }
  checkKeys(raw, SCAN_KEYS, 'scan', problems);
  const kinds = Object.keys(DETECTORS);
  const checkKinds = (v: unknown, at: string): FindingKind[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((k) => typeof k === 'string' && kinds.includes(k))) {
      problems.push(`"${at}" must be a list of check names (${kinds.join(', ')})`);
      return [];
    }
    return v as FindingKind[];
  };
  const checks = (v: unknown, at: string): ChecksConfig => {
    if (v === undefined) return {};
    if (!isRecord(v)) { problems.push(`"${at}" must be an object with "enable" and/or "disable"`); return {}; }
    checkKeys(v, CHECKS_KEYS, at, problems);
    const out: ChecksConfig = {};
    if (v.enable !== undefined) out.enable = checkKinds(v.enable, `${at}.enable`);
    if (v.disable !== undefined) out.disable = checkKinds(v.disable, `${at}.disable`);
    return out;
  };
  const devices = (v: unknown, at: string): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.length || !v.every((d) => typeof d === 'string' && d)) { problems.push(`"${at}" must be a non-empty list of device ids`); return undefined; }
    return v as string[];
  };
  const matchers = (v: unknown, at: string): ControlMatcher[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((m) => isRecord(m) && (m.role !== undefined || m.name !== undefined) &&
      ['role', 'name', 'route'].every((k) => m[k] === undefined || typeof m[k] === 'string') && Object.keys(m).every((k) => ['role', 'name', 'route'].includes(k)))) {
      problems.push(`"${at}" must be a list of {"role", "name", "route"} matchers (role or name required; name and route may use *)`);
      return [];
    }
    return v as ControlMatcher[];
  };
  const steps = (v: unknown, at: string): ScenarioStep[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) { problems.push(`"${at}" must be a list of steps`); return []; }
    v.forEach((st, i) => {
      if (!isRecord(st) || typeof st.do !== 'string' || !ACTIONS.includes(st.do)) { problems.push(`"${at}[${i}].do" must be one of ${ACTIONS.join(', ')}`); return; }
      checkKeys(st, STEP_KEYS, `${at}[${i}]`, problems);
      checkKeys(st.to, TARGET_KEYS, `${at}[${i}].to`, problems);
      checkKeys(st.expect, EXPECT_KEYS, `${at}[${i}].expect`, problems);
      if (isRecord(st.expect)) {
        checkKeys(st.expect.control, [...TARGET_KEYS, 'disabled', 'invalid'], `${at}[${i}].expect.control`, problems);
        checkKeys(st.expect.noControl, TARGET_KEYS, `${at}[${i}].expect.noControl`, problems);
      }
      if (TARGETED.includes(st.do) && st.name === undefined && st.nameContains === undefined) problems.push(`"${at}[${i}]" (${st.do}) needs "name" or "nameContains", optionally with "role"`);
      if (st.do === 'fill' && typeof st.value !== 'string') problems.push(`"${at}[${i}]" (fill) needs a "value"`);
      if (st.do === 'press' && typeof st.key !== 'string') problems.push(`"${at}[${i}]" (press) needs a "key"`);
    });
    return v as ScenarioStep[];
  };

  if (raw.devices !== undefined) scan.devices = devices(raw.devices, 'scan.devices') ?? scan.devices;
  scan.checks = checks(raw.checks, 'scan.checks');
  if (raw.tapTargets !== undefined) {
    checkKeys(raw.tapTargets, ['standard'], 'scan.tapTargets', problems);
    const t = isRecord(raw.tapTargets) ? raw.tapTargets.standard : undefined;
    if (t !== 'wcag22-aa' && t !== 'wcag22-aaa') problems.push('"scan.tapTargets.standard" must be "wcag22-aa" (24 px with the spacing exception) or "wcag22-aaa" (44 px)');
    else scan.tapTargets = { standard: t };
  }
  scan.noWrap = matchers(raw.noWrap, 'scan.noWrap');
  if (raw.wrapNearbyRatio !== undefined) {
    if (typeof raw.wrapNearbyRatio !== 'number' || raw.wrapNearbyRatio <= 1 || raw.wrapNearbyRatio > 3) problems.push('"scan.wrapNearbyRatio" must be a number above 1 and at most 3');
    else scan.wrapNearbyRatio = raw.wrapNearbyRatio;
  }
  if (raw.layoutShiftMin !== undefined) {
    if (typeof raw.layoutShiftMin !== 'number' || raw.layoutShiftMin <= 0 || raw.layoutShiftMin > 1) problems.push('"scan.layoutShiftMin" must be a number above 0 and at most 1');
    else scan.layoutShiftMin = raw.layoutShiftMin;
  }

  if (raw.explore !== undefined) {
    if (!isRecord(raw.explore)) problems.push('"scan.explore" must be an object');
    else {
      const e = raw.explore;
      checkKeys(e, EXPLORE_KEYS, 'scan.explore', problems);
      const lim = (k: 'maxDepth' | 'maxStates' | 'maxActionsPerState' | 'maxMs', max: number) => {
        if (e[k] === undefined) return;
        if (typeof e[k] !== 'number' || !Number.isInteger(e[k]) || (e[k] as number) < 1 || (e[k] as number) > max) problems.push(`"scan.explore.${k}" must be a whole number from 1 to ${max}`);
        else scan.explore[k] = e[k] as number;
      };
      if (e.enabled !== undefined && typeof e.enabled !== 'boolean') problems.push('"scan.explore.enabled" must be true or false');
      scan.explore.enabled = e.enabled === true;
      lim('maxDepth', 4); lim('maxStates', 100); lim('maxActionsPerState', 50); lim('maxMs', 3_600_000);
      scan.explore.allow = matchers(e.allow, 'scan.explore.allow');
      scan.explore.deny = matchers(e.deny, 'scan.explore.deny');
    }
  }

  if (raw.scenarios !== undefined) {
    if (!Array.isArray(raw.scenarios)) problems.push('"scan.scenarios" must be a list');
    else {
      const names = new Set<string>();
      raw.scenarios.forEach((sc, i) => {
        const at = `scan.scenarios[${i}]`;
        if (!isRecord(sc)) { problems.push(`"${at}" must be an object`); return; }
        checkKeys(sc, SCENARIO_KEYS, at, problems);
        if (typeof sc.name !== 'string' || !sc.name.trim()) problems.push(`"${at}.name" must be a non-empty string`);
        else if (names.has(sc.name)) problems.push(`scenario name "${sc.name}" is used twice`);
        else names.add(sc.name);
        if (typeof sc.route !== 'string' || !sc.route.startsWith('/')) problems.push(`"${at}.route" must start with "/"`);
        const auth = sc.auth ?? 'session';
        if (!['session', 'saved', 'fresh'].includes(auth as string)) problems.push(`"${at}.auth" must be "session", "saved" or "fresh"`);
        if (sc.explore !== undefined && typeof sc.explore !== 'boolean') problems.push(`"${at}.explore" must be true or false`);
        const scenario: ScanScenario = {
          name: String(sc.name ?? ''), route: String(sc.route ?? '/'), auth: auth as ScanScenario['auth'],
          ...(sc.devices !== undefined ? { devices: devices(sc.devices, `${at}.devices`) } : {}),
          steps: steps(sc.steps, `${at}.steps`), cleanup: steps(sc.cleanup, `${at}.cleanup`),
          ...(sc.checks !== undefined ? { checks: checks(sc.checks, `${at}.checks`) } : {}),
          ...(typeof sc.explore === 'boolean' ? { explore: sc.explore } : {}),
        };
        scan.scenarios.push(scenario);
      });
    }
  }

  if (raw.suppressions !== undefined) {
    if (!Array.isArray(raw.suppressions)) problems.push('"scan.suppressions" must be a list');
    else raw.suppressions.forEach((su, i) => {
      const at = `scan.suppressions[${i}]`;
      if (!isRecord(su)) { problems.push(`"${at}" must be an object`); return; }
      checkKeys(su, SUPPRESSION_KEYS, at, problems);
      checkKeys(su.target, ['role', 'name'], `${at}.target`, problems);
      if (typeof su.reason !== 'string' || !su.reason.trim()) problems.push(`"${at}.reason" must say why the finding is accepted`);
      if (su.kind === undefined && su.fingerprint === undefined) problems.push(`"${at}" needs "kind" or "fingerprint" (a suppression may not match every finding)`);
      const ks = su.kind === undefined ? [] : Array.isArray(su.kind) ? su.kind : [su.kind];
      if (!ks.every((k) => typeof k === 'string' && kinds.includes(k))) problems.push(`"${at}.kind" must be a check name or a list of them`);
      if (su.expires !== undefined && (typeof su.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(su.expires))) problems.push(`"${at}.expires" must be a date, YYYY-MM-DD`);
      for (const k of ['fingerprint', 'route', 'scenario', 'device'] as const) if (su[k] !== undefined && typeof su[k] !== 'string') problems.push(`"${at}.${k}" must be a string`);
      if (su.target !== undefined && !(isRecord(su.target) && ['role', 'name'].every((k) => (su.target as Record<string, unknown>)[k] === undefined || typeof (su.target as Record<string, unknown>)[k] === 'string'))) problems.push(`"${at}.target" must be {"role", "name"}`);
      scan.suppressions.push(su as unknown as Suppression);
    });
  }

  if (raw.policy !== undefined) {
    if (!isRecord(raw.policy)) problems.push('"scan.policy" must be an object');
    else {
      const p = raw.policy;
      checkKeys(p, POLICY_KEYS, 'scan.policy', problems);
      if (p.failOn !== undefined && !SEVERITIES.includes(p.failOn as string)) problems.push(`"scan.policy.failOn" must be one of ${SEVERITIES.join(', ')}`);
      else if (p.failOn !== undefined) scan.policy.failOn = p.failOn as ScanConfig['policy']['failOn'];
      for (const k of ['failOnErrors', 'failOnHeuristic'] as const) {
        if (p[k] !== undefined && typeof p[k] !== 'boolean') problems.push(`"scan.policy.${k}" must be true or false`);
        else if (p[k] !== undefined) scan.policy[k] = p[k] as boolean;
      }
    }
  }
  return scan;
}

/** The `ci` section: what `agentlab test` runs and how it decides. Strict like the others. */
function parseCi(raw: unknown, problems: string[]): CiConfig {
  const ci: CiConfig = {};
  if (raw === undefined) return ci;
  if (!isRecord(raw)) { problems.push('"ci" must be an object'); return ci; }
  checkKeys(raw, CI_KEYS, 'ci', problems);
  const list = (k: 'flows' | 'routes' | 'devices'): void => {
    const v = raw[k];
    if (v === undefined) return;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x)) problems.push(`"ci.${k}" must be a list of non-empty strings`);
    else if (k === 'routes' && !v.every((x) => (x as string).startsWith('/'))) problems.push('"ci.routes" entries must start with "/"');
    else ci[k] = v as string[];
  };
  list('flows'); list('routes'); list('devices');
  if (raw.scenarios !== undefined) {
    if (raw.scenarios === 'all') ci.scenarios = 'all';
    else if (Array.isArray(raw.scenarios) && raw.scenarios.every((x) => typeof x === 'string' && x)) ci.scenarios = raw.scenarios as string[];
    else problems.push('"ci.scenarios" must be a list of scenario names or "all"');
  }
  const oneOf = <K extends 'failOn' | 'scenarioErrors' | 'trace' | 'evidence' | 'auth'>(k: K, allowed: readonly string[]): void => {
    const v = raw[k];
    if (v === undefined) return;
    if (typeof v !== 'string' || !allowed.includes(v)) problems.push(`"ci.${k}" must be one of ${allowed.join(', ')}`);
    else (ci as Record<string, unknown>)[k] = v;
  };
  oneOf('failOn', SEVERITIES); oneOf('scenarioErrors', ['fail', 'report']);
  oneOf('trace', ['off', 'on-failure', 'always']); oneOf('evidence', ['off', 'on-failure', 'always']); oneOf('auth', ['fresh', 'saved', 'env']);
  if (raw.failOnHeuristic !== undefined) {
    if (typeof raw.failOnHeuristic !== 'boolean') problems.push('"ci.failOnHeuristic" must be true or false');
    else ci.failOnHeuristic = raw.failOnHeuristic;
  }
  if (raw.out !== undefined) {
    if (typeof raw.out !== 'string' || !raw.out.trim()) problems.push('"ci.out" must be a non-empty path');
    else ci.out = raw.out;
  }
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== 'number' || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs < 1000) problems.push('"ci.timeoutMs" must be a number of milliseconds, at least 1000');
    else ci.timeoutMs = raw.timeoutMs;
  }
  return ci;
}

/** Default policy: only localhost and private development hosts, unless explicitly opted in. */
export function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number) as [number, number];
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  if (isIP(host) === 6) return /^f[cd]/.test(host) || host.startsWith('fe80');
  return false;
}

export function assertUrlAllowed(url: string, allowExternal: boolean): void {
  const { protocol, hostname } = new URL(url);
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new LabError('url_not_allowed', `Only http(s) URLs are supported, got ${protocol}`);
  }
  if (!allowExternal && !isLocalOrPrivateHost(hostname)) {
    throw new LabError('url_not_allowed', `${hostname} is not a local or private development host`, {
      hint: 'Set "allowExternalUrl": true in agentlab.json to opt in explicitly.',
    });
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export { SCHEMA_VERSION };
