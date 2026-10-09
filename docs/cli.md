# Command-line reference

Every command and flag of `agentlab`, as of Web V1 (0.3.x). `agentlab help` prints the same list in short form. Install first ([install.md](install.md)); describe your project in [configuration.md](configuration.md).

## Conventions

- **Sessions.** `start` launches a small background daemon for the current directory. It keeps the browser open between commands, which are then sent to it. The session commands (`observe`, `click`, ...) need a running daemon and fail with `no_session` without one.
- **State.** Runs, logs and the daemon record live in `./.agentlab/` in a directory with an `agentlab.json` (or an existing `.agentlab/`), otherwise under `$XDG_STATE_HOME/agentlab/projects/<dir>-<hash>/`. `agentlab state-dir` prints it. `AGENTLAB_HOME` overrides both.
- **Targets.** A targeted action takes a **ref** from the latest observation (`e12`), or `--name <exact name>` with an optional `--role <role>`. A name that matches more than one control is `ambiguous_target`; the lab never guesses.
- **Headless unless you ask.** Every command runs the browser without a window; you watch it in the [dashboard](dashboard.md), which shows the agent's page and each width of a sweep or scan. Pass `--headed` to open a visible browser window as well (it needs `DISPLAY` or `WAYLAND_DISPLAY`, or `xvfb-run`). `--headless` is still accepted and changes nothing.
- **Dashboard.** Every session serves a dashboard on `127.0.0.1` unless you pass `--no-ui`. See [dashboard.md](dashboard.md).

### `--json`

Every command accepts `--json` and then prints the full structured result instead of text.

- Results carry `"schemaVersion": 1` (the `results` contract, shown by `agentlab version`). A failure is `{"error": {"code", "message", "hint?", "recoverable", "details?"}}` and is printed to **stdout** in `--json` mode.
- In CI commands, `--json` prints the `agentlab.ci-result` document on stdout and sends progress to stderr.
- `scan` prints the compact scan summary, not the full result (the full result is `result.json` in the run directory).
- Fields may be added in a later version without changing `schemaVersion`; a change that removes or reshapes a field bumps it. See [compatibility.md](compatibility.md).

### Exit codes

| command | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| session commands (`start`, `observe`, actions, `inspect`, `sweep`, `scan` in the session, `bundle`, ...) | ok | the command failed, an action had outcome `error`, or the scan policy failed | | |
| `doctor` | no check failed (warnings allowed) | a check failed | | |
| `scan --project` | policy passed | policy failed | could not run | |
| `test`, `sweep --project`, `scenario --project` | pass | policy failed | could not run | timed out |
| `replay` | reproduced | not reproduced | could not run | diverged or blocked |
| `bundles`, `report` | ok | | an error | |
| `run` | the flow passed | the flow failed | | |

Commands that run a session in this process (`run`, `scan --project`, the CI commands) exit 130, 143 or 129 when cancelled by SIGINT, SIGTERM or SIGHUP, after stopping what they started. Details for CI: [ci.md](ci.md).

## Setup

### `init`

```bash
agentlab init [dir] [--yes | --print] [--force]
```

Inspects the project and proposes an `agentlab.json`. It only reads files: it never runs project commands, and from `.env.example`, `.env.sample` and `.env.template` it takes variable **names** only, never `.env` itself. Nothing is written until you confirm.

| flag | meaning |
| --- | --- |
| `--print` | Show the proposal and stop. |
| `--yes`, `-y` | Write without asking: `agentlab.json`, and `.agentlab/` added to `.gitignore`. |
| `--force` | Replace an existing `agentlab.json`. Without it an existing one is left alone. |

Without `--yes`, `init` asks on a terminal and writes nothing when it is not interactive. It recognises: package scripts and the package manager (bun, pnpm, yarn or npm, from the lockfile); monorepo packages (`workspaces`, `apps/*`, `packages/*`, `services/*`, and directories named web, frontend, api, server, backend, worker and similar) and root scripts such as `api`, `web`, `worker`; common frameworks and their default ports (Vite, Next.js, Nuxt, Astro, SvelteKit, Angular, Create React App, Gatsby, Vue CLI, Parcel), explicit `--port` and `PORT=`, and `process.env.PORT ?? N` or a `/health` route in a Node entry file; a Playwright config's `baseURL` and `webServer`; Docker Compose files, as a one-shot `docker compose up -d` service with a TCP check on the first published port; and, when nothing in the Node ecosystem is found, a Django project (`manage.py` at the root) as `<virtualenv>/bin/python manage.py runserver 127.0.0.1:8000 --noreload` with a TCP check (python3 when no virtualenv with `pyvenv.cfg` sits in the project). The proposal is a starting point: read it, and edit commands, URLs and readiness checks before saving.

### `doctor`

```bash
agentlab doctor [--project <dir>] [--no-launch] [--json]
```

