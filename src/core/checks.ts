import { writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { coveredHits, detectLayout, labelKey, modalHits, shiftHits, type DetectorHit, type DetectorOptions, type ShiftEntry } from './detectors.js';
import {
  centreInView, coveredAtExtremes, extractPage, lookupRef, measureLayout, panIntoView, scrollToOrigin, takeLayoutShifts, targetPoint,
  type RawBox, type RawElement, type RawLabel,
} from './extract.js';
import type { FindingStore, RecordContext } from './findings.js';
import { buildObservation } from './observation.js';
import type { EvidenceFrame, Finding, FindingKind, Observation } from './schema.js';

// One detector engine for every responsive check. The sweep and the scan both measure a page state
// here: the observation's own layout flags, the layout detectors (detectors.ts), content under fixed
// bars at the scroll extremes, the click path's reach check (and, in an open dialog, whether every
// control can be scrolled into view), and layout shifts while the state settled.

export interface MeasureOptions {
  store: FindingStore;
  sessionId: string;
  gen: number;
  /** Where findings are recorded: device, and for a scan the scenario and state. */
  ctx: RecordContext & { device: string };
  reproduction: readonly string[];
  detectors: DetectorOptions;
  /** Controls given the reach check. */
  reachLimit: number;
  /** Evidence frame file for a suffix, e.g. "state" or "F12". */
  frameFile: (suffix: string) => string;
  /** The page's latest observation, when the caller already made one (its refs are then reused). */
  observation?: Observation;
  /** Layout shifts: how to describe when they happened, and a frame from before the state settled. */
  shift?: { when: string; before?: string };
  /** Findings first recorded, with their evidence frame (for the dashboard). */
  onFindings?: (findings: Finding[], frame?: string) => void;
}

export interface StateMeasure {
  observation: Observation;
  frame?: string;
  /** Findings seen in this state, new or already known. */
  findings: string[];
  reachChecked: number;
  labels: RawLabel[];
  /** Controls (labelKey) whose label is cut off or truncated with no alternative in this state. */
  hiddenLabels: Set<string>;
  /** Elements the layout detectors examined, and how many the budget left out. */
  examined: number;
  omitted: number;
}

const OBSERVE_LIMIT = 60;

export async function measureState(page: Page, m: MeasureOptions): Promise<StateMeasure> {
  const on = m.detectors.enabled;
  const seen = new Set<string>();
  await page.evaluate(scrollToOrigin);
  let o = m.observation;
  if (!o) {
    const raw = await page.evaluate(extractPage, { nextRef: 1, limit: OBSERVE_LIMIT });
    o = buildObservation(raw, { sessionId: m.sessionId, gen: m.gen, consoleErrors: 0, failedRequests: 0 });
  }
  const frame = await shot(page, m.frameFile('state'));
  const ctx: RecordContext = { ...m.ctx, keepRefs: false, ...(frame ? { frame } : {}) };
  const where = { route: o.route, viewport: o.viewport, gen: o.gen };
  const fresh: { findings: Finding[]; frame?: string }[] = [];
  const note = (f: Finding, isNew: boolean, evidence = frame) => {
    seen.add(f.id);
    if (isNew) fresh.push({ findings: [f], ...(evidence ? { frame: evidence } : {}) });
  };
  const record = (hit: DetectorHit, extra: Partial<RecordContext> = {}) => {
    const r = m.store.recordHit(hit, where, m.reproduction, { ...ctx, ...extra });
    note(r.finding, r.fresh, extra.frame ?? frame);
    return r.finding;
  };

  // 1. The observation's layout flags (document overflow, controls past the viewport edge).
  const flags = { ...o, layout: o.layout.filter((f) => on(f.kind)) };
  for (const r of m.store.observationResults(flags, m.reproduction, ctx)) note(r.finding, r.fresh);

  // 2. Layout detectors over one measurement of the state.
  const raw = await page.evaluate(measureLayout, { maxElements: 2500, maxItems: 40 });
  const hits = detectLayout(raw, m.detectors);
  const hiddenLabels = new Set<string>();
  // A control a fixed layer covers is explained by fixed-collision; the reach check would repeat it.
  const collided = new Set(hits.filter((h) => h.kind === 'fixed-collision' && h.confidence === 'confirmed' && h.target).map((h) => labelKey(h.target!)));
  for (const h of hits) {
    record(h);
    if (h.target && h.confidence === 'confirmed' && (h.kind === 'text-clipped' || h.kind === 'text-truncated' || h.kind === 'container-clipped')) hiddenLabels.add(labelKey(h.target));
  }

  // 3. Layout shifts while the state settled (before any scrolling here, which the API ignores anyway).
  if (m.shift && on('layout-shift')) {
    const entries = await page.evaluate(takeLayoutShifts).catch(() => [] as ShiftEntry[]);
    for (const h of shiftHits(entries, m.detectors.layoutShiftMin, m.shift.when)) {
      const frames: EvidenceFrame[] = [
        ...(m.shift.before ? [{ label: 'before it settled', path: m.shift.before }] : []),
        ...(frame ? [{ label: 'after it settled', path: frame }] : []),
      ];
      record({ ...h, frames });
    }
  }

  // 4. The reach check, as the click path does it: scroll the control into view, then on past a fixed
  //    bar, and hit-test its centre. In an open dialog, a control whose centre never comes into view
  //    cannot be reached at all.
  let reachChecked = 0;
  const unreachable: { el: RawElement; box: RawBox }[] = [];
  const obstructed = new Set<string>();
  const frameTick = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  for (const c of o.controls.slice(0, m.reachLimit)) {
    if (c.disabled || c.rect.w < 4 || c.rect.h < 4) continue;
    const handle = (await page.evaluateHandle(lookupRef, c.ref)).asElement();
    if (!handle) continue;
    try {
      await page.evaluate(scrollToOrigin);
      let { dx } = await handle.evaluate(panIntoView);
      await frameTick();
      let point = await handle.evaluate(targetPoint);
      if ((!point.hitOk && point.hitFixed) || (!point.inView && o.dialog)) {
        dx += (await handle.evaluate(centreInView)).dx;
        await frameTick();
        point = await handle.evaluate(targetPoint);
      }
      reachChecked++;
      const steps = [...m.reproduction, `scroll ${c.role} "${c.name}" into view`];
      if (dx && on('horizontal-pan-required')) {
        const r = m.store.panResult(o, c, { role: c.role, name: c.name, ref: c.ref }, Math.abs(dx), steps, { ...ctx, source: 'sweep-reachability' });
        note(r.finding, r.fresh);
      }
      if (point.inView && !point.hitOk && point.hit && on('control-obstructed') && !collided.has(labelKey(c))) {
        obstructed.add(labelKey(c));
        const r = m.store.obstructionResult(o, c, point.hit, steps, { ...ctx, source: 'sweep-reachability' });
        // The moment of obstruction is the evidence: the control scrolled into view, still covered.
        const evidence = r.fresh ? await shot(page, m.frameFile(r.finding.id)) : undefined;
        if (evidence) r.finding.frame = evidence;
        note(r.finding, r.fresh, evidence ?? frame);
      }
      if (!point.inView && o.dialog) unreachable.push({ el: { role: c.role, name: c.name, selector: '', control: true }, box: { x: c.rect.x, y: c.rect.y, w: c.rect.w, h: c.rect.h } });
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }
  await page.evaluate(scrollToOrigin);
  if (on('modal-overflow')) for (const h of modalHits(raw.modal, unreachable, raw.viewport)) record(h);

  // 5. Content that stays under a fixed bar at the top or bottom of the page (skipped while a modal
  //    locks scrolling). A control the reach check already found covered is the same problem.
  if (on('content-under-fixed') && !raw.modal) {
    const covered = await page.evaluate(coveredAtExtremes, { maxItems: 20 });
    const hitsUnder = coveredHits(covered).filter((h) => !(h.target && obstructed.has(labelKey(h.target))));
    if (hitsUnder.length) {
      await page.evaluate(() => window.scrollTo({ left: 0, top: (document.scrollingElement ?? document.documentElement).scrollHeight, behavior: 'instant' }));
      const bottom = hitsUnder.some((h) => h.evidence.edge === 'bottom') ? await shot(page, m.frameFile('bottom')) : undefined;
      await page.evaluate(scrollToOrigin);
      for (const h of hitsUnder) record(h, h.evidence.edge === 'bottom' && bottom ? { frame: bottom } : {});
    }
  }

  for (const f of fresh) m.onFindings?.(f.findings, f.frame);
  return {
    observation: o, ...(frame ? { frame } : {}), findings: [...seen], reachChecked,
    labels: raw.labels, hiddenLabels, examined: raw.examined, omitted: raw.omitted,
  };
}

/** Which checks run: `enable` limits them to those kinds, `disable` removes kinds. */
export function checkFilter(...configs: ({ enable?: readonly FindingKind[]; disable?: readonly FindingKind[] } | undefined)[]): (kind: FindingKind) => boolean {
  return (kind) => configs.every((c) => !c || ((!c.enable?.length || c.enable.includes(kind)) && !(c.disable ?? []).includes(kind)));
}

export async function shot(page: Page, file: string): Promise<string | undefined> {
  try {
    writeFileSync(file, await page.screenshot({ type: 'jpeg', quality: 70, scale: 'css', caret: 'initial', animations: 'allow', timeout: 5000 }));
    return file;
  } catch {
    return undefined;
  }
}
