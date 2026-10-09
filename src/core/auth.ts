import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { LabError, type AuthPolicy } from './schema.js';

// Saved browser state (cookies and localStorage) so a signed-in session can be reused. The file holds
// credentials in effect: it is written owner-only, must be ignored by git, and its contents never
// leave this module. Callers only ever see counts and the path.

export interface StoredState {
  cookies: { name: string; value: string; domain: string; path: string; expires: number }[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}

export interface AuthStatus {
  file: string;
  exists: boolean;
  /** Octal permission bits, e.g. "600". */
  mode?: string;
  ownerOnly?: boolean;
  cookies?: number;
  origins?: number;
  /** Every cookie has expired and there is no localStorage to fall back on. */
  expired?: boolean;
  /** true: git ignores the file; false: git would track it; undefined: not in a git repository. */
  ignored?: boolean;
  problem?: string;
}

/** Load and check the saved state. Throws auth_missing, or auth_invalid after invalidating an unusable file. */
export function loadAuthState(policy: AuthPolicy): StoredState {
  if (!existsSync(policy.file)) {
    throw new LabError('auth_missing', `No saved sign-in state at ${policy.file}`, {
      hint: 'Start a fresh session, sign in, then run `agentlab auth save` (MCP: auth_save).',
    });
  }
  const mode = statSync(policy.file).mode & 0o777;
  if (mode & 0o077) {
    throw new LabError('auth_invalid', `Saved sign-in state ${policy.file} is readable by other users (mode ${mode.toString(8)})`, {
      hint: `Run \`chmod 600 ${policy.file}\`, or \`agentlab auth clear\` and save it again.`,
    });
  }
  let state: StoredState;
  try {
    state = JSON.parse(readFileSync(policy.file, 'utf8')) as StoredState;
    if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new Error('missing cookies/origins');
  } catch (err) {
    invalidate(policy);
    throw new LabError('auth_invalid', `Saved sign-in state was unreadable (${(err as Error).message.split('\n')[0]}) and has been removed`, {
      hint: 'Start a fresh session, sign in, then save the state again.',
    });
  }
  if (isExpired(state)) {
    invalidate(policy);
    throw new LabError('auth_invalid', 'Saved sign-in state had expired (every cookie is past its expiry) and has been removed', {
      hint: 'Start a fresh session, sign in, then save the state again.',
    });
  }
  return state;
}

/** The environment variable CI mode reads a sign-in state from (JSON or base64 JSON). */
export const AUTH_STATE_ENV = 'AGENTLAB_AUTH_STATE';

/**
 * A sign-in state from an environment variable value (Playwright storageState as JSON or base64 JSON), with
 * the same shape and expiry checks as `loadAuthState`. It never touches the disk, and no message here
 * quotes the value (a JSON parser's own message would).
 */
export function authStateFromEnv(value: string): StoredState {
  const text = value.trim();
  const bad = (why: string): never => {
    throw new LabError('auth_invalid', `${AUTH_STATE_ENV} is not a usable sign-in state: ${why}`, {
      hint: `Set it to a Playwright storageState as JSON or base64-encoded JSON (\`agentlab auth save\` writes one; base64 -w0 encodes it).`,
    });
  };
  if (!text) return bad('it is empty');
  let raw: unknown;
  try {
    raw = JSON.parse(text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8'));
  } catch {
    return bad('it is neither JSON nor base64-encoded JSON');
  }
  const obj = raw as Partial<StoredState> | null;
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.cookies) || !Array.isArray(obj.origins)) return bad('it needs "cookies" and "origins" lists');
  const cookies = obj.cookies.map((c, i) => {
    const k = c as Record<string, unknown> | null;
    if (!k || typeof k !== 'object' || typeof k.name !== 'string' || typeof k.value !== 'string' || typeof k.domain !== 'string') {
      return bad(`cookie ${i + 1} needs a string name, value and domain`);
    }
    return { ...k, path: typeof k.path === 'string' ? k.path : '/', expires: typeof k.expires === 'number' ? k.expires : -1 } as StoredState['cookies'][number];
  });
  const origins = obj.origins.map((o, i) => {
    const k = o as Record<string, unknown> | null;
    if (!k || typeof k !== 'object' || typeof k.origin !== 'string') return bad(`origin ${i + 1} needs a string origin`);
    if (k.localStorage !== undefined && !Array.isArray(k.localStorage)) return bad(`origin ${i + 1}: localStorage must be a list`);
    return { ...k, localStorage: (k.localStorage ?? []) as { name: string; value: string }[] } as StoredState['origins'][number];
  });
  const state: StoredState = { ...(obj as object), cookies, origins } as StoredState;
  if (isExpired(state)) return bad('every cookie is past its expiry');
  return state;
}

