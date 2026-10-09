import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { authStatus, gitIgnores } from './auth.js';
import { PROFILE_FILE, loadProfile } from './profile.js';
import { probeReadiness, probeTcp } from './project-runner.js';
import { missingEnv } from './services.js';
import { LabError, type ProjectProfile } from './schema.js';

// `agentlab doctor`: read-only checks of the machine and the project. It never creates directories,
// starts services or prints environment values.

export interface Check { name: string; status: 'ok' | 'warn' | 'fail'; detail: string; hint?: string }
export interface DoctorReport { ok: boolean; checks: Check[]; profile?: string }

export interface DoctorOptions {
  cwd: string;
  /** Project directory or agentlab.json; default: cwd when it holds agentlab.json. */
  project?: string;
  /** Where this directory's runs and daemon record go (see stateDir). */
  stateDir: string;
  /** Launch Chromium headless once to prove it starts (default true). */
  launch?: boolean;
  /** For the daemon-record check: undefined when there is no record. */
  daemon?: { pid: number; check: 'same' | 'gone' | 'reused' | 'unverifiable' };
}

export const MIN_NODE_MAJOR = 22;

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (...c: Check[]) => checks.push(...c);

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= MIN_NODE_MAJOR
    ? { name: 'node', status: 'ok', detail: `Node.js ${process.versions.node} (needs ${MIN_NODE_MAJOR} or newer)` }
    : { name: 'node', status: 'fail', detail: `Node.js ${process.versions.node} is too old`, hint: `Install Node.js ${MIN_NODE_MAJOR} or newer.` });

  add(...await browserChecks(opts.launch !== false));

  const display = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
  add(display
    ? { name: 'display', status: 'ok', detail: `headed browser available (${process.env.WAYLAND_DISPLAY ? `WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY}` : `DISPLAY=${process.env.DISPLAY}`})` }
    : { name: 'display', status: 'warn', detail: 'no DISPLAY or WAYLAND_DISPLAY: headless only',
      hint: onPath('xvfb-run') ? 'Use --headless, or run headed under xvfb-run.' : 'Use --headless (xvfb-run is not installed).' });

  add(writable('state directory', opts.stateDir));
  add(writable('temp directory', tmpdir()));
  if (opts.daemon) {
    add(opts.daemon.check === 'same'
      ? { name: 'session', status: 'warn', detail: `a session daemon (pid ${opts.daemon.pid}) is already running for this directory`, hint: 'Use it, or `agentlab stop` first.' }
      : { name: 'session', status: 'warn', detail: `stale session record (pid ${opts.daemon.pid}: ${opts.daemon.check}); it is cleared on the next start or stop` });
  }

  const target = opts.project ?? (existsSync(join(opts.cwd, PROFILE_FILE)) ? opts.cwd : undefined);
  if (!target) {
    add({ name: 'project', status: 'warn', detail: `no ${PROFILE_FILE} in ${opts.cwd}`, hint: 'Run `agentlab init` in the project, or pass --project <dir>.' });
    return { ok: !checks.some((c) => c.status === 'fail'), checks };
  }
  let profile: ProjectProfile;
  try {
    profile = await loadProfile(target);
  } catch (err) {
    const e = LabError.from(err);
    add({ name: e.code === 'profile_too_new' ? 'profile version' : 'project', status: 'fail', detail: e.message, ...(e.hint ? { hint: e.hint } : {}) });
    return { ok: false, checks };
  }
  add({ name: 'project', status: 'ok', detail: `${profile.name}: ${profile.services.length} service(s), app ${profile.app.url}${profile.startPath} (${relative(opts.cwd, profile.profilePath) || profile.profilePath})` });
  if (profile.migration) add({ name: 'profile version', status: 'warn', detail: 'agentlab.json is schemaVersion 1', hint: 'Run `agentlab migrate` to rewrite it as schemaVersion 2.' });
  add(...await serviceChecks(profile));
  add(...projectFileChecks(profile));
  return { ok: !checks.some((c) => c.status === 'fail'), checks, profile: profile.profilePath };
}

/** True on Linux with musl libc (Alpine): Node's diagnostic report has no glibc runtime version there. */
export function isMusl(header: { glibcVersionRuntime?: string } | undefined = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header): boolean {
  return process.platform === 'linux' && !header?.glibcVersionRuntime;
}

