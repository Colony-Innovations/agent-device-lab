# Architecture

This page is the map of Agent Device Lab Web V1: which processes exist, what each module is responsible for, how a command travels from an agent to the browser, how a person supervises the session, and what is written to disk. It describes the code as of Web V1 (0.3.0). Scans are described in [web-v1-m2.md](web-v1-m2.md).

The rules that hold everywhere:

- **One core, thin adapters.** The CLI, the MCP server and flows all run commands through `src/core/commands.ts`. Adapters translate; they hold no session logic.
- **One session, one page.** A `Lab` owns one Chromium context and one active page. Commands run strictly one at a time.
- **Only stop what the lab started.** A process is signalled only after its identity (PID plus start time) is verified.
- **Page text is untrusted.** Observations are bounded, and what is omitted is counted.

## Process model

```
agentlab CLI ──unix socket (0600)──▶ daemon (one per state dir) ──┐
MCP client ──stdio──▶ agentlab mcp ────────────────────────────────┤──▶ SessionHost ─▶ dispatch() + COMMANDS ─▶ Lab
agentlab run | scan --project | test | sweep --project |           │
  scenario --project (in-process, no daemon) ──────────────────────┘          │
                                                                              ├─ ServiceGroup: owned process groups, or reused
                                                                              ├─ Chromium: one context, one active page (tabs)
                                                                              ├─ FindingStore, action log, Supervisor
                                                                              └─ LabEvent ─▶ SessionFeed ─▶ Dashboard
browser ──http://127.0.0.1:<port>, token──▶ Dashboard (same process as the Lab)
```

| process | started by | holds the session | dashboard | ends when |
| --- | --- | --- | --- | --- |
| **Daemon** (`src/daemon/main.ts`) | `agentlab start` (detached) | yes, for later CLI calls | yes, unless `--no-ui` | the session closes, `start` fails, the browser goes away, or it receives SIGINT, SIGTERM or SIGHUP |
| **MCP server** (`src/mcp/server.ts`) | an MCP client, via `agentlab mcp` | yes, for the client's tool calls | yes, unless `--no-ui` | the client disconnects (stdin ends), or a signal |
| **In-process run** (`src/cli/main.ts`, `src/cli/ci.ts`) | `run`, `scan --project`, `test`, `sweep --project`, `scenario --project` | yes, for the length of the command | `run --ui` and `scan --project --ui` only | the command finishes, times out or is cancelled by a signal |

Why a daemon: each CLI call is a separate process, but the browser, the refs and the observation baseline must persist between calls. The CLI reaches the daemon over a unix socket in the state directory (a hashed name in the temp directory when the path would be too long for a socket). The socket is mode 0600, and the daemon's own queue runs one command at a time.

Why the MCP server holds its own session: the client talks to it over stdio, so there is nothing to attach to. Tool calls are queued, so a client that pipelines calls still gets them run in order.

The in-process commands (`run`, `scan --project`, CI) never use a daemon. They create a `Lab`, run, and close it. `onTermination` (`src/cli/signals.ts`) closes the Lab on SIGINT, SIGTERM or SIGHUP and exits 130, 143 or 129; a second signal exits at once with 1.

## Core modules

All paths are under `src/core/` unless noted.

