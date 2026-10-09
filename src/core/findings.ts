import { createHash } from 'node:crypto';
import { DETECTORS, type DetectorHit } from './detectors.js';
import type { Control, EvidenceBasis, EvidenceFrame, Finding, FindingTarget, LayoutFlag, Observation } from './schema.js';

/** Where a finding was measured. The session's own device by default; a sweep or scan passes its own. */
export interface RecordContext {
  device?: string;
  /** Sweep and scan controls live in a throwaway context, so their refs are not actionable and are dropped. */
  keepRefs?: boolean;
  source?: Finding['source'];
  /** Scan findings: the scenario and UI state they were measured in. */
  scenario?: string;
  state?: string;
  /** Evidence frame for a finding first recorded here. */
  frame?: string;
}

/** Where on the page: an observation, or the parts of one a detector needs. */
export interface Where { route: string; viewport: { width: number }; gen: number }

/** Basis that counts as a deterministic measurement: only these may make a heuristic high severity. */
const DETERMINISTIC: ReadonlySet<EvidenceBasis> = new Set(['clipping', 'hit-test', 'interaction', 'standard', 'browser-metric']);

/**
 * The same underlying problem, stable across runs: the detector family (so a control covered at its
 * centre is one problem whether the reach check or the fixed-bar check found it), the route without
 * its fragment, and the element's identity. Device, scenario and state are left out so a problem seen
 * at several widths or in several scenarios groups together.
 */
export function fingerprintOf(kind: Finding['kind'], route: string, target?: Pick<FindingTarget, 'role' | 'name' | 'context'>): string {
  const family = DETECTORS[kind].family;
  const identity = target ? [target.role, target.name, target.context ?? ''].join('\u0000') : kind;
  return createHash('sha1').update([family, route.split('#')[0], identity].join('\u0001')).digest('hex').slice(0, 12);
}

/** A session keeps at most this many distinct findings; later new ones are counted in `omitted`. */
export const MAX_FINDINGS = 2000;

/** Session-scoped finding store. Pure: no browser, so it is unit-tested directly. */
export class FindingStore {
  private readonly byKey = new Map<string, Finding>();
  private next = 1;
  private omittedCount = 0;

  constructor(private readonly device: string, private readonly max = MAX_FINDINGS) {}

  /** New findings that arrived after the cap and were counted, not kept. Findings already kept are never dropped. */
  get omitted(): number {
    return this.omittedCount;
  }

  list(): Finding[] {
    return [...this.byKey.values()];
  }

  get(id: string): Finding | undefined {
    return this.list().find((f) => f.id === id);
  }

  get size(): number {
    return this.byKey.size;
  }

  /** Record every layout flag in an observation (heuristic). Returns findings seen for the first time. */
  recordObservation(o: Observation, reproduction: readonly string[], ctx: RecordContext = {}): Finding[] {
    return this.observationResults(o, reproduction, ctx).filter((r) => r.fresh).map((r) => r.finding);
  }

  /** Like recordObservation, but returns every finding the observation shows, new or already known. */
  observationResults(o: Observation, reproduction: readonly string[], ctx: RecordContext = {}): { finding: Finding; fresh: boolean }[] {
    const out: { finding: Finding; fresh: boolean }[] = [];
    for (const flag of o.layout) {
      const control = flag.ref ? o.controls.find((c) => c.ref === flag.ref) : undefined;
      const f = this.upsert({
        kind: flag.kind, severity: flag.severity, source: 'measured-layout', confidence: 'heuristic',
        confidenceScore: 0.6, basis: flag.kind === 'control-clipped' ? ['clipping'] : ['geometry'],
        route: o.route, viewportWidth: o.viewport.width, target: control ? controlTarget(control) : undefined,
        message: `${flag.message} on ${o.route}`, evidence: flag.evidence, gen: o.gen, reproduction,
      }, ctx);
      out.push(f);
    }
    return out;
  }

