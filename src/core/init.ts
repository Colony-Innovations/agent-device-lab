import { appendFile, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { LabError } from './schema.js';
import { PROFILE_FILE, parseProfile } from './profile.js';

/** One thing `agentlab init` found. `path` is relative to the project directory. */
export interface Detection { kind: string; path: string; detail: string }

export interface InitProposal {
  /** Absolute project directory. */
  dir: string;
  /** The agentlab.json object (schemaVersion 2) to write. */
  profile: Record<string, unknown>;
  /** Everything found, in the order examined. */
  detections: Detection[];
  /** Things the person must review or edit. */
  warnings: string[];
  /** Whether .gitignore ignores `.agentlab/`. */
  gitignore: { file: string; exists: boolean; ignoresState: boolean };
  /** agentlab.json is already present. */
  existing: boolean;
}

type Category = 'web' | 'api' | 'worker' | 'other';
type Json = Record<string, unknown>;

interface Framework { dep: string; bins: readonly string[]; port: number; timeoutMs?: number }

/** Dev servers by dependency and the command word that runs them. More specific first (several use vite). */
const FRAMEWORKS: readonly Framework[] = [
  { dep: '@sveltejs/kit', bins: [], port: 5173 },
  { dep: 'next', bins: ['next'], port: 3000, timeoutMs: 120_000 },
  { dep: 'nuxt', bins: ['nuxt', 'nuxi'], port: 3000, timeoutMs: 120_000 },
  { dep: 'astro', bins: ['astro'], port: 4321 },
  { dep: 'gatsby', bins: ['gatsby'], port: 8000 },
  { dep: '@angular/cli', bins: ['ng'], port: 4200 },
  { dep: 'react-scripts', bins: ['react-scripts'], port: 3000 },
  { dep: '@vue/cli-service', bins: ['vue-cli-service'], port: 8080 },
  { dep: 'parcel', bins: ['parcel'], port: 1234 },
  { dep: 'webpack-dev-server', bins: ['webpack-dev-server'], port: 8080 },
  { dep: 'vite', bins: ['vite'], port: 5173 },
];
const API_DEPS = ['express', 'fastify', 'koa', 'hono', '@nestjs/core', '@hapi/hapi'];
const NAMES: Record<Exclude<Category, 'other'>, readonly string[]> = {
  web: ['web', 'frontend', 'client', 'app', 'ui', 'site'],
  api: ['api', 'server', 'backend'],
  worker: ['worker', 'jobs', 'queue'],
};
const LOCKFILES: readonly [string, string][] = [
  ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'],
];
const RUN_SCRIPTS = ['dev', 'serve', 'start', 'preview'];
const SERVICE_DIRS = ['web', 'frontend', 'client', 'app', 'ui', 'site', 'api', 'server', 'backend', 'worker', 'jobs'];
const GROUP_DIRS = ['apps', 'packages', 'services'];
const ROOT_SCRIPT_NAMES = ['api', 'server', 'backend', 'web', 'frontend', 'client', 'worker', 'jobs'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build']);
const ENV_EXAMPLES = ['.env.example', '.env.sample', '.env.template'];
const PLAYWRIGHT_CONFIGS = ['ts', 'js', 'mjs', 'cjs'].map((e) => `playwright.config.${e}`);
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
/** Published ports that are databases, caches or brokers rather than a browsable app. */
const NON_HTTP_PORTS = new Set([5432, 3306, 6379, 27017, 9200, 5672, 11211]);
const MAX_ENTRY_BYTES = 200 * 1024;
const GITIGNORE_BLOCK = '\n# Agent Device Lab: local runs, logs and saved sign-in state\n.agentlab/\n';
const IGNORE_LINES = new Set(['.agentlab', '.agentlab/', '/.agentlab', '/.agentlab/']);
const ORDER = ['compose', 'api', 'worker', 'web'];

interface Pkg { rel: string; json: Json; scripts: Record<string, string>; deps: Set<string> }

interface Draft {
  base: string;
  category: Category;
  command: string;
  cwd: string;
  scriptText: string;
  pkg: Pkg;
  requiredEnv: string[];
  port?: number;
  /** Set from the Playwright config; wins over the port. */
  url?: string;
  framework?: Framework;
  /** A health route found in the server code, used for readiness. */
  health?: string;
}

/**
 * Inspect a project directory read-only and propose an agentlab.json. Never runs project commands,
 * never writes, and never opens `.env`: only example env files, and only their names.
 */
export async function proposeProfile(dir: string): Promise<InitProposal> {
  const root = resolve(dir);
  const detections: Detection[] = [];
  const warnings: string[] = [];
  const found = (kind: string, path: string, detail: string) => detections.push({ kind, path: path || '.', detail });

  const existing = await isFile(join(root, PROFILE_FILE));
  if (existing) {
    found('existing-profile', PROFILE_FILE, 'already present');
    warnings.push(`${PROFILE_FILE} already exists; writing this proposal replaces it only when forced.`);
  }

  // Packages: the root, then workspaces, then conventional service directories.
  const rootPkg = await readPackage(root, '', found, warnings);
  const subPkgs: Pkg[] = [];
  const seen = new Set<string>(['']);
  for (const rel of await candidateDirs(root, rootPkg)) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const pkg = await readPackage(root, rel, found, warnings);
    if (pkg) subPkgs.push(pkg);
  }

  const envCache = new Map<string, string[]>();
  const env = async (rel: string) => {
    if (!envCache.has(rel)) envCache.set(rel, await readEnvNames(root, rel, found));
    return envCache.get(rel)!;
  };

  const drafts: Draft[] = [];
  const pm = async (rel: string) => packageManager(root, rel, found);
  for (const pkg of subPkgs) {
    const script = RUN_SCRIPTS.find((s) => pkg.scripts[s]);
    if (!script) continue;
    const text = pkg.scripts[script]!;
    found('package-script', join(pkg.rel, 'package.json'), `scripts.${script} = ${JSON.stringify(text)}`);
    const category = classify(basename(pkg.rel), pkg.deps);
    drafts.push({
      base: category === 'other' ? serviceName(basename(pkg.rel)) : category, category,
      command: `${await pm(pkg.rel)} run ${script}`, cwd: pkg.rel, scriptText: text, pkg,
      requiredEnv: unique([...await env(pkg.rel), ...await env('')]),
    });
  }

  if (rootPkg) {
    // Root scripts named after a service (api, dev:web, start:worker, ...).
    const fromSubs = new Set(drafts.map((d) => d.base));
    const rootDrafts: Draft[] = [];
    for (const n of ROOT_SCRIPT_NAMES) {
      const script = [`dev:${n}`, n, `start:${n}`].find((s) => rootPkg.scripts[s]);
      if (!script) continue;
      const text = rootPkg.scripts[script]!;
      const category = classify(n, new Set());
      if (fromSubs.has(category)) {
        found('root-script', 'package.json', `scripts.${script} skipped: the ${category} package already provides it`);
        continue;
      }
      found('root-script', 'package.json', `scripts.${script} = ${JSON.stringify(text)}`);
      rootDrafts.push({ base: category, category, command: `${await pm('')} run ${script}`, cwd: '', scriptText: text, pkg: rootPkg, requiredEnv: await env('') });
    }
    // The root's own dev script, unless it only orchestrates services found above.
    const script = RUN_SCRIPTS.find((s) => rootPkg.scripts[s]);
    if (script) {
      const text = rootPkg.scripts[script]!;
      const orchestrates = drafts.length > 0 || rootDrafts.some((d) => d.category === 'web');
      found('package-script', 'package.json', `scripts.${script} = ${JSON.stringify(text)}${orchestrates ? ' (not a service: it runs the packages above)' : ''}`);
      if (!orchestrates) {
        const byDeps = classify('', rootPkg.deps);
        const category = byDeps === 'other' ? 'web' : byDeps;
        rootDrafts.unshift({ base: category, category, command: `${await pm('')} run ${script}`, cwd: '', scriptText: text, pkg: rootPkg, requiredEnv: await env('') });
      }
    }
    drafts.push(...rootDrafts);
  } else {
    await env('');
  }

  // Ports and frameworks.
  for (const d of drafts) {
    if (d.category === 'worker') continue;
    d.framework = frameworkFor(d.scriptText, d.pkg.deps, d.category);
    const at = join(d.cwd, 'package.json');
    const explicit = scriptPort(d.scriptText);
    if (explicit) { d.port = explicit; found('port', at, `${explicit} from the script text`); continue; }
    const entry = await entryPort(root, d.cwd, d.scriptText);
    if (entry) {
      d.port = entry.port;
      found('port', entry.path, `${entry.port} from the entry file`);
      if (entry.health) { d.health = entry.health; found('readiness', entry.path, `route ${entry.health} in the entry file`); }
      continue;
    }
    const envPort = await exampleEnvPort(root, d.cwd);
    if (envPort) { d.port = envPort.port; found('port', envPort.path, `${envPort.port} from PORT in the example env file`); continue; }
    if (d.framework) {
      d.port = /\bvite\s+preview\b/.test(d.scriptText) ? 4173 : d.framework.port;
      found('framework', at, `${d.framework.dep} (default port ${d.port})`);
    }
  }

  // Names: clashes get a numeric suffix.
  const services: Record<string, Json> = {};
  const named: { name: string; d: Draft }[] = [];
  for (const d of drafts) {
    let name = d.base;
    for (let i = 2; named.some((n) => n.name === name) || name === 'compose'; i++) name = `${d.base}-${i}`;
    named.push({ name, d });
  }

  // Playwright config: its webServer is the most reliable way the project already starts the app.
  const pw = await readPlaywright(root, found);
  const web = named.find((n) => n.name === 'web');
  if (pw && web) {
    const origin = originOf(pw.webServerUrl) ?? originOf(pw.baseURL);
    if (pw.webServerCommand) { web.d.command = pw.webServerCommand; web.d.cwd = pw.cwd; }
    if (origin) web.d.url = origin;
  }

  const compose = await readCompose(root, found);
  for (const { name, d } of named) {
    const svc: Json = { command: d.command };
    if (d.cwd && d.cwd !== '.') svc.cwd = d.cwd.split(sep).join('/');
    const url = d.category === 'worker' ? undefined : d.url ?? (d.port ? `http://localhost:${d.port}` : undefined);
    if (url) {
      svc.url = url;
      svc.readiness = { path: d.health ?? '/', timeoutMs: d.framework?.timeoutMs ?? 60_000 };
    } else if (d.category === 'worker') {
      svc.readiness = { alive: 2000 };
      warnings.push(`services.${name}: readiness only checks that it is still running after 2 s; if it prints a line when ready, use {"log": "<that line>"} instead.`);
    } else {
      svc.readiness = { alive: 2000 };
      warnings.push(`services.${name}: no port found; set its "url" (or a {"tcp": "host:port"} / {"log": "..."} readiness) so the lab knows when it is ready.`);
    }
    if (d.requiredEnv.length) svc.requiredEnv = d.requiredEnv;
    services[name] = svc;
  }

  if (compose) {
    const first = compose.ports[0];
    services.compose = {
      command: 'docker compose up -d', mode: 'oneshot',
      readiness: first ? { tcp: `127.0.0.1:${first}`, timeoutMs: 120_000 } : { timeoutMs: 120_000 },
      shutdown: { command: 'docker compose stop' },
    };
    if (!first) warnings.push(`services.compose: ${compose.file} publishes no ports, so readiness only waits for \`docker compose up -d\` to exit; add a {"tcp": "127.0.0.1:<port>"} check if a service must be reachable.`);
  }

  // Dependencies: compose first, then api.
  for (const [name, svc] of Object.entries(services)) {
    if (name === 'compose') continue;
    const deps: string[] = [];
    if (services.compose) deps.push('compose');
    const category = named.find((n) => n.name === name)?.d.category;
    if (services.api && name !== 'api' && (category === 'web' || category === 'worker')) deps.push('api');
    if (deps.length) svc.dependsOn = deps;
  }

  // A Django project (manage.py at the root) when nothing in the Node ecosystem was found. Its python
  // is a virtualenv next to it when there is one; readiness is a TCP check because many Django projects
  // answer 404 at "/" (an admin-only site, for example).
  if (!Object.keys(services).length && await isFile(join(root, 'manage.py'))) {
    const python = await virtualenvPython(root);
    found('django', 'manage.py', python ? `python from ${python.split('/').slice(0, -2).join('/')}` : 'no virtualenv found next to it');
    services.web = {
      command: `${python ?? 'python3'} manage.py runserver 127.0.0.1:8000 --noreload`,
      url: 'http://127.0.0.1:8000',
      readiness: { tcp: '127.0.0.1:8000', timeoutMs: 60_000 },
    };
    if (!python) warnings.push('services.web: no virtualenv was found next to manage.py, so the command uses python3; point it at the project\'s environment if Django is installed there.');
    warnings.push('services.web: Django was detected; set "startPath" to a page that exists (e.g. /admin/), and run migrations first (agentlab does not run project commands during init).');
  }

  const placeholder = Object.keys(services).length === 0;
  if (placeholder) {
    services.web = { command: 'npm run dev', url: 'http://localhost:3000', readiness: { path: '/', timeoutMs: 60_000 } };
    warnings.unshift('NOTHING RUNNABLE WAS FOUND: services.web is a placeholder. Replace its "command" and "url" with how this project really starts.');
  }

  const ordered: Record<string, Json> = {};
  const rank = (n: string) => (ORDER.includes(n) ? ORDER.indexOf(n) : ORDER.length);
  for (const n of Object.keys(services).sort((a, b) => rank(a) - rank(b))) ordered[n] = services[n]!;

  const profile: Json = {
    schemaVersion: 2,
    name: typeof rootPkg?.json.name === 'string' && rootPkg.json.name ? rootPkg.json.name : basename(root),
    services: ordered,
  };
  if (ordered.web?.url) profile.app = { service: 'web' };
  else if (compose?.httpPort) profile.app = { url: `http://localhost:${compose.httpPort}` };
  profile.startPath = '/';
  profile.device = 'mobile-390';

  const envNames = unique(Object.values(ordered).flatMap((s) => (s.requiredEnv as string[] | undefined) ?? []));
  if (envNames.length) warnings.push(`Export ${envNames.join(', ')} in your shell before \`agentlab start\`; the lab checks they are set and never reads .env files.`);

  try {
    parseProfile(profile, join(root, PROFILE_FILE));
  } catch (err) {
    const problems = (err as LabError).details?.problems;
    if (Array.isArray(problems)) for (const p of problems) warnings.push(`Profile check: ${String(p)}`);
    else warnings.push(`Profile check: ${(err as Error).message}`);
  }

  const gitignoreFile = join(root, '.gitignore');
  const gitignoreText = await readFile(gitignoreFile, 'utf8').catch(() => undefined);
  const ignoresState = gitignoreText !== undefined && ignores(gitignoreText);
  found('gitignore', '.gitignore', gitignoreText === undefined ? 'absent' : ignoresState ? 'ignores .agentlab/' : 'does not ignore .agentlab/');

  return { dir: root, profile, detections, warnings, gitignore: { file: gitignoreFile, exists: gitignoreText !== undefined, ignoresState }, existing };
}

/** Write agentlab.json and make sure .gitignore ignores `.agentlab/`. Idempotent for .gitignore. */
export async function writeProposal(p: InitProposal, opts: { force?: boolean } = {}): Promise<{ profilePath: string; gitignoreUpdated: boolean }> {
  const profilePath = join(p.dir, PROFILE_FILE);
  if (!opts.force && await isFile(profilePath)) {
    throw new LabError('invalid_request', `${profilePath} already exists`, { hint: 'Review the proposal, then force the write to replace it.' });
  }
  await writeFile(profilePath, JSON.stringify(p.profile, null, 2) + '\n');

  const file = join(p.dir, '.gitignore');
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text !== undefined && ignores(text)) return { profilePath, gitignoreUpdated: false };
  if (text === undefined) await writeFile(file, GITIGNORE_BLOCK.slice(1));
  else await appendFile(file, (text === '' || text.endsWith('\n') ? '' : '\n') + GITIGNORE_BLOCK);
  return { profilePath, gitignoreUpdated: true };
}