/**
 * The values of a state that must never be printed or written (cookie values and storage values), for the
 * caller's redaction set. Values shorter than 6 characters are left out: they would match ordinary text.
 */
export function authStateSecrets(state: StoredState): string[] {
  const out = new Set<string>();
  for (const c of state.cookies) if (typeof c.value === 'string' && c.value.length >= 6) out.add(c.value);
  for (const o of state.origins) for (const e of o.localStorage ?? []) if (typeof e.value === 'string' && e.value.length >= 6) out.add(e.value);
  return [...out];
}

/** Whether a saved state exists and is usable, without changing anything (unlike `loadAuthState`, which removes an unusable file). */
export function savedStateProblem(policy: AuthPolicy, root: string): string | undefined {
  const s = authStatus(policy, root);
  if (!s.exists) return `no saved sign-in state at ${policy.file}`;
  if (s.problem) return `saved sign-in state ${policy.file} is ${s.problem}`;
  if (s.ownerOnly === false) return `saved sign-in state ${policy.file} is readable by other users (mode ${s.mode})`;
  if (s.expired) return `saved sign-in state ${policy.file} has expired`;
  return undefined;
}

/** Remove a saved state that has proved unusable. */
export function invalidate(policy: AuthPolicy): void {
  rmSync(policy.file, { force: true });
}

/**
 * Write state owner-only (0600) under a 0700 directory, atomically. Refuses when the project is a git
 * repository that would track the file.
 */
export function saveAuthState(policy: AuthPolicy, root: string, state: StoredState): { cookies: number; origins: number; file: string } {
  if (gitIgnores(root, policy.file) === false) {
    throw new LabError('auth_not_ignored', `git would track ${relative(root, policy.file)}, so the sign-in state was not saved`, {
      hint: 'Run `agentlab init` (it adds .agentlab/ to .gitignore) or add the file to .gitignore yourself.',
    });
  }
  const dir = dirname(policy.file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${policy.file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, policy.file);
  return { cookies: state.cookies.length, origins: state.origins.length, file: policy.file };
}

export function authStatus(policy: AuthPolicy, root: string): AuthStatus {
  const status: AuthStatus = { file: policy.file, exists: existsSync(policy.file) };
  const ignored = gitIgnores(root, policy.file);
  if (ignored !== undefined) status.ignored = ignored;
  if (!status.exists) return status;
  const mode = statSync(policy.file).mode & 0o777;
  status.mode = mode.toString(8);
  status.ownerOnly = !(mode & 0o077);
  try {
    const state = JSON.parse(readFileSync(policy.file, 'utf8')) as StoredState;
    status.cookies = state.cookies?.length ?? 0;
    status.origins = state.origins?.length ?? 0;
    status.expired = isExpired(state);
  } catch {
    status.problem = 'unreadable JSON';
  }
  return status;
}

function isExpired(state: StoredState): boolean {
  const now = Date.now() / 1000;
  const hasStorage = state.origins.some((o) => o.localStorage?.length);
  const session = state.cookies.filter((c) => !(c.expires > 0));
  return !hasStorage && !session.length && state.cookies.length > 0 && state.cookies.every((c) => c.expires > 0 && c.expires < now);
}

/** true/false from `git check-ignore`; undefined outside a git repository or without git. */
export function gitIgnores(root: string, file: string): boolean | undefined {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', file], { cwd: root, stdio: 'ignore' });
    return true;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 1) return false;
    return undefined;
  }
}