| module | responsibility |
| --- | --- |
| `schema.ts` | The versioned JSON contract: observations, action results, findings, the profile, `LabError` and its codes, the failure bundle. |
| `versions.ts` | `CONTRACT_VERSIONS`, the one place every contract number lives, and the package version. |
| `profile.ts` | Loads and strictly parses `agentlab.json` (schemaVersion 1 and 2), `startOrder`, the URL policy. `migrate.ts` rewrites version 1 as 2. |
| `project-runner.ts` | One service: start, reuse, readiness (http, tcp, log, alive, one-shot exit), owned-only stop, capped service logs. `WebServer` is the single-server wrapper. |
| `services.ts` | `ServiceGroup`: environment check, dependency-ordered concurrent start, abort and clean up on a required failure, reverse-order stop. |
| `process-identity.ts` | PID plus kernel start time (and boot id). `checkIdentity` returns `same`, `gone`, `reused` or `unverifiable`. Nothing is signalled unless it is `same`. |
| `ownership.ts` | Ownership records, `reapOrphans`, `stopRecordedServices` (shared with `agentlab stop`), `pruneRuns`. |
| `lab.ts` | The session: start and close, observation, every action, settling, tabs, sweeps and scans, bundles, traces, supervision hooks, human input. `Lab.isolated` makes the child Labs that scenarios run in. |
| `commands.ts` | The command table, `SessionHost` and `dispatch()`. |
| `control.ts` | `Supervisor`: the pure supervision state machine (see below). |
| `extract.ts` | In-page functions. Playwright serialises them, so they are self-contained: no imports, no outer references. |
| `observation.ts` | Pure layout flags and the observation diff. |
| `findings.ts` | `FindingStore`: pure, session-scoped, at most 2000 findings. |
| `checks.ts`, `detectors.ts` | The one detector engine (`measureState`) and the pure detector decisions and registry. `sweep.ts` and `scan.ts` must not grow their own detectors. |
| `sweep.ts`, `scan.ts` | The serial responsive sweep, and stateful scans with exploration, wrap comparison, suppressions, policy and reports (`explore-safety.ts`, `scan-policy.ts`, `scan-report.ts`). |
| `steps.ts` | Flow and scenario steps: role/name resolution and expectations. Shared by `src/cli/flow.ts` and `scan.ts`. |
| `auth.ts` | Saved sign-in state: owner-only file, git-ignore check, validation, invalidation, the `AGENTLAB_AUTH_STATE` parser. Its contents never leave this module. |
| `action-log.ts` | The structured, replay-oriented log of agent actions (last 500) and a compact copy of the last 10 observations. Masks values typed into password-like fields. |
| `reproduction.ts` | Capped history and event lists with exact totals. |
| `bundle.ts`, `replay.ts` | Failure bundles (write, read, list, prune) and replay. `trace-sanitize.ts` and `zip.ts` make a Playwright trace safe to include. |
| `ci.ts` | Pure CI mode: selection from flags and the `ci` section, the policy, the `agentlab.ci-result` document and its text, JUnit and HTML renderings. |
| `feed.ts` | `SessionFeed`, the dashboard's typed event stream. |
| `format.ts` | Text output for the CLI and the MCP `content`. |
| `init.ts`, `doctor.ts` | Read-only project detection and environment checks. |
| `devices.ts` | Built-in device profiles and project overrides. |

Outside `core/`:

| module | responsibility |
| --- | --- |
| `src/cli/main.ts` | Argument parsing and every CLI command, including `init`, `doctor`, `migrate`, `clean`, `version`, `install-browser`, `bundles`, `replay`. |
| `src/cli/ci.ts` | CI orchestration: validation, flows, sweeps and scan, artifacts, exit codes. |
| `src/cli/flow.ts` | The scripted flow runner. |
| `src/daemon/` | The daemon process and its state files (`state.ts`). |
| `src/dashboard/server.ts` | The HTTP server: tokens, Host and Origin checks, SSE, MJPEG, control and input POSTs. `open.ts` opens the desktop browser. |
| `src/mcp/server.ts` | The stdio MCP adapter. |
| `assets/dashboard/` | The dashboard page: static HTML, CSS and JavaScript. It renders page text with `textContent` only. |
| `bin/agentlab.js` | The package entry. It refuses Node.js older than 22 before loading anything. |

## Commands and dispatch

`COMMANDS` in `commands.ts` is the command table. Each entry has a name, a description, a flat JSON-Schema input, the surfaces it appears on (`cli`, `mcp`) and a **kind** that decides how supervision treats it:

| kind | meaning | commands |
| --- | --- | --- |
| `read` | never refused | `inspect`, `bundle`, `status` (CLI only), `tabs` |
| `observe` | refused only while a person holds the page (or after a stop) | `observe` |
| `act` | needs agent control and, after a hand-back, a fresh observation | `start`, `click`, `fill`, `press`, `select`, `check`, `uncheck`, `scroll`, `swipe`, `back`, `forward`, `hover`, `upload`, `drag`, `open_tab`, `switch_tab`, `close_tab`, `sweep`, `scan`, `auth_save`, `stop` |

`dispatch(host, surface, name, args)` is the only entry point both adapters call:

1. `getCommand` finds the command for the surface, or returns `invalid_request` listing the commands.
2. `validateArgs` checks the arguments against the command's schema: unknown argument, wrong type, enum, minimum and maximum, required. A string without its own `maxLength` is limited to 4096 characters, and a list without its own `maxItems` to 100 items.
3. The command runs. Targeted actions take a `ref`, or a `name` (optionally with `role`) that is resolved against the latest observation. More than one match is `ambiguous_target`; the lab never guesses.
4. Any error becomes a `LabError` with a code, message, hint and `recoverable` flag.

`SessionHost` owns the current `Lab`. A `Lab` is single-use: after a session ends, the next `start` gets a new one. After a person stops the session from the dashboard, `host.halted` is set and `start` fails with `session_stopped`, so an agent cannot start again behind the person's back.

Adding a capability means adding it to this table. Arbitrary script evaluation is deliberately not a command.

## Supervision

A person watching the dashboard can pause the agent, take over the browser, hand control back, or stop the run. `Supervisor` (`control.ts`) is a pure state machine; `Lab` performs the side effects. Nothing is queued: a command that may not run now is refused at that moment with a structured, recoverable error.

### Modes

| mode | meaning |
| --- | --- |
| `agent` | The agent has control. |
| `pausing` | A pause or takeover was requested while a command was running. It takes effect when that command ends. `pending` says what happens next (`paused` or `human`). |
| `paused` | A person paused the session. Nothing acts; reads and `observe` still work. |
| `human` | A person holds the browser. Even `observe` is refused. |
| `stopping` | A stop was requested while a command was running. `pending` is `stop`. |
| `stopped` | The session is stopping or has stopped. Final. |

### Requests and transitions

| request | from | to |
| --- | --- | --- |
| `pause` ("Pause after this action") | `agent`, idle | `paused` |
| | `agent`, busy | `pausing` (pending `paused`, interrupts long commands at their next checkpoint) |
| | `pausing` (pending `paused`) | stays `pausing`, and now interrupts too |
| `pause-next` ("Pause before next action") | `agent`, idle | `paused` |
| | `agent`, busy | `pausing` (pending `paused`, the running command runs to the end) |
| `takeover` | `agent`, `pausing` or `paused`, idle | `human` |
| | busy | `pausing` (pending `human`, interrupts) |
| `resume` | `paused`, or `pausing` with pending `paused` | `agent`, with `observeRequired` if a person acted meanwhile |
| `return` | `human`, or `pausing` with pending `human` | `agent`, with `observeRequired` set |
| `stop` | any mode but `stopping`, `stopped`; idle | `stopped` |
| | busy | `stopping`, interrupts |
| `emergency-stop` | any mode but `stopped` | `stopped` at once |
| (command ends) | `pausing` | `paused` or `human` |
| | `stopping` | `stopped` |
| (agent observes) | `agent` with `observeRequired` | `agent`, flag cleared |

Any other combination is `invalid_control` (HTTP 409 from the dashboard), with the reason in the message: for example `resume` while a person has control says to use `return`.

### What an agent gets when it is refused

`admit(command, kind)` runs before an action is resolved, so a paused session says so instead of answering `not_found`.