async function browserChecks(launch: boolean): Promise<Check[]> {
  const require = createRequire(import.meta.url);
  let pwVersion = '?';
  try { pwVersion = (JSON.parse(readFileSync(require.resolve('playwright/package.json'), 'utf8')) as { version: string }).version; } catch { /* reported below */ }
  const { chromium } = await import('playwright');
  const exe = chromium.executablePath();
  // Playwright's Chromium is built for glibc. On musl it downloads fine and then fails to spawn with a bare ENOENT.
  if (isMusl()) {
    return [{ name: 'browser', status: 'fail', detail: `this Linux uses musl libc (Alpine): Playwright's Chromium ${pwVersion} is built for glibc and cannot start here`,
      hint: 'Use a Debian or Ubuntu based image or host (for Node.js: node:22-bookworm-slim). See docs/install.md.' }];
  }
  if (!existsSync(exe)) {
    return [{ name: 'browser', status: 'fail', detail: `Chromium for Playwright ${pwVersion} is not installed (${exe})`, hint: 'Run `agentlab install-browser`.' }];
  }
  if (!launch) return [{ name: 'browser', status: 'ok', detail: `Chromium for Playwright ${pwVersion} at ${exe} (launch not tested)` }];
  try {
    const browser = await chromium.launch({ headless: true, timeout: 30_000, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    const version = browser.version();
    await browser.close();
    return [{ name: 'browser', status: 'ok', detail: `Chromium ${version} (Playwright ${pwVersion}) launches headless` }];
  } catch (err) {
    const msg = (err as Error).message.split('\n').find((l) => l.trim()) ?? String(err);
    return [{ name: 'browser', status: 'fail', detail: `Chromium is installed but did not launch: ${msg.slice(0, 200)}`,
      hint: /shared librar|libnss|libatk|dependencies/i.test((err as Error).message)
        ? 'System libraries are missing: run `sudo npx playwright@' + pwVersion + ' install-deps chromium`.'
        : 'Run `agentlab install-browser` again, or check the error above.' }];
  }
}

async function serviceChecks(profile: ProjectProfile): Promise<Check[]> {
  const checks: Check[] = [];
  for (const m of missingEnv(profile.services)) {
    checks.push({ name: `env ${m.service}`, status: 'fail', detail: `not set: ${m.names.join(', ')}`, hint: 'Export them where agentlab runs (only names are checked, never values).' });
  }
  for (const s of profile.services) {
    const name = `service ${s.name}`;
    if (!existsSync(s.cwd) || !statSync(s.cwd).isDirectory()) {
      checks.push({ name, status: 'fail', detail: `working directory ${s.cwd} does not exist` });
      continue;
    }
    const exe = firstWord(s.command);
    if (exe && !exe.includes('/') && !onPath(exe) && !SHELL_WORDS.has(exe)) {
      checks.push({ name, status: 'fail', detail: `"${exe}" (from "${s.command}") is not on PATH`, hint: 'Install it, or fix the service command.' });
    }
    const secretLiterals = Object.keys(s.env).filter((k) => /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE)/i.test(k));
    if (secretLiterals.length) {
      checks.push({ name, status: 'warn', detail: `env gives literal values for ${secretLiterals.join(', ')} in agentlab.json`, hint: 'Move secrets to requiredEnv (names only) and export them instead.' });
    }
    if (!s.reuseExisting && (s.readiness.kind === 'log' || s.readiness.kind === 'alive')) {
      checks.push({ name, status: 'warn', detail: 'reuseExisting has no effect: a log/alive readiness cannot detect a running instance' });
    }
    const probe = probeReadiness(s.readiness, 1500);
    if (probe) {
      const r = await probe;
      const at = s.readiness.kind === 'http' ? `${s.readiness.url}${s.readiness.path}` : s.readiness.kind === 'tcp' ? `${s.readiness.host}:${s.readiness.port}` : '';
      if (r.kind === 'healthy') {
        checks.push(s.reuseExisting
          ? { name, status: 'ok', detail: `already running at ${at}: will be reused and left running` }
          : { name, status: 'fail', detail: `port conflict: something is already ready at ${at} and reuseExisting is false`, hint: 'Stop it, or set "reuseExisting": true.' });
      } else if (r.kind === 'unhealthy') {
        checks.push({ name, status: 'fail', detail: `port conflict: ${at} answers HTTP ${r.status}, not ${s.readiness.kind === 'http' ? s.readiness.status : 200}`, hint: 'Another process holds the port; the lab will not start a second one or stop it.' });
      } else {
        checks.push({ name, status: 'ok', detail: `${at} is free; "${s.command}" will be started` });
      }
    } else if (s.url) {
      const u = new URL(s.url);
      const r = await probeTcp(u.hostname, Number(u.port || (u.protocol === 'https:' ? 443 : 80)), 1000);
      checks.push(r.kind === 'healthy'
        ? { name, status: 'warn', detail: `${u.host} is already in use; with ${s.readiness.kind} readiness the lab cannot tell whether it is this service` }
        : { name, status: 'ok', detail: `${u.host} is free; "${s.command}" will be started` });
    } else {
      checks.push({ name, status: 'ok', detail: `"${s.command}" will be started (readiness: ${s.readiness.kind})` });
    }
  }
  return checks;
}

function projectFileChecks(profile: ProjectProfile): Check[] {
  const checks: Check[] = [];
  const auth = authStatus(profile.auth, profile.root);
  const rel = relative(profile.root, auth.file) || auth.file;
  if (!auth.exists) checks.push({ name: 'auth', status: 'ok', detail: `no saved sign-in state (${rel})` });
  else if (auth.ownerOnly === false) checks.push({ name: 'auth', status: 'fail', detail: `${rel} is mode ${auth.mode}, readable by others`, hint: `chmod 600 ${auth.file}` });
  else if (auth.problem) checks.push({ name: 'auth', status: 'warn', detail: `${rel}: ${auth.problem}; it will be removed on next use` });
  else if (auth.expired) checks.push({ name: 'auth', status: 'warn', detail: `${rel} has expired; it will be removed on next use` });
  else checks.push({ name: 'auth', status: 'ok', detail: `saved sign-in state ${rel} (${auth.cookies} cookies, owner-only)` });
  if (auth.ignored === false) checks.push({ name: 'auth', status: 'fail', detail: `git would track ${rel}`, hint: 'Run `agentlab init` or add .agentlab/ to .gitignore.' });

  const state = gitIgnores(profile.root, join(profile.root, '.agentlab', 'runs'));
  if (state === false) checks.push({ name: 'gitignore', status: 'warn', detail: '.agentlab/ (runs, logs, saved sign-in) is not ignored by git', hint: 'Add ".agentlab/" to .gitignore (agentlab init does this).' });

  for (const a of profile.uploads.allow) {
    if (!existsSync(a)) checks.push({ name: 'uploads', status: 'warn', detail: `uploads.allow entry ${relative(profile.root, a)} does not exist` });
  }
  return checks;
}

/** A directory can be written, or created because its nearest existing ancestor can be. Never creates it. */
function writable(name: string, dir: string): Check {
  let probe = dir;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  try {
    accessSync(probe, constants.W_OK);
    return { name, status: 'ok', detail: existsSync(dir) ? `${dir} is writable` : `${dir} will be created (under ${probe})` };
  } catch {
    return { name, status: 'fail', detail: `${probe} is not writable, so ${dir} cannot be used`, hint: 'Fix the permissions, or set AGENTLAB_HOME to a writable directory.' };
  }
}

const SHELL_WORDS = new Set(['cd', 'exec', 'env', 'export', 'true', 'false', 'test', '[', 'set', 'sh', 'bash']);

function firstWord(command: string): string | undefined {
  // Skip leading VAR=value assignments.
  return command.trim().split(/\s+/).find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
}

export function onPath(exe: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, exe), constants.X_OK);
      return true;
    } catch { /* keep looking */ }
  }
  return false;
}

export function formatDoctor(r: DoctorReport): string {
  const mark = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' } as const;
  const lines = r.checks.map((c) => `${mark[c.status]}  ${c.name}: ${c.detail}${c.hint ? `\n        → ${c.hint}` : ''}`);
  const fails = r.checks.filter((c) => c.status === 'fail').length;
  const warns = r.checks.filter((c) => c.status === 'warn').length;
  lines.push('', fails ? `${fails} problem(s) to fix${warns ? `, ${warns} warning(s)` : ''}` : `ready${warns ? ` (${warns} warning(s))` : ''}`);
  return lines.join('\n');
}
