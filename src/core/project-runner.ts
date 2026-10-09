import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { connect } from 'node:net';
import { redactSecrets } from './feed.js';
import { identify, type ProcessIdentity } from './process-identity.js';
import { describeMemberStop, mergeMembers, snapshotMembers, stopGroup, type GroupMember } from './process-group.js';
import { LabError, type ReadinessSpec, type ServerInfo, type ServiceInfo, type ServiceSpec, type WebServerSpec } from './schema.js';

export type ProbeResult =
  | { kind: 'healthy'; status: number }
  | { kind: 'unhealthy'; status: number }
  | { kind: 'down'; reason: string };

/** One readiness probe: GET url+path, following redirects. */
export async function probe(spec: Pick<WebServerSpec, 'url' | 'readiness'>, timeoutMs = 2000): Promise<ProbeResult> {
  try {
    const res = await fetch(spec.url + spec.readiness.path, { signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel();
    return res.status === spec.readiness.status ? { kind: 'healthy', status: res.status } : { kind: 'unhealthy', status: res.status };
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return { kind: 'down', reason: cause?.code ?? (err as Error).name };
  }
}

/** Does host:port accept a TCP connection? */
export function probeTcp(host: string, port: number, timeoutMs = 1000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (r: ProbeResult) => { socket.destroy(); resolve(r); };
    socket.setTimeout(timeoutMs, () => done({ kind: 'down', reason: 'ETIMEDOUT' }));
    socket.once('connect', () => done({ kind: 'healthy', status: 0 }));
    socket.once('error', (err: NodeJS.ErrnoException) => done({ kind: 'down', reason: err.code ?? err.name }));
  });
}

/** Probe an http or tcp readiness check; other kinds cannot detect an instance that is already running. */
export function probeReadiness(r: ReadinessSpec, timeoutMs = 2000): Promise<ProbeResult> | undefined {
  if (r.kind === 'http') return probe({ url: r.url, readiness: { path: r.path, status: r.status, timeoutMs: r.timeoutMs, intervalMs: r.intervalMs } }, timeoutMs);
  if (r.kind === 'tcp') return probeTcp(r.host, r.port, Math.min(timeoutMs, 1000));
  return undefined;
}

export function describeReadiness(r: ReadinessSpec): string {
  switch (r.kind) {
    case 'http': return `GET ${r.url}${r.path} ${r.status}`;
    case 'tcp': return `tcp ${r.host}:${r.port}`;
    case 'log': return `log /${r.pattern}/`;
    case 'alive': return `alive ${r.ms}ms`;
    case 'exit': return 'exit 0';
  }
}

/** A process service that exited on its own after it had become ready (not because the lab stopped it). */
export interface UnexpectedExit {
  name: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The last output lines, with credential-looking values masked. */
  logTail: string[];
}

/** Each service's output file stops growing at this size (env AGENTLAB_SERVICE_LOG_MAX_BYTES). */
export const SERVICE_LOG_MAX_BYTES = 20 * 1024 * 1024;

export function serviceLogMax(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.AGENTLAB_SERVICE_LOG_MAX_BYTES);
  return Number.isInteger(n) && n > 0 ? n : SERVICE_LOG_MAX_BYTES;
}

export interface RunnerOptions {
  /** File that receives the service's stdout/stderr. */
  logFile?: string;
  onLog?: (line: string) => void;
  /** Called once if the started process service exits by itself after becoming ready. */
  onUnexpectedExit?: (exit: UnexpectedExit) => void;
  /** Aborted when a sibling service fails: stop what was started and give up. */
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A declared service the lab is responsible for. Only instances with `owned === true` are ever
 * stopped; a reused service is never signalled, and a stop command runs only for a one-shot service
 * the lab itself started.
 */
export class Service {
  readonly spec: ServiceSpec;
  readonly info: ServiceInfo;
  private readonly child?: ChildProcess;
  private readonly log?: WriteStream;
  private exited: Promise<void>;
  private stopping = false;
  /** Identity of the process-group leader, captured at spawn; used for crash recovery. */
  readonly identity?: ProcessIdentity;
  /**
   * Identities of the other processes in the leader's group, snapshotted while the leader was alive. If the
   * leader (the shell wrapper) dies first, these are what stop() may still signal, one by one.
   */
  private groupMembers: GroupMember[] = [];

