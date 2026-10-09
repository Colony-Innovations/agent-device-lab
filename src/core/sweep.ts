import { mkdirSync, writeFileSync } from 'node:fs';
import { redactUrlSecrets } from './url-redact.js';
import { join, relative } from 'node:path';
import type { Browser, BrowserContextOptions } from 'playwright';
import { getDevice } from './devices.js';
import { measureState } from './checks.js';
import type { DetectorOptions } from './detectors.js';
import { installNavTracking, installTimerTracking, waitForDomQuiet } from './extract.js';
import type { FindingStore } from './findings.js';
import type { LabEvent, WatchPage } from './lab.js';
import { settleCauseText } from './format.js';
import { LabError, SCHEMA_VERSION, type DeviceOverride, type Finding, type Interruption, type SettlePolicy, type SweepDeviceResult, type SweepResult } from './schema.js';

// Serial responsive sweep. Each width gets its own browser context (fresh page, same cookies and
// storage as the session), then the one detector engine (checks.ts) measures the route as loaded:
// layout flags from the observation, the layout detectors, and the click path's reach check. A scan
// (scan.ts) is the same engine applied to declared and explored UI states.

export interface SweepEnv {
  browser: Browser;
  storageState: BrowserContextOptions['storageState'];
  origin: string;
  sessionId: string;
  gen: number;
  settle: SettlePolicy;
  store: FindingStore;
  history: readonly string[];
  runDir: string;
  emit: (e: LabEvent) => void;
  /** Project-defined device profiles, so a sweep can use them too. */
  devices?: Readonly<Record<string, DeviceOverride>>;
  /** Which checks run and their settings (the profile's scan section). */
  detectors: DetectorOptions;
  /** Asked before each width: a person paused, took over or stopped the session. */
  checkpoint?: () => Interruption | undefined;
  /** Shows each width's page in the session's live viewport while it is measured. */
  watch?: WatchPage;
}

export interface SweepOptions {
  id: string;
  route: string;
  devices: readonly string[];
  /** Controls given the reach check per width (the rest are still measured for layout). */
  reachLimit?: number;
}

export async function runSweep(env: SweepEnv, opts: SweepOptions): Promise<SweepResult> {
  const devices = opts.devices.map((id) => getDevice(id, env.devices));
  if (!opts.route.startsWith('/')) throw new LabError('invalid_request', `sweep route must be a path starting with "/", got "${opts.route}"`);
  const dir = join(env.runDir, 'sweeps', opts.id);
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  env.emit({ kind: 'sweep', phase: 'start', id: opts.id, route: redactUrlSecrets(opts.route), devices: devices.map((d) => ({ id: d.id, width: d.viewport.width, height: d.viewport.height })) });

  const results: SweepDeviceResult[] = [];
  let interrupted: SweepResult['interrupted'];
  for (const [i, device] of devices.entries()) {
    const stop = env.checkpoint?.();
    if (stop) {
      interrupted = { ...stop, skipped: devices.slice(i).map((d) => d.id) };
      break;
    }
    env.emit({ kind: 'sweep', phase: 'device-start', id: opts.id, device: device.id });
    const r = await sweepDevice(env, opts, device, dir);
    results.push(r);
    env.emit({ kind: 'sweep', phase: 'device-done', id: opts.id, result: r });
  }

  const ids = new Set(results.flatMap((r) => r.findings));
  const findings = env.store.list().filter((f) => ids.has(f.id));
  const report = join(dir, 'report.md');
  const result: SweepResult = {
    schemaVersion: SCHEMA_VERSION, id: opts.id, route: redactUrlSecrets(opts.route), startedAt, ms: Date.now() - t0, devices: results, findings, report,
    ...(interrupted ? { interrupted } : {}),
  };
  writeFileSync(report, sweepReportMarkdown(result, dir));
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  env.emit({ kind: 'sweep', phase: 'done', id: opts.id, result });
  return result;
}

