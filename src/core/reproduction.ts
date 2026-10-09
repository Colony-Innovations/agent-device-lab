/** How many of the most recent steps a session's reproduction history keeps (the first step is always kept). */
export const HISTORY_KEEP = 200;
/** How many console errors and failed requests a session keeps in memory (counters stay exact). */
export const EVENTS_KEEP = 500;

const OMITTED = /^… (\d+) earlier steps omitted$/;

/**
 * Append a reproduction step, keeping the first step (the `open …` line) and the latest `keep`, with one
 * "… N earlier steps omitted" line between them. The array is edited in place: findings, sweeps and
 * scans hold it by reference and copy it when they record a finding.
 */
export function appendStep(history: string[], step: string, keep = HISTORY_KEEP): void {
  history.push(step);
  const marker = history.length > 1 ? OMITTED.exec(history[1]!) : null;
  const tailStart = marker ? 2 : 1;
  const drop = history.length - tailStart - keep;
  if (drop <= 0) return;
  history.splice(tailStart, drop);
  const text = `… ${(marker ? Number(marker[1]) : 0) + drop} earlier steps omitted`;
  if (marker) history[1] = text;
  else history.splice(1, 0, text);
}

/** Add to a list that keeps only the latest `keep` entries; the caller counts the true total. */
export function pushCapped<T>(list: T[], item: T, keep = EVENTS_KEEP): void {
  list.push(item);
  if (list.length > keep) list.splice(0, list.length - keep);
}

/** Entries added after `mark` (a total taken earlier), as far as the capped list still holds them. */
export function since<T>(list: readonly T[], total: number, mark: number): T[] {
  const n = Math.min(total - mark, list.length);
  return n > 0 ? list.slice(-n) : [];
}
