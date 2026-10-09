import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { redactTree } from '../core/bundle.js';
import { formatAction, formatClose, formatError, formatStart } from '../core/format.js';
import type { StoredState } from '../core/auth.js';
import { Lab, type CloseResult, type LabOptions } from '../core/lab.js';
import { LabError, type ActionResult, type BundleFailure, type LabErrorJSON } from '../core/schema.js';
import { check, describeStep, stepRequest, type FlowStep } from '../core/steps.js';

export { check, type Expectation, type FlowStep } from '../core/steps.js';

// A flow is a scripted agent session: role/name targets are resolved against the latest observation
// (never guessed), each action goes through the same core as the CLI, and expectations check the result.

export interface Flow {
  name: string;
  description?: string;
  project: string;
  device?: string;
  /** Saved sign-in state for the flow's session (default: fresh, so flows are reproducible). */
  auth?: 'auto' | 'saved' | 'fresh';
  steps: FlowStep[];
}

export interface FlowOptions {
  headed: boolean; device?: string; slowMoMs?: number; json: boolean; stateDir: string;
  /** Output sink (default: stdout). */
  write?: (text: string) => void;
  /** Extra Lab options, e.g. the dashboard's event sink. */
  lab?: Omit<LabOptions, 'stateDir'>;
  /** Called with the Lab before it starts (the dashboard reads its viewport from it). */
  onLab?: (lab: Lab) => void;
  /** CI: run the flow against this project instead of the flow file's `project`. */
  project?: string;
  /** CI: the sign-in mode for a flow that does not declare its own `auth`. */
  auth?: 'auto' | 'saved' | 'fresh';
  /** CI: an in-memory sign-in state, used unless the flow declares `auth: "fresh"`. */
  authState?: StoredState;
  /** Record a Playwright trace for the failure bundle or a saved trace. */
  trace?: boolean;
  /**
   * Called with the still-open Lab after the last step and before it closes: a CI run writes the failure
   * bundle or the trace here. `failure` is set when the flow failed after its session started. Errors thrown are ignored.
   */
  beforeClose?: (lab: Lab, outcome: { passed: boolean; failure?: BundleFailure; reason?: string }) => Promise<void>;
}

/** What a flow run reports, for a CI result. */
export interface FlowOutcome {
  name: string;
  file: string;
  passed: boolean;
  steps: number;
  completed: number;
  elapsedMs: number;
  runDir?: string;
  /** The first step that failed, when the flow got that far. */
  failedStep?: { index: number; label: string; kind: 'action-error' | 'expectation' | 'error'; text: string };
  /** The session could not start: the flow never ran. */
  startError?: LabErrorJSON;
}

interface StepReport { index: number; label: string; ok: boolean; action?: ActionResult; checks: { ok: boolean; text: string }[]; error?: LabErrorJSON }

export async function runFlow(flowPath: string, opts: FlowOptions): Promise<boolean> {
  return (await runFlowDetailed(flowPath, opts)).passed;
}

