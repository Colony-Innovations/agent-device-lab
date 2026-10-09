// Long-lived session process. `agentlab start` spawns it detached; later CLI invocations talk to it
// over a unix socket. It owns the browser, the session and any server it started, and writes an
// ordered action log to stdout (redirected to .agentlab/daemon.log). Unless started with --no-ui it
// also serves the live dashboard on 127.0.0.1.
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { SessionHost, dispatch } from '../core/commands.js';
import { SessionFeed } from '../core/feed.js';
import { formatAction, formatClose, formatControlChange, formatHuman, formatService } from '../core/format.js';
import type { HumanInput, LabEvent } from '../core/lab.js';
import type { ControlOp } from '../core/control.js';
import { identify } from '../core/process-identity.js';
import { Dashboard } from '../dashboard/server.js';
import { clearState, paths, writeState, type DaemonState, type RpcResponse } from './state.js';

const dir = process.argv[2];
const ui = !process.argv.includes('--no-ui');
if (!dir) {
  console.error('usage: daemon <stateDir> [--no-ui]');
  process.exit(2);
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
const { socket } = paths(dir);

const ts = () => new Date().toISOString().slice(11, 23);
const logBlock = (head: string, body?: string) => {
  process.stdout.write(`[${ts()}] ${head}\n`);
  if (body) process.stdout.write(body.split('\n').map((l) => `    ${l}`).join('\n') + '\n');
};

/** The service output echoed into daemon.log stops here (env AGENTLAB_DAEMON_ECHO_MAX_BYTES); the service's own log file is capped separately. */
const echoMax = Number(process.env.AGENTLAB_DAEMON_ECHO_MAX_BYTES) > 0 ? Number(process.env.AGENTLAB_DAEMON_ECHO_MAX_BYTES) : 5 * 1024 * 1024;
let echoed = 0;
function echoServerLine(line: string): void {
  if (echoed > echoMax) return;
  const text = `[${ts()}] [web] ${line}\n`;
  echoed += Buffer.byteLength(text);
  if (echoed > echoMax) process.stdout.write(`[${ts()}] [web] … server output in this log stopped at ${echoMax} bytes; the full output is in the run's service log files\n`);
  else process.stdout.write(text);
}

const state: DaemonState = { pid: process.pid, daemon: identify(process.pid), socket, startedAt: new Date().toISOString() };

const feed = new SessionFeed();

function onEvent(e: LabEvent): void {
  feed.apply(e);
  switch (e.kind) {
    case 'server-log': echoServerLine(e.line); break;
    case 'start': {
      const { session, server, observation } = e.result;
      state.sessionId = session.id;
      state.server = { url: server.url, owned: server.owned, pid: server.pid, identity: host.lab.serverIdentity() };
      state.services = host.lab.serviceRecords();
      writeState(dir!, state);
      logBlock(`start ${session.id} ${session.device.id} ${session.browser.headed ? 'headed' : 'headless'}; server ${server.owned ? `started pid ${server.pid} (owned)` : 'reused (not owned)'}; route ${observation.route}`);
      if (e.result.services.length > 1) logBlock('services', e.result.services.map(formatService).join('\n'));
      break;
    }
    case 'observe': logBlock(`observe gen ${e.observation.gen} route ${e.observation.route} controls ${e.observation.controls.length} layout flags ${e.observation.layout.length}`); break;
    case 'act': {
      const [head, ...rest] = formatAction(e.result).split('\n');
      // Keep the log readable: a navigation embeds a full observation, which the log does not need.
      logBlock(head ?? '', rest.filter((l) => /^(note|changed|console):/.test(l)).join('\n'));
      break;
    }
    case 'control': logBlock(`control: ${formatControlChange(e.change)}`); break;
    case 'human': logBlock(`person ${formatHuman(e.action)}`); break;
    case 'refused': logBlock(`${e.command} refused: ${e.error.code}`); break;
    case 'closed':
      logBlock(formatClose(e.result));
      shutdown(0);
      break;
  }
}

const host = new SessionHost({ stateDir: dir, onEvent, evidenceFrames: ui });
const dashboard = ui ? await Dashboard.listen({
  feed, source: () => host.lab,
  control: (op, by) => host.supervise(op as ControlOp, by),
  input: (i) => host.lab.humanInput(i as HumanInput),
}) : undefined;
if (dashboard) {
  // Agents get the view-only URL; the person's control URL stays in the owner-only daemon.json (`agentlab ui`).
  host.dashboardUrl = () => dashboard.viewUrl;
  state.dashboard = { url: dashboard.url };
}
let queue: Promise<unknown> = Promise.resolve();
let shuttingDown = false;

const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/rpc') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    // Commands run strictly one at a time against the single page.
    queue = queue.then(async () => {
      let response: RpcResponse;
      let command = '?';
      let args: unknown;
      try {
        ({ command, args } = JSON.parse(body) as { command: string; args?: unknown });
      } catch { /* dispatch reports the unknown command */ }
      const out = await dispatch(host, 'cli', command, args);
      if (out.ok) {
        response = { ok: true, result: out.output.result, text: out.output.text };
      } else {
        response = { ok: false, error: out.error };
        logBlock(`${command} failed: ${out.error.code}: ${out.error.message}`);
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response));
      if (command === 'start' && !response.ok) shutdown(1);
    });
  });
});

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // Give in-flight responses (and the dashboard's final status) a moment to flush first.
  setTimeout(async () => {
    server.close();
    clearState(dir!);
    await dashboard?.close().catch(() => undefined);
    process.exit(code);
  }, 100);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    logBlock(`received ${sig}`);
    void host.lab.close(`daemon received ${sig}`).then(() => shutdown(0));
  });
}
process.on('uncaughtException', (err) => {
  logBlock(`uncaught error: ${err.stack ?? err.message}`);
  void host.lab.close('daemon crashed').finally(() => shutdown(1));
});

rmSync(socket, { force: true });
// Only the owner may connect: bind under a restrictive umask (the fallback path lives in the shared temp
// directory), then set the mode explicitly.
const previousUmask = process.umask(0o177);
server.listen(socket, () => {
  chmodSync(socket, 0o600);
  writeState(dir, state);
  logBlock(`daemon ${process.pid} listening on ${socket}${dashboard ? `; dashboard on ${dashboard.origin}` : ''}`);
});
process.umask(previousUmask);