| session state | `read` | `observe` | `act` |
| --- | --- | --- | --- |
| `agent` | runs | runs | runs |
| `agent`, `observeRequired` | runs | runs, then clears the flag | `observation_required` |
| `paused`, or `pausing` toward a pause | runs | runs | `session_paused` |
| `human`, or `pausing` toward a takeover | runs | `human_control` | `human_control` |
| `stopping`, `stopped` | runs | `session_stopped` | `session_stopped` |

`stop` is an `act`, so an agent's `stop` tool is refused while a person has paused or taken over. `agentlab stop` from a terminal is the owner's safety operation and is not: on the `cli` surface (the daemon's owner-only socket), while control is not with the agent, `stop` is applied as a supervision stop by `terminal`, recorded as `stopped from the terminal` (the command in flight finishes first, as with the dashboard's stop), and the process starts no further session. Emergency stop stays available on the dashboard in every mode until the session has stopped. In agent mode `stop` never needs a fresh observe after a hand-back: it acts on no ref, so stale refs do not matter.

A refusal is recorded on the dashboard's timeline as a `refused` entry.

### Side effects in the Lab

- On `resume` or `return` after a person used the page, the Lab raises its ref floor: every ref issued earlier is stale.
- On `stopped`, the Lab sets the ended reason first (so a command in flight reports `browser_closed` rather than a generic failure), then closes the session: browser first, then only the services the lab started.
- A scan, a sweep or a flow checks `shouldInterrupt()` between units of work. An interrupted scan has the verdict `incomplete` and lists the runs it skipped. A flow has no one to return an error to, so it waits for control to come back (`waitForTurn`), and fails with `session_stopped` if the person stops the run.
- The in-page recorder reports a person's interactions only while the mode is `paused` or `human`. See [dashboard.md](dashboard.md) for what is recorded.

## Event flow

```
Lab ──emit──▶ LabEvent ──onEvent──▶ SessionFeed.apply ──▶ FeedMessage {seq, at, event}
                                         │                        │
                              (pure: no browser, no                ├─ SSE /api/events: snapshot, then live messages
                               second engine)                      └─ buffered: last 1000 messages
Lab.screencast ─▶ Dashboard (only while a viewer is connected) ──▶ MJPEG /api/viewport
```

`LabEvent` kinds are `starting`, `start`, `start-failed`, `server-log`, `observe`, `act`, `findings`, `page`, `counts`, `service`, `auth`, `sweep`, `scan`, `control`, `human`, `refused` and `closed`. `SessionFeed` turns them into feed events: `reset` (a new session), `status`, `timeline`, `finding`, `server-log`, `sweep` and `scan`. It derives everything from the events, never re-observes the page, redacts values (see [security.md](security.md)) and is unit-tested without a browser. The daemon also logs from the same events (`daemon.log`).

Delivery: every message has a sequence number, which is the SSE `id`. A new connection gets a snapshot (status, the last 200 timeline entries, all findings, the last 200 server log lines, recent sweeps and scans). A reconnect with `Last-Event-ID` gets only the messages it missed, or a fresh snapshot when they are no longer buffered. High-frequency counters are coalesced (250 ms).

The dashboard has two tokens. The **view token** is in the URL agents receive; it can read. The **control token** is in the URL a person gets from `agentlab ui`; only it may POST supervision requests and input. Both rotate when a new session starts in the same process. See [dashboard.md](dashboard.md).

## State on disk, ownership and cleanup

State lives in `./.agentlab/` in a directory that has `agentlab.json` (or an existing `.agentlab/`), otherwise in `$XDG_STATE_HOME/agentlab/projects/<dir>-<hash>/`. `AGENTLAB_HOME` overrides both. Directories are created 0700 and files 0600.

```
<state dir>/
  daemon.json         daemon pid and identity, socket, session id, the dashboard control URL, service records (0600)
  daemon.sock         the daemon's socket (0600)
  daemon.log          the ordered action log; server output echoed up to 5 MB
  mcp-dashboard.json  the MCP server's control URL for `agentlab ui` (0600); removed when the server exits
  runs/<session>/     actions.jsonl, <service>.log (each capped at 20 MB), findings.json, frames/, sweeps/S<n>/, scans/R<n>/, flow-result.json
  owned/<session>.json  what the live session started, and its own process identity
  bundles/<id>/       failure bundles
```

