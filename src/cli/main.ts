import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEVICES } from '../core/devices.js';
import { formatError, formatScan } from '../core/format.js';
import { scanSummary } from '../core/scan.js';
import type { LabErrorJSON } from '../core/schema.js';
import { checkIdentity, type IdentityCheck } from '../core/process-identity.js';
import { clearState, daemonCheck, paths, readDashboardRecord, readState, rpc, stateDir, userStateRoot, type DaemonState, type RpcResponse } from '../daemon/state.js';
import { runCi, runReport } from './ci.js';
import { runFlow } from './flow.js';
import { holdIfTerminating, onTermination } from './signals.js';
import { keepRuns, liveSessionIds, pruneRuns, reapOrphans, stopRecordedServices } from '../core/ownership.js';
import { runMcpServer } from '../mcp/server.js';
import { SessionFeed } from '../core/feed.js';
import { Lab, type HumanInput } from '../core/lab.js';
import type { ControlOp } from '../core/control.js';
import { Dashboard } from '../dashboard/server.js';
import { hasDisplay, openInBrowser } from '../dashboard/open.js';
import { formatProposal, proposeProfile, writeProposal } from '../core/init.js';
import { formatDoctor, runDoctor } from '../core/doctor.js';
import { authStatus } from '../core/auth.js';
import { PROFILE_FILE, loadProfile } from '../core/profile.js';
import { migrateProfile } from '../core/migrate.js';
import { listBundles, loadBundle, pruneBundles, removeBundle, retentionLimits } from '../core/bundle.js';
import { formatReplay, replayBundle, replayExitCode } from '../core/replay.js';
import { LabError } from '../core/schema.js';
import { CONTRACT_VERSIONS, productVersion } from '../core/versions.js';

const HELP = `agentlab: launch a project, drive it in a mobile browser, and see what changed.

Setup:
  agentlab init [dir] [--yes | --print] [--force]
                                           inspect the project and propose agentlab.json (shown before saving)
  agentlab doctor [--project <dir>] [--no-launch]
                                           check Node.js, the browser, display, permissions, ports and the profile
  agentlab migrate [--project <dir|file>] [--yes | --print] [--force]
                                           rewrite an older agentlab.json as schemaVersion 2 (keeps agentlab.json.v1.bak)
  agentlab clean                           stop services a crashed session left running and prune old runs (AGENTLAB_KEEP_RUNS, default 20)
  agentlab install-browser [--with-deps]   install the Chromium build this version of Playwright needs
  agentlab version

Session (a background daemon per directory keeps the browser open between commands):
  agentlab start [--project <dir>] [--device mobile-390] [--headed] [--slow-mo <ms>] [--auth auto|saved|fresh] [--trace]
  agentlab observe [--limit <n>]
  agentlab click <ref>                     e.g. agentlab click e3; or --name <name> [--role <role>] for any targeted action
  agentlab fill <ref> <text>
  agentlab press <key> [ref]               Enter, Escape, Tab, Shift+Tab, Control+a …
  agentlab select <ref> <option>...        by label or value (native <select>)
  agentlab check <ref> | uncheck <ref>
  agentlab scroll [up|down|left|right] [ref] [--amount <px>]   no direction: bring <ref> into view
  agentlab swipe <left|right|up|down> [ref] [--amount <px>]    touch swipe (the finger's direction)
  agentlab back | forward
  agentlab hover <ref>
  agentlab upload <ref> <file>...          project-relative files inside uploads.allow
  agentlab drag <ref> (--to <ref> | --dx <px> --dy <px>)
  agentlab tabs                            list tabs; tab open </path> | tab switch <t2> | tab close [t2]
  agentlab inspect [F2 | e10]              session findings with evidence and reproduction steps
  agentlab sweep [/route] [--devices mobile-320,tablet-768]
                                           responsive sweep at 320/390/768/1440 px, one isolated context each
  agentlab scan [/route] [--scenario <a,b>] [--devices <ids>] [--explore | --no-explore]
                                           stateful scan of agentlab.json scan.scenarios in the running session
                                           (menus, drawers, dialogs…); exit 1 when the scan policy fails
  agentlab auth save | status | clear      saved sign-in state (owner-only, git-ignored, never printed)
  agentlab bundle [--note <why>]           write a secret-free failure bundle for the running session
  agentlab status
  agentlab log [-f]                        ordered action log for the running session
  agentlab stop                            close the browser; stop only the services the lab started

Live dashboard (served by the session on 127.0.0.1 with a per-session token; --no-ui disables it):
  agentlab ui [--no-open]                  print the dashboard URL and open it when a display is available

MCP (stdio server over the same commands; start returns the dashboard URL):
  agentlab mcp [--headed] [--no-ui]

Scripted:
  agentlab run <flow.json> [--headed] [--device <id>] [--slow-mo <ms>] [--ui [--no-open]]
  agentlab scan --project <dir> [/route] [--scenario <a,b>] [--devices <ids>] [--explore] [--headed] [--auth auto|saved|fresh] [--ui [--no-open]]
                                           start, scan, stop: HTML and JSON reports; exit 0 pass, 1 policy fail, 2 could not run
  agentlab devices

CI (non-interactive, provider-neutral; docs/ci.md). Each starts the project, runs, and stops only what it started:
  agentlab test [--project <dir>]          everything the profile's "ci" section selects (flows, routes to sweep, scenarios to scan)
  agentlab sweep --project <dir> [/route ...]      CI sweep of routes (without --project: the running session, as above)
  agentlab scenario --project <dir> [name ...]     CI scan of declared scenarios (without --project: scan in the running session)
  agentlab report <out-dir|ci-result.json> [--format text|json|html|junit] [--out <file>]
                                           re-render a saved result; no browser
  shared flags: --devices a,b  --flows a.json,b.json  --routes /a,/b  --scenarios A,B  --fail-on high|medium|low|none
                --fail-on-heuristic  --scenario-errors fail|report (default fail)  --out <dir> (default ./agentlab-results)
                --format text,json,html,junit (default all; ci-result.json is always written)  --trace off|on-failure|always (default off)
                --evidence off|on-failure|always (default on-failure)  --timeout 90s|15m (default 30m)
                --auth fresh|saved|env (env: AGENTLAB_AUTH_STATE; default env when set, else fresh)
                --validate-only  --headed  --json (print the result JSON instead of the text report)
  exit codes: 0 pass, 1 policy failed (a flow failed, or a finding at/above --fail-on), 2 could not run (invalid profile, missing env or
              browser, unknown selection, start failure), 3 timed out (partial result written), 130/143/129 cancelled by SIGINT/SIGTERM/SIGHUP
              (services stopped, partial result written). Artifacts in --out: ci-result.json, summary.txt, report.html, junit.xml, scan/,
              frames/, bundles/, traces/. Secrets are redacted from every output; a leak aborts the write with exit 2.

Failure bundles (under <state>/bundles; kept 14 days, newest 20; AGENTLAB_BUNDLE_DAYS, AGENTLAB_KEEP_BUNDLES):
  agentlab bundles [list] | show <id> | rm <id> | prune [--older-than <days>]   [--dir <bundles dir>]
  agentlab replay <bundle dir|bundle.json> [--project <dir>] [--headed] [--allow-consequential] [--secret <step>=<ENV_NAME>]... [--until <step>]
                                           re-run the recorded actions against the live project: exit 0 reproduced, 1 not reproduced,
                                           2 could not run, 3 diverged or blocked. start --trace records a sanitized trace for bundles.

Every command accepts --json for the full structured result.
State lives in ./.agentlab in an initialised project, otherwise under ${'$'}XDG_STATE_HOME/agentlab
(override with AGENTLAB_HOME).`;

