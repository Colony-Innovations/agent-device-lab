// Proves the packed npm artifact works without the source repository: pack, install it three ways
// (global prefix, local project, npx), then drive copies of the fixtures with the INSTALLED CLI and
// MCP server only. Every step is recorded as {step, ok, ms, detail} and printed as it goes.
//   node scripts/verify-package.mjs [--keep] [--out verify-results/package]
// Runs in a temp dir; never writes to the repo except the results dir. Touches the project named by AGENTLAB_VERIFY_EXTERNAL_PROJECT (optional) only
// with the read-only `agentlab init --print`, and checks its git status is unchanged. Kills only the
// processes it started. Ports: 5356 (interaction copy), 5357/5358 (multi-service copy; the invoice copy reuses 5357 afterwards),
// 5359 (init copy), 5360 (responsive copy).
// Every lab command runs with its own HOME (<tmp>/home) and XDG_STATE_HOME, so anything the installed package writes outside a
// project shows up there and nowhere else; the browser cache is pointed at the real ~/.cache/ms-playwright.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { keep: { type: 'boolean', default: false }, out: { type: 'string', default: 'verify-results/package' } } });
const repo = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const tmp = mkdtempSync(join(tmpdir(), 'agentlab-pkg-'));
const outDir = resolve(repo, args.out);
mkdirSync(outDir, { recursive: true });