  private constructor(spec: ServiceSpec, info: ServiceInfo, child?: ChildProcess, log?: WriteStream) {
    this.spec = spec;
    this.info = info;
    this.child = child;
    this.log = log;
    this.identity = spec.mode === 'process' ? identify(child?.pid) : undefined;
    this.exited = child
      ? new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', () => resolve())))
      : Promise.resolve();
  }

  /** Reuse a service that already passes its http/tcp readiness check, or run its command and wait for readiness. */
  static async ensure(spec: ServiceSpec, opts: RunnerOptions = {}): Promise<Service> {
    const t0 = Date.now();
    const at = spec.url ?? describeReadiness(spec.readiness);
    const existing = await probeReadiness(spec.readiness);
    if (existing?.kind === 'healthy') {
      if (!spec.reuseExisting) {
        throw new LabError('port_conflict', `${label(spec)}: something is already ready at ${at} and reuseExisting is false`, {
          hint: 'Stop that process yourself, or set "reuseExisting": true.', details: { service: spec.name },
        });
      }
      return new Service(spec, {
        name: spec.name, ...(spec.url ? { url: spec.url } : {}), mode: spec.mode, status: 'reused', owned: false,
        command: spec.command, readyMs: Date.now() - t0, readiness: describeReadiness(spec.readiness),
      });
    }
    if (existing?.kind === 'unhealthy' && spec.readiness.kind === 'http') {
      throw new LabError('port_conflict',
        `${label(spec)}: something is already answering at ${spec.readiness.url} but ${spec.readiness.path} returned ${existing.status} (expected ${spec.readiness.status})`,
        { hint: 'The lab will not start a second server on an occupied port or stop a process it did not start. Stop it or fix the readiness check.', details: { service: spec.name } });
    }
    return Service.start(spec, opts, t0);
  }

  private static async start(spec: ServiceSpec, opts: RunnerOptions, t0: number): Promise<Service> {
    const log = opts.logFile ? createWriteStream(opts.logFile, { flags: 'a' }) : undefined;
    const tail: string[] = [];
    let logMatched = false;
    const pattern = spec.readiness.kind === 'log' ? new RegExp(spec.readiness.pattern) : undefined;
    const maxBytes = serviceLogMax();
    let written = 0;
    // The file is capped; readiness matching and the tail below keep seeing every line.
    const write = (chunk: Buffer) => {
      if (!log || log.writableEnded || written > maxBytes) return;
      const room = maxBytes - written;
      if (chunk.length <= room) {
        written += chunk.length;
        log.write(chunk);
        return;
      }
      log.write(chunk.subarray(0, room));
      log.write(`\n… output truncated at ${maxBytes} bytes; later output discarded\n`);
      written = maxBytes + 1;
    };
    const record = (stream: string) => (chunk: Buffer) => {
      write(chunk);
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(`${stream}: ${line}`);
        if (tail.length > 40) tail.shift();
        if (pattern?.test(line)) logMatched = true;
        opts.onLog?.(line);
      }
    };

