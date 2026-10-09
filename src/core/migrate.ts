import { parseProfile } from './profile.js';
import { CONTRACT_VERSIONS } from './versions.js';

// `agentlab migrate`: rewrite an older agentlab.json as the current schemaVersion. Pure: it takes the
// parsed JSON and returns the new object; reading and writing files is the CLI's job.

export interface Migration {
  changed: boolean;
  from: number;
  to: 2;
  profile: Record<string, unknown>;
  notes: string[];
}

/**
 * Migrate a raw profile object. An invalid profile throws `invalid_profile`, a newer one
 * `profile_too_new` (both from `parseProfile`, so the rules are the ones `start` applies).
 * A current profile is returned unchanged.
 *
 * schemaVersion 1 → 2: the `web` section becomes `services.web` (same keys: v2 infers an http check
 * from the service url and `readiness.path`, so nothing is added), `app` points at it, and every other
 * top-level field is kept in place.
 */
export function migrateProfile(raw: unknown): Migration {
  const parsed = parseProfile(raw, '/migrate/agentlab.json'); // throws on invalid or too new
  const obj = raw as Record<string, unknown>;
  const to = CONTRACT_VERSIONS.profile;
  if (parsed.schemaVersion === to) return { changed: false, from: to, to, profile: obj, notes: [] };

  const notes = ['schemaVersion 1 → 2'];
  const profile: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'schemaVersion') profile.schemaVersion = to;
    else if (key === 'web') {
      profile.services = { web: structuredClone(value) };
      profile.app = { service: 'web' };
      notes.push('"web" became "services.web"', 'added "app": {"service": "web"}');
    } else if (key === 'app') notes.push('dropped "app": schemaVersion 1 ignored it, and the application is now services.web');
    else profile[key] = value;
  }
  return { changed: true, from: 1, to, profile, notes };
}