// prefer-offline: registry metadata from the local cache when present (installs are otherwise minutes on a slow link).
const npmEnv = { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false', npm_config_update_notifier: 'false', npm_config_prefer_offline: 'true' };
const NPM_TIMEOUT = 600_000;
const globalPrefix = join(tmp, 'global');
const cli = join(globalPrefix, 'bin', 'agentlab');
const pkgRoot = join(globalPrefix, 'lib', 'node_modules', pkg.name);
// Every lab command below runs the installed CLI with this environment, never the repo's bin/.
const labHome = join(tmp, 'home');
mkdirSync(labHome);
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
const labEnv = { ...process.env, HOME: labHome, PLAYWRIGHT_BROWSERS_PATH: browsersPath, PATH: `${join(globalPrefix, 'bin')}${delimiter}${process.env.PATH}`, XDG_STATE_HOME: join(tmp, 'state') };
delete labEnv.AGENTLAB_HOME;
delete labEnv.DEMO_API_TOKEN;
const projects = join(tmp, 'projects');
const interaction = join(projects, 'interaction-app');
const multi = join(projects, 'multi-service');
const initCopy = join(projects, 'interaction-init');
const responsive = join(projects, 'responsive-app');
const invoice = join(projects, 'invoice-app'); // schemaVersion 1 profile: migrated, then bundled and replayed
const tooNew = join(projects, 'too-new');
const badKey = join(projects, 'bad-key');
const ciOut = join(tmp, 'ci');
const external = process.env.AGENTLAB_VERIFY_EXTERNAL_PROJECT ? resolve(process.env.AGENTLAB_VERIFY_EXTERNAL_PROJECT) : null;

const steps = [];
const facts = { package: {}, node: {} };
let tarball;
const started = []; // child processes this script spawned itself
const sessions = new Set(); // project dirs where a lab session may be running

// ---------- helpers ----------

async function step(name, fn) {
  const t0 = Date.now();
  let ok = true, detail;
  try {
    detail = await fn();
  } catch (err) {
    ok = false;
    detail = err instanceof Error ? err.message : String(err);
  }
  const row = { step: name, ok, ms: Date.now() - t0, detail: detail ?? '' };
  steps.push(row);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(row.ms).padStart(6)} ms  ${name}${row.detail ? `  — ${typeof row.detail === 'string' ? row.detail : JSON.stringify(row.detail)}` : ''}`);
  return ok;
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

function sh(command, argv, opts = {}) {
  const r = spawnSync(command, argv, { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 180_000, ...opts });
  if (r.error) throw r.error;
  return r;
}

/** Run the installed CLI in `cwd`. Returns the process result and, with --json, the parsed stdout. */
function lab(cwd, argv, env = {}) {
  const r = sh('agentlab', argv, { cwd, env: { ...labEnv, ...env } });
  let data;
  if (argv.includes('--json')) { try { data = JSON.parse(r.stdout); } catch { /* not JSON */ } }
  return { ...r, data };
}

const brief = (r) => `exit ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 400)}`;

function portOpen(port) {
  return new Promise((res) => {
    const s = connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
  });
}

async function waitPortFree(port, ms = 5000) {
  const deadline = Date.now() + ms;
  while (await portOpen(port)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

const statusTexts = (result) => (result?.observation?.messages ?? []).map((m) => m.text);

/** A CLI action with --json: exit 0, outcome success, and (optionally) the status text in observation.messages. */
function act(argv, status, cwd = interaction) {
  const r = lab(cwd, [...argv, '--json']);
  expect(r.status === 0 && r.data?.outcome === 'success', `${argv.join(' ')}: ${r.data?.error ? JSON.stringify(r.data.error) : brief(r)}`);
  if (status) {
    const texts = statusTexts(r.data);
    expect(typeof status === 'string' ? texts.includes(status) : texts.some((t) => status.test(t)), `${argv.join(' ')}: status ${status} not in messages ${JSON.stringify(texts)}`);
  }
  return r.data;
}

function refOf(cwd, role, name) {
  const r = lab(cwd, ['observe', '--json', '--limit', '200']);
  expect(r.status === 0, `observe: ${brief(r)}`);
  const hits = r.data.controls.filter((c) => c.role === role && c.name === name);
  expect(hits.length === 1, `expected one ${role} "${name}", found ${hits.length}`);
  return hits[0].ref;
}

function patchProfile(dir, fn) {
  const file = join(dir, 'agentlab.json');
  const profile = JSON.parse(readFileSync(file, 'utf8'));
  fn(profile);
  writeFileSync(file, JSON.stringify(profile, null, 2) + '\n');
}

/** Read the dashboard's SSE stream until the first `snapshot` event and return its data. */
async function firstSnapshot(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: ac.signal });
    expect(res.status === 200, `/api/events status ${res.status}`);
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      for (const frame of buf.split('\n\n').slice(0, -1)) {
        if (/^event: snapshot$/m.test(frame)) return JSON.parse(frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n'));
      }
    }
    throw new Error('stream ended without a snapshot');
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}

const npxDir = join(homedir(), '.npm', '_npx');
const npxEntries = () => (existsSync(npxDir) ? readdirSync(npxDir) : []);
const npxCreated = [];

const listDir = (dir) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() || e.isSocket?.()).map((e) => join(e.parentPath ?? e.path, e.name).slice(dir.length + 1)).sort();
};

// ---------- 1–4: pack and install ----------

async function main() {
  await step('1 npm pack', () => {
    const r = sh('npm', ['pack', '--pack-destination', tmp], { cwd: repo, env: npmEnv });
    expect(r.status === 0, brief(r));
    const name = r.stdout.trim().split('\n').at(-1);
    tarball = join(tmp, name);
    expect(existsSync(tarball), `no tarball at ${tarball}`);
    const notice = r.stderr;
    const grab = (label) => new RegExp(`${label}:\\s+(.+)`).exec(notice)?.[1].trim();
    Object.assign(facts.package, { tarball: name, bytes: statSync(tarball).size, packageSize: grab('package size'), unpackedSize: grab('unpacked size'), totalFiles: Number(grab('total files')) });
    return `${name}: ${facts.package.bytes} bytes; package size ${facts.package.packageSize}, unpacked ${facts.package.unpackedSize}, ${facts.package.totalFiles} files`;
  });
  if (!tarball) return;

  const installed = await step('2 global install into a temp prefix', () => {
    const r = sh('npm', ['install', '-g', '--prefix', globalPrefix, tarball], { env: npmEnv, timeout: NPM_TIMEOUT });
    expect(r.status === 0, brief(r));
    expect(existsSync(cli), `no CLI at ${cli}`);
    const leaked = ['src', 'test', 'bench'].filter((d) => existsSync(join(pkgRoot, d)));
    expect(!leaked.length, `package root contains ${leaked.join(', ')}`);
    return `package root: ${readdirSync(pkgRoot).sort().join(', ')}`;
  });
  if (!installed) return;

  await step('2b global install: version --json contracts, doctor --no-launch, --help lists the new commands', () => {
    const cwd = join(tmp, 'plain-cwd');
    mkdirSync(cwd);
    let r = lab(cwd, ['version', '--json']);
    expect(r.status === 0 && r.data, brief(r));
    const c = r.data.contracts ?? {};
    for (const k of ['profile', 'profileSupported', 'results', 'mcpTools', 'report', 'bundle', 'events']) expect(c[k] !== undefined, `version --json contracts lacks ${k}: ${JSON.stringify(c)}`);
    facts.package.contracts = c;
    r = lab(cwd, ['doctor', '--no-launch', '--json']);
    expect(r.status === 0 && r.data?.ok === true, `doctor --no-launch: ${brief(r)}`);
    const warned = r.data.checks.filter((x) => x.status === 'warn').map((x) => x.name);
    r = lab(cwd, ['--help']);
    expect(r.status === 0, brief(r));
    const missing = ['test', 'replay', 'migrate', 'clean', 'bundles'].filter((w) => !new RegExp(`^\\s+agentlab ${w}\\b`, 'm').test(r.stdout));
    expect(!missing.length, `--help lacks ${missing.join(', ')}`);
    expect(readdirSync(cwd).length === 0, `cwd not empty after version/doctor/help: ${readdirSync(cwd).join(', ')}`);
    return `contracts ${JSON.stringify(c)}; doctor --no-launch ok (warnings: ${warned.join(', ') || 'none'}); help lists test, replay, migrate, clean, bundles`;
  });

  await step('3 local project install + npx agentlab version', () => {
    const local = join(tmp, 'local');
    mkdirSync(local);
    let r = sh('npm', ['init', '-y'], { cwd: local, env: npmEnv });
    expect(r.status === 0, brief(r));
    r = sh('npm', ['install', tarball], { cwd: local, env: npmEnv, timeout: NPM_TIMEOUT });
    expect(r.status === 0, brief(r));
    r = sh('npx', ['agentlab', 'version'], { cwd: local, env: npmEnv });
    expect(r.status === 0 && r.stdout.includes(`agentlab ${pkg.version}`), brief(r));
    expect(r.stdout.includes(join(local, 'node_modules', pkg.name)), `not run from the local install: ${r.stdout}`);
    return r.stdout.trim().split('\n')[0];
  });

  await step('4 npx --package <tgz> without install', () => {
    const cwd = join(tmp, 'npx-cwd');
    mkdirSync(cwd);
    // npx installs into ~/.npm/_npx/<hash>; the entry it creates is removed again at the end.
    const before = new Set(npxEntries());
    const r = sh('npx', ['--yes', '--package', tarball, 'agentlab', 'version', '--json'], { cwd, env: { ...npmEnv, XDG_STATE_HOME: join(tmp, 'state') }, timeout: NPM_TIMEOUT });
    npxCreated.push(...npxEntries().filter((e) => !before.has(e)));
    expect(r.status === 0, brief(r));
    const v = JSON.parse(r.stdout);
    expect(v.agentlab === pkg.version, `version ${v.agentlab} != ${pkg.version}`);
    expect(readdirSync(cwd).length === 0, `npx-cwd not empty: ${readdirSync(cwd).join(', ')}`);
    return `agentlab ${v.agentlab} from ${v.installedAt}; cwd still empty`;
  });

  // ---------- 5: copies of the test projects, on their own ports ----------

  await step('5 copy fixtures out of the repo and move their ports', () => {
    cpSync(join(repo, 'fixtures/interaction-app'), interaction, { recursive: true, filter: (s) => !s.includes('.agentlab') });
    patchProfile(interaction, (p) => { p.services.web.url = 'http://127.0.0.1:5356'; p.services.web.env.PORT = '5356'; });
    cpSync(join(repo, 'examples/multi-service'), multi, { recursive: true, filter: (s) => !s.includes('.agentlab') && !s.endsWith('compose.agentlab.json') });
    const ports = { api: '5357', web: '5358' };
    patchProfile(multi, (p) => {
      for (const [name, s] of Object.entries(p.services)) {
        if (ports[name]) { s.url = `http://127.0.0.1:${ports[name]}`; s.env.PORT = ports[name]; }
        if (s.env?.API_URL) s.env.API_URL = 'http://127.0.0.1:5357';
      }
    });
    // `upload ../../package.json` from the interaction copy must name an existing file outside uploads/.
    cpSync(join(repo, 'package.json'), join(tmp, 'package.json'));
    const leftover = JSON.stringify(JSON.parse(readFileSync(join(multi, 'agentlab.json'), 'utf8'))).match(/534[12]/);
    expect(!leftover, 'multi-service copy still mentions 5341/5342');
    return `${interaction} on 5356; ${multi} api 5357, web 5358`;
  });

  await step('5b npx from an empty directory: nothing is left in it, state goes to $XDG_STATE_HOME', async () => {
    cpSync(join(repo, 'fixtures/invoice-app'), invoice, { recursive: true, filter: (x) => !x.includes('.agentlab') });
    const original = readFileSync(join(invoice, 'agentlab.json'), 'utf8');
    writeFileSync(join(invoice, 'agentlab.json'), original.replaceAll('5199', '5357'));
    const cwd = join(tmp, 'npx-state-cwd');
    const xdg = join(tmp, 'state-npx');
    mkdirSync(cwd);
    const before = new Set(npxEntries());
    const env = { ...npmEnv, XDG_STATE_HOME: xdg };
    let running = false;
    try {
      let r = sh('npx', ['--yes', '--package', tarball, 'agentlab', 'version'], { cwd, env, timeout: NPM_TIMEOUT });
      expect(r.status === 0 && r.stdout.includes(`agentlab ${pkg.version}`), brief(r));
      // A session started from the empty directory (the project is elsewhere) keeps its state under XDG_STATE_HOME, not in cwd.
      r = sh('npx', ['--yes', '--package', tarball, 'agentlab', 'start', '--headless', '--no-ui', '--project', invoice, '--json'], { cwd, env: { ...env, PLAYWRIGHT_BROWSERS_PATH: browsersPath }, timeout: NPM_TIMEOUT });
      expect(r.status === 0, `npx start: ${brief(r)}`);
      running = true;
      r = sh('npx', ['--yes', '--package', tarball, 'agentlab', 'stop'], { cwd, env, timeout: NPM_TIMEOUT });
      expect(r.status === 0, `npx stop: ${brief(r)}`);
      running = false;
    } finally {
      if (running) lab(cwd, ['stop'], { XDG_STATE_HOME: xdg });
      npxCreated.push(...npxEntries().filter((e) => !before.has(e)));
    }
    expect(readdirSync(cwd).length === 0, `npx cwd not empty: ${readdirSync(cwd).join(', ')}`);
    expect(!existsSync(join(invoice, '.agentlab')), 'npx start litters the project directory with .agentlab');
    const files = listDir(xdg);
    expect(files.length > 0 && files.every((f) => f.startsWith('agentlab/')), `state files: ${files.join(', ')}`);
    expect(await waitPortFree(5357), '5357 still in use');
    return `cwd empty, project untouched; ${files.length} state files under $XDG_STATE_HOME/agentlab/projects/ (e.g. ${files.slice(0, 3).join(', ')}); npx cache entries created: ${npxCreated.length}`;
  });

  // ---------- 6: the installed CLI against the copies ----------

  await step('6a help, version, install-browser', () => {
    let r = lab(interaction, ['--help']);
    expect(r.status === 0, brief(r));
    for (const word of ['init', 'doctor', 'install-browser']) expect(r.stdout.includes(word), `help lacks ${word}`);
    r = lab(interaction, ['version', '--json']);
    expect(r.status === 0, brief(r));
    expect(r.data.installedAt.startsWith(globalPrefix), `installedAt ${r.data.installedAt}`);
    expect(r.data.chromium.installed, 'chromium not installed');
    facts.package.playwright = r.data.playwright;
    r = lab(interaction, ['install-browser']);
    expect(r.status === 0, brief(r));
    return `installedAt ${r.data?.installedAt ?? pkgRoot}; playwright ${facts.package.playwright}; install-browser exit 0`;
  });

  await step('6b doctor --json in the interaction copy', () => {
    const r = lab(interaction, ['doctor', '--json']);
    expect(r.data?.ok === true, `doctor not ok: ${r.stdout.slice(0, 800) || brief(r)}`);
    return `ok; ${(r.data.checks ?? []).length} checks`;
  });

  await step('6c init --print (multi-service copy)', () => {
    const before = readFileSync(join(multi, 'agentlab.json'), 'utf8');
    const r = lab(multi, ['init', '--print']);
    expect(r.status === 0 && r.stdout.trim(), brief(r));
    writeFileSync(join(outDir, 'init-multi-service.txt'), r.stdout);
    expect(readFileSync(join(multi, 'agentlab.json'), 'utf8') === before, 'agentlab.json changed');
    return `${r.stdout.split('\n').length} lines; agentlab.json unchanged`;
  });

  const initOk = await step('6c init --yes (git-initialised interaction copy)', () => {
    cpSync(interaction, initCopy, { recursive: true });
    rmSync(join(initCopy, 'agentlab.json'));
    rmSync(join(initCopy, '.agentlab'), { recursive: true, force: true });
    expect(sh('git', ['init', '-q'], { cwd: initCopy }).status === 0, 'git init failed');
    const r = lab(initCopy, ['init', '--yes']);
    expect(r.status === 0, brief(r));
    writeFileSync(join(outDir, 'init-interaction-app.txt'), r.stdout);
    expect(existsSync(join(initCopy, 'agentlab.json')), 'agentlab.json not written');
    const gi = readFileSync(join(initCopy, '.gitignore'), 'utf8');
    expect(/^\.agentlab\/?$/m.test(gi), `.gitignore lacks .agentlab/: ${gi}`);
    const proposed = JSON.parse(readFileSync(join(initCopy, 'agentlab.json'), 'utf8'));
    // Move the written profile to its own port before anything starts it.
    patchProfile(initCopy, (p) => {
      for (const s of Object.values(p.services ?? {})) {
        if (s.url) s.url = s.url.replace(/:\d+/, ':5359');
        if (s.env?.PORT) s.env.PORT = '5359';
        else if (s.url) s.env = { ...(s.env ?? {}), PORT: '5359' };
      }
      if (p.web?.url) { p.web.url = p.web.url.replace(/:\d+/, ':5359'); p.web.env = { ...(p.web.env ?? {}), PORT: '5359' }; }
    });
    return `wrote agentlab.json (services: ${Object.keys(proposed.services ?? { web: 1 }).join(', ')}; proposed url ${Object.values(proposed.services ?? {})[0]?.url ?? proposed.web?.url}); .gitignore has .agentlab/; moved to 5359`;
  });

  await step('6c init --print on an external git checkout (read-only)', () => {
    if (!external) return 'skipped: set AGENTLAB_VERIFY_EXTERNAL_PROJECT to a git checkout to run this step';
    expect(existsSync(external), `${external} not found`);
    const git = () => sh('git', ['-C', external, 'status', '--porcelain']).stdout;
    const marks = () => ['agentlab.json', '.agentlab'].map((f) => existsSync(join(external, f)));
    const before = git(), marksBefore = marks();
    const r = lab(projects, ['init', '--print', external]);
    const after = git(), marksAfter = marks();
    expect(r.status === 0 && r.stdout.trim(), brief(r));
    writeFileSync(join(outDir, 'init-external-project.txt'), r.stdout);
    expect(before === after, 'git status of the external project changed');
    expect(JSON.stringify(marksBefore) === JSON.stringify(marksAfter), 'agentlab.json/.agentlab appeared in the external project');
    return `${r.stdout.split('\n').length} lines; git status identical (${before.trim() ? 'dirty' : 'clean'} before and after)`;
  });

  // 6d: a CLI session driving every new action.
  const startOk = await step('6d start --headless (with dashboard)', async () => {
    sessions.add(interaction);
    const r = lab(interaction, ['start', '--headless', '--json']);
    expect(r.status === 0 && r.data?.observation?.route === '/', brief(r));
    expect(await portOpen(5356), 'nothing on 5356');
    return `session ${r.data.session.id}; ${r.data.observation.controls.length} controls on /`;
  });
  if (startOk) {
    await step('6d select', () => {
      act(['click', '--name', 'Form controls', '--role', 'link']);
      act(['select', '--name', 'Plan', 'Pro'], 'Plan: Pro');
      return 'Plan: Pro';
    });
    await step('6d check / uncheck', () => {
      act(['check', '--name', 'Email me updates'], 'Email updates on');
      act(['uncheck', '--name', 'Email me updates'], 'Email updates off');
      act(['check', '--name', 'Large', '--role', 'radio'], 'Size: Large');
      act(['check', '--name', 'Dark mode', '--role', 'switch'], 'Dark mode on');
      act(['uncheck', '--name', 'Dark mode', '--role', 'switch'], 'Dark mode off');
      return 'checkbox, radio, switch';
    });
    await step('6d back / forward', () => {
      act(['click', '--name', 'Next step'], 'Step 2');
      act(['back'], 'Step 1');
      act(['forward'], 'Step 2');
      return 'Step 2 → Step 1 → Step 2';
    });
    await step('6d press', () => {
      act(['click', '--name', 'Home', '--role', 'link']);
      act(['click', '--name', 'Keyboard', '--role', 'link']);
      act(['fill', '--name', 'Search', 'lamps']);
      act(['press', 'Enter', '--name', 'Search'], 'Searched for: lamps');
      return 'Searched for: lamps';
    });
    await step('6d scroll / swipe', () => {
      act(['click', '--name', 'Home', '--role', 'link']);
      act(['click', '--name', 'Scroll and swipe', '--role', 'link']);
      const s = act(['scroll', 'down', '--amount', '400']);
      expect(s.observation?.scroll?.y > 0, `page did not scroll: ${JSON.stringify(s.observation?.scroll)}`);
      act(['swipe', 'left', '--name', 'Card'], 'Swiped left');
      act(['scroll', 'right', '--name', 'Photo 1'], /^Showing photo [2-5]$/);
      return `scrollY ${s.observation.scroll.y}; Swiped left; carousel moved`;
    });
    await step('6d hover', () => {
      act(['click', '--name', 'Home', '--role', 'link']);
      act(['click', '--name', 'Pointer', '--role', 'link']);
      act(['hover', '--name', 'Info'], 'Tooltip shown');
      return 'Tooltip shown';
    });
    await step('6d drag (--to and --dx)', () => {
      const a = refOf(interaction, 'button', 'Task A');
      act(['drag', '--name', 'Task B', '--to', a], 'Order: B, A, C');
      const v = act(['drag', '--name', 'Volume', '--dx', '75', '--dy', '0'], /^Volume \d+$/);
      const n = Number(/^Volume (\d+)$/.exec(statusTexts(v).find((t) => /^Volume \d+$/.test(t)))[1]);
      expect(n > 50, `Volume ${n} did not increase`);
      return `Order: B, A, C; Volume ${n}`;
    });
    await step('6d upload (+ refused outside uploads/)', () => {
      act(['click', '--name', 'Home', '--role', 'link']);
      act(['click', '--name', 'Upload', '--role', 'link']);
      act(['upload', '--name', 'Attachments', 'uploads/notes.txt'], 'Attached: notes.txt (79 bytes)');
      act(['upload', '--name', 'Choose photo', 'uploads/photo.png'], 'Photo: photo.png (70 bytes)');
      const r = lab(interaction, ['upload', '--name', 'Attachments', '../../package.json', '--json']);
      const code = r.data?.error?.code;
      expect(r.status === 1 && code === 'upload_not_allowed', `outside upload: exit ${r.status}, code ${code}: ${r.stdout.slice(0, 300)}`);
      return 'notes.txt, photo.png; ../../package.json → exit 1 upload_not_allowed';
    });
    await step('6d tabs / tab switch / tab close / tab open', () => {
      act(['click', '--name', 'Home', '--role', 'link']);
      act(['click', '--name', 'Tabs', '--role', 'link']);
      const opened = act(['click', '--name', 'Open help']);
      expect(opened.changes?.tabs?.opened?.length === 1, `no tab opened: ${JSON.stringify(opened.changes?.tabs)}`);
      const newTab = opened.changes.tabs.opened[0];
      let r = lab(interaction, ['tabs', '--json']);
      expect(r.status === 0 && r.data.tabs.length === 2, `tabs: ${r.stdout}`);
      const first = r.data.tabs.find((t) => t.id !== newTab).id;
      act(['tab', 'switch', newTab]);
      act(['click', '--name', 'Done'], 'Done');
      act(['tab', 'switch', first]);
      act(['tab', 'close', newTab]);
      const o = act(['tab', 'open', '/help']);
      expect(o.observation?.route === '/help', `tab open landed on ${o.observation?.route}`);
      act(['tab', 'close']);
      r = lab(interaction, ['tabs', '--json']);
      expect(r.status === 0 && r.data.tabs.length === 1, `tabs after closes: ${r.stdout}`);
      return `opened ${newTab}, switched, closed; tab open /help then closed; 1 tab left`;
    });
    await step('6d dashboard: page, SSE snapshot, token required', async () => {
      const r = lab(interaction, ['ui', '--no-open', '--json']);
      expect(r.status === 0 && r.data?.url, brief(r));
      const url = new URL(r.data.url);
      const token = new URLSearchParams(url.hash.slice(1)).get('token');
      expect(token, 'no token in the URL fragment');
      const page = await fetch(url.origin + '/');
      expect(page.status === 200 && page.headers.get('content-type')?.startsWith('text/html'), `page ${page.status} ${page.headers.get('content-type')}`);
      const snap = await firstSnapshot(`${url.origin}/api/events?token=${token}`);
      const kinds = new Set((snap.timeline ?? []).map((e) => e.kind));
      const wanted = ['select', 'check', 'uncheck', 'back', 'forward', 'press', 'scroll', 'swipe', 'hover', 'drag', 'upload', 'open_tab', 'switch_tab', 'close_tab'];
      const missing = wanted.filter((k) => !kinds.has(k));
      expect(!missing.length, `timeline lacks ${missing.join(', ')} (has ${[...kinds].join(', ')})`);
      const anon = await fetch(`${url.origin}/api/events`);
      expect(anon.status === 401, `token-less request got ${anon.status}`);
      await anon.body?.cancel();
      return `${snap.timeline.length} timeline entries; kinds ${[...kinds].join(', ')}; token-less 401`;
    });
    await step('6d stop → 5356 free', async () => {
      const r = lab(interaction, ['stop']);
      expect(r.status === 0, brief(r));
      sessions.delete(interaction);
      expect(await waitPortFree(5356), '5356 still in use');
      return r.stdout.trim().split('\n')[0];
    });
  }

  // 6e: the MCP server from the installed package, with the SDK from the package's own node_modules.
  await step('6e MCP (installed package)', async () => {
    const sdk = join(pkgRoot, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client');
    const { Client } = await import(pathToFileURL(join(sdk, 'index.js')).href);
    const { StdioClientTransport } = await import(pathToFileURL(join(sdk, 'stdio.js')).href);
    const client = new Client({ name: 'verify-package', version: '0.0.0' });
    await client.connect(new StdioClientTransport({ command: cli, args: ['mcp', '--headless'], cwd: interaction, env: labEnv, stderr: 'pipe' }));
    sessions.add(interaction);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      const needed = ['bundle', 'observe', 'scan', 'press', 'select', 'check', 'uncheck', 'scroll', 'swipe', 'back', 'forward', 'hover', 'upload', 'drag', 'tabs', 'open_tab', 'switch_tab', 'close_tab', 'auth_save'];
      const missing = needed.filter((n) => !names.includes(n));
      expect(!missing.length, `tools missing: ${missing.join(', ')}`);
      const call = async (name, a = {}) => {
        const res = await client.callTool({ name, arguments: a });
        expect(!res.isError, `${name}: ${res.content?.[0]?.text}`);
        return res.structuredContent;
      };
      const ok = async (name, a) => {
        const d = await call(name, a);
        expect(d.outcome === 'success', `${name}: outcome ${d.outcome}`);
        return d;
      };
      await call('start', { project: interaction });
      const obs = await call('observe');
      expect(obs.route === '/' && obs.controls?.length > 0, `observe: ${JSON.stringify(obs).slice(0, 200)}`);
      await ok('click', { name: 'Form controls', role: 'link' });
      let d = await ok('select', { name: 'Plan', values: ['Team'] });
      expect(statusTexts(d).includes('Plan: Team'), 'select: no Plan: Team');
      d = await ok('check', { name: 'Email me updates' });
      expect(statusTexts(d).includes('Email updates on'), 'check: no Email updates on');
      await ok('press', { key: 'Tab' });
      d = await ok('back');
      expect(d.observation?.route === '/', `back landed on ${d.observation?.route}`);
      await ok('click', { name: 'Upload', role: 'link' });
      d = await ok('upload', { name: 'Attachments', files: ['uploads/notes.txt'] });
      expect(statusTexts(d).includes('Attached: notes.txt (79 bytes)'), 'upload: status missing');
      const outside = await client.callTool({ name: 'upload', arguments: { name: 'Attachments', files: ['../../package.json'] } });
      expect(outside.isError, 'upload outside uploads/ was not an error');
      const tabs = await call('tabs');
      expect(tabs.tabs?.length === 1, `tabs: ${JSON.stringify(tabs)}`);
      await call('stop');
      sessions.delete(interaction);
      return `${names.length} tools (incl. bundle); start, observe, select, check, press, back, upload, tabs, stop; outside upload isError (${outside.content?.[0]?.text?.split('\n')[0]})`;
    } finally {
      await client.close();
      expect(await waitPortFree(5356), '5356 still in use after MCP stop');
    }
  });

  // 6f: multi-service start/stop and partial reuse.
  const svcEnv = { DEMO_API_TOKEN: 'verify-package-token' };
  await step('6f multi-service start/status/stop', async () => {
    sessions.add(multi);
    let r = lab(multi, ['start', '--headless', '--no-ui', '--json'], svcEnv);
    expect(r.status === 0, brief(r));
    const svcs = r.data.services;
    expect(svcs.length === 3 && svcs.every((s) => s.owned), `services: ${JSON.stringify(svcs.map((s) => [s.name, s.owned]))}`);
    r = lab(multi, ['status', '--json'], svcEnv);
    expect(r.status === 0 && r.data.active, `status: ${brief(r)}`);
    r = lab(multi, ['stop', '--json'], svcEnv);
    expect(r.status === 0, brief(r));
    sessions.delete(multi);
    const stopped = r.data.services ?? [];
    expect(stopped.length === 3 && stopped.every((s) => s.stopped), `stop: ${JSON.stringify(stopped)}`);
    expect(await waitPortFree(5357) && await waitPortFree(5358), '5357/5358 still in use');
    return `started ${svcs.map((s) => s.name).join(', ')} (all owned); all stopped; ports free`;
  });

  await step('6f partial reuse (api started by this script)', async () => {
    const api = spawn(process.execPath, ['api/server.mjs'], { cwd: multi, env: { ...process.env, ...svcEnv, PORT: '5357' }, stdio: 'ignore' });
    started.push(api);
    const deadline = Date.now() + 10_000;
    while (!(await portOpen(5357))) {
      expect(Date.now() < deadline, 'own api did not listen');
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      sessions.add(multi);
      let r = lab(multi, ['start', '--headless', '--no-ui', '--json'], svcEnv);
      expect(r.status === 0, brief(r));
      const apiInfo = r.data.services.find((s) => s.name === 'api');
      expect(apiInfo && apiInfo.owned === false && apiInfo.status === 'reused', `api: ${JSON.stringify(apiInfo)}`);
      r = lab(multi, ['stop', '--json'], svcEnv);
      expect(r.status === 0, brief(r));
      sessions.delete(multi);
      const health = await fetch('http://127.0.0.1:5357/health');
      expect(health.status === 200, `own api /health ${health.status} after stop`);
      expect(await waitPortFree(5358), '5358 still in use');
      return 'api reused (owned false); after stop our api still answers /health 200';
    } finally {
      api.kill('SIGTERM');
      await new Promise((r) => (api.exitCode !== null ? r() : api.once('exit', r)));
    }
  });

  // 6g: saved sign-in state in the git-initialised copy.
  if (initOk) {
    await step('6g auth save / status / reuse / clear', async () => {
      sessions.add(initCopy);
      let r = lab(initCopy, ['start', '--headless', '--no-ui', '--json']);
      expect(r.status === 0, `start: ${brief(r)}`);
      r = lab(initCopy, ['auth', 'save', '--json']);
      expect(r.status === 0 && r.data?.saved === true, `auth save: ${brief(r)}`);
      const file = join(initCopy, '.agentlab', 'auth', 'state.json');
      const mode = (statSync(file).mode & 0o777).toString(8);
      expect(mode === '600', `state.json mode ${mode}`);
      r = lab(initCopy, ['auth', 'status', '--json']);
      expect(r.status === 0 && r.data?.exists && r.data?.ignored === true, `auth status: ${r.stdout}`);
      const status = r.data;
      expect(lab(initCopy, ['stop']).status === 0, 'stop failed');
      r = lab(initCopy, ['start', '--headless', '--no-ui', '--json']);
      expect(r.status === 0, `restart: ${brief(r)}`);
      const auth = r.data.session.auth;
      expect(lab(initCopy, ['stop']).status === 0, 'second stop failed');
      sessions.delete(initCopy);
      expect(auth === 'saved-state', `session.auth ${auth}`);
      r = lab(initCopy, ['auth', 'clear', '--json']);
      expect(r.status === 0 && r.data?.cleared === true && !existsSync(file), `auth clear: ${r.stdout}`);
      expect(await waitPortFree(5359), '5359 still in use');
      return `mode 600, ignored by git, ${status.cookies} cookies/${status.origins} origins; restart auth=saved-state; cleared`;
    });
  }

  // 6h: a stateful scan from the installed package, standalone (start, scan, stop), with its exit codes.
  await step('6h scan --project (responsive copy): reports and exit codes', async () => {
    cpSync(join(repo, 'fixtures/responsive-app'), responsive, { recursive: true, filter: (x) => !x.includes('.agentlab') });
    patchProfile(responsive, (p) => { p.services.web.url = 'http://127.0.0.1:5360'; p.services.web.env.PORT = '5360'; });
    let r = lab(responsive, ['scan', '--project', '.', '--scenario', 'Filters drawer,About (clean)', '--devices', 'mobile-320,mobile-390', '--json']);
    expect(r.status === 0 && r.data?.verdict?.result === 'pass', `drawer scan: ${brief(r)}`);
    const wrap = r.data.groups.find((g) => g.kind === 'text-wrap-change');
    expect(wrap && wrap.devices.join() === 'mobile-320', `no 320-only wrap group: ${JSON.stringify(r.data.groups)}`);
    expect(existsSync(r.data.reports.html) && existsSync(r.data.reports.json), 'reports missing');
    expect(!/"frames?"/.test(r.stdout), 'frames in the command result');
    r = lab(responsive, ['scan', '--project', '.', '--scenario', 'Checkout', '--devices', 'mobile-390']);
    expect(r.status === 1 && /^scan R1: FAIL/.test(r.stdout), `checkout scan should fail the policy: ${brief(r)}`);
    r = lab(responsive, ['scan', '--project', '.', '--scenario', 'No such scenario']);
    expect(r.status === 2, `unknown scenario should exit 2: ${brief(r)}`);
    expect(await waitPortFree(5360), '5360 still in use');
    return `drawer + about: PASS, wrap "${wrap.title}" at 320 only; checkout: exit 1 FAIL; unknown scenario: exit 2; 5360 free`;
  });

  // ---------- 6i: upgrade and migration ----------

  await step('6i upgrade: schemaVersion 1 profile → doctor warns, migrate rewrites with a backup, start/stop work', async () => {
    const file = join(invoice, 'agentlab.json');
    const original = readFileSync(file, 'utf8');
    expect(JSON.parse(original).schemaVersion === 1, 'invoice copy is not schemaVersion 1');
    let r = lab(invoice, ['doctor', '--no-launch', '--json']);
    const warn = r.data?.checks?.find((c) => c.name === 'profile version');
    expect(r.status === 0 && r.data?.ok === true && warn?.status === 'warn' && /migrate/.test(warn.hint ?? ''), `doctor should warn and suggest migrate: ${r.stdout.slice(0, 600)}`);
    r = lab(invoice, ['migrate', '--print']);
    expect(r.status === 0 && readFileSync(file, 'utf8') === original && !existsSync(`${file}.v1.bak`), `migrate --print must not write: ${brief(r)}`);
    r = lab(invoice, ['migrate', '--yes']);
    expect(r.status === 0 && /original kept as/.test(r.stdout), brief(r));
    expect(readFileSync(`${file}.v1.bak`, 'utf8') === original, 'backup differs from the original bytes');
    const migrated = JSON.parse(readFileSync(file, 'utf8'));
    expect(migrated.schemaVersion === 2 && migrated.services?.web?.url === 'http://127.0.0.1:5357' && migrated.app?.service === 'web', `migrated profile: ${JSON.stringify(migrated).slice(0, 300)}`);
    r = lab(invoice, ['migrate', '--yes']);
    expect(r.status === 0 && /already schemaVersion 2/.test(r.stdout), `second migrate: ${brief(r)}`);
    r = lab(invoice, ['doctor', '--no-launch', '--json']);
    expect(r.data?.ok === true && !r.data.checks.some((c) => c.name === 'profile version'), `doctor after migrate: ${r.stdout.slice(0, 400)}`);
    sessions.add(invoice);
    r = lab(invoice, ['start', '--headless', '--no-ui', '--json']);
    expect(r.status === 0 && r.data?.observation?.route === '/invoices', `start after migrate: ${brief(r)}`);
    r = lab(invoice, ['stop']);
    sessions.delete(invoice);
    expect(r.status === 0, brief(r));
    expect(await waitPortFree(5357), '5357 still in use');
    return 'doctor warned (schemaVersion 1, run migrate); migrate --print read-only; --yes wrote schemaVersion 2 + agentlab.json.v1.bak (identical bytes); 2nd migrate no-op; start/stop ok';
  });

  await step('6i profile_too_new (schemaVersion 3) and an unknown key with a did-you-mean', () => {
    mkdirSync(tooNew, { recursive: true });
    writeFileSync(join(tooNew, 'agentlab.json'), JSON.stringify({ schemaVersion: 3, name: 'from-the-future' }, null, 2));
    const out = (r) => `${r.stdout}${r.stderr}`;
    let r = lab(tooNew, ['start', '--headless']);
    expect(r.status === 1 && out(r).includes('profile_too_new'), `start: ${brief(r)}`);
    r = lab(tooNew, ['migrate', '--yes']);
    expect(r.status !== 0 && out(r).includes('profile_too_new'), `migrate: ${brief(r)}`);
    expect(JSON.parse(readFileSync(join(tooNew, 'agentlab.json'), 'utf8')).schemaVersion === 3 && !existsSync(join(tooNew, 'agentlab.json.v1.bak')), 'migrate touched the newer profile');
    r = lab(tooNew, ['doctor', '--no-launch']);
    expect(r.status === 1 && /profile version/.test(out(r)) && /schemaVersion 3/.test(out(r)), `doctor: ${brief(r)}`);
    r = lab(tooNew, ['test', '--validate-only']);
    expect(r.status === 2, `test --validate-only on a too-new profile: exit ${r.status}`);
    mkdirSync(badKey, { recursive: true });
    writeFileSync(join(badKey, 'agentlab.json'), JSON.stringify({ schemaVersion: 2, name: 'typo', services: { web: { command: 'node server.mjs', url: 'http://127.0.0.1:5357', readines: { path: '/health' } } } }, null, 2));
    r = lab(badKey, ['start', '--headless']);
    expect(r.status === 1 && out(r).includes('unknown key "readines"') && out(r).includes('did you mean "readiness"?'), `start: ${brief(r)}`);
    r = lab(badKey, ['doctor', '--no-launch']);
    expect(r.status === 1 && out(r).includes('did you mean "readiness"?'), `doctor: ${brief(r)}`);
    r = lab(badKey, ['test', '--validate-only']);
    expect(r.status === 2 && out(r).includes('did you mean "readiness"?'), `test --validate-only: exit ${r.status} ${brief(r)}`);
    return 'schemaVersion 3: start exit 1 profile_too_new, migrate refuses and leaves the file, doctor FAIL, test --validate-only exit 2; unknown key "readines": did you mean "readiness"? from start, doctor and test --validate-only';
  });

  // ---------- 6j: CI from the installed package ----------

  await step('6j CI: agentlab test pass (0) / policy fail (1) / --validate-only missing env (2) / report junit', async () => {
    expect(existsSync(responsive), 'responsive copy missing (step 6h did not run)');
    const pass = join(ciOut, 'pass'), fail = join(ciOut, 'fail');
    let r = lab(responsive, ['test', '--project', '.', '--scenarios', 'Filters drawer,About (clean)', '--devices', 'mobile-320,mobile-390', '--out', pass]);
    expect(r.status === 0 && /^agentlab test: PASS/m.test(r.stdout), `pass case: ${brief(r)}`);
    const missing = ['ci-result.json', 'summary.txt', 'report.html', 'junit.xml', 'scan/report.html'].filter((f) => !existsSync(join(pass, f)));
    expect(!missing.length, `artifacts missing: ${missing.join(', ')}`);
    const result = JSON.parse(readFileSync(join(pass, 'ci-result.json'), 'utf8'));
    expect(result.schema === 'agentlab.ci-result', `schema ${result.schema}`);
    const passFiles = listDir(pass).length;
    r = lab(responsive, ['report', pass, '--format', 'junit']);
    expect(r.status === 0 && /<testsuites name="agentlab" tests="4" failures="0" errors="0"/.test(r.stdout), `report junit: ${brief(r)}`);
    r = lab(responsive, ['test', '--project', '.', '--scenarios', 'Checkout', '--devices', 'mobile-390', '--out', fail]);
    expect(r.status === 1 && /^agentlab test: FAIL/m.test(r.stdout), `fail case: ${brief(r)}`);
    expect(existsSync(join(fail, 'ci-result.json')) && readdirSync(join(fail, 'bundles')).length >= 1, 'failing run wrote no ci-result.json or bundle');
    r = lab(responsive, ['report', fail, '--format', 'junit']);
    expect(r.status === 0 && /<failure/.test(r.stdout), `failing report junit: ${brief(r)}`);
    r = lab(multi, ['test', '--project', '.', '--validate-only']);
    expect(r.status === 2 && r.stdout.includes('DEMO_API_TOKEN') && !r.stdout.includes('verify-package-token'), `validate-only without the env: ${brief(r)}`);
    r = lab(multi, ['test', '--project', '.', '--validate-only'], svcEnv);
    expect(r.status === 0 && /can run/.test(r.stdout), `validate-only with the env: ${brief(r)}`);
    expect(await waitPortFree(5360) && await waitPortFree(5357) && await waitPortFree(5358), 'a CI port is still in use');
    return `pass: exit 0, ${passFiles} artifact files (ci-result.json, summary.txt, report.html, junit.xml, scan/); Checkout: exit 1 with a bundle; report --format junit ok for both; validate-only: exit 2 (DEMO_API_TOKEN named, no value) then exit 0 with it set`;
  });

  // ---------- 6k: bundle and replay ----------

  await step('6k bundle via the daemon, then replay (exit 0, reproduced)', async () => {
    sessions.add(invoice);
    let r = lab(invoice, ['start', '--headless', '--no-ui', '--json']);
    expect(r.status === 0, `start: ${brief(r)}`);
    act(['click', '--name', 'New invoice'], null, invoice);
    act(['fill', '--name', 'Customer', 'Verify Ltd'], null, invoice);
    r = lab(invoice, ['bundle', '--note', 'verify-package']);
    expect(r.status === 0, `bundle: ${brief(r)}`);
    const m = /bundle (b-[\w-]+) → (.+)/.exec(r.stdout);
    expect(m, `no bundle line: ${r.stdout}`);
    const [, id, dir] = m;
    r = lab(invoice, ['stop']);
    sessions.delete(invoice);
    expect(r.status === 0, `stop: ${brief(r)}`);
    expect(existsSync(join(dir, 'bundle.json')), `no bundle.json in ${dir}`);
    r = lab(invoice, ['bundles', 'list']);
    expect(r.status === 0 && r.stdout.includes(id), `bundles list: ${brief(r)}`);
    r = lab(invoice, ['replay', dir, '--project', '.', '--json']);
    expect(r.status === 0 && r.data?.outcome === 'reproduced', `replay: exit ${r.status} ${r.data?.outcome} ${r.data?.reason ?? brief(r)}`);
    const steps = r.data.steps.length;
    expect(await waitPortFree(5357), '5357 still in use after replay');
    return `bundle ${id} (${listDir(dir).length} files); bundles list shows it; replay: outcome reproduced, exit 0 (${steps} steps)`;
  });

  // ---------- 6l: MCP client configuration (no model usage: only the clients' own mcp subcommands) ----------

  const mcpCommand = [cli, 'mcp', '--headless'];
  const findBin = (name, extra = []) => {
    const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    return r.stdout.trim() || extra.find((p) => existsSync(p));
  };
  const claudeBin = findBin('claude', [join(homedir(), '.local', 'bin', 'claude')]);
  const codexBin = findBin('codex');
  // Real handshake with a stdio command taken from a client's own configuration.
  const handshake = async (command, argv) => {
    const sdk = join(pkgRoot, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client');
    const { Client } = await import(pathToFileURL(join(sdk, 'index.js')).href);
    const { StdioClientTransport } = await import(pathToFileURL(join(sdk, 'stdio.js')).href);
    const client = new Client({ name: 'verify-package-client-config', version: '0.0.0' });
    await client.connect(new StdioClientTransport({ command, args: argv, cwd: tmp, env: labEnv, stderr: 'pipe' }));
    try {
      const { tools } = await client.listTools();
      return tools.map((t) => t.name);
    } finally {
      await client.close();
    }
  };
  const version = (bin) => (sh(bin, ['--version'], { env: { ...process.env, HOME: labHome } }).stdout ?? '').trim();

  await step('6l MCP client config: Claude Code (user scope and project .mcp.json)', async () => {
    if (!claudeBin) return 'SKIPPED: claude is not installed on this machine';
    const home = join(tmp, 'claude-home'), projectHome = join(tmp, 'claude-home-project'), projectDir = join(tmp, 'claude-project');
    for (const d of [home, projectHome, projectDir]) mkdirSync(d, { recursive: true });
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(tmp, 'state') };
    const claude = (argv, e = env, cwd = tmp) => sh(claudeBin, argv, { env: e, cwd, timeout: 120_000 });
    let r = claude(['mcp', 'add', '--scope', 'user', 'agentlab', '--', ...mcpCommand]);
    expect(r.status === 0 && /Added stdio MCP server agentlab/.test(r.stdout), `mcp add: ${brief(r)}`);
    const config = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    const entry = config.mcpServers?.agentlab;
    expect(entry?.command === cli && entry.args.join(' ') === 'mcp --headless', `~/.claude.json entry: ${JSON.stringify(entry)}`);
    r = claude(['mcp', 'get', 'agentlab']);
    expect(r.status === 0 && /Status: ✔ Connected/.test(r.stdout), `mcp get: ${brief(r)}`);
    r = claude(['mcp', 'list']);
    expect(r.status === 0 && /agentlab: .* - ✔ Connected/.test(r.stdout), `mcp list: ${brief(r)}`);
    const tools = await handshake(entry.command, entry.args);
    expect(tools.includes('bundle') && tools.includes('start'), `tools from the configured command: ${tools.join(',')}`);
    // Project scope: the file a team commits. Claude Code asks before connecting to it, so `get` reports what it reports.
    const pe = { ...env, HOME: projectHome };
    r = claude(['mcp', 'add', '--scope', 'project', 'agentlab', '--', ...mcpCommand], pe, projectDir);
    expect(r.status === 0, `project add: ${brief(r)}`);
    const mcpJson = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8'));
    expect(mcpJson.mcpServers?.agentlab?.command === cli, `.mcp.json: ${JSON.stringify(mcpJson)}`);
    r = claude(['mcp', 'get', 'agentlab'], pe, projectDir);
    const projectStatus = /Status: (.+)/.exec(r.stdout)?.[1] ?? brief(r);
    return `${version(claudeBin)}: user scope add/get/list all "✔ Connected" (Claude Code's own health check does the MCP initialize handshake; no login needed, no model call); ~/.claude.json entry ok; configured command lists ${tools.length} tools incl. bundle; project scope wrote .mcp.json, \`mcp get\` status: ${projectStatus}`;
  });

  await step('6l MCP client config: Codex CLI', async () => {
    if (!codexBin) return 'SKIPPED: codex is not installed on this machine';
    const home = join(tmp, 'codex-home');
    mkdirSync(home);
    const env = { ...process.env, CODEX_HOME: home, HOME: labHome };
    const codex = (argv) => sh(codexBin, argv, { env, cwd: tmp, timeout: 60_000 });
    let r = codex(['mcp', 'add', 'agentlab', '--', ...mcpCommand]);
    expect(r.status === 0 && /Added global MCP server 'agentlab'/.test(r.stdout), `mcp add: ${brief(r)}`);
    const toml = readFileSync(join(home, 'config.toml'), 'utf8');
    expect(toml.includes('[mcp_servers.agentlab]') && toml.includes(`command = "${cli}"`) && toml.includes('args = ["mcp", "--headless"]'), `config.toml: ${toml}`);
    r = codex(['mcp', 'list', '--json']);
    const listed = JSON.parse(r.stdout).find((e) => e.name === 'agentlab');
    expect(listed?.enabled && listed.transport.type === 'stdio' && listed.transport.command === cli, `mcp list: ${r.stdout.slice(0, 300)}`);
    r = codex(['mcp', 'get', 'agentlab', '--json']);
    const got = JSON.parse(r.stdout);
    expect(got.transport?.command === cli && got.transport.args.join(' ') === 'mcp --headless', `mcp get: ${r.stdout.slice(0, 300)}`);
    const tools = await handshake(got.transport.command, got.transport.args);
    expect(tools.includes('bundle') && tools.includes('start'), `tools from the configured command: ${tools.join(',')}`);
    return `${version(codexBin)}: \`codex mcp add\` wrote [mcp_servers.agentlab] to $CODEX_HOME/config.toml; \`mcp list --json\` and \`mcp get --json\` show it enabled (stdio); NOT verifiable without a model session: Codex's own connection to the server (\`mcp list\` reads the config only, Auth "Unsupported" is normal for stdio); instead the command and args Codex reads back were launched through the MCP SDK client (${tools.length} tools incl. bundle)`;
  });

  // ---------- 7: Node.js versions ----------

  await step('7 Node.js version gate', () => {
    const bin = join(pkgRoot, 'bin', 'agentlab.js');
    const out = [];
    for (const v of ['v20.18.1', 'v18.20.5']) {
      const node = join(homedir(), '.nvm', 'versions', 'node', v, 'bin', 'node');
      expect(existsSync(node), `${node} missing`);
      const r = sh(node, [bin, 'version']);
      expect(r.status === 1 && r.stderr.includes('needs Node.js 22'), `${v}: ${brief(r)}`);
      facts.node[v] = 'refused';
      out.push(`${v} refused`);
    }
    const r = sh(process.execPath, [bin, 'version'], { env: labEnv });
    expect(r.status === 0, `current node: ${brief(r)}`);
    facts.node[process.version] = 'ok';
    return `${out.join(', ')}; ${process.version} ok`;
  });

  // ---------- 8: uninstall, and where data lives ----------

  await step('8 uninstall: the bin goes; list everything the run left outside the package', () => {
    const r = sh('npm', ['uninstall', '-g', '--prefix', globalPrefix, pkg.name], { env: npmEnv });
    expect(r.status === 0, brief(r));
    expect(!existsSync(cli) && !existsSync(pkgRoot), 'CLI or package dir still present');
    expect(!existsSync(join(globalPrefix, 'bin', 'agentlab')), 'bin symlink remains');
    const stateRoot = join(tmp, 'state', 'agentlab');
    const projectDirs = [interaction, multi, initCopy, responsive, invoice].map((p) => [`${p}/.agentlab`, listDir(join(p, '.agentlab'))]);
    const data = {
      [`$XDG_STATE_HOME/agentlab (${stateRoot})`]: listDir(stateRoot),
      [`$HOME of the lab commands (${labHome})`]: listDir(labHome),
      ...Object.fromEntries(projectDirs),
    };
    facts.dataLeft = data;
    // The documented full removal: the state dir. Nothing else outside projects and the browser cache may exist.
    rmSync(join(tmp, 'state'), { recursive: true, force: true });
    // Files in $HOME that belong to other software the lab runs, not to the lab: Chromium's font and GPU shader caches, and the
    // `npm run dev` the fixture profiles use as their service command (npm writes its logs and update stamp there). Anything else would be the package's own litter.
    const third = [['.cache/fontconfig/', 'Chromium font cache (fontconfig)'], ['.cache/mesa_shader_cache/', 'Chromium GPU shader cache (mesa)'], ['.npm/', 'npm logs and update-check stamp of the fixtures\' `npm run dev` service command']];
    const home = listDir(labHome);
    const other = home.filter((f) => !third.some(([prefix]) => f.startsWith(prefix)));
    expect(other.length === 0, `lab commands wrote into $HOME: ${other.join(', ')}`);
    const groups = third.map(([prefix, what]) => [what, home.filter((f) => f.startsWith(prefix)).length]).filter(([, n]) => n);
    facts.dataLeft[`$HOME of the lab commands (${labHome})`] = groups.map(([what, n]) => `${what}: ${n} files`);
    return `global bin and package removed; left after uninstall: ${Object.entries(facts.dataLeft).map(([k, v]) => `${k}: ${v.length} files`).join('; ')}; after \`rm -rf $XDG_STATE_HOME/agentlab\`: $HOME of the lab commands holds only other software's files (${groups.map(([what, n]) => `${what}: ${n}`).join('; ')}) and nothing from agentlab (the browser lives in ${browsersPath}, outside the package and never removed by uninstall); npm's own cache entries from npx: ${npxCreated.length}`;
  });
}

