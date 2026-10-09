import { join } from 'node:path';
import { startOrder } from './profile.js';
import { Service, type UnexpectedExit } from './project-runner.js';
import { LabError, type ServiceInfo, type ServiceSpec, type ServiceStartReport, type ServiceStopResult } from './schema.js';

export interface ServiceGroupOptions {
  /** Each service's output goes to <runDir>/<name>.log. */
  runDir: string;
  onLog?: (service: string, line: string) => void;
  /** A started process service exited by itself after it became ready. `required` is the spec's flag. */
  onUnexpectedExit?: (exit: UnexpectedExit & { required: boolean }) => void;
  /** Called as each service becomes ready (started or reused). */
  onReady?: (info: ServiceInfo) => void;
  /** Aborted when the session is closing while services are still starting: what started is stopped and start fails. */
  signal?: AbortSignal;
  /** The environment requiredEnv is checked against (default process.env). */
  env?: NodeJS.ProcessEnv;
}

/** Names of required environment variables that are unset or empty, per service. Values are never read out. */
export function missingEnv(specs: readonly ServiceSpec[], env: NodeJS.ProcessEnv = process.env): { service: string; names: string[] }[] {
  return specs
    .map((s) => ({ service: s.name, names: s.requiredEnv.filter((n) => !env[n] && !s.env[n]) }))
    .filter((m) => m.names.length);
}

/**
 * The project's services for one session. Independent services start concurrently; a service starts
 * only when everything it depends on is ready. If a required service fails, services still starting
 * are abandoned, and every service this group started is stopped in reverse order. Reused services
 * are never stopped.
 */
export class ServiceGroup {
  /** In the order they became ready. */
  private constructor(readonly services: Service[]) {}

  static async start(specs: readonly ServiceSpec[], opts: ServiceGroupOptions): Promise<ServiceGroup> {
    const missing = missingEnv(specs, opts.env);
    if (missing.length) {
      const names = [...new Set(missing.flatMap((m) => m.names))];
      throw new LabError('missing_env', `Required environment variable${names.length > 1 ? 's' : ''} not set: ${names.join(', ')}`, {
        hint: 'Export them in the shell (or MCP client environment) that runs agentlab. Only the names are checked and reported.',
        details: { missing },
      });
    }

    const byName = new Map(specs.map((s) => [s.name, s]));
    const report = new Map<string, ServiceStartReport>(startOrder(specs).map((n) => [n, { name: n, status: 'pending' }]));
    const ready: Service[] = [];
    const abort = new AbortController();
    let failure: LabError | undefined;
    const running = new Map<string, Promise<Service | undefined>>();
    const external = () => {
      failure ??= new LabError('startup_failed', 'service start abandoned: the session is closing');
      abort.abort();
    };
    if (opts.signal?.aborted) external();
    else opts.signal?.addEventListener('abort', external, { once: true });

    const run = (name: string): Promise<Service | undefined> => {
      let p = running.get(name);
      if (p) return p;
      p = (async () => {
        const spec = byName.get(name)!;
        const deps = await Promise.all(spec.dependsOn.map(run));
        const entry = report.get(name)!;
        if (failure) {
          entry.status = 'skipped';
          entry.detail = 'not started: another service failed';
          return undefined;
        }
        const missingDep = spec.dependsOn.find((_, i) => !deps[i]);
        if (missingDep) {
          entry.status = 'skipped';
          entry.detail = `not started: depends on "${missingDep}", which failed`;
          if (spec.required) {
            failure = new LabError('startup_failed', `service "${name}" needs optional service "${missingDep}", which failed`, { details: { service: name } });
            abort.abort();
          }
          return undefined;
        }
        try {
          const svc = await Service.ensure(spec, {
            logFile: join(opts.runDir, `${name}.log`),
            onLog: (line) => opts.onLog?.(name, line),
            signal: abort.signal,
            onUnexpectedExit: (exit) => opts.onUnexpectedExit?.({ ...exit, required: spec.required }),
          });
          ready.push(svc);
          entry.status = svc.info.owned ? 'ready' : 'reused';
          opts.onReady?.(svc.info);
          return svc;
        } catch (err) {
          const error = LabError.from(err);
          const abandoned = error.details?.aborted === true;
          entry.status = abandoned ? 'aborted' : 'failed';
          entry.detail = error.message;
          if (!abandoned && spec.required && !failure) {
            failure = error;
            abort.abort();
          }
          return undefined;
        }
      })();
      running.set(name, p);
      return p;
    };

    await Promise.all(specs.map((s) => run(s.name)));
    opts.signal?.removeEventListener('abort', external);
    const group = new ServiceGroup(ready);
    if (failure) {
      const stopped = await group.stop();
      for (const s of stopped) {
        const entry = report.get(s.name);
        if (entry && s.owned) entry.stopped = s.detail;
      }
      throw new LabError(failure.code, failure.message, {
        hint: failure.hint,
        details: { ...failure.details, services: [...report.values()], stopped },
      });
    }
    return group;
  }

  get(name: string | undefined): Service | undefined {
    return name === undefined ? undefined : this.services.find((s) => s.spec.name === name);
  }

  infos(): ServiceInfo[] {
    return this.services.map((s) => s.info);
  }

  /** Snapshot every owned process service's group members; only those whose leader is still alive can be. */
  refreshMembers(): void {
    for (const svc of this.services) svc.refreshMembers();
  }

  /** Stop owned services, most recently ready first (dependents before what they depend on). */
  async stop(): Promise<ServiceStopResult[]> {
    const results: ServiceStopResult[] = [];
    for (const svc of [...this.services].reverse()) {
      const r = await svc.stop();
      results.push({ name: svc.spec.name, owned: svc.info.owned, stopped: r.stopped, detail: r.reason });
    }
    return results;
  }
}
