import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { redactSecrets } from './feed.js';
import { checkIdentity, identify, type IdentityCheck, type ProcessIdentity } from './process-identity.js';

/**
 * A service's command runs under a shell that leads its process group; the real server is a member.
 * If the leader dies first, the group's pgid no longer proves anything about who is in it, so the lab
 * records each member's own identity while the leader is alive and signals only those, one by one.
 */
export interface GroupMember extends ProcessIdentity {
  /** The command line, redacted and shortened, so a person can recognise it. */
  command: string;
}

export interface GroupProcess { pid: number; command: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const COMMAND_MAX = 100;

function shorten(text: string): string {
  const t = redactSecrets(text.replace(/\s+/g, ' ').trim());
  return t.length > COMMAND_MAX ? `${t.slice(0, COMMAND_MAX)}…` : t;
}

/** Live (not zombie) processes whose process group is `pgid`, including the leader if it is still there. */
export function listGroup(pgid: number): GroupProcess[] {
  if (!Number.isInteger(pgid) || pgid <= 0) return [];
  const out: GroupProcess[] = [];
  if (process.platform === 'linux') {
    let names: string[];
    try { names = readdirSync('/proc'); } catch { return []; }
    for (const n of names) {
      if (!/^\d+$/.test(n)) continue;
      try {
        const stat = readFileSync(`/proc/${n}/stat`, 'utf8');
        // Fields after the last ')': state, ppid, pgrp.
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(f[2]) !== pgid || f[0] === 'Z') continue;
        let command = '';
        try { command = readFileSync(`/proc/${n}/cmdline`, 'utf8').split('\0').join(' '); } catch { /* exited */ }
        if (!command.trim()) command = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
        out.push({ pid: Number(n), command: shorten(command) });
      } catch { /* exited while scanning */ }
    }
    return out;
  }
  try {
    const text = execFileSync('ps', ['-axo', 'pid=,pgid=,stat=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of text.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (m && Number(m[2]) === pgid && !m[3]!.startsWith('Z')) out.push({ pid: Number(m[1]), command: shorten(m[4]!) });
    }
  } catch { /* ps unavailable */ }
  return out;
}

/**
 * The members of the leader's process group right now, each with its own identity (the leader itself is
 * not included). Only while the leader is verifiably the recorded process: then the pgid is its group.
 */
export function snapshotMembers(leader: ProcessIdentity | undefined): GroupMember[] | undefined {
  if (!leader || checkIdentity(leader) !== 'same') return undefined;
  const out: GroupMember[] = [];
  for (const p of listGroup(leader.pid)) {
    if (p.pid === leader.pid) continue;
    const id = identify(p.pid);
    if (id) out.push({ ...id, command: p.command });
  }
  return out;
}

const keyOf = (m: ProcessIdentity) => `${m.pid}:${m.startTime}`;

/** A new snapshot added to what was recorded before; members that have since exited are dropped. */
export function mergeMembers(previous: readonly GroupMember[], snapshot: readonly GroupMember[]): GroupMember[] {
  const merged = new Map<string, GroupMember>();
  for (const m of previous) if (checkIdentity(m) === 'same') merged.set(keyOf(m), m);
  for (const m of snapshot) merged.set(keyOf(m), m);
  return [...merged.values()];
}

/** Still running: the identity matches and the process is not a zombie. */
function live(m: ProcessIdentity): boolean {
  if (checkIdentity(m) !== 'same') return false;
  return !isZombie(m.pid);
}

/** Is this pid a zombie? (A killed child that nobody has reaped yet is no longer running.) */
function isZombie(pid: number): boolean {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
    } catch { return false; }
  }
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().startsWith('Z');
  } catch { return false; }
}

export const describeProcess = (p: GroupProcess) => `${p.command || '?'} (pid ${p.pid})`;

export interface GroupStopResult {
  /** How it was stopped: the whole group (leader verified), recorded members one by one, or nothing to do. */
  via: 'group' | 'members' | 'none';
  leader: IdentityCheck;
  /** Group: SIGTERM was enough. Members: every signalled member exited on SIGTERM. */
  graceful: boolean;
  /** Recorded members that were signalled (via 'members'). */
  stopped: GroupProcess[];
  /** Recorded members that were still running after SIGKILL. */
  survivors: GroupProcess[];
  /** Processes still in the group that were never recorded: not signalled. Only known when the leader is gone. */
  unverified: GroupProcess[];
}