async function sweepDevice(env: SweepEnv, opts: SweepOptions, device: ReturnType<typeof getDevice>, dir: string): Promise<SweepDeviceResult> {
  const t0 = Date.now();
  const url = env.origin + opts.route;
  const base: SweepDeviceResult = {
    device: device.id, label: device.label, width: device.viewport.width, height: device.viewport.height, route: redactUrlSecrets(opts.route),
    status: 'ok', ms: 0, settled: 'quiet', documentWidth: 0, controls: 0, reachChecked: 0, findings: [],
  };
  const context = await env.browser.newContext({
    viewport: device.viewport, deviceScaleFactor: device.deviceScaleFactor, isMobile: device.isMobile, hasTouch: device.hasTouch,
    userAgent: device.userAgent, storageState: env.storageState,
  });
  let unwatch: (() => Promise<void>) | undefined;
  try {
    if (env.settle.timerMaxMs > 0) await context.addInitScript(installTimerTracking);
    await context.addInitScript(installNavTracking);
    const page = await context.newPage();
    unwatch = await env.watch?.(page, device.viewport);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // A scan fails a load error with its HTTP status; a sweep does the same instead of measuring an error page.
    if (response) base.httpStatus = response.status();
    if (response && response.status() >= 400) {
      throw new LabError('http_status', `GET ${redactUrlSecrets(opts.route)} answered HTTP ${response.status()} at ${device.id}; the page was not measured`, {
        hint: 'Check the route, or that the app serves it when signed in with the session\'s state.', details: { status: response.status(), route: redactUrlSecrets(opts.route) },
      });
    }
    await page.waitForLoadState('load', { timeout: env.settle.maxMs }).catch(() => undefined);
    base.settled = await page.evaluate(waitForDomQuiet, { quietMs: env.settle.quietMs, maxMs: env.settle.maxMs, timerMaxMs: env.settle.timerMaxMs })
      .catch(() => 'timeout' as const);
    if (base.settled !== 'quiet') base.settleCause = base.settled === 'timeout' ? 'dom' : base.settled;
    const open = `sweep ${opts.id}: open ${redactUrlSecrets(url)} in a new ${device.id} context (${device.viewport.width}x${device.viewport.height}) with the session's cookies and storage`;
    // The same engine as a scan: the observation's flags, the layout detectors and the reach check.
    const m = await measureState(page, {
      store: env.store, sessionId: env.sessionId, gen: env.gen, ctx: { device: device.id }, reproduction: [...env.history, open],
      detectors: env.detectors, reachLimit: opts.reachLimit ?? 40,
      frameFile: (suffix) => join(dir, suffix === 'state' ? `${device.id}.jpg` : `${device.id}-${suffix}.jpg`),
      onFindings: (findings, frame) => env.emit({ kind: 'findings', findings, ...(frame ? { frame } : {}) }),
    });
    base.route = m.observation.route;
    base.documentWidth = m.observation.documentWidth;
    base.controls = m.observation.controls.length;
    base.reachChecked = m.reachChecked;
    if (m.frame) base.frame = m.frame;
    base.findings = m.findings;
  } catch (err) {
    base.status = 'error';
    base.error = LabError.from(err).toJSON();
  } finally {
    await unwatch?.().catch(() => undefined);
    await context.close().catch(() => undefined);
  }
  base.ms = Date.now() - t0;
  return base;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Compact Markdown report: one section per width, confirmed obstructions apart from heuristic warnings. */
export function sweepReportMarkdown(r: SweepResult, dir: string): string {
  const byId = new Map(r.findings.map((f) => [f.id, f]));
  const lines = [
    `# Responsive sweep ${r.id}: ${r.route}`,
    '',
    `${r.startedAt} · ${r.devices.length} widths, serial, one isolated browser context each · ${r.ms} ms`,
    '',
    '**Confirmed** findings were measured by the reach check (a sideways pan was needed, or the centre is covered after scrolling into view). **Heuristic** findings are layout warnings that often, but not always, hurt a person.',
    '',
    '| device | width | status | document width | controls | confirmed | heuristic | frame |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const d of r.devices) {
    const fs = d.findings.map((id) => byId.get(id)).filter((f): f is Finding => !!f);
    const confirmed = fs.filter((f) => f.confidence === 'confirmed').length;
    lines.push(`| ${d.device} | ${d.width} | ${d.status === 'ok' ? `ok (${d.settled === 'quiet' ? 'quiet' : cell(`settle timed out: ${settleCauseText(d.settleCause ?? 'dom')}`)})` : `error: ${cell(`${d.error?.code ?? ''} ${d.error?.message ?? ''}`.trim())}`} | ${d.documentWidth} | ${d.controls} (${d.reachChecked} reach-checked) | ${confirmed} | ${fs.length - confirmed} | ${d.frame ? `[${d.device}.jpg](${relative(dir, d.frame)})` : '–'} |`);
  }
  for (const d of r.devices) {
    const fs = d.findings.map((id) => byId.get(id)).filter((f): f is Finding => !!f);
    lines.push('', `## ${d.device} (${d.width}×${d.height}) · ${d.route}`, '');
    if (!fs.length) { lines.push('No findings.'); continue; }
    lines.push('| id | confidence | severity | finding | measurements | reproduction |', '| --- | --- | --- | --- | --- | --- |');
    for (const f of [...fs].sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === 'confirmed' ? -1 : 1))) {
      const evidence = Object.entries(f.evidence).map(([k, v]) => `${k}=${v}`).join(', ');
      const repro = f.reproduction.slice(-3).map((s, i, a) => `${f.reproduction.length - a.length + i + 1}. ${s}`).join('<br>');
      lines.push(`| ${f.id} | ${f.confidence} | ${f.severity} | ${cell(`${f.kind}: ${f.message}`)} | ${cell(evidence)} | ${cell(repro)} |`);
    }
  }
  lines.push('', 'Full reproduction steps and evidence frames: `result.json` and the `.jpg` files next to this report.');
  return lines.join('\n') + '\n';
}