    // detached → own process group, so stop() can signal the command and its children (npm → node).
    const child = spawn(spec.command, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', record('out'));
    child.stderr?.on('data', record('err'));
    let spawnError: Error | undefined;
    child.once('error', (err) => { spawnError = err; });

    const service = new Service(spec, {
      name: spec.name, ...(spec.url ? { url: spec.url } : {}), mode: spec.mode, status: 'started', owned: true,
      ...(spec.mode === 'process' ? { pid: child.pid } : {}), command: spec.command, readyMs: 0,
      readiness: describeReadiness(spec.readiness), ...(opts.logFile ? { logFile: opts.logFile } : {}),
    }, child, log);
    const exited = () => !!spawnError || child.exitCode !== null || child.signalCode !== null;
    const details = (extra: Record<string, unknown> = {}) =>
      ({ service: spec.name, command: spec.command, cwd: spec.cwd, logTail: tail.slice(-15), logFile: opts.logFile, ...extra });
    const failExit = async (): Promise<never> => {
      await sleep(50); // let trailing output arrive
      log?.end();
      throw new LabError('startup_failed',
        `${label(spec)}: command exited before becoming ready (${spawnError?.message ?? `exit code ${child.exitCode ?? child.signalCode}`})`,
        { hint: startupHint(tail, child.exitCode), details: details({ exitCode: child.exitCode }) });
    };
    const aborted = async (): Promise<never> => {
      await service.stop();
      throw new LabError('startup_failed', `${label(spec)}: start abandoned because another service failed; the started process was stopped`, {
        details: details({ aborted: true }),
      });
    };

    const r = spec.readiness;
    const timeoutMs = r.kind === 'alive' ? r.ms + 60_000 : r.timeoutMs;
    const deadline = t0 + timeoutMs;

    if (spec.mode === 'oneshot') {
      // The command itself must finish successfully (e.g. `docker compose up -d`), then readiness is polled.
      while (!exited()) {
        if (opts.signal?.aborted) return aborted();
        if (Date.now() > deadline) {
          await service.kill();
          throw new LabError('readiness_timeout', `${label(spec)}: one-shot command did not finish within ${timeoutMs}ms; it was stopped`, {
            hint: startupHint(tail), details: details(),
          });
        }
        await sleep(50);
      }
      await sleep(20);
      if (spawnError || child.exitCode !== 0) return failExit();
    }

    let last = 'not probed';
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) return aborted();
      if (spec.mode === 'process' && exited()) return failExit();
      let ready = false;
      if (r.kind === 'log') ready = logMatched;
      else if (r.kind === 'exit') ready = true;
      else if (r.kind === 'alive') ready = Date.now() - t0 >= r.ms;
      else {
        const p = (await probeReadiness(r, Math.min(2000, r.intervalMs * 4)))!;
        ready = p.kind === 'healthy';
        last = p.kind === 'down' ? p.reason : `HTTP ${p.status}`;
      }
      if (ready) {
        service.info.readyMs = Date.now() - t0;
        if (spec.mode === 'process') {
          service.refreshMembers();
          service.watchExit(opts.onUnexpectedExit, tail);
        }
        return service;
      }
      await sleep(r.kind === 'http' || r.kind === 'tcp' ? r.intervalMs : 50);
    }

    const stop = await service.stop();
    const what = r.kind === 'http' ? `${r.url}${r.path}` : describeReadiness(r);
    throw new LabError('readiness_timeout',
      `${label(spec)}: ${what} was not ready within ${timeoutMs}ms${r.kind === 'http' || r.kind === 'tcp' ? ` (last probe: ${last})` : ''}; the started process was ${stop.stopped ? 'stopped' : `not stopped (${stop.reason})`}`,
      { hint: startupHint(tail), details: details() });
  }

  /** Report an exit that the lab did not cause (see stop and kill). */
  private watchExit(cb: ((exit: UnexpectedExit) => void) | undefined, tail: string[]): void {
    const child = this.child;
    if (!cb || !child) return;
    const report = () => {
      if (this.stopping) return;
      // Let trailing output arrive before the tail is read.
      setTimeout(() => cb({ name: this.spec.name, code: child.exitCode, signal: child.signalCode, logTail: tail.slice(-10).map(redactSecrets) }), 50);
    };
    if (child.exitCode !== null || child.signalCode !== null) report();
    else child.once('exit', report);
  }

  /** Snapshot the group's current members; possible only while the leader is alive and verifiably ours. */
  refreshMembers(): void {
    if (this.spec.mode !== 'process' || !this.info.owned) return;
    const snapshot = snapshotMembers(this.identity);
    if (snapshot) this.groupMembers = mergeMembers(this.groupMembers, snapshot);
  }

  /** The recorded group members (not the leader), for ownership records. */
  get members(): readonly GroupMember[] {
    return this.groupMembers;
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Stop the service if and only if the lab started it: signal its process group, or run a one-shot's stop command. */
  async stop(): Promise<{ stopped: boolean; reason: string }> {
    if (!this.info.owned || !this.child?.pid) return { stopped: false, reason: 'not owned by the lab; left running' };
    this.stopping = true;
    if (this.spec.mode === 'oneshot') {
      if (this.running) await this.kill();
      this.log?.end();
      if (!this.spec.shutdown.command) return { stopped: false, reason: 'one-shot command finished; no shutdown.command declared' };
      return runStopCommand(this.spec);
    }
    const { signal: sig, graceMs } = this.spec.shutdown;
    if (this.running) this.refreshMembers();
    // The shell (e.g. dash) may stay as the service's parent and exit first, so the service has
    // stopped only when its whole process group is empty. If the leader is already gone, only the
    // members recorded while it lived are signalled, each after an identity check.
    const r = await stopGroup(this.identity, this.groupMembers, { signal: sig, graceMs, ...(this.running ? { liveLeaderPid: this.child.pid } : {}) });
    await this.exited;
    this.log?.end();
    if (r.via === 'group') return { stopped: true, reason: r.graceful ? sig : `SIGKILL after ${graceMs}ms grace period` };
    const detail = describeMemberStop(r, graceMs);
    if (!detail) return { stopped: true, reason: 'already exited' };
    return { stopped: r.survivors.length === 0 && r.unverified.length === 0, reason: `already exited; ${detail}` };
  }

  /** Immediately end a command the lab started (a one-shot that overran). */
  private async kill(): Promise<void> {
    if (!this.child?.pid || !this.running) return;
    this.stopping = true;
    try { process.kill(-this.child.pid, 'SIGKILL'); } catch { /* gone */ }
    await this.exited;
  }
}