// `--trace` is a switch for `start`, and takes off|on-failure|always for the CI commands: the second form is
// renamed before parsing so both keep working.
const TRACE_MODES = ['off', 'on-failure', 'always'];
const argv = process.argv.slice(2).flatMap((a, i, all) => {
  if (a.startsWith('--trace=')) return [`--trace-mode=${a.slice(8)}`];
  if (a === '--trace' && TRACE_MODES.includes(all[i + 1] ?? '')) return ['--trace-mode'];
  return [a];
});

const { values: flags, positionals } = parseArgs({
  args: argv,
  allowPositionals: true,
  allowNegative: true,
  options: {
    project: { type: 'string' },
    device: { type: 'string' },
    headless: { type: 'boolean', default: false },
    'slow-mo': { type: 'string' },
    limit: { type: 'string' },
    role: { type: 'string' },
    devices: { type: 'string' },
    scenario: { type: 'string' },
    explore: { type: 'boolean' },
    headed: { type: 'boolean', default: false },
    name: { type: 'string' },
    auth: { type: 'string' },
    amount: { type: 'string' },
    to: { type: 'string' },
    dx: { type: 'string' },
    dy: { type: 'string' },
    yes: { type: 'boolean', short: 'y', default: false },
    print: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    launch: { type: 'boolean', default: true },
    'with-deps': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    follow: { type: 'boolean', short: 'f', default: false },
    ui: { type: 'boolean' },
    trace: { type: 'boolean', default: false },
    'trace-mode': { type: 'string' },
    flows: { type: 'string' },
    routes: { type: 'string' },
    scenarios: { type: 'string' },
    'fail-on': { type: 'string' },
    'fail-on-heuristic': { type: 'boolean' },
    'scenario-errors': { type: 'string' },
    out: { type: 'string' },
    format: { type: 'string' },
    evidence: { type: 'string' },
    timeout: { type: 'string' },
    'validate-only': { type: 'boolean', default: false },
    note: { type: 'string' },
    dir: { type: 'string' },
    'older-than': { type: 'string' },
    until: { type: 'string' },
    secret: { type: 'string', multiple: true },
    'allow-consequential': { type: 'boolean', default: false },
    open: { type: 'boolean', default: true },
    version: { type: 'boolean', short: 'v', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const dir = stateDir();
const json = flags.json;
const require = createRequire(import.meta.url);
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function printResponse(res: RpcResponse): never {
  if (json) process.stdout.write(JSON.stringify(res.ok ? res.result : { error: res.error }, null, 2) + '\n');
  else if (res.ok) process.stdout.write((res.text ?? '') + '\n');
  else process.stderr.write(`error ${formatError(res.error!)}\n`);
  const r = res.result as { outcome?: string; verdict?: { result?: string } } | undefined;
  const actionFailed = res.ok && (r?.outcome === 'error' || (r?.verdict?.result !== undefined && r.verdict.result !== 'pass'));
  process.exit(res.ok && !actionFailed ? 0 : 1);
}

function fail(error: LabErrorJSON): never {
  printResponse({ ok: false, error });
}

function usage(message: string): never {
  fail({ code: 'invalid_request', message, hint: 'Run `agentlab help`.', recoverable: true });
}

const toNumber = (v: string | undefined, name: string, signed = false) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || (!signed && n < 0)) usage(`--${name} must be a ${signed ? '' : 'non-negative '}number`);
  return n;
};

async function call(command: string, args: Record<string, unknown> = {}): Promise<never> {
  const state = readState(dir);
  if (!state || daemonCheck(state) !== 'same') {
    if (state) clearState(dir);
    fail({ code: 'no_session', message: 'No session is running in this directory', hint: 'Run `agentlab start --project <dir>` first.', recoverable: false });
  }
  try {
    printResponse(await rpc(state.socket, command, args));
  } catch (err) {
    fail({ code: 'no_session', message: `Cannot reach the session daemon: ${(err as Error).message}`, hint: 'Run `agentlab stop`, then start again.', recoverable: false });
  }
}

/** --name/--role, or a ref taken from the positionals. */
function targetArgs(rest: string[], required: boolean, command: string): Record<string, unknown> {
  if (flags.name !== undefined) return { name: flags.name, ...(flags.role ? { role: flags.role } : {}) };
  const ref = rest[0] && /^e\d+$/.test(rest[0]) ? rest.shift() : undefined;
  if (!ref && required) usage(`${command} needs a ref (e.g. e3) or --name`);
  return ref ? { ref } : {};
}

async function start(): Promise<never> {
  if (flags.auth !== undefined && !['auto', 'saved', 'fresh'].includes(flags.auth)) usage('--auth must be auto, saved or fresh');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = readState(dir);
  if (existing && daemonCheck(existing) === 'same') {
    fail({ code: 'session_exists', message: `A session daemon (pid ${existing.pid}) is already running here`, hint: 'Use it, or run `agentlab stop` first.', recoverable: false });
  }
  if (existing) clearState(dir);

  const log = openSync(paths(dir).log, 'a', 0o600);
  const daemon = spawn(process.execPath, [fileURLToPath(new URL('../daemon/main.js', import.meta.url)), dir, ...(flags.ui === false ? ['--no-ui'] : [])], {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  daemon.unref();

  // Wait for the daemon's socket.
  const deadline = Date.now() + 10_000;
  let exited = false;
  daemon.once('exit', () => { exited = true; });
  while (!(readState(dir)?.pid === daemon.pid && existsSync(paths(dir).socket))) {
    if (exited || Date.now() > deadline) {
      fail({ code: 'startup_failed', message: `Session daemon did not start; see ${paths(dir).log}`, recoverable: false });
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const res = await rpc(paths(dir).socket, 'start', {
    project: resolve(flags.project ?? '.'),
    ...(flags.device ? { device: flags.device } : {}),
    headed: flags.headed === true,
    ...(flags['slow-mo'] ? { slowMoMs: toNumber(flags['slow-mo'], 'slow-mo') } : {}),
    ...(flags.auth ? { auth: flags.auth } : {}),
    ...(flags.trace ? { trace: true } : {}),
  });
  if (res.ok && !json) res.text += `\n\naction log: agentlab log -f   (or tail -f ${paths(dir).log})${flags.ui === false ? '' : '\nwatch live: agentlab ui'}`;
  printResponse(res);
}

function showDashboard(url: string, open: boolean, write: (s: string) => void): void {
  write(`dashboard: ${url}\n`);
  if (!open) return;
  if (openInBrowser(url)) write('opened in your browser\n');
  else write(`no desktop display detected (DISPLAY/WAYLAND_DISPLAY unset); open the URL in a browser on this machine,\nor forward the port: ssh -L ${new URL(url).port}:127.0.0.1:${new URL(url).port} <this host>\n`);
}

async function ui(): Promise<never> {
  const state = readState(dir);
  if (!state || daemonCheck(state) !== 'same') {
    // No CLI session here: an MCP server started from this directory may be serving one.
    const mcp = readDashboardRecord(dir);
    if (mcp) {
      if (json) process.stdout.write(JSON.stringify({ url: mcp.url, source: 'mcp', opened: flags.open && hasDisplay() && openInBrowser(mcp.url) }) + '\n');
      else showDashboard(mcp.url, flags.open!, (s) => process.stdout.write(s));
      process.exit(0);
    }
    fail({ code: 'no_session', message: 'No session is running in this directory', hint: 'Run `agentlab start --project <dir>` first (or run this where the MCP server was started).', recoverable: false });
  }
  if (!state.dashboard) {
    fail({ code: 'invalid_request', message: 'This session was started with --no-ui, so it has no dashboard', hint: 'Stop it and start again without --no-ui.', recoverable: false });
  }
  if (json) process.stdout.write(JSON.stringify({ url: state.dashboard.url, opened: flags.open && hasDisplay() && openInBrowser(state.dashboard.url) }) + '\n');
  else showDashboard(state.dashboard.url, flags.open!, (s) => process.stdout.write(s));
  process.exit(0);
}

/** `run --ui`: serve the dashboard for this in-process flow and give a viewer a chance to connect first. */
async function runWithDashboard(flow: string): Promise<boolean> {
  const feed = new SessionFeed();
  let lab: Lab | undefined;
  const dashboard = await Dashboard.listen({
    feed, source: () => lab,
    control: (op, by) => { if (!lab) throw new LabError('no_session', 'The flow has not started yet'); return lab.supervise(op as ControlOp, by); },
    input: (i) => { if (!lab) throw new LabError('no_session', 'The flow has not started yet'); return lab.humanInput(i as HumanInput); },
  });
  const err = (s: string) => process.stderr.write(s);
  onTermination(async (signal) => { await lab?.close(`interrupted by ${signal}`); await dashboard.close().catch(() => undefined); }, { stateDir: dir });
  showDashboard(dashboard.url, flags.open!, err);
  const deadline = Date.now() + 30_000;
  while (!dashboard.getStats().viewers.events && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  err(dashboard.getStats().viewers.events ? 'dashboard connected; running\n' : 'no dashboard connected after 30 s; running anyway\n');
  try {
    return await runFlow(flow, {
      headed: flags.headed === true, device: flags.device, slowMoMs: toNumber(flags['slow-mo'], 'slow-mo'), json, stateDir: dir,
      lab: { onEvent: (e) => feed.apply(e), evidenceFrames: true }, onLab: (l) => { lab = l; },
    });
  } finally {
    await holdIfTerminating();
    await new Promise((r) => setTimeout(r, 300)); // let the final status reach the viewer
    await dashboard.close();
  }
}

function scanArgs(route?: string): Record<string, unknown> {
  return {
    ...(route ? { route } : {}), ...(flags.scenario ? { scenarios: flags.scenario } : {}), ...(flags.devices ? { devices: flags.devices } : {}),
    ...(flags.explore !== undefined ? { explore: flags.explore } : {}),
  };
}

/**
 * `scan --project`: start the project (headless unless --headed), scan it, stop what was started.
 * Exit 0 when the policy passes, 1 when it fails, 2 when the scan could not run.
 */
async function scanStandalone(route?: string): Promise<never> {
  if (flags.auth !== undefined && !['auto', 'saved', 'fresh'].includes(flags.auth)) usage('--auth must be auto, saved or fresh');
  const feed = flags.ui ? new SessionFeed() : undefined;
  let lab: Lab | undefined;
  const dashboard = feed ? await Dashboard.listen({
    feed, source: () => lab,
    control: (op, by) => lab!.supervise(op as ControlOp, by),
    input: (i) => lab!.humanInput(i as HumanInput),
  }) : undefined;
  if (dashboard) showDashboard(dashboard.url, flags.open!, (s) => process.stderr.write(s));
  lab = new Lab({ stateDir: dir, ...(feed ? { onEvent: (e) => feed.apply(e), evidenceFrames: true } : {}) });
  let code = 2;
  onTermination(async (signal) => { await lab?.close(`interrupted by ${signal}`); await dashboard?.close().catch(() => undefined); }, { stateDir: dir });
  try {
    await lab.start({
      project: resolve(flags.project!), ...(flags.device ? { device: flags.device } : {}), headed: flags.headed === true,
      ...(flags.auth ? { auth: flags.auth as 'auto' | 'saved' | 'fresh' } : {}),
    });
    const a = scanArgs(route);
    const list = (v: unknown) => typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
    const result = await lab.scan({ route: a.route as string | undefined, scenarios: list(a.scenarios), devices: list(a.devices), explore: a.explore as boolean | undefined });
    process.stdout.write(json ? JSON.stringify(scanSummary(result), null, 2) + '\n' : formatScan(result) + '\n');
    code = result.verdict.result === 'pass' ? 0 : 1;
  } catch (err) {
    process.stderr.write(`error ${formatError(LabError.from(err).toJSON())}\n`);
  } finally {
    await lab.close('scan finished');
    if (dashboard) { await new Promise((r) => setTimeout(r, 300)); await dashboard.close(); }
  }
  await holdIfTerminating();
  process.exit(code);
}

/** The CI commands (`test`, `sweep --project`, `scenario --project`): see docs/ci.md. */
function ci(command: 'test' | 'sweep' | 'scenario', positional: string[]): Promise<never> {
  return runCi({
    command, positionals: positional, project: resolve(flags.project ?? '.'), stateDir: dir, validateOnly: flags['validate-only'], headed: flags.headed === true, json,
    ...(flags.devices ? { devices: flags.devices } : {}), ...(flags.flows !== undefined ? { flows: flags.flows } : {}),
    ...(flags.routes !== undefined ? { routes: flags.routes } : {}), ...(flags.scenarios !== undefined ? { scenarios: flags.scenarios } : {}),
    ...(flags['fail-on'] ? { failOn: flags['fail-on'] } : {}), ...(flags['fail-on-heuristic'] !== undefined ? { failOnHeuristic: flags['fail-on-heuristic'] } : {}),
    ...(flags['scenario-errors'] ? { scenarioErrors: flags['scenario-errors'] } : {}), ...(flags.out ? { out: flags.out } : {}),
    ...(flags.format ? { format: flags.format } : {}), ...(flags['trace-mode'] ? { trace: flags['trace-mode'] } : {}),
    ...(flags.evidence ? { evidence: flags.evidence } : {}), ...(flags.timeout ? { timeout: flags.timeout } : {}), ...(flags.auth ? { auth: flags.auth } : {}),
  });
}

async function stop(): Promise<never> {
  const state = readState(dir);
  if (!state) {
    const notes = await reapOrphans(dir);
    process.stdout.write(['no session running', ...notes].join('; ') + '\n');
    process.exit(0);
  }
  const daemon = daemonCheck(state);
  if (daemon === 'same') {
    try {
      const res = await rpc(state.socket, 'stop');
      // Wait for the daemon to exit so a following `start` never races it.
      for (let i = 0; i < 100 && daemonCheck(state) === 'same'; i++) await new Promise((r) => setTimeout(r, 50));
      printResponse(res);
    } catch { /* unreachable daemon: fall through to recovery */ }
    if (daemonCheck(state) === 'same') {
      try { process.kill(state.pid, 'SIGTERM'); } catch { /* gone */ }
    }
  }
  const notes = [describeDaemon(state, daemon), ...await recoverServices(state)];
  clearState(dir);
  notes.push(...await reapOrphans(dir));
  process.stdout.write(notes.join('; ') + '\n');
  process.exit(0);
}

function describeDaemon(state: DaemonState, check: IdentityCheck): string {
  switch (check) {
    case 'same': return `session daemon ${state.pid} did not answer and was sent SIGTERM`;
    case 'gone': return `session daemon ${state.pid} had already exited`;
    case 'reused': return `stale record: pid ${state.pid} now belongs to another process, which was not signalled`;
    case 'unverifiable': return `record for pid ${state.pid} has no process identity (older format); nothing was signalled`;
  }
}

/**
 * Recovery for a daemon that died without cleanup: stop only owned process groups whose identity still
 * matches. A one-shot service's stop command is named for the person to run; its containers cannot be
 * proved to still be the ones the lab started.
 */
async function recoverServices(state: DaemonState): Promise<string[]> {
  const records = state.services ?? (state.server ? [{ name: 'web', mode: 'process' as const, ...state.server }] : []);
  return stopRecordedServices(records);
}

/** `clean`: stop what crashed sessions left running (ownership records) and prune old runs. */
async function clean(): Promise<never> {
  const notes = await reapOrphans(dir);
  const state = readState(dir);
  const removed = pruneRuns(dir, keepRuns(), liveSessionIds(dir).add(state?.sessionId ?? ''));
  const lines = [...notes, removed.length ? `pruned ${removed.length} old run${removed.length > 1 ? 's' : ''} (keeping the latest ${keepRuns()})` : 'no old runs to prune'];
  if (!notes.length) lines.unshift('no services left behind by earlier sessions');
  if (json) process.stdout.write(JSON.stringify({ reaped: notes, prunedRuns: removed }, null, 2) + '\n');
  else process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}

function contractsLine(): string {
  const c = CONTRACT_VERSIONS;
  return `contracts: profile ${c.profile} (reads ${c.profileSupported[0]}–${c.profileSupported.at(-1)}), results ${c.results}, mcp tools ${c.mcpTools}, report ${c.report}, bundle ${c.bundle}, events ${c.events}`;
}

async function version(): Promise<never> {
  const pwDir = dirname(require.resolve('playwright/package.json'));
  const pw = (JSON.parse(readFileSync(join(pwDir, 'package.json'), 'utf8')) as { version: string }).version;
  const { chromium } = await import('playwright');
  const exe = chromium.executablePath();
  const info = { agentlab: productVersion(), node: process.versions.node, playwright: pw, chromium: { executable: exe, installed: existsSync(exe) }, installedAt: PACKAGE_ROOT, stateDir: dir, contracts: CONTRACT_VERSIONS };
  if (json) process.stdout.write(JSON.stringify(info, null, 2) + '\n');
  else {
    process.stdout.write(`agentlab ${info.agentlab}\nnode ${info.node}\nplaywright ${pw}; chromium ${info.chromium.installed ? 'installed' : 'NOT installed (run `agentlab install-browser`)'} at ${exe}\ninstalled at ${PACKAGE_ROOT}\n${contractsLine()}\n`);
  }
  process.exit(0);
}

function installBrowser(): never {
  // Playwright's own CLI from this package's dependency, so the browser build matches the pinned version.
  const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
  const args = [cli, 'install', ...(flags['with-deps'] ? ['--with-deps'] : []), 'chromium'];
  process.stderr.write(`running: ${process.execPath} ${args.join(' ')}\n`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

async function doctor(): Promise<never> {
  const state = readState(dir);
  const report = await runDoctor({
    cwd: process.cwd(), ...(flags.project ? { project: resolve(flags.project) } : {}), stateDir: dir, launch: flags.launch,
    ...(state ? { daemon: { pid: state.pid, check: daemonCheck(state) } } : {}),
  });
  process.stdout.write(json ? JSON.stringify(report, null, 2) + '\n' : `agentlab ${productVersion()} doctor\n${formatDoctor(report)}\n`);
  process.exit(report.ok ? 0 : 1);
}

async function init(target?: string): Promise<never> {
  const project = resolve(target ?? '.');
  const proposal = await proposeProfile(project);
  if (json && (flags.print || !flags.yes)) {
    process.stdout.write(JSON.stringify(proposal, null, 2) + '\n');
    process.exit(0);
  }
  if (!json) process.stdout.write(formatProposal(proposal) + '\n');
  if (flags.print) process.exit(0);
  if (proposal.existing && !flags.force) {
    process.stdout.write(`\nagentlab.json already exists; nothing written. Re-run with --force to replace it.\n`);
    process.exit(0);
  }
  let write = flags.yes;
  if (!write) {
    if (!process.stdin.isTTY) {
      process.stdout.write('\nNothing written (not interactive). Review the proposal, then re-run with --yes to save it.\n');
      process.exit(0);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nWrite ${join(project, 'agentlab.json')}${proposal.gitignore.ignoresState ? '' : ' and add .agentlab/ to .gitignore'}? [y/N] `);
    rl.close();
    write = /^y(es)?$/i.test(answer.trim());
  }
  if (!write) {
    process.stdout.write('Nothing written.\n');
    process.exit(0);
  }
  const saved = await writeProposal(proposal, { force: flags.force });
  const out = { written: saved.profilePath, gitignoreUpdated: saved.gitignoreUpdated };
  process.stdout.write(json ? JSON.stringify(out) + '\n'
    : `wrote ${saved.profilePath}${saved.gitignoreUpdated ? '; added .agentlab/ to .gitignore' : ''}\nnext: agentlab doctor, then agentlab start\n`);
  process.exit(0);
}

/** A copy of a profile for display, with env values whose names look secret replaced. */
function maskSecretEnv(profile: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(profile);
  const services = (copy.services ?? {}) as Record<string, { env?: Record<string, unknown> }>;
  for (const svc of [...Object.values(services), copy.web as { env?: Record<string, unknown> } | undefined]) {
    for (const k of Object.keys(svc?.env ?? {})) if (SECRET_NAME.test(k)) svc!.env![k] = '‹redacted›';
  }
  return copy;
}
const SECRET_NAME = /secret|token|passw|api[_-]?key|auth|cookie|session|private|credential/i;

function bundlesDir(): string {
  return resolve(flags.dir ?? join(dir, 'bundles'));
}

/** `agentlab bundles [list] | show <id> | rm <id> | prune`. */
async function bundles(sub = 'list', id?: string): Promise<never> {
  const root = bundlesDir();
  const say = (s: string) => process.stdout.write(s + '\n');
  try {
    switch (sub) {
      case 'list': {
        const all = listBundles(root);
        if (json) say(JSON.stringify({ dir: root, bundles: all }, null, 2));
        else if (!all.length) say(`no bundles in ${root}`);
        else for (const b of all) say(`${b.id}  ${b.createdAt.slice(0, 19)}  ${b.failure.padEnd(14)} ${b.actions} actions, ${b.findings} findings${b.trace ? ', trace' : ''}  ${b.reason.slice(0, 80)}`);
        break;
      }
      case 'show': {
        if (!id) return usage('bundles show needs a bundle id');
        const b = loadBundle(join(root, id));
        if (json) { say(JSON.stringify(b, null, 2)); break; }
        say(`${b.id}  ${b.retention.createdAt}  (expires ${b.retention.expiresAt.slice(0, 10)})\nreason: ${b.reason}\nfailure: ${JSON.stringify(b.failure)}`);
        say(`project ${b.project.name}  device ${b.session.device}  auth ${b.session.auth}  start ${b.session.startRoute}  route now ${b.route}`);
        say(`agentlab ${b.product.version}  ${b.environment.platform}/${b.environment.arch}  node ${b.environment.node}  chromium ${b.environment.chromium}${b.environment.ci ? '  CI' : ''}`);
        for (const a of b.actions) {
          say(a.actor === 'person' ? `  ${a.index}  a person: ${a.description}`
            : `  ${a.index}  ${a.action}${a.target ? ` ${a.target.role} ${JSON.stringify(a.target.name)}` : ''}${a.secret ? '  ‹secret›' : ''}  ${a.routeBefore ?? '?'} → ${a.routeAfter ?? '?'}  ${a.outcome === 'error' ? `ERROR ${a.error?.code}` : 'ok'}${a.consequential ? '  (consequential)' : ''}`);
        }
        if (b.actionsOmitted) say(`  (${b.actionsOmitted} earlier action(s) dropped from the log)`);
        say(`${b.findings.length} findings, ${b.consoleErrors.length} console errors, ${b.failedRequests.length} failed requests, ${b.frames.length} frames${b.trace ? ', sanitized trace' : b.traceDropped ? `, trace left out (${b.traceDropped})` : ''}`);
        break;
      }
      case 'rm':
        if (!id) return usage('bundles rm needs a bundle id');
        removeBundle(root, id);
        say(`removed ${id}`);
        break;
      case 'prune': {
        const days = toNumber(flags['older-than'], 'older-than');
        const removed = pruneBundles(root, { ...(days !== undefined ? { maxAgeDays: days } : {}) });
        const limits = retentionLimits();
        say(json ? JSON.stringify({ removed }) : `removed ${removed.length} bundle(s)${removed.length ? `: ${removed.join(', ')}` : ''} (keeping the newest ${limits.keep}, at most ${days ?? limits.maxAgeDays} days old)`);
        break;
      }
      default: return usage('bundles takes list, show <id>, rm <id> or prune');
    }
  } catch (err) {
    process.stderr.write(`error ${formatError(LabError.from(err).toJSON())}\n`);
    process.exit(2);
  }
  process.exit(0);
}

/** `agentlab replay <bundle>`: exit 0 reproduced, 1 not reproduced, 2 could not run, 3 diverged or blocked. */
async function replay(target?: string): Promise<never> {
  if (!target) return usage('replay needs a bundle directory or bundle.json');
  const secrets: Record<number, string> = {};
  for (const spec of flags.secret ?? []) {
    const m = /^(\d+)=(.+)$/.exec(spec);
    if (!m) return usage('--secret takes <step>=<ENV_NAME>, e.g. --secret 2=MY_PASSWORD');
    secrets[Number(m[1])] = m[2]!;
  }
  const until = toNumber(flags.until, 'until');
  let running: Lab | undefined;
  onTermination(async (signal) => { await running?.close(`interrupted by ${signal}`); }, { stateDir: dir });
  try {
    const result = await replayBundle({
      bundle: target, ...(flags.project ? { project: flags.project } : {}), stateDir: dir, headed: flags.headed,
      allowConsequential: flags['allow-consequential'], secrets, ...(until !== undefined ? { until } : {}),
      onLab: (l) => { running = l; },
    });
    await holdIfTerminating();
    process.stdout.write(json ? JSON.stringify(result, null, 2) + '\n' : formatReplay(result) + '\n');
    process.exit(replayExitCode(result));
  } catch (err) {
    process.stderr.write(`error ${formatError(LabError.from(err).toJSON())}\n`);
    process.exit(2);
  }
}

async function migrate(): Promise<never> {
  let file = resolve(flags.project ?? '.');
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, PROFILE_FILE);
  let migration;
  try {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      // Never echo the parser's message: V8 quotes the file's text around the error, which may hold values.
      const at = /position (\d+)/.exec((err as Error).message)?.[1];
      const why = (err as NodeJS.ErrnoException).code ? `cannot read it (${(err as NodeJS.ErrnoException).code})` : `not valid JSON${at ? ` (at character ${at})` : ''}`;
      throw new LabError('invalid_profile', `${file}: ${why}`, { hint: 'Pass --project <dir|file> for the agentlab.json to migrate.' });
    }
    migration = migrateProfile(raw);
  } catch (err) {
    fail(LabError.from(err).toJSON());
  }
  const { changed, from, to, notes, profile } = migration;
  if (!changed) {
    process.stdout.write(json ? JSON.stringify({ changed, from, to }) + '\n' : `${basename(file)} is already schemaVersion ${to}; nothing to do\n`);
    process.exit(0);
  }
  const text = JSON.stringify(profile, null, 2) + '\n';
  const backup = `${file}.v1.bak`;
  // What is shown masks secret-looking env values; the file written keeps them as they were.
  const shown = maskSecretEnv(profile);
  if (json && (flags.print || !flags.yes)) {
    process.stdout.write(JSON.stringify({ changed, from, to, notes, profile: shown }, null, 2) + '\n');
    process.exit(0);
  }
  if (!json) process.stdout.write(`${file}: schemaVersion ${from} → ${to}\n${notes.map((n) => `  - ${n}`).join('\n')}\n\n${JSON.stringify(shown, null, 2)}\n`);
  if (flags.print) process.exit(0);
  if (existsSync(backup) && !flags.force) {
    fail({ code: 'invalid_request', message: `${backup} already exists; nothing written`, hint: 'Move it away, or re-run with --force to overwrite the backup.', recoverable: true });
  }
  let write = flags.yes;
  if (!write) {
    if (!process.stdin.isTTY) {
      process.stdout.write('\nNothing written (not interactive). Review the result, then re-run with --yes to save it.\n');
      process.exit(0);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nRewrite ${file} (backup: ${backup})? [y/N] `);
    rl.close();
    write = /^y(es)?$/i.test(answer.trim());
  }
  if (!write) {
    process.stdout.write('Nothing written.\n');
    process.exit(0);
  }
  // Back up the original bytes, then replace the file atomically (same directory, same mode).
  copyFileSync(file, backup);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  chmodSync(tmp, statSync(file).mode & 0o777);
  renameSync(tmp, file);
  process.stdout.write(json ? JSON.stringify({ changed, from, to, notes, written: file, backup }) + '\n' : `wrote ${file}; original kept as ${backup}\nnext: agentlab doctor\n`);
  process.exit(0);
}

async function auth(sub: string | undefined): Promise<never> {
  if (sub === 'save') return call('auth_save');
  if (sub !== 'status' && sub !== 'clear') usage('auth needs save, status or clear');
  let profile;
  try {
    profile = await loadProfile(resolve(flags.project ?? '.'));
  } catch (err) {
    fail(LabError.from(err).toJSON());
  }
  const status = authStatus(profile.auth, profile.root);
  if (sub === 'clear') {
    rmSync(profile.auth.file, { force: true });
    process.stdout.write(json ? JSON.stringify({ cleared: status.exists, file: status.file }) + '\n' : status.exists ? `removed ${status.file}\n` : `no saved sign-in state at ${status.file}\n`);
    process.exit(0);
  }
  if (json) process.stdout.write(JSON.stringify(status, null, 2) + '\n');
  else if (!status.exists) process.stdout.write(`no saved sign-in state (${status.file})\n`);
  else {
    process.stdout.write(`${status.file}: ${status.cookies ?? '?'} cookies, ${status.origins ?? '?'} origins with storage, mode ${status.mode}${status.ownerOnly ? '' : ' (TOO OPEN)'}` +
      `${status.expired ? ', expired' : ''}${status.ignored === false ? ', NOT ignored by git' : ''}${status.problem ? `, ${status.problem}` : ''}\n`);
  }
  process.exit(0);
}

async function main(): Promise<void> {
  const [command, ...rest] = positionals;
  if (flags.version || command === 'version' || command === '--version') return version();
  if (flags.help || !command || command === 'help') {
    process.stdout.write(HELP + '\n');
    return;
  }
  switch (command) {
    case 'init': return init(rest[0]);
    case 'migrate': return migrate();
    case 'doctor': return doctor();
    case 'install-browser': return installBrowser();
    case 'start': return start();
    case 'stop': case 'close': return stop();
    case 'clean': return clean();
    case 'ui': return ui();
    case 'scan': return flags.project !== undefined ? scanStandalone(rest[0]) : call('scan', scanArgs(rest[0]));
    case 'sweep':
      return flags.project !== undefined ? ci('sweep', rest) : call('sweep', { ...(rest[0] ? { route: rest[0] } : {}), ...(flags.devices ? { devices: flags.devices } : {}) });
    case 'scenario':
      return flags.project !== undefined ? ci('scenario', rest) : call('scan', { ...(rest.length ? { scenarios: rest.join(',') } : {}), ...(flags.devices ? { devices: flags.devices } : {}) });
    case 'test': return ci('test', rest);
    case 'report': return runReport(rest[0], flags.format, flags.out);
    case 'status': return call('status');
    case 'bundle': return call('bundle', flags.note ? { note: flags.note } : {});
    case 'bundles': return bundles(rest[0], rest[1]);
    case 'replay': return replay(rest[0]);
    case 'tabs': return call('tabs');
    case 'tab': {
      const [sub, arg] = rest;
      if (sub === 'open') return arg ? call('open_tab', { path: arg }) : usage('tab open needs a path, e.g. /help');
      if (sub === 'switch') return arg ? call('switch_tab', { tab: arg }) : usage('tab switch needs a tab id, e.g. t2');
      if (sub === 'close') return call('close_tab', arg ? { tab: arg } : {});
      return usage('tab needs open, switch or close');
    }
    case 'auth': return auth(rest[0]);
    case 'inspect': {
      const [id] = rest;
      return call('inspect', id ? (/^e\d+$/.test(id) ? { ref: id } : { id }) : {});
    }
    case 'observe': return call('observe', flags.limit ? { limit: toNumber(flags.limit, 'limit') } : {});
    case 'click': case 'fill': case 'act': {
      const action = command === 'act' ? rest.shift() : command;
      if (action !== 'click' && action !== 'fill') usage('act needs click or fill');
      const target = targetArgs(rest, true, action);
      const value = action === 'fill' ? rest.shift() : undefined;
      if (action === 'fill' && value === undefined) usage('fill needs the text to enter');
      return call(action, { ...target, ...(value !== undefined ? { value } : {}) });
    }
    case 'press': {
      const key = rest.shift();
      if (!key) usage('press needs a key, e.g. Enter');
      return call('press', { key, ...targetArgs(rest, false, command) });
    }
    case 'select': {
      const target = targetArgs(rest, true, command);
      if (!rest.length) usage('select needs at least one option label or value');
      return call('select', { ...target, values: rest });
    }
    case 'check': case 'uncheck': case 'hover': return call(command, targetArgs(rest, true, command));
    case 'scroll': case 'swipe': {
      const direction = rest[0] && ['up', 'down', 'left', 'right'].includes(rest[0]) ? rest.shift() : undefined;
      if (command === 'swipe' && !direction) usage('swipe needs a direction: left, right, up or down');
      const target = targetArgs(rest, false, command);
      if (!direction && !target.ref && !target.name) usage('scroll needs a direction, a ref, or both');
      return call(command, { ...(direction ? { direction } : {}), ...target, ...(flags.amount ? { amount: toNumber(flags.amount, 'amount') } : {}) });
    }
    case 'back': case 'forward': return call(command);
    case 'upload': {
      const target = targetArgs(rest, true, command);
      if (!rest.length) usage('upload needs at least one file');
      return call('upload', { ...target, files: rest });
    }
    case 'drag': {
      const target = targetArgs(rest, true, command);
      const toRef = flags.to ?? rest.shift();
      if (!toRef && flags.dx === undefined && flags.dy === undefined) usage('drag needs --to <ref>, or --dx/--dy');
      return call('drag', { ...target, ...(toRef ? { toRef } : {}), ...(flags.dx !== undefined ? { dx: toNumber(flags.dx, 'dx', true) } : {}), ...(flags.dy !== undefined ? { dy: toNumber(flags.dy, 'dy', true) } : {}) });
    }
    case 'log': {
      const file = paths(dir).log;
      if (!existsSync(file)) { process.stdout.write('no log yet\n'); return; }
      if (!flags.follow) { process.stdout.write(readFileSync(file, 'utf8')); return; }
      spawn('tail', ['-n', '+1', '-f', file], { stdio: 'inherit' });
      return;
    }
    case 'mcp':
      // stdout belongs to the MCP protocol from here on.
      return runMcpServer({ stateDir: dir, headless: flags.headed !== true, ui: flags.ui !== false });
    case 'devices':
      for (const d of Object.values(DEVICES)) process.stdout.write(`${d.id}\t${d.label}\n`);
      return;
    case 'run': {
      const flow = rest[0];
      if (!flow) usage('run needs a flow file');
      let running: Lab | undefined;
      if (!flags.ui) onTermination(async (signal) => { await running?.close(`interrupted by ${signal}`); }, { stateDir: dir });
      const ok = flags.ui ? await runWithDashboard(flow) : await runFlow(flow, {
        headed: flags.headed === true, device: flags.device, slowMoMs: toNumber(flags['slow-mo'], 'slow-mo'), json, stateDir: dir,
        onLab: (l) => { running = l; },
      });
      await holdIfTerminating();
      process.exit(ok ? 0 : 1);
    }
    case 'state-dir':
      process.stdout.write(`${dir}\n(user state root: ${userStateRoot()})\n`);
      return;
    default:
      usage(`Unknown command "${command}"`);
  }
}

main().catch((err) => {
  process.stderr.write(`agentlab: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
