# MCP server

`agentlab mcp` is a local stdio [Model Context Protocol](https://modelcontextprotocol.io) server. It gives an agent the same commands as the CLI: start a project, observe it, act in it, sweep and scan it, and stop. It uses the same command table and core as the CLI ([architecture.md](architecture.md#commands-and-dispatch)); the adapter only translates messages.

## Setup

Use the absolute path of the installed binary (`command -v agentlab`) unless you know the client's `PATH` contains it; GUI launchers often do not. Neither client needs a login or any model usage to register the server. The browser runs without a window; watch it in the dashboard. `--headed` in place of `--headless` opens a visible window and needs a display.

The commands below are the ones verified in [install.md](install.md).

### Claude Code (verified with 2.1.280)

```bash
claude mcp add --scope user agentlab -- "$(command -v agentlab)" mcp --headless
claude mcp get agentlab       # Status: ✔ Connected
claude mcp list               # agentlab: <path> mcp --headless - ✔ Connected
```

`claude mcp get` and `claude mcp list` health-check the server with a real MCP `initialize` over stdio, so "Connected" proves the client can launch and talk to it. The entry lands in `~/.claude.json`. With `--scope project` the entry is written to `.mcp.json` in the project, the file you commit; Claude Code then shows it as `⏸ Pending approval (run claude to approve)` and does not connect until a person approves it in a session.

### Codex CLI (verified with 0.151.0)

```bash
codex mcp add agentlab -- "$(command -v agentlab)" mcp --headless
codex mcp list                # agentlab ... enabled  (Auth "Unsupported" is normal for stdio)
codex mcp get agentlab --json
```

This writes to `~/.codex/config.toml` (`$CODEX_HOME/config.toml`):

```toml
[mcp_servers.agentlab]
command = "/usr/local/bin/agentlab"
args = ["mcp", "--headless"]
```

`codex mcp list` and `get` only read that file; they do not start the server. Codex's own connection to the server could not be verified without a model session. What was verified: the `command` and `args` Codex reads back were launched through the MCP SDK client, which listed the 25 tools and ran a `start`, `observe`, `stop` round trip.

### Any other client

Any client that can launch a stdio server can use it: the command is the absolute path of `agentlab`, the arguments are `mcp` (and `--headless`), and the environment must hold the variables named in the project's `requiredEnv`. Other clients were not tested.

```json
{ "mcpServers": { "agentlab": { "command": "/usr/local/bin/agentlab", "args": ["mcp", "--headless"], "env": { "DEMO_API_TOKEN": "…" } } } }
```

Options: `agentlab mcp [--headed] [--no-ui]`. The browser has no window unless the server is started with `--headed` (the agent cannot open one on its own); `--headless` is accepted and is the default. `--no-ui` turns the dashboard off.

### Using it

The agent calls `start` with `{"project": "/abs/path/to/app"}` (a directory containing `agentlab.json`), then actions with a `ref` from the latest observation, or with `role` and `name`. State goes to `.agentlab/` of the directory the MCP server was started from, or to the per-user state directory if that directory has no `agentlab.json` (see [cli.md](cli.md#conventions)). When the client disconnects, the server closes the session and stops only the services it started.

## Tools

25 tools. A tool call that needs a ref or a name takes either `ref`, or `name` with an optional `role` (an exact accessible name). More than one match is `ambiguous_target`. Arguments are strictly validated: an unknown argument, a wrong type or a value out of range is `invalid_request`. A string without its own limit is at most 4096 characters; a list at most 100 items.

| tool | arguments (`*` required) | what it does |
| --- | --- | --- |
| `start` | `project`\*, `device`, `headed`, `slowMoMs` (0 to 10000), `auth` (`auto`, `saved`, `fresh`), `trace` | Start or reuse the project's services, open Chromium, return the first observation. The result carries `dashboard.url`, a view-only link to share with the user. |
| `observe` | `limit` (1 to 500, default 40) | The compact state: route, headings, open dialog, visible controls with refs, messages, layout flags, finding count, console and network counts. |
| `click` | `ref` or `name` (+ `role`) | A verified tap or click. Returns what changed, how the page settled, new findings and the new observation. |
| `fill` | `ref` or `name` (+ `role`), `value`\* (at most 20000 characters) | Replace the text of a text field. |
| `press` | `key`\* (a key or chord, at most 64 characters), optional `ref` or `name` | Press a key on a control or on whatever has focus. |
| `select` | target, `values`\* (1 to 100 option labels or values) | Choose options of a native `<select>`. |
| `check`, `uncheck` | target | A checkbox, radio or switch, with the state change verified. |
| `scroll` | `direction` (`up`, `down`, `left`, `right`), `amount` (CSS px), optional target | Scroll the page or the region holding the target; with no direction, bring the target into view. |
| `swipe` | `direction`\*, `amount`, optional target | A touch swipe. Needs a touch device profile. |
| `back`, `forward` | none | The active tab's history. |
| `hover` | target | Move the pointer over a control. |
| `upload` | target, `files`\* (1 to 20 project-relative paths) | Give files to a file input. Files must be inside `uploads.allow`. |
| `drag` | target, `toRef`, `dx`, `dy` | Drag onto another control, or by an offset. |
| `tabs` | none | List open tabs. |
| `open_tab` | `path`\* | Open a tab at a path on the app's origin and switch to it. |
| `switch_tab` | `tab`\* (e.g. `t2`) | Make another tab active and observe it. |
| `close_tab` | `tab` (default: active) | Close a tab and switch to its opener. |
| `inspect` | `id` (e.g. `F2`), `ref` | Session findings with evidence and reproduction steps. |
| `sweep` | `route`, `devices` (comma-separated ids) | Load a route at 320, 390, 768 and 1440 px in isolated contexts; returns per-width results, findings and a report path. |
| `scan` | `scenarios` (comma-separated), `route`, `devices`, `explore` | Run the project's declared scenarios (or one route); returns a verdict, problem groups and report paths. |
| `bundle` | `note` (at most 500 characters) | Write a secret-free failure bundle; returns its id, folder, files and counts, never its contents. |
| `auth_save` | none | Save the session's sign-in state for later sessions. The state is never returned. |
| `stop` | none | Close the browser and stop only the services the session started. |

`status` is a CLI-only command and is not an MCP tool. Frames and screenshots never appear in any tool result. Fields and shapes of results are defined in `src/core/schema.ts` and, for scans, described in [web-v1-m2.md](web-v1-m2.md).

The server also sends instructions at initialization: how to start, observe and act; that refs from a previous page or another tab are stale; that `uploads.allow` limits uploads; and, when the dashboard is on, that the `start` result includes a dashboard URL it can share with the user.

## Results

Every tool call returns one MCP result.

| field | content |
| --- | --- |
| `content` | One text item: a concise text rendering of the result. |
| `structuredContent` | The full JSON result of the command (`"schemaVersion": 1`). For `scan`, a compact summary. |
| `isError` | `true` when the call failed, and also when an action ran but its outcome was `error`. Absent otherwise. |

Claude Code 2.1.280 gives the model `structuredContent` when it is present, instead of `content`. Agents using it therefore read the JSON, not the text rendering.

A failed call has `isError: true`, `content` like `error stale_ref: e4 is no longer attached` (with the hint on a following line), and `structuredContent`:

```json
{ "error": { "code": "stale_ref", "message": "e4 is no longer attached to the page", "hint": "Run observe and use a fresh ref.", "recoverable": true, "details": { } } }
```

A failed *action* (for example `stale_ref` on a `click`) returns the action result itself, with `outcome: "error"` and an `error` object of the same shape, and `isError: true`.

Tool calls run strictly one at a time, in order, even if a client pipelines them.

## Errors

`recoverable: true` means the agent can fix it within the same session (observe again, wait, retry with other arguments). `false` means a person must change something, or the session is over.

### Supervision errors

A person watching the dashboard can pause the agent, take over the browser, or stop the run ([dashboard.md](dashboard.md)). These errors say so. Nothing ran and nothing is queued. `details.control` holds the mode, who changed it and since when.

| code | recoverable | meaning | what the agent should do |
| --- | --- | --- | --- |
| `session_paused` | yes | A person paused the session; the action did not run. | `observe`, `inspect`, `tabs` and `bundle` still work. Tell the user you are waiting, and retry the action later. Do not loop. |
| `human_control` | yes | A person has taken control of the browser; `observe` and actions are refused. | Wait for the person to hand control back. Then `observe`: refs from before are stale. |
| `observation_required` | yes | Control came back after a person used the browser, and you have not observed since. | Run `observe`, then act on the fresh refs. |
| `session_stopped` | no | A person stopped the session (or a stop is in progress), or you tried to `start` after one. | Stop. Report what you did, and ask the user before starting another session. Do not work around it. |
| `browser_closed` | no | The session ended while a command was running or before it: an emergency stop, a crashed tab, a service that exited, a closed window. | The session is over. `start` a new one if the user wants to continue (unless a person stopped it, see above). |

### Action errors (recoverable)

| code | meaning | what the agent should do |
| --- | --- | --- |
| `stale_ref` | The ref's element was re-rendered, the page navigated, the ref belongs to another tab, or a person used the page since it was issued. The hint may name the successor ref or the tab. | `observe`, then use a fresh ref (or `switch_tab`). |
| `unknown_ref` | The ref was never issued in this session. | Use a ref from the latest observation. |
| `not_found` | No control matches that role and name, or no such option. | `observe` and check the exact name; a `select` error lists the first options. |
| `ambiguous_target` | More than one control matches. | Use a `ref`, or add a `role`. |
| `not_visible`, `disabled` | The control is hidden or disabled. | `observe` again; act on something else, or satisfy the page's precondition. |
| `obstructed` | A hit test at the control's centre lands on another element, so the control was not activated. The message names it. | Close the overlay or scroll, then retry. |
| `not_fillable`, `not_selectable`, `not_checkable`, `not_uploadable` | The control does not support that action. | Pick the right action for the control's role. |
| `upload_not_allowed` | A file is outside the project's `uploads.allow` directories. | Use an allowed file, or ask the user to allow the directory. |
| `no_history` | There is nothing to go back or forward to. | |
| `unknown_tab` | No such tab. | Run `tabs`. |
| `action_failed` | The action failed for another reason (the first line of the cause). | Read the message; `observe` and retry. |
| `http_status` | A sweep's route answered HTTP 400 or above at that width, so it was not measured. Appears in `sweep` results (`devices[].error`, with `httpStatus`), not as a thrown error. | Fix the route, or the app's state for it. |
| `invalid_request` | A bad argument, an unknown command, or a missing target. | Fix the call. |
| `invalid_control` | A supervision request that does not fit the current mode. Returned to the dashboard, not to agents. | |

### Session and project errors (not recoverable)

| code | meaning | what the agent should do |
| --- | --- | --- |
| `invalid_profile` | `agentlab.json` is missing or invalid; the message lists every problem, including unknown keys. | Fix the file (or ask the user), then `start` again. |
| `profile_too_new` | The profile's `schemaVersion` is newer than this agentlab reads. | Ask the user to upgrade agentlab. |
| `url_not_allowed` | A service or app URL is not a local or private host. | Ask the user; `allowExternalUrl` is their decision. |
| `missing_env` | A service's `requiredEnv` names are not set in the MCP server's environment. The names are listed, never values. | Ask the user to set them where the MCP client launches the server. |
| `port_conflict` | Something else answers where a service should run. | Ask the user to stop it. The lab never stops a process it did not start. |
| `startup_failed`, `readiness_timeout` | A service failed or was not ready in time. `details.logTail` has its last output. | Read the log tail and fix the command or readiness check. |
| `no_display` | A headed session was asked for without a display. | Run the server without `--headed`, or start with `headed: false`. |
| `no_session` | No session is running. | `start` one. |
| `session_exists` | A session already runs here. | Use it. |
| `unknown_device` | The device id is not built in or declared. | Use a listed device. |
| `auth_missing`, `auth_invalid`, `auth_not_ignored` | Saved sign-in state is missing, unusable (it is removed), or git would track it. | Start with `auth: "fresh"`, sign in, then `auth_save`; or ask the user to add `.agentlab/` to `.gitignore`. |
| `bundle_unsafe` | The `bundle` tool found a secret value still in the bundle after redaction, and wrote nothing. | This is a bug in agentlab: report it, without attaching the run. |

`bundle_invalid` and `bundle_too_new` come from `agentlab replay` and `agentlab bundles` on the command line, not from MCP tools. `trace_unsanitizable` is not returned as a tool error: a trace that could not be proved clean is left out of the bundle, and the `bundle` result says so in its `trace` field.

## The dashboard URL

`start` results (and, in a terminal, `agentlab status`) carry `dashboard.url`. That URL is **view-only**: it shows the live viewport, the timeline and findings, and the server refuses supervision requests from it. Share it with the user so they can watch.

The person's control URL, which can pause, take over and stop, is never in a tool result. The MCP server prints it to its stderr (the client's log) and keeps it in an owner-only record. The person runs `agentlab ui` in the directory the MCP server was started from to get it. When a new session starts, both tokens change and the control URL is printed again; a dashboard page left open from the previous session loses access.

## Versioning of tool schemas

The tool names and their input schemas are one contract, `mcpTools` (currently 1, shown by `agentlab version`). A client sees the tools of the installed version on its next `tools/list`; nothing in its configuration changes when agentlab is upgraded. Adding a tool or an optional argument does not change the number. Removing or renaming a tool or argument, or making an argument required, would. Results carry `schemaVersion` (the `results` contract). The policy is in [compatibility.md](compatibility.md).
