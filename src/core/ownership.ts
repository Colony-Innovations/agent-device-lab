import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceRecord } from './lab.js';
import { describeMemberStop, stopGroup } from './process-group.js';
import { checkIdentity, identify, type ProcessIdentity } from './process-identity.js';

/**
 * What a live session owns, written where a later start or `agentlab stop|clean` can find it if the
 * session dies without cleanup (SIGKILL, a crash of an MCP server or an in-process run).
 */
export interface OwnershipRecord {
  sessionId: string;
  /** The process that owns the services. Only a record whose owner is gone or reused is ever reaped. */
  owner?: ProcessIdentity;
  recordedAt: string;
  services: ServiceRecord[];
}

const ownedDir = (stateDir: string) => join(stateDir, 'owned');
const recordFile = (stateDir: string, sessionId: string) => join(ownedDir(stateDir), `${sessionId}.json`);

export function recordOwnership(stateDir: string, sessionId: string, services: ServiceRecord[]): void {
  mkdirSync(ownedDir(stateDir), { recursive: true, mode: 0o700 });
  const record: OwnershipRecord = { sessionId, owner: identify(process.pid), recordedAt: new Date().toISOString(), services };
  const file = recordFile(stateDir, sessionId);
  writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function releaseOwnership(stateDir: string, sessionId: string): void {
  rmSync(recordFile(stateDir, sessionId), { force: true });
}

/** Records in <stateDir>/owned; unreadable or malformed files are ignored. */
export function readOwnership(stateDir: string): OwnershipRecord[] {
  let names: string[];
  try { names = readdirSync(ownedDir(stateDir)); } catch { return []; }
  const out: OwnershipRecord[] = [];
  for (const n of names.filter((f) => f.endsWith('.json'))) {
    try {
      const r = JSON.parse(readFileSync(join(ownedDir(stateDir), n), 'utf8')) as OwnershipRecord;
      if (typeof r.sessionId === 'string' && Array.isArray(r.services)) out.push(r);
    } catch { /* not a record */ }
  }
  return out;
}

/** An owner that is neither gone nor reused: a live session, or one whose identity cannot be checked. */
const ownerPresent = (r: OwnershipRecord) => {
  const c = checkIdentity(r.owner);
  return c !== 'gone' && c !== 'reused';
};

/** Run names (directories under runs/) that a live owner's record names: never pruned. */
export function liveSessionIds(stateDir: string): Set<string> {
  return new Set(readOwnership(stateDir).filter(ownerPresent).map((r) => r.sessionId));
}


/**
 * Stop recorded services the lab started: only owned process groups whose leader's identity still
 * matches (SIGTERM, then SIGKILL after `graceMs` if the group has not emptied). If the leader (the
 * shell wrapper) is gone, each recorded group member whose own identity still matches is signalled
 * individually; any other process left in the group is reported, never signalled. A one-shot service's
 * stop command is named for the person to run; its containers cannot be proved to still be the ones the
 * lab started. Returns human-readable notes.
 */
export async function stopRecordedServices(records: readonly ServiceRecord[], opts: { graceMs?: number } = {}): Promise<string[]> {
  const graceMs = opts.graceMs ?? 5000;
  const notes: string[] = [];
  const single = records.length === 1;
  for (const s of [...records].reverse()) {
    const label = single ? 'owned server' : `owned service "${s.name}"`;
    if (!s.owned) { notes.push(single ? 'reused server left running' : `service "${s.name}" was reused; left running`); continue; }
    if (s.mode === 'oneshot') {
      if (s.stopCommand) notes.push(`${label} was started by a one-shot command; to stop it, run \`${s.stopCommand}\` in ${s.cwd}`);
      continue;
    }
    const check = checkIdentity(s.identity);
    if (check === 'unverifiable') { notes.push(`${label} pid ${s.pid ?? '?'} cannot be verified; not signalled (check it manually)`); continue; }
    const r = await stopGroup(s.identity, s.members ?? [], { graceMs });
    if (r.via === 'group') {
      notes.push(`stopped ${label} process group ${s.identity!.pid}${r.graceful ? '' : ` (SIGKILL after ${graceMs}ms)`}`);
      continue;
    }
    const detail = describeMemberStop(r, graceMs);
    const lead = check === 'gone' ? `${label} had already exited` : `${label} pid ${s.pid} now belongs to another process; not signalled`;
    notes.push(detail ? `${lead}; ${detail}` : lead);
  }
  return notes;
}

/**
 * Clean up after sessions that died without stopping their services. A record whose owner is still the
 * process that wrote it (a live session) is never touched, and neither is one whose owner cannot be
 * verified. Returns notes; each handled record is removed.
 */
export async function reapOrphans(stateDir: string): Promise<string[]> {
  const notes: string[] = [];
  for (const r of readOwnership(stateDir)) {
    if (ownerPresent(r)) continue;
    const owned = r.services.filter((s) => s.owned);
    if (owned.length) {
      const stopped = await stopRecordedServices(owned);
      notes.push(...stopped.map((n) => `session ${r.sessionId} ended without cleanup: ${n}`));
    }
    releaseOwnership(stateDir, r.sessionId);
  }
  return notes;
}

/**
 * Delete the oldest runs beyond the `keep` most recent (0 keeps all), never one in `protect`. Returns
 * the deleted run names. Run names sort chronologically (s-YYYYMMDDHHMMSS-xxxx).
 */
export function pruneRuns(stateDir: string, keep: number, protect: ReadonlySet<string>): string[] {
  if (!(keep > 0)) return [];
  const runs = join(stateDir, 'runs');
  let names: string[];
  try {
    names = readdirSync(runs).filter((n) => { try { return statSync(join(runs, n)).isDirectory(); } catch { return false; } });
  } catch { return []; }
  names.sort();
  const removed: string[] = [];
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    if (protect.has(n)) continue;
    rmSync(join(runs, n), { recursive: true, force: true });
    removed.push(n);
  }
  return removed;
}

/** AGENTLAB_KEEP_RUNS, default 20; 0 keeps everything. */
export function keepRuns(env: NodeJS.ProcessEnv = process.env): number {
  const v = env.AGENTLAB_KEEP_RUNS;
  if (v === undefined || v === '') return 20;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : 20;
}