/** Human-readable proposal: what was found, the JSON, what to review, and what to do next. */
export function formatProposal(p: InitProposal): string {
  const lines = [`Proposed ${PROFILE_FILE} for ${p.dir}`, '', 'Found:'];
  for (const d of p.detections) lines.push(`  ${d.path}: ${d.detail}`);
  if (!p.detections.length) lines.push('  nothing');
  lines.push('', `${PROFILE_FILE}:`, JSON.stringify(p.profile, null, 2));
  if (p.warnings.length) {
    lines.push('', 'Review before starting:');
    for (const w of p.warnings) lines.push(`  - ${w}`);
  }
  lines.push('', 'Nothing has been written.');
  lines.push(p.existing
    ? `${PROFILE_FILE} already exists; saving this proposal replaces it only when forced.`
    : `Saving writes ${PROFILE_FILE}${p.gitignore.ignoresState ? '' : ' and adds .agentlab/ to .gitignore'}.`);
  lines.push('Next: edit the file if needed, then run `agentlab start`.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Detection helpers. Each reads a bounded set of files and never follows commands.

type Found = (kind: string, path: string, detail: string) => void;

async function readPackage(root: string, rel: string, found: Found, warnings: string[]): Promise<Pkg | undefined> {
  const path = join(rel, 'package.json');
  const text = await readFile(join(root, path), 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  let json: unknown;
  try { json = JSON.parse(text); } catch {
    warnings.push(`${path} is not valid JSON; it was skipped.`);
    return undefined;
  }
  if (!isRecord(json)) return undefined;
  const scripts: Record<string, string> = {};
  if (isRecord(json.scripts)) for (const [k, v] of Object.entries(json.scripts)) if (typeof v === 'string') scripts[k] = v;
  const deps = new Set<string>();
  for (const key of ['dependencies', 'devDependencies']) if (isRecord(json[key])) for (const d of Object.keys(json[key] as Json)) deps.add(d);
  found('package', path, typeof json.name === 'string' ? json.name : '(unnamed)');
  return { rel, json, scripts, deps };
}

/** Sub-package directories (depth ≤ 2): workspaces globs, conventional names, apps/*, packages/*, services/*. */
async function candidateDirs(root: string, rootPkg: Pkg | undefined): Promise<string[]> {
  const out: string[] = [];
  const ws = rootPkg?.json.workspaces;
  const patterns = Array.isArray(ws) ? ws : isRecord(ws) && Array.isArray(ws.packages) ? ws.packages : [];
  for (const pat of patterns) {
    if (typeof pat !== 'string') continue;
    const clean = pat.replace(/^\.\//, '').replace(/\/+$/, '');
    const parts = clean.split('/');
    if (parts.length === 2 && parts[1] === '*' && usable(parts[0]!)) out.push(...(await subdirs(root, parts[0]!)).map((d) => `${parts[0]}/${d}`));
    else if (parts.length <= 2 && parts.every(usable)) out.push(clean);
  }
  const top = await subdirs(root, '');
  for (const name of SERVICE_DIRS) if (top.includes(name)) out.push(name);
  for (const group of GROUP_DIRS) if (top.includes(group)) out.push(...(await subdirs(root, group)).map((d) => `${group}/${d}`));
  return out.map((r) => r.split('/').join(sep));
}

function usable(name: string): boolean {
  return !!name && !name.startsWith('.') && !SKIP_DIRS.has(name) && !/[*?{[]/.test(name);
}

async function subdirs(root: string, rel: string): Promise<string[]> {
  const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && usable(e.name)).map((e) => e.name).sort();
}

async function packageManager(root: string, rel: string, found: Found): Promise<string> {
  for (const dir of rel ? [rel, ''] : ['']) {
    for (const [file, pm] of LOCKFILES) {
      if (await isFile(join(root, dir, file))) {
        found('lockfile', join(dir, file), pm);
        return pm;
      }
    }
  }
  return 'npm';
}

function classify(name: string, deps: ReadonlySet<string>): Category {
  const n = name.toLowerCase();
  for (const c of ['web', 'api', 'worker'] as const) if (NAMES[c].includes(n)) return c;
  if (FRAMEWORKS.some((f) => deps.has(f.dep))) return 'web';
  if (API_DEPS.some((d) => deps.has(d))) return 'api';
  return 'other';
}

function serviceName(dirName: string): string {
  const s = dirName.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^[-_]+/, '');
  return s || 'service';
}

/** The framework the script runs: its command words first, then (for a web service) the dependencies. */
function frameworkFor(script: string, deps: ReadonlySet<string>, category: Category): Framework | undefined {
  const words = script.split(/[\s;&|()]+/);
  const byBin = FRAMEWORKS.find((f) => f.bins.some((b) => words.includes(b)));
  if (byBin) return byBin;
  return category === 'web' ? FRAMEWORKS.find((f) => deps.has(f.dep)) : undefined;
}

function scriptPort(script: string): number | undefined {
  for (const re of [/--port[=\s]+(\d{2,5})\b/, /(?:^|\s)-p[=\s]*(\d{2,5})\b/, /\bPORT=(\d{2,5})\b/]) {
    const m = re.exec(script);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** For `node <file>` scripts, read that one file (≤ 200 KB, inside the project) for its default port. */
async function entryPort(root: string, cwd: string, script: string): Promise<{ port: number; path: string; health?: string } | undefined> {
  const words = script.trim().split(/\s+/);
  if (words[0] !== 'node') return undefined;
  let file: string | undefined;
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (['-r', '--require', '--import', '--loader'].includes(w)) { i++; continue; }
    if (w.startsWith('-')) continue;
    file = w;
    break;
  }
  if (!file) return undefined;
  const abs = resolve(root, cwd, file);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || resolve(rel) === rel) return undefined;
  const info = await stat(abs).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_ENTRY_BYTES) return undefined;
  const text = await readFile(abs, 'utf8');
  const m = /process\.env\.PORT\s*(?:\?\?|\|\|)\s*['"]?(\d{2,5})\b/.exec(text) ?? /\.listen\(\s*(\d{2,5})\b/.exec(text);
  // A health route in the server code is a better readiness check than "/", which many APIs 404.
  const health = /['"`](\/(?:api\/)?(?:health|healthz|livez|readyz))['"`]/.exec(text)?.[1];
  return m ? { port: Number(m[1]), path: rel, ...(health ? { health } : {}) } : undefined;
}

async function firstEnvExample(root: string, rel: string): Promise<{ path: string; lines: { name: string; value: string }[] } | undefined> {
  for (const name of ENV_EXAMPLES) {
    const path = join(rel, name);
    const text = await readFile(join(root, path), 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    const lines: { name: string; value: string }[] = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let value = m[2]!.trim();
      if (!/^["']/.test(value)) value = value.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
      lines.push({ name: m[1]!, value });
    }
    return { path, lines };
  }
  return undefined;
}

/** Names with an empty example value are required. Values are never recorded. */
async function readEnvNames(root: string, rel: string, found: Found): Promise<string[]> {
  const env = await firstEnvExample(root, rel);
  if (!env) return [];
  const required: string[] = [];
  for (const { name, value } of env.lines) {
    if (value === '' || value === '""' || value === "''") {
      required.push(name);
      found('env-name', env.path, `${name} (empty in the example: required)`);
    } else {
      found('env-name', env.path, `${name} has example default`);
    }
  }
  return unique(required);
}

async function exampleEnvPort(root: string, rel: string): Promise<{ port: number; path: string } | undefined> {
  const env = await firstEnvExample(root, rel);
  const line = env?.lines.find((l) => l.name === 'PORT' && /^["']?\d{2,5}["']?$/.test(l.value));
  return env && line ? { port: Number(line.value.replace(/["']/g, '')), path: env.path } : undefined;
}

interface PlaywrightInfo { cwd: string; baseURL?: string; webServerCommand?: string; webServerUrl?: string }

async function readPlaywright(root: string, found: Found): Promise<PlaywrightInfo | undefined> {
  for (const file of PLAYWRIGHT_CONFIGS) {
    const text = await readFile(join(root, file), 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    const str = (re: RegExp, from: string) => re.exec(from)?.[1];
    const info: PlaywrightInfo = { cwd: dirname(file) === '.' ? '' : dirname(file) };
    info.baseURL = str(/baseURL\s*:\s*['"`]([^'"`]+)['"`]/, text);
    const ws = /webServer\s*:\s*[{[]/.exec(text);
    if (ws) {
      const block = text.slice(ws.index, ws.index + 2000);
      info.webServerCommand = str(/command\s*:\s*['"`]([^'"`]+)['"`]/, block);
      info.webServerUrl = str(/\burl\s*:\s*['"`]([^'"`]+)['"`]/, block);
    }
    const parts = [
      info.baseURL && `baseURL ${info.baseURL}`,
      info.webServerCommand && `webServer.command ${JSON.stringify(info.webServerCommand)}`,
      info.webServerUrl && `webServer.url ${info.webServerUrl}`,
    ].filter(Boolean);
    found('playwright-config', file, parts.length ? parts.join(', ') : 'no baseURL or webServer found');
    return info;
  }
  return undefined;
}

interface ComposeInfo { file: string; ports: number[]; httpPort?: number }

/** Line-based scan of top-level `services:` names and their published ports. No YAML parser. */
async function readCompose(root: string, found: Found): Promise<ComposeInfo | undefined> {
  for (const file of COMPOSE_FILES) {
    const text = await readFile(join(root, file), 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    const services: { name: string; ports: number[] }[] = [];
    let inServices = false;
    let serviceIndent = -1;
    let inPorts = false;
    let portsIndent = -1;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\s+#.*$/, '');
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      const body = line.trim();
      if (indent === 0) { inServices = body === 'services:'; serviceIndent = -1; inPorts = false; continue; }
      if (!inServices) continue;
      if (serviceIndent < 0) serviceIndent = indent;
      if (indent === serviceIndent) {
        const m = /^["']?([A-Za-z0-9._-]+)["']?:\s*$/.exec(body);
        if (m) services.push({ name: m[1]!, ports: [] });
        inPorts = false;
        continue;
      }
      const current = services.at(-1);
      if (!current) continue;
      if (/^ports:\s*$/.test(body)) { inPorts = true; portsIndent = indent; continue; }
      if (inPorts && indent <= portsIndent && !body.startsWith('-')) inPorts = false;
      if (!inPorts) continue;
      const published = /^(?:-\s*)?published:\s*["']?(\d+)/.exec(body);
      if (published) { current.ports.push(Number(published[1])); continue; }
      const short = /^-\s*["']?([^"'\s]+)["']?\s*$/.exec(body);
      if (short && !short[1]!.includes(': ') && !/^[a-z_]+:/.test(short[1]!)) {
        const parts = short[1]!.replace(/\/(tcp|udp)$/, '').split(':');
        const host = parts.length === 3 ? parts[1] : parts.length === 2 ? parts[0] : undefined;
        const port = host ? Number(/^\d+/.exec(host)?.[0]) : NaN;
        if (port > 0 && port < 65536) current.ports.push(port);
      }
    }
    for (const s of services) found('compose-service', file, `${s.name}${s.ports.length ? ` publishes ${s.ports.join(', ')}` : ' publishes no ports'}`);
    const ports = services.flatMap((s) => s.ports);
    return { file, ports, httpPort: ports.find((p) => !NON_HTTP_PORTS.has(p)) };
  }
  return undefined;
}

function originOf(url: string | undefined): string | undefined {
  if (!url || !URL.canParse(url)) return undefined;
  return new URL(url).origin;
}

function ignores(gitignore: string): boolean {
  return gitignore.split(/\r?\n/).some((l) => IGNORE_LINES.has(l.trim()));
}

/** `<dir>/bin/python` of a virtualenv directly inside the project (a directory with pyvenv.cfg), as a relative path. */
async function virtualenvPython(root: string): Promise<string | undefined> {
  const names = ['.venv', 'venv', 'env', ...(await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name)).map((e) => e.name)];
  for (const name of unique(names)) {
    if (await isFile(join(root, name, 'pyvenv.cfg')) && await isFile(join(root, name, 'bin', 'python'))) return `${name}/bin/python`;
  }
  return undefined;
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isFile() ?? false;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
