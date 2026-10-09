import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { checkIdentity, identify, type IdentityCheck, type ProcessIdentity } from '../core/process-identity.js';
import type { ServiceRecord } from '../core/lab.js';
import type { LabErrorJSON } from '../core/schema.js';

// Where the per-repository daemon keeps its socket, state and logs.

export interface DaemonState {
  pid: number;
  /** Verified before the CLI trusts or signals the daemon; a bare pid may have been reused. */
  daemon?: ProcessIdentity;
  socket: string;
  startedAt: string;
  sessionId?: string;
  /** Live dashboard, including its access token; the file is written owner-read/write only. */
  dashboard?: { url: string };
  /** Older records: the single server. */
  server?: { url: string; owned: boolean; pid?: number; identity?: ProcessIdentity };
  /** Recorded so `agentlab stop` can clean up owned services even if the daemon died. */
  services?: ServiceRecord[];
}

/**
 * Where runs, logs and the daemon record live. AGENTLAB_HOME wins. A directory that was initialised
 * (it has agentlab.json or .agentlab/) keeps them in ./.agentlab; anywhere else they go under the
 * user's state directory, so running agentlab never litters an unrelated directory.
 */
export function stateDir(cwd = process.cwd()): string {
  if (process.env.AGENTLAB_HOME) return resolve(process.env.AGENTLAB_HOME);
  const local = join(cwd, '.agentlab');
  if (existsSync(local) || existsSync(join(cwd, 'agentlab.json'))) return local;
  return join(userStateRoot(), 'projects', `${basename(cwd).replace(/[^\w.-]/g, '_') || 'root'}-${createHash('sha1').update(cwd).digest('hex').slice(0, 10)}`);
}

/** $XDG_STATE_HOME/agentlab, else ~/.local/state/agentlab. `rm -rf` of it removes everything the lab kept outside projects. */
export function userStateRoot(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'agentlab');
}

export const paths = (dir: string) => {
  const preferred = join(dir, 'daemon.sock');
  // Unix socket paths are limited to ~107 bytes; fall back to a hashed name in the temp dir.
  const socket = preferred.length < 100 ? preferred : join(tmpdir(), `agentlab-${createHash('sha1').update(dir).digest('hex').slice(0, 12)}.sock`);
  return { socket, state: join(dir, 'daemon.json'), log: join(dir, 'daemon.log') };
};

export function readState(dir: string): DaemonState | undefined {
  try {
    return JSON.parse(readFileSync(paths(dir).state, 'utf8')) as DaemonState;
  } catch {
    return undefined;
  }
}

export function writeState(dir: string, state: DaemonState): void {
  const file = paths(dir).state;
  writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function clearState(dir: string): void {
  const p = paths(dir);
  rmSync(p.state, { force: true });
  if (existsSync(p.socket)) rmSync(p.socket, { force: true });
}

/** The dashboard of an MCP server running from this directory: its person's (control) URL, owner-only. */
export interface DashboardRecord { url: string; pid: number; identity?: ProcessIdentity }

const dashboardFile = (dir: string) => join(dir, 'mcp-dashboard.json');

export function writeDashboardRecord(dir: string, url: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record: DashboardRecord = { url, pid: process.pid, identity: identify(process.pid) };
  writeFileSync(dashboardFile(dir), JSON.stringify(record, null, 2), { mode: 0o600 });
  chmodSync(dashboardFile(dir), 0o600);
}

export function clearDashboardRecord(dir: string): void {
  rmSync(dashboardFile(dir), { force: true });
}

/** The live MCP server's dashboard record, if its process is still the one that wrote it. */
export function readDashboardRecord(dir: string): DashboardRecord | undefined {
  try {
    const r = JSON.parse(readFileSync(dashboardFile(dir), 'utf8')) as DashboardRecord;
    return checkIdentity(r.identity) === 'same' ? r : undefined;
  } catch {
    return undefined;
  }
}

/** Is the recorded daemon the process currently holding that pid? Records without identity are unverifiable. */
export function daemonCheck(state: DaemonState): IdentityCheck {
  return checkIdentity(state.daemon);
}

export interface RpcResponse { ok: boolean; result?: unknown; text?: string; error?: LabErrorJSON }

export function rpc(socket: string, command: string, args: Record<string, unknown> = {}): Promise<RpcResponse> {
  return new Promise((resolvePromise, reject) => {
    const body = JSON.stringify({ command, args });
    const req = request({ socketPath: socket, path: '/rpc', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolvePromise(JSON.parse(data) as RpcResponse); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