  /**
   * Reaching a control needed the view to pan sideways (confirmed by measuring the pan). An automated
   * click still succeeds, but a person would first have to discover the hidden horizontal pan.
   */
  recordHorizontalPan(o: Observation, control: Control | undefined, target: { role: string; name: string; ref: string }, panPx: number, reproduction: readonly string[], ctx: RecordContext = {}): Finding | undefined {
    const r = this.panResult(o, control, target, panPx, reproduction, ctx);
    return r.fresh ? r.finding : undefined;
  }

  panResult(o: Observation, control: Control | undefined, target: { role: string; name: string; ref: string }, panPx: number, reproduction: readonly string[], ctx: RecordContext = {}): { finding: Finding; fresh: boolean } {
    const width = control?.rect.w ?? 0;
    const outsidePx = control?.clip?.px ?? panPx;
    const entirelyOutside = width > 0 && outsidePx >= width;
    return this.upsert({
      kind: 'horizontal-pan-required', severity: entirelyOutside ? 'high' : 'medium', source: ctx.source ?? 'interaction', confidence: 'confirmed',
      confidenceScore: 0.95, basis: ['interaction'],
      route: o.route, viewportWidth: o.viewport.width, target: control ? controlTarget(control) : { ...target },
      message: `${target.role} "${target.name}" on ${o.route} could only be reached after panning ${panPx}px sideways; ` +
        `on a ${o.viewport.width}px-wide screen a person must first discover the horizontal pan`,
      evidence: {
        panPx, viewportWidth: o.viewport.width, documentWidth: o.documentWidth,
        ...(control ? { targetLeft: control.rect.x, targetRight: control.rect.x + control.rect.w, targetWidth: control.rect.w } : {}),
      },
      gen: o.gen, reproduction,
    }, ctx);
  }

  /**
   * After scrolling a control into view, a pointer at its centre lands on another element (confirmed
   * by hit-testing, the same check a click makes before tapping).
   */
  recordObstruction(o: Observation, control: Control, hit: string, reproduction: readonly string[], ctx: RecordContext = {}): Finding | undefined {
    const r = this.obstructionResult(o, control, hit, reproduction, ctx);
    return r.fresh ? r.finding : undefined;
  }

  obstructionResult(o: Observation, control: Control, hit: string, reproduction: readonly string[], ctx: RecordContext = {}): { finding: Finding; fresh: boolean } {
    return this.upsert({
      kind: 'control-obstructed', severity: 'high', source: ctx.source ?? 'sweep-reachability', confidence: 'confirmed',
      confidenceScore: 0.95, basis: ['hit-test'],
      route: o.route, viewportWidth: o.viewport.width, target: controlTarget(control),
      message: `${control.role} "${control.name}" on ${o.route} is covered at its centre by ${hit} even after scrolling it into view`,
      evidence: { coveredBy: hit.slice(0, 80), viewportWidth: o.viewport.width, targetLeft: control.rect.x, targetTop: control.rect.y, targetWidth: control.rect.w, targetHeight: control.rect.h },
      gen: o.gen, reproduction,
    }, ctx);
  }

  /** A scan detector's result. Returns the finding (new or the existing one it merged into) and whether it is new. */
  recordHit(hit: DetectorHit, where: Where, reproduction: readonly string[], ctx: RecordContext = {}): { finding: Finding; fresh: boolean } {
    return this.upsert({
      kind: hit.kind, severity: hit.severity, source: ctx.source ?? 'scan', confidence: hit.confidence, confidenceScore: hit.confidenceScore,
      basis: hit.basis, route: where.route, viewportWidth: where.viewport.width, target: hit.target,
      message: `${hit.message} on ${where.route}`, evidence: hit.evidence, gen: where.gen, reproduction, frames: hit.frames,
    }, ctx);
  }