Saved sign-in state is not under the state directory: it is the project's `auth.file` (default `.agentlab/auth/state.json`, relative to the profile).

**Ownership records.** Right after a session's services start, it writes `owned/<session>.json`: its own process identity and one record per service (owned or reused, process or one-shot, PID and identity, the one-shot's stop command). It removes the file after it has stopped the services. If the session dies without cleanup (SIGKILL, a crash), the record is what lets the next `Lab.start`, `agentlab stop` or `agentlab clean` find the orphans.

**Reaping** (`reapOrphans`). For each record:

- A record whose owner is still the process that wrote it (a live session), or whose owner cannot be verified, is never touched.
- For a record whose owner is gone or reused, each *owned process* service whose group leader's identity is still `same` gets SIGTERM, then SIGKILL after its grace period (5 s by default) if the group has not emptied.
- A service whose PID now belongs to another process (`reused`), or that cannot be verified, is not signalled and is named in the output.
- A one-shot service (such as `docker compose up -d`) is never stopped by reaping: its stop command is printed for a person to run, because the containers cannot be proved to be the ones the lab started.
- Reused services are never signalled.

`pruneRuns` keeps the newest 20 runs (`AGENTLAB_KEEP_RUNS`, 0 keeps all) and never removes a run a live session owns.

## Failure bundles and replay

A bundle is a folder under `<state dir>/bundles/<id>/` (or `<out>/bundles/<id>/` in CI) holding `bundle.json`, `frames/*.jpg` and, when the session recorded a trace and it could be proved clean, `trace.zip`.

- **Writing** (`writeBundle`): the structured action log, the last observations, findings, console and network failures (counts and short texts, never bodies, headers or queries), the sanitized profile, and the environment and versions. Then a final pass replaces every secret value the process knows and checks that none remains; if one does, nothing is written (`bundle_unsafe`).
- **Reading** (`parseBundle`): a bundle is untrusted input. Its shape is validated, a newer `bundleVersion` is refused (`bundle_too_new`), and every field replay uses is checked.
- **Replay** (`replayBundle`): re-runs the recorded *agent* actions in a fresh session against the live `agentlab.json`. Nothing that runs comes from the bundle: commands, environment and paths come from the project's own profile, and role/name targets and typed values go through the same `act()` an agent's would, including the `uploads.allow` check. It stops at the first difference.

The commands are in [cli.md](cli.md#failure-bundles-and-replay).

## CI pipeline

`agentlab test`, `sweep --project`, `scenario --project` and `report` (`src/cli/ci.ts` over `src/core/ci.ts`):

```
validate (read-only, every problem listed)  ── exit 2 on any problem; --validate-only stops here
   │
flows ── one Lab each, sequentially; a failing flow writes a bundle
   │
one Lab for sweeps and scan ── isolated contexts per width and scenario
   │
decide ── apply suppressions, group findings, evaluate the policy
   │
redact every output with the redaction set, check once more for leaks (fail closed)
   │
write ci-result.json, summary.txt, report.html, junit.xml, scan/, frames/, bundles/, traces/  ── exit 0, 1, 2 or 3
```

A wall-clock timeout (default 30 minutes) or a signal closes every Lab (stopping only what the lab started), writes a partial result and exits 3, or 130, 143 or 129. Everything about flags, artifacts and exit codes is in [ci.md](ci.md).

## Where to look next

| if you want to | read |
| --- | --- |
| set up a project | [configuration.md](configuration.md) |
| run a command | [cli.md](cli.md) |
| connect an agent | [mcp.md](mcp.md) |
| watch or supervise a session | [dashboard.md](dashboard.md) |
| understand the safety model | [security.md](security.md) |