// ---------- 9: results and cleanup ----------

async function cleanup() {
  // Sessions a failed step left running: `stop` stops only services the lab started.
  for (const dir of sessions) lab(dir, ['stop'], { DEMO_API_TOKEN: 'verify-package-token' });
  for (const p of started) if (p.exitCode === null && p.signalCode === null) p.kill('SIGTERM');
}

try {
  await main();
} catch (err) {
  steps.push({ step: 'unexpected', ok: false, ms: 0, detail: err.stack });
  console.error(err);
} finally {
  if (existsSync(cli)) await cleanup();
  else for (const p of started) if (p.exitCode === null) p.kill('SIGTERM');
}

const ok = steps.every((s) => s.ok);
writeFileSync(join(outDir, 'verify.json'), JSON.stringify({ at: new Date().toISOString(), ok, version: pkg.version, node: process.version, package: facts.package, nodeGate: facts.node, dataLeft: facts.dataLeft, steps }, null, 2) + '\n');
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
writeFileSync(join(outDir, 'verify.md'), [
  `# Package verification (${pkg.name} ${pkg.version})`,
  '',
  `Node ${process.version}. Tarball ${facts.package.tarball ?? '?'}: ${facts.package.bytes ?? '?'} bytes (package size ${facts.package.packageSize ?? '?'}, unpacked ${facts.package.unpackedSize ?? '?'}, ${facts.package.totalFiles ?? '?'} files). Generated by \`node scripts/verify-package.mjs\`.`,
  '',
  '| step | result | ms | detail |',
  '| --- | --- | ---: | --- |',
  ...steps.map((s) => `| ${cell(s.step)} | ${s.ok ? 'ok' : 'FAIL'} | ${s.ms} | ${cell(typeof s.detail === 'string' ? s.detail : JSON.stringify(s.detail))} |`),
  '',
].join('\n'));

console.log(`\n${steps.filter((s) => s.ok).length}/${steps.length} steps ok; results in ${outDir}`);
if (args.keep) console.log(`kept ${tmp}`);
else rmSync(tmp, { recursive: true, force: true });
for (const e of npxCreated) rmSync(join(npxDir, e), { recursive: true, force: true });
process.exit(ok ? 0 : 1);