  /**
   * Copy a finding recorded elsewhere (a scenario's own context, e.g. a sideways pan during a setup
   * step) into this store under the given context.
   */
  adopt(f: Finding, reproduction: readonly string[], ctx: RecordContext): { finding: Finding; fresh: boolean } {
    return this.upsert({
      kind: f.kind, severity: f.severity, source: f.source, confidence: f.confidence, confidenceScore: f.confidenceScore, basis: f.basis,
      route: f.route, viewportWidth: f.viewportWidth, target: f.target, message: f.message, evidence: f.evidence, gen: f.firstSeen.gen,
      reproduction, frames: f.frames,
    }, ctx);
  }

  /** Mark or clear a scan suppression on a finding (the finding itself is always kept and reported). */
  suppress(id: string, s: Finding['suppressed'] | undefined): void {
    const f = this.get(id);
    if (!f) return;
    if (s) f.suppressed = s;
    else delete f.suppressed;
  }

  private upsert(input: {
    kind: Finding['kind']; severity: Finding['severity']; source: Finding['source']; confidence: Finding['confidence'];
    confidenceScore: number; basis: EvidenceBasis[]; route: string; viewportWidth: number;
    target?: FindingTarget; message: string; evidence: LayoutFlag['evidence']; gen: number; reproduction: readonly string[];
    frames?: EvidenceFrame[];
  }, ctx: RecordContext): { finding: Finding; fresh: boolean } {
    const device = ctx.device ?? this.device;
    const keepRef = ctx.keepRefs ?? !ctx.device;
    // Refs change across documents, so identity is device + scenario + kind + route + the element's
    // role, name and context. The UI state is not part of it: the same problem seen in several states
    // of one scenario is one finding, which lists every state.
    const key = [device, ctx.scenario ?? '', input.kind, input.route, input.target?.role ?? '', input.target?.name ?? '', input.target?.context ?? ''].join('\u0000');
    const { ref, ...rest } = input.target ?? { role: '', name: '' };
    const target: FindingTarget | undefined = input.target ? { ...rest, ...(keepRef && ref ? { ref } : {}) } : undefined;
    const existing = this.byKey.get(key);
    if (existing) {
      existing.lastSeenGen = input.gen;
      existing.occurrences++;
      if (target) existing.target = target;
      if (ctx.state && !existing.states?.includes(ctx.state)) (existing.states ??= []).push(ctx.state);
      return { finding: existing, fresh: false };
    }
    // A heuristic stays below high severity unless a deterministic measurement backs it.
    const severity = input.confidence === 'heuristic' && input.severity === 'high' && !input.basis.some((b) => DETERMINISTIC.has(b)) ? 'medium' : input.severity;
    const finding: Finding = {
      id: `F${this.next++}`, kind: input.kind, detector: { name: input.kind, version: DETECTORS[input.kind].version },
      severity, source: input.source, confidence: input.confidence, confidenceScore: input.confidenceScore, basis: [...input.basis],
      route: input.route, device, viewportWidth: input.viewportWidth,
      ...(ctx.scenario ? { scenario: ctx.scenario } : {}),
      ...(ctx.state ? { state: ctx.state, states: [ctx.state] } : {}),
      ...(target ? { target } : {}),
      message: input.message, evidence: { ...input.evidence },
      fingerprint: fingerprintOf(input.kind, input.route, target),
      ...(ctx.frame ? { frame: ctx.frame } : {}),
      ...(input.frames?.length ? { frames: input.frames.map((f) => ({ ...f })) } : {}),
      firstSeen: { gen: input.gen, at: new Date().toISOString() }, lastSeenGen: input.gen, occurrences: 1,
      reproduction: [...input.reproduction],
    };
    if (this.byKey.size >= this.max) {
      this.omittedCount++;
      return { finding, fresh: false };
    }
    this.byKey.set(key, finding);
    return { finding, fresh: true };
  }
}

function controlTarget(c: Pick<Control, 'ref' | 'role' | 'name' | 'context'>): FindingTarget {
  return { role: c.role, name: c.name, ...(c.ref ? { ref: c.ref } : {}), ...(c.context ? { context: c.context } : {}) };
}
