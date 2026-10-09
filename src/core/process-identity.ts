import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * A PID alone is not an identity: after a crash or reboot the number can belong to an unrelated
 * process. Pair it with the kernel's start time (and boot id on Linux) so stale records can never
 * cause the lab to signal something it did not start.
 */
export interface ProcessIdentity {
  pid: number;
  /** Linux: /proc/<pid>/stat starttime (clock ticks since boot). Elsewhere: `ps -o lstart=`. */
  startTime: string;
  bootId?: string;
}

export function identify(pid: number | undefined): ProcessIdentity | undefined {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Field 2 (comm) may contain spaces and parentheses; fields after the last ')' start at field 3.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const startTime = fields[19]; // field 22
      if (!startTime) return undefined;
      return { pid, startTime, bootId: bootId() };
    } catch {
      return undefined;
    }
  }
  try {
    const startTime = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return startTime ? { pid, startTime } : undefined;
  } catch {
    return undefined;
  }
}

export type IdentityCheck = 'same' | 'gone' | 'reused' | 'unverifiable';

/** Compare a recorded identity with whatever currently holds that PID. */
export function checkIdentity(recorded: Partial<ProcessIdentity> | undefined): IdentityCheck {
  if (!recorded?.pid || !recorded.startTime) return 'unverifiable';
  const current = identify(recorded.pid);
  if (!current) return 'gone';
  if (current.startTime !== recorded.startTime) return 'reused';
  if (recorded.bootId && current.bootId && recorded.bootId !== current.bootId) return 'reused';
  return 'same';
}

export function isSameProcess(recorded: Partial<ProcessIdentity> | undefined): boolean {
  return checkIdentity(recorded) === 'same';
}

let cachedBootId: string | undefined;
function bootId(): string | undefined {
  if (cachedBootId === undefined) {
    try {
      cachedBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      cachedBootId = '';
    }
  }
  return cachedBootId || undefined;
}
