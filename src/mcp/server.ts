// Local stdio MCP server. A thin adapter: tools, schemas and behaviour all come from the command
// table in src/core/commands.ts; this file only translates to and from MCP messages.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { COMMANDS, SessionHost, dispatch } from '../core/commands.js';
import { SessionFeed } from '../core/feed.js';
import { formatError } from '../core/format.js';
import { productVersion } from '../core/versions.js';
import { Dashboard } from '../dashboard/server.js';
import type { HumanInput } from '../core/lab.js';
import type { ControlOp } from '../core/control.js';
import { clearDashboardRecord, writeDashboardRecord } from '../daemon/state.js';

const INSTRUCTIONS = `Agent Device Lab drives a local web app in a Chromium mobile profile.
1. start {project}: starts or reuses the services declared in the project's agentlab.json (in dependency order) and returns the first observation. auth "fresh" ignores saved sign-in state.
2. observe returns visible controls with refs (e.g. e12). Actions take a ref, or an exact role + name: click, fill, press, select, check, uncheck, hover, upload, drag; scroll and swipe (the page or a region); back and forward.
3. Every action returns only what changed ("changed"), plus notes, settling and new usability findings. Pop-ups and new tabs open as tabs: the new tab becomes active; tabs / switch_tab / close_tab manage them.
4. sweep {route?} checks one route at 320, 390, 768 and 1440 px in isolated contexts. scan runs the project's declared UI states (drawers, menus, dialogs, tabs; scan.scenarios in agentlab.json), optionally exploring safe ones, and returns a verdict, problem groups and report paths. Confirmed findings rest on a measurement (hit test, clipping, a WCAG rule); heuristic ones are warnings.
5. inspect lists findings (overflow, clipping, obstruction, tap targets, wrapping, layout shift…) with evidence and reproduction steps; inspect {id} for one.
6. auth_save stores the session's sign-in state for later sessions (never returned). bundle {note?} writes a secret-free failure bundle (action log, findings, frames) that "agentlab replay" can re-run. stop closes the browser and stops only the services the lab started.
Refs from a previous page or another tab are stale; observe again rather than guessing. Upload files must be inside the project's uploads.allow directories.`;
const DASHBOARD_NOTE = '\nThe start result includes a local dashboard URL (live viewport, timeline, findings) for a person to watch; share it with the user if they want to follow along.';

export async function runMcpServer(opts: { stateDir: string; headless?: boolean; ui?: boolean }): Promise<void> {
  const version = productVersion();
  const ui = opts.ui ?? true;
  const feed = new SessionFeed();
  // A new session rotates the dashboard's tokens (old viewers lose access), so the person's control URL
  // is re-published whenever one starts; it would otherwise stop working after the agent's second start.
  let announce: (() => void) | undefined;
  const host = new SessionHost({
    stateDir: opts.stateDir, evidenceFrames: ui,
    onEvent: (e) => { feed.apply(e); if (e.kind === 'starting') announce?.(); },
  }, { headless: opts.headless });
  // Frames and events go to the dashboard only; tool results carry at most its URL.
  const dashboard = ui ? await Dashboard.listen({
    feed, source: () => host.lab,
    control: (op, by) => host.supervise(op as ControlOp, by),
    input: (i) => host.lab.humanInput(i as HumanInput),
  }) : undefined;
  if (dashboard) {
    // The agent's results carry the view-only URL. The person's control URL goes to stderr (the MCP
    // client's log) and to an owner-only record that `agentlab ui` reads; it never reaches tool results.
    host.dashboardUrl = () => dashboard.viewUrl;
    let published = '';
    announce = () => {
      if (dashboard.url === published) return;
      published = dashboard.url;
      writeDashboardRecord(opts.stateDir, dashboard.url);
      process.stderr.write(`agentlab: dashboard with controls: ${dashboard.url}\n  (or run \`agentlab ui\` in ${process.cwd()})\n`);
    };
    announce();
  }
  const tools = COMMANDS.filter((c) => c.surfaces.includes('mcp'));

  const server = new Server({ name: 'agent-device-lab', version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS + (dashboard ? DASHBOARD_NOTE : '') });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((c) => ({ name: c.name, description: c.description, inputSchema: c.inputSchema })),
  }));

  // One page, one session: tool calls run strictly in order even if a client pipelines them.
  let queue: Promise<unknown> = Promise.resolve();
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const task = queue.then(async (): Promise<CallToolResult> => {
      const out = await dispatch(host, 'mcp', request.params.name, request.params.arguments ?? {});
      if (!out.ok) {
        return { isError: true, content: [{ type: 'text', text: `error ${formatError(out.error)}` }], structuredContent: { error: out.error } };
      }
      const failed = out.output.result.outcome === 'error';
      return { content: [{ type: 'text', text: out.output.text }], structuredContent: out.output.result, ...(failed ? { isError: true } : {}) };
    });
    queue = task.catch(() => undefined);
    return task;
  });

  let closing = false;
  const shutdown = async (reason: string) => {
    if (closing) return;
    closing = true;
    await host.lab.close(reason).catch(() => undefined);
    await dashboard?.close().catch(() => undefined);
    if (dashboard) clearDashboardRecord(opts.stateDir);
    process.exit(0);
  };
  server.onclose = () => void shutdown('mcp client disconnected');
  process.stdin.on('end', () => void shutdown('mcp client disconnected'));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => void shutdown(`mcp server received ${sig}`));

  await server.connect(new StdioServerTransport());
}
