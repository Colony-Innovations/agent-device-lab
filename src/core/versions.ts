import { readFileSync } from 'node:fs';
import { SCHEMA_VERSION } from './schema.js';

/**
 * Every versioned contract agentlab exposes, in one place. A number changes only when its shape changes
 * incompatibly; `agentlab version` prints them so a project or an agent can check compatibility.
 */
export const CONTRACT_VERSIONS = {
  /** The `schemaVersion` written into agentlab.json by `init` and `migrate`. */
  profile: 2,
  /** The `schemaVersion`s of agentlab.json this version of agentlab reads. */
  profileSupported: [1, 2],
  /** The `schemaVersion` on CLI and MCP JSON results (`SCHEMA_VERSION` in schema.ts). */
  results: SCHEMA_VERSION,
  /** MCP tool names and their input schemas. */
  mcpTools: 1,
  /** Scan and CI report JSON. */
  report: 1,
  /** The failure bundle. */
  bundle: 1,
  /** Dashboard feed messages. */
  events: 1,
} as const;

let cached: string | undefined;

/** The package.json version of this installation. Read once. */
export function productVersion(): string {
  cached ??= (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  return cached;
}