Read-only checks: the Node.js version; Chromium installed and, unless `--no-launch`, actually launching headless; the display; whether the state and temp directories are writable (nothing is created); a stale or live session record; the profile; for each service its working directory, command on `PATH`, required environment **names**, secret-looking literal `env` values and its port (free, ready to reuse, or a conflict); the saved sign-in file (mode, expiry, git-ignored); whether `.agentlab/` is git-ignored; `uploads.allow` entries. It also says so on musl (Alpine). Exit 1 when any check fails.

### `migrate`

```bash
agentlab migrate [--project <dir|file>] [--yes | --print] [--force]
```

Rewrites a schemaVersion 1 `agentlab.json` as schemaVersion 2 and keeps the original as `agentlab.json.v1.bak`. `--print` shows the result and writes nothing. `--force` overwrites an existing backup. See [configuration.md](configuration.md#version-1-and-migration).

### `clean`

```bash
agentlab clean [--json]
```

Stops services that crashed sessions left running (using the ownership records, and only when the recorded owner is gone and the service's identity still matches), and prunes old runs: the newest 20 are kept, `AGENTLAB_KEEP_RUNS` changes that and 0 keeps all. It never touches a live session's services. A one-shot service's stop command is printed for you to run, not run.

### `install-browser`

```bash
agentlab install-browser [--with-deps]
```

Installs the Chromium build the bundled Playwright needs, using Playwright's own CLI from inside the package. `--with-deps` also installs the system libraries (needs root, Debian or Ubuntu only).

### `version`

```bash
agentlab version [--json]        # also: agentlab --version, agentlab -v
```

Prints the package, Node.js and Playwright versions, whether Chromium is installed, where the package lives and the contract versions. With `--json`, also the state directory.

## Session

### `start`

```bash
agentlab start [--project <dir>] [--device mobile-390] [--headed] [--slow-mo <ms>]
               [--auth auto|saved|fresh] [--trace] [--no-ui]
```

Starts the daemon, then the project's services (or reuses them), opens Chromium with the device profile, and returns the first observation and the dashboard URL.

| flag | meaning |
| --- | --- |
| `--project <dir>` | The directory holding `agentlab.json` (default: the current directory). |
| `--device <id>` | Overrides the profile's `device`. `agentlab devices` lists the built-ins. |
| `--headed` | Also open a visible browser window (default: none; watch in the dashboard). |
| `--slow-mo <ms>` | Delay each browser operation, for watching. |
| `--auth` | `auto` (default): use saved sign-in state if it exists. `saved`: require it. `fresh`: start signed out. |
| `--trace` | Record a Playwright trace so a failure bundle can carry a sanitized copy. |
| `--no-ui` | No dashboard. |

A start that fails stops everything it started and exits 1; the daemon exits with it.

### Observing

| command | meaning |
| --- | --- |
| `observe [--limit <n>]` | The compact state: route, headings, open dialog, visible controls with refs (up to 40 by default), messages, layout flags, finding count, console and network counts. |
| `inspect [F2 \| e10]` | Session findings with evidence and reproduction steps; one finding by id, or a control and its findings by ref. |
| `status` | Whether a session is active, its device, server ownership, current route and the dashboard URL. |
| `tabs` | List open tabs. |
| `log [-f]` | The daemon's ordered action log (`-f` follows it). |

### Actions

Every action returns what changed, how the page settled, notes, new findings and the new observation. They need agent control: a person's pause or takeover refuses them (see [Supervision](#supervision-from-the-dashboard)).

| command | meaning |
| --- | --- |
| `click <ref>` | A verified tap (touch profiles) or click. Also `--name <name> [--role <role>]` for any targeted action. |
| `fill <ref> <text>` | Replace the text of a text field. |
| `press <key> [ref]` | A key or chord (`Enter`, `Escape`, `Tab`, `Shift+Tab`, `Control+a`), on a control or on whatever has focus. |
| `select <ref> <option>...` | Choose options of a native `<select>` by label or value. |
| `check <ref>`, `uncheck <ref>` | A checkbox, radio or switch, with the state change confirmed. |
| `scroll [up\|down\|left\|right] [ref] [--amount <px>]` | Scroll the page, or the region holding the control. With no direction, bring the control into view. |
| `swipe <left\|right\|up\|down> [ref] [--amount <px>]` | A touch swipe (the finger's direction). Touch profiles only. |
| `back`, `forward` | The active tab's history. |
| `hover <ref>` | Move the pointer over a control. |
| `upload <ref> <file>...` | Give project-relative files to a file input. Only files inside `uploads.allow` are accepted. |
| `drag <ref> (--to <ref> \| --dx <px> --dy <px>)` | Drag a control onto another, or by an offset. |
| `tab open </path>`, `tab switch <t2>`, `tab close [t2]` | Open a tab on the app's origin, make another tab active, or close one. |
| `act click\|fill ...` | The same as `click` and `fill`. |
| `auth save` | Save this session's sign-in state ([security.md](security.md#secrets)). Needs a running session. |
| `auth status`, `auth clear` `[--project <dir>]` | Show the saved state's path, mode, cookie and origin counts, expiry and git-ignore status, or remove it. They read the profile in `--project` (default: the current directory) and need no session. The contents are never printed. |

The exit code is 1 when an action fails: `stale_ref`, `not_found`, `ambiguous_target`, `obstructed`, and so on. The error codes are in [mcp.md](mcp.md#errors).

### Ending a session

```bash
agentlab stop        # also: agentlab close
```

Closes the browser and stops only the services the session started. If the daemon is gone it recovers: it stops recorded process groups whose identity still matches, prints what it could not verify, and reaps orphans from other crashed sessions. `stop` also works while a person has paused or taken over the session: from the terminal it is the owner's safety operation, recorded on the dashboard timeline as a stop by `terminal`. A command in flight finishes first; for an immediate stop use **Emergency stop** on the dashboard. (An agent's MCP `stop` is still refused while a person has control.)

## Responsive sweeps and scans

| command | meaning |
| --- | --- |
| `sweep [/route] [--devices a,b]` | Load a route at 320, 390, 768 and 1440 px, one isolated context each, in the running session. |
| `scan [/route] [--scenario <a,b>] [--devices <ids>] [--explore \| --no-explore]` | Scan the declared scenarios (or one route as loaded) in the running session. Exits 1 when the policy fails. |
| `scenario [name ...] [--devices <ids>]` | Without `--project`: the same as `scan` for the named scenarios, in the running session. |
| `scan --project <dir> [/route] [--scenario <a,b>] [--devices <ids>] [--explore] [--headed] [--auth auto\|saved\|fresh] [--ui [--no-open]]` | Standalone: start the project headless, scan it, stop only what it started. Exit 0 pass, 1 policy fail, 2 could not run. `--ui` serves the dashboard while it runs. |

A sweep loads one route at 320, 390, 768 and 1440 CSS px, one width at a time. Each width gets its own browser context carrying the session's cookies and storage, so signed-in routes work without replaying the login; the session's own page, refs and history are untouched. At each width it measures the route as loaded through the same engine as `scan`. The fixture's seeded defect, swept (`agentlab sweep /reports`):

```
sweep S1 of /reports: 4 widths in 2280ms (serial, isolated contexts)
  mobile-320 (320px): document 598px, 5 controls, 5 reach-checked → 2 confirmed, 3 heuristic
    F5 [high, confirmed] horizontal-pan-required button "Export CSV"
    …
  tablet-768 (768px): document 768px, 5 controls, 5 reach-checked → clean
  desktop-1440 (1440px): document 1440px, 5 controls, 5 reach-checked → clean
report: .agentlab/runs/<session>/sweeps/S1/report.md
```

Each sweep writes `report.md`, `result.json` and one viewport JPEG per width to `runs/<session>/sweeps/S<n>/`. `agentlab inspect F5` gives the measurements and reproduction steps for one finding.

Detectors, scenarios and reports: [web-v1-m2.md](web-v1-m2.md).

## Scripted flows

```bash
agentlab run <flow.json> [--headed] [--device <id>] [--slow-mo <ms>] [--ui [--no-open]]
agentlab devices
```

A flow is a JSON file: `name`, `project` (relative to the flow file), optional `device`, `auth` (`auto`, `saved` or `fresh`; default `fresh`, so flows are reproducible) and `steps`. Each step is an optional action (the same step format as scan scenarios, see [configuration.md](configuration.md#scan)) and an optional `expect`. A flow resolves targets by role and name against the current observation and fails a step on `ambiguous_target`. See `flows/clean.flow.json`. `run` writes `flow-result.json`, `actions.jsonl` and `web.log` under `.agentlab/runs/<session>/`. With `--ui` it serves the dashboard and waits up to 30 seconds for a viewer to connect.

## Live dashboard

```bash
agentlab ui [--no-open] [--json]
```

Prints the dashboard URL **with controls** for the running session and opens it in the desktop browser when a display is available. `--no-open` only prints it; `--json` prints `{url, opened}`. It works for a CLI daemon and for an MCP server started from the same directory. The URL that `start` prints and that MCP gives to agents is view-only. See [dashboard.md](dashboard.md).

## Supervision from the dashboard

There are no CLI commands for pausing, taking over or stopping a run: supervision is done by a person in the dashboard ([dashboard.md](dashboard.md#supervision-workflow)). The requests are `pause`, `pause-next`, `resume`, `takeover`, `return`, `stop` and `emergency-stop`; their semantics are in [architecture.md](architecture.md#supervision).

## MCP server

```bash
agentlab mcp [--headed] [--no-ui]
```

A stdio MCP server over the same command table. stdout belongs to the protocol. See [mcp.md](mcp.md).

## Failure bundles and replay

```bash
agentlab bundle [--note <why>]                       # write a secret-free bundle for the running session
agentlab bundles [list] | show <id> | rm <id> | prune [--older-than <days>] [--dir <bundles dir>]
agentlab replay <bundle dir|bundle.json> [--project <dir>] [--headed] [--allow-consequential]
                [--secret <step>=<ENV_NAME>]... [--until <step>]
```

Bundles are kept under `<state dir>/bundles`; the newest 20 and at most 14 days (`AGENTLAB_KEEP_BUNDLES`, `AGENTLAB_BUNDLE_DAYS`). `replay` re-runs the recorded agent actions against the live `agentlab.json`. Exit 0 reproduced, 1 not reproduced, 2 could not run, 3 diverged or blocked. `--secret 2=MY_PASSWORD` supplies the value of step 2 (masked in the bundle) from an environment variable. How it works: [architecture.md](architecture.md#failure-bundles-and-replay).

## CI

```bash
agentlab test [--project <dir>]
agentlab sweep --project <dir> [/route ...]
agentlab scenario --project <dir> [name ...]
agentlab report <out-dir|ci-result.json> [--format text|json|html|junit] [--out <file>]
```

Non-interactive, provider-neutral. Each starts the project, runs, and stops only what it started.

| flag | default | meaning |
| --- | --- | --- |
| `--devices a,b` | the scenario's own; `scan.devices` for sweeps | Device ids. |
| `--flows a.json,b.json` | `ci.flows` | Flow files (`test` only). |
| `--routes /a,/b` | `ci.routes` | Routes to sweep. |
| `--scenarios A,B` | `ci.scenarios`, else all declared | Scenario names. |
| `--fail-on high\|medium\|low\|none` | `ci.failOn`, else `scan.policy.failOn` | Lowest severity of a confirmed finding that fails the run. |
| `--fail-on-heuristic` | `ci.failOnHeuristic` | Heuristic findings count too. |
| `--scenario-errors fail\|report` | `fail` | A run that could not complete fails the run, or is only listed. |
| `--out <dir>` | `ci.out`, else `./agentlab-results` | Artifacts directory. |
| `--format text,json,html,junit` | all | Files to write. `ci-result.json` is always written. |
| `--trace off\|on-failure\|always` | `off` | Record a sanitized trace. (`--trace` alone is `start`'s switch.) |
| `--evidence off\|on-failure\|always` | `on-failure` | Copy evidence frames into the artifacts. |
| `--timeout 90s\|15m\|2h` | `ci.timeoutMs`, else 30m | Whole-run limit. |
| `--auth fresh\|saved\|env` | `env` when `AGENTLAB_AUTH_STATE` is set, else `fresh` | Where the sign-in state comes from. |
| `--validate-only` | | Check everything and start nothing: exit 0 valid, 2 not. |
| `--headed` | headless | For debugging on a machine with a display. |
| `--json` | | Print the result JSON on stdout; progress goes to stderr. |

`report` re-renders a saved result in any format without a browser. Exit codes 0, 1, 2, 3, and artifacts: [ci.md](ci.md).

## Environment variables

| variable | effect |
| --- | --- |
| `AGENTLAB_HOME` | The state directory, instead of `./.agentlab` or the per-user location. |
| `XDG_STATE_HOME` | Where the per-user state (for directories with no `agentlab.json`) lives: `$XDG_STATE_HOME/agentlab`, default `~/.local/state/agentlab`. |
| `AGENTLAB_AUTH_STATE` | A Playwright storage state, as JSON or base64 JSON, for CI sign-in. Kept in memory, never written. |
| `AGENTLAB_KEEP_RUNS` | Runs kept by `clean` and pruning (default 20; 0 keeps all). |
| `AGENTLAB_KEEP_BUNDLES`, `AGENTLAB_BUNDLE_DAYS` | Bundle retention (defaults 20 and 14). |
| `AGENTLAB_SERVICE_LOG_MAX_BYTES` | The cap on each service log (default 20 MB). |
| `AGENTLAB_DAEMON_ECHO_MAX_BYTES` | The cap on server output echoed into `daemon.log` (default 5 MB). |
| `PLAYWRIGHT_BROWSERS_PATH` | Where Playwright keeps browsers. Set it the same way for `install-browser` and every later command. |
| `CI` | When set, a failure bundle records `ci: true` in its environment. |
| the names in your services' `requiredEnv` | Must be set where agentlab runs. Only names are checked or reported. |

## Maintenance

`clean`, `migrate`, `version`, `doctor` and `install-browser` are described above. To remove everything the lab kept: [install.md](install.md#uninstall).