export async function runFlowDetailed(flowPath: string, opts: FlowOptions): Promise<FlowOutcome> {
  const file = resolve(flowPath);
  const flow = JSON.parse(await readFile(file, 'utf8')) as Flow;
  const write = opts.write ?? ((s: string) => { process.stdout.write(s); });
  const out = (s: string) => { if (!opts.json) write(s + '\n'); };
  const indent = (s: string) => s.split('\n').map((l) => `    ${l}`).join('\n');

  const lab = new Lab({ ...opts.lab, stateDir: opts.stateDir });
  opts.onLab?.(lab);
  const t0 = Date.now();
  const reports: StepReport[] = [];
  let closeResult: CloseResult | undefined;
  let runDir: string | undefined;
  let startError: LabErrorJSON | undefined;

  out(`flow: ${flow.name}`);
  try {
    const start = await lab.start({
      project: opts.project ?? resolve(dirname(file), flow.project),
      device: opts.device ?? flow.device,
      headed: opts.headed,
      slowMoMs: opts.slowMoMs,
      auth: flow.auth ?? opts.auth ?? 'fresh',
      ...(opts.authState && (flow.auth ?? 'saved') !== 'fresh' ? { authState: opts.authState } : {}),
      ...(opts.trace ? { trace: true } : {}),
    });
    runDir = start.session.runDir;
    out(indent(formatStart(start)));

    for (const [i, step] of flow.steps.entries()) {
      const label = step.label ?? describeStep(step);
      out(`\nstep ${i + 1}/${flow.steps.length}: ${label}`);
      const report: StepReport = { index: i + 1, label, ok: true, checks: [] };
      reports.push(report);
      try {
        // A person watching may pause or take over between steps. A flow has no one to return an error
        // to, so it waits for control to come back, then observes afresh before resolving the next target.
        if (lab.control.mode !== 'agent') {
          out(`  waiting: ${lab.control.mode === 'human' ? 'a person has control of the browser' : 'paused from the dashboard'}`);
          await lab.control.waitForTurn();
        }
        if (lab.control.state.observeRequired) await lab.observe();
        if (step.do) {
          report.action = await lab.act(stepRequest(lab, step));
          out(indent(formatAction(report.action)));
          if (report.action.outcome === 'error') report.ok = false;
        }
        if (report.ok && step.expect) {
          report.checks = check(step.expect, lab.lastObservation!, report.action, lab.inspect().findings);
          for (const c of report.checks) out(`  ${c.ok ? 'PASS' : 'FAIL'} ${c.text}`);
          report.ok = report.checks.every((c) => c.ok);
        }
      } catch (err) {
        report.ok = false;
        report.error = LabError.from(err).toJSON();
        out(indent(`ERROR ${formatError(report.error)}`));
      }
      if (!report.ok) break;
    }
  } catch (err) {
    startError = LabError.from(err).toJSON();
    out(`start failed: ${formatError(startError)}`);
  } finally {
    if (opts.beforeClose && lab.active) {
      const bad = reports.find((r) => !r.ok);
      const failure = bad ? failureOf(bad) : undefined;
      const failedStep = bad ? failedStepOf(bad) : undefined;
      const passed = !bad && reports.length === flow.steps.length;
      await opts.beforeClose(lab, {
        passed, ...(failure ? { failure, reason: `flow "${flow.name}" failed at step ${failedStep!.index}: ${failedStep!.text}` } : {}),
      }).catch(() => undefined);
    }
    closeResult = await lab.close('flow finished');
    out(`\n${formatClose(closeResult)}`);
  }

  const passed = !startError && reports.length === flow.steps.length && reports.every((r) => r.ok);
  // The page can echo what was typed (a console message, an error): every secret the session knows is redacted.
  const secrets = lab.secretValues().filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  const summary = redactTree({
    flow: flow.name, passed, steps: flow.steps.length, completed: reports.filter((r) => r.ok).length,
    elapsedMs: Date.now() - t0, session: lab.status().session?.id, runDir, startError, close: closeResult,
    findings: lab.status().session ? lab.inspect().findings : [], reports,
  }, secrets);
  if (runDir) await writeFile(join(runDir, 'flow-result.json'), JSON.stringify(summary, null, 2));
  if (opts.json) write(JSON.stringify(summary, null, 2) + '\n');
  else out(`${passed ? 'PASS' : 'FAIL'} ${flow.name}: ${summary.completed}/${summary.steps} steps in ${(summary.elapsedMs / 1000).toFixed(1)}s${runDir ? `  (report: ${join(runDir, 'flow-result.json')})` : ''}`);
  const bad = reports.find((r) => !r.ok);
  return {
    name: flow.name, file, passed, steps: flow.steps.length, completed: summary.completed, elapsedMs: summary.elapsedMs, ...(runDir ? { runDir } : {}),
    ...(bad ? { failedStep: failedStepOf(bad) } : {}), ...(startError ? { startError } : {}),
  };
}

/** The bundle's classification of a failed step: an action that errored, or an expectation that did not hold. */
function failureOf(r: StepReport): BundleFailure {
  if (r.error) return { kind: 'action-error', step: r.index, code: r.error.code };
  if (r.action?.outcome === 'error') return { kind: 'action-error', step: r.index, code: r.action.error?.code ?? 'unknown' };
  return { kind: 'expectation', step: r.index, text: r.checks.find((c) => !c.ok)?.text ?? r.label };
}

function failedStepOf(r: StepReport): NonNullable<FlowOutcome['failedStep']> {
  const f = failureOf(r);
  if (f.kind === 'expectation') return { index: r.index, label: r.label, kind: 'expectation', text: f.text };
  const e = r.error ?? r.action?.error;
  return { index: r.index, label: r.label, kind: r.error ? 'error' : 'action-error', text: e ? formatError(e) : (f as { code: string }).code };
}