/** Run a one-shot service's declared stop command (e.g. `docker compose stop cache`). */
function runStopCommand(spec: ServiceSpec): Promise<{ stopped: boolean; reason: string }> {
  return new Promise((resolve) => {
    const child = spawn(spec.shutdown.command!, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, shell: true, stdio: 'ignore', detached: true });
    const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } }, Math.max(spec.shutdown.graceMs, 30_000));
    child.once('error', (err) => { clearTimeout(timer); resolve({ stopped: false, reason: `stop command failed: ${err.message}` }); });
    child.once('exit', (code, sig) => {
      clearTimeout(timer);
      resolve(code === 0 ? { stopped: true, reason: `ran ${spec.shutdown.command}` } : { stopped: false, reason: `stop command exited ${code ?? sig}` });
    });
  });
}

/** The single web server of a schemaVersion 1 profile: a Service named "web" with an http readiness check. */
export class WebServer {
  private constructor(private readonly service: Service) {}

  static async ensure(spec: WebServerSpec, opts: RunnerOptions = {}): Promise<WebServer> {
    return new WebServer(await Service.ensure(webService(spec), opts));
  }

  get info(): ServerInfo {
    return serverInfo(this.service.info);
  }

  get identity(): ProcessIdentity | undefined {
    return this.service.identity;
  }

  get running(): boolean {
    return this.service.running;
  }

  stop(): Promise<{ stopped: boolean; reason: string }> {
    return this.service.stop();
  }
}

export function webService(spec: WebServerSpec): ServiceSpec {
  return {
    name: 'web', command: spec.command, cwd: spec.cwd, url: spec.url, env: spec.env, requiredEnv: [],
    readiness: { kind: 'http', url: spec.url, ...spec.readiness }, dependsOn: [], reuseExisting: spec.reuseExisting,
    required: true, mode: 'process', shutdown: { signal: 'SIGTERM', graceMs: 5000 },
  };
}

/** The single-server view (start and status results) of a service. */
export function serverInfo(s: ServiceInfo): ServerInfo {
  return {
    url: s.url ?? '', owned: s.owned, reused: s.status === 'reused',
    ...(s.pid !== undefined ? { pid: s.pid } : {}), ...(s.owned ? { command: s.command } : {}),
    readyMs: s.readyMs, ...(s.logFile ? { logFile: s.logFile } : {}),
  };
}

function label(spec: ServiceSpec): string {
  return `service "${spec.name}"`;
}

function startupHint(tail: string[], exitCode?: number | null): string {
  const text = tail.join('\n');
  if (exitCode === 127 || /: not found$/m.test(text)) return 'The command was not found; install project dependencies or fix the service command.';
  if (/EADDRINUSE|address already in use/i.test(text)) return 'The port is already in use by another process.';
  if (/command not found|ENOENT|Cannot find module/i.test(text)) return 'A command or module is missing; install project dependencies first.';
  if (/Cannot connect to the Docker daemon|docker daemon/i.test(text)) return 'Docker is not running; start it and try again.';
  return 'See the log tail and log file for the service output.';
}