/**
 * Stop what a service started. With the leader verified (`same`) the whole group is signalled (SIGTERM,
 * then SIGKILL after `graceMs` if it has not emptied). With the leader gone, each recorded member whose
 * identity still matches is signalled on its own; nothing unrecorded is ever signalled, only reported.
 * A leader that is `reused` or `unverifiable` is never signalled at all, and its group is not scanned.
 * `liveLeaderPid` is for a caller that still holds the unreaped child handle of the leader.
 */
export async function stopGroup(leader: ProcessIdentity | undefined, members: readonly GroupMember[], opts: { signal?: NodeJS.Signals; graceMs: number; liveLeaderPid?: number }): Promise<GroupStopResult> {
  const sig = opts.signal ?? 'SIGTERM';
  // A caller that still holds the unreaped child handle has already proved the leader pid is its own.
  const check: IdentityCheck = opts.liveLeaderPid ? 'same' : checkIdentity(leader);
  const result: GroupStopResult = { via: 'none', leader: check, graceful: true, stopped: [], survivors: [], unverified: [] };
  if (check === 'same') {
    const pgid = opts.liveLeaderPid ?? leader!.pid;
    const signal = (s: NodeJS.Signals) => { try { process.kill(-pgid, s); } catch { /* group already gone */ } };
    const groupAlive = () => { try { process.kill(-pgid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; } };
    signal(sig);
    const deadline = Date.now() + opts.graceMs;
    while (groupAlive() && Date.now() < deadline) await sleep(50);
    result.via = 'group';
    result.graceful = !groupAlive();
    if (!result.graceful) {
      signal('SIGKILL');
      for (let i = 0; i < 40 && groupAlive(); i++) await sleep(50);
    }
    return result;
  }
  if (check === 'unverifiable') return result;

  // The leader is gone (or its pid now belongs to something else): only recorded, still-matching members.
  const targets = members.filter((m) => checkIdentity(m) === 'same');
  const as = (m: GroupMember): GroupProcess => ({ pid: m.pid, command: m.command });
  const send = (list: readonly GroupMember[], s: NodeJS.Signals) => {
    for (const m of list) {
      // Re-check just before signalling: the pid must still be the recorded process.
      if (checkIdentity(m) === 'same') { try { process.kill(m.pid, s); } catch { /* gone */ } }
    }
  };
  if (targets.length) {
    result.via = 'members';
    send(targets, sig);
    const deadline = Date.now() + opts.graceMs;
    while (targets.some(live) && Date.now() < deadline) await sleep(50);
    const stillRunning = targets.filter(live);
    result.graceful = stillRunning.length === 0;
    if (stillRunning.length) {
      send(stillRunning, 'SIGKILL');
      for (let i = 0; i < 40 && targets.some(live); i++) await sleep(50);
    }
    result.stopped = targets.map(as);
    result.survivors = targets.filter(live).map(as);
  }
  // A gone leader's pid cannot be reused while its group still has members, so what is left is that group.
  if (check === 'gone' && leader) {
    const known = new Set(members.map(keyOf));
    result.unverified = listGroup(leader.pid).filter((p) => {
      const id = identify(p.pid);
      return !id || !known.has(keyOf(id));
    });
  }
  return result;
}

/** Notes for a person about a stop that went through members (or left unrecorded processes behind). */
export function describeMemberStop(r: GroupStopResult, graceMs: number): string {
  const parts: string[] = [];
  if (r.stopped.length) {
    const survivors = new Set(r.survivors.map((p) => p.pid));
    const gone = r.stopped.filter((p) => !survivors.has(p.pid));
    if (gone.length) parts.push(`stopped ${gone.length === 1 ? 'recorded member' : 'recorded members'} ${gone.map(describeProcess).join(', ')}${r.graceful ? '' : ` (SIGKILL after ${graceMs}ms)`}`);
    if (r.survivors.length) parts.push(`recorded ${r.survivors.length === 1 ? 'member' : 'members'} still running after SIGKILL: ${r.survivors.map(describeProcess).join(', ')}`);
  }
  if (r.unverified.length) {
    parts.push(`${r.unverified.length} ${r.unverified.length === 1 ? 'process remains' : 'processes remain'} in the group unverified and ${r.unverified.length === 1 ? 'was' : 'were'} not signalled: ${r.unverified.map(describeProcess).join(', ')} (stop ${r.unverified.length === 1 ? 'it' : 'them'} yourself if ${r.unverified.length === 1 ? 'it is' : 'they are'} part of the service)`);
  }
  return parts.join('; ');
}
