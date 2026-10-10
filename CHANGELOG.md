# Changelog

All notable changes to Agent Device Lab are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The package on npm is `agent-device-lab`.

Contract versions (profile, results, MCP tools, report, bundle, events) are listed by `agentlab version`; a change to one is called out here. See [docs/compatibility.md](docs/compatibility.md).

## [0.4.0] - 2026-10-10

The live viewport can be expanded or shown full screen, and its frames are sharper. Contract versions are unchanged.

### Added

- Dashboard: **Expand view** and **Full screen** for the live viewport. Both reuse the one stream, keep the device's aspect ratio and keep the supervision controls available; Escape exits full screen first, then closes the expanded view.

### Changed

- Dashboard: live viewport frames are now at most 1920 px wide at JPEG quality 85 (was 800 px, quality 60), so a desktop viewport is no longer downsampled. The 5 fps cap is unchanged. Watching uses more bandwidth and CPU; see [docs/benchmark-2026-10-10-viewport-efficiency.md](docs/benchmark-2026-10-10-viewport-efficiency.md).
- Text output: an error states whether it is recoverable and the supervision state; a failed action lists its new console errors and failed requests; controls show selected state, title changes are reported, and omitted controls are counted. JSON results are unchanged.

## [0.3.1] - 2026-10-09

A dependency update, documentation and package metadata; the lab's own code is the same as 0.3.0.

### Security

- `@modelcontextprotocol/sdk` is updated from 1.30.1 to 1.32.1 for advisory GHSA-6qxp-vccf-f47h (the SDK's OAuth client could send credentials to an authorization server chosen by an MCP server; fixed in 1.31.0). The lab uses only the SDK's stdio server and never its OAuth client, so it was not exposed, but an install no longer carries the affected version.

### Changed

- The description says what the lab already does: it works at phone, tablet and desktop size (`mobile-320`, `mobile-390`, `tablet-768`, `desktop-1440`), not only on a phone-sized screen.

### Added

- A "Support development" section in the README and a `funding` entry in `package.json`, pointing to Patreon. Support is optional.

## [0.3.0] - 2026-10-09: Web V1

Web V1 is three milestones on top of the first slices: an installable package for ordinary Linux web projects (milestone 1), stateful responsive scans (milestone 2), and supervision, CI mode, failure bundles, versioned contracts and hardening (milestone 3). Scans are described in [docs/web-v1-m2.md](docs/web-v1-m2.md) and the structure in [docs/architecture.md](docs/architecture.md). Release notes: [docs/release-notes-web-v1.md](docs/release-notes-web-v1.md).

### Changed

- `back` and `forward` add a note that the browser restores the earlier scroll position and that page state kept only in memory may have been reset. An action that removed controls prints which refs no longer exist. A lone control inside a card or list item ("View profile" when one result is left) is listed with the card's heading, as repeated ones already were.
- The dashboard timeline folds the list of controls and headings an action added or removed under one line ("Page content changed: 12 appeared, 9 went"); where it went, what opened and what was typed stay in view. The status strip wraps long values instead of cutting them off.
- Agent-facing wording: a change to a password field reads `value set (hidden: password field)` instead of a four-dot mask that looked like a length; a scan's verdict says `N confirmed findings below high severity do not fail the scan (failOn is high)`; and the scan output explains that each problem `G` groups the findings `F` that are the same problem at different widths or scenarios.
- The browser now runs without a window by default (`start`, `run`, `mcp`), so nothing covers the dashboard; `--headed` opens a window as before, and `--headless` is still accepted. An MCP client can no longer open a window unless the server was started with `--headed`.
- The dashboard puts the live viewport in the centre, sized to the device on screen, with the timeline on the left and findings on the right. During a sweep or scan the viewport follows the page being measured at each width (each held at least 1.2 s while someone watches) and a line above it says what is showing. Frames are now up to 800 px wide (was 390).
- `agentlab stop` from a terminal is no longer refused while a person has paused or taken over the session: it is the owner's safety operation, applied like the dashboard's **Stop run** and recorded as `stopped from the terminal` (not as a person's stop: anything with a shell as your user can run it). The agent's MCP `stop` tool is still refused while a person has control, and emergency stop remains available on the dashboard in every mode.
- The GitHub Actions example installs one exact agentlab version (including for prereleases), never `latest` or a dist-tag; a pipeline that cannot reach the registry can install a committed tarball checked against a pinned SHA-256. See [docs/ci.md](docs/ci.md#installing-agentlab-in-a-pipeline).
- [docs/security.md](docs/security.md#reporting-a-security-issue) names the security contact: kwaleyelamusil@gmail.com.

### Fixed

- A token in a page's URL (for example `#access_token=…` or `?api_key=…`) was printed in the observation's route and URL and so reached results, logs, reports and bundles. The value of a secret-looking query or fragment parameter is now replaced with `‹redacted›` everywhere the lab outputs a route; the browser still uses the real URL. Found by pointing the lab at its own dashboard.
- Found by pointing the lab at its own dashboard: the finding chips in the timeline were 18.7 px tall and closer together than WCAG 2.2 SC 2.5.8 allows (now 24 px and spaced), and a finding's accessible name ran its words together ("horizontal-overflowHEURISTIC").
- `outside-container` no longer reports a control that has scrolled out of a scrolling list inside a panel: the list hides it, so nothing a person sees sticks out.
- The dashboard's scan table counted 0 findings for a scenario whose findings came from comparing widths (a label that wraps at a narrower width), while the findings list showed them. The table now counts what the list holds.
- Ctrl-C (SIGINT) during a run with the browser open now cleans up like SIGTERM: exit 130, a partial result, every started service stopped and the ownership record removed. Playwright's own signal handlers exited the process as soon as the browser closed, which with several services left some running. `agentlab replay` now handles termination signals too.
- A flow step's label no longer prints a `fill` value. It was masked only when the field's name contained an English secret word, so a password field named in another language (for example "Senha") printed its value in `agentlab run` and `agentlab test` output and in `flow-result.json`. `flow-result.json` is now also redacted with the session's secret values, which covers a page that echoes typed text to its console.
- `stop` right after a person handed control back was refused with `observation_required`, from the terminal and over MCP. Stop acts on no ref, so it no longer needs a fresh observe.
- A click on a link or form with a `target`, or one that calls `window.open`, could report no new tab when the browser delivered the tab after the opener page went quiet (seen under machine load). Settling now waits, up to 2 s, for a tab the page asked to open.

### Added

- Licensed under the Apache License 2.0 (`LICENSE`, `NOTICE`); copyright Colony Innovations.
- A step-by-step [getting-started guide](docs/getting-started.md) with real output from the demo app, a [documentation index](docs/README.md), `CONTRIBUTING.md` and `SECURITY.md`. The README is rewritten in plain terms.
- `agentlab init` detects a Django project (`manage.py`) and proposes `runserver` with the project's virtualenv python and a TCP readiness check.

**Milestone 1: installable, multi-service, full interaction set**

- An npm-packable package with a Node.js 22 gate in `bin/agentlab.js`, `agentlab version`, `agentlab install-browser [--with-deps]` (runs the bundled Playwright CLI so Chromium always matches), and a state directory that stays out of directories that were never initialised.
- `agentlab init`: proposes a schemaVersion 2 profile from files only (it never runs project commands or reads `.env` values) and writes it only after confirmation.
- `agentlab doctor`: read-only checks of Node.js, Chromium (including a launch), display, directories, the profile, each service, saved sign-in state and `.gitignore`.
- Profile schemaVersion 2: named `services` with `command`, `cwd`, `url`, `env`, `requiredEnv`, `readiness` (http, tcp, log, alive, one-shot exit), `dependsOn`, `reuseExisting`, `required`, `mode` and `shutdown`; `app`, custom `devices`, `auth` and `uploads`. `ServiceGroup` starts services concurrently in dependency order, abandons and cleans up on a required failure, and stops dependents first.
- The full set of actions through the shared command table: `press`, `select`, `check`, `uncheck`, `scroll`, `swipe`, `back`, `forward`, `hover`, `upload` (restricted to `uploads.allow`), `drag`, and tabs and pop-ups (`tabs`, `open_tab`, `switch_tab`, `close_tab`).
- Saved sign-in state: `agentlab auth save | status | clear` and the `auth_save` tool. Owner-only, git-ignored, never output.
- Per-service process identity and crash recovery by `agentlab stop`.

**Milestone 2: stateful responsive scans**

- `agentlab scan` (in the running session, or standalone with `--project`) and the `scan` tool: declared scenarios (`scan.scenarios`: route, setup steps, devices, checks, cleanup), each scenario × device in an isolated browser context.
- Bounded, safe exploration of controls the page marks as openable, with every non-GET request blocked and a recorded reason for every skipped control.
- One detector engine shared by `sweep` and `scan`: container and text clipping, truncation, fixed-layer collisions, content under fixed bars, modal overflow, unreachable content, controls outside their container, unintended horizontal scrolling, WCAG 2.2 tap targets, layout shift, and label wrapping across nearby widths.
- Findings with confidence (`confirmed` only when a measurement shows a person is affected), fingerprints, grouping by problem, suppressions that are never hidden, a pass/fail policy, HTML and JSON reports, and dashboard views for scans.
- The `scan` profile section: `devices`, `checks`, `tapTargets`, `noWrap`, `wrapNearbyRatio`, `layoutShiftMin`, `explore`, `scenarios`, `suppressions`, `policy`.

**Milestone 3: supervision, CI, bundles, versioning, hardening**

- Supervision from the dashboard: pause (after this action, or before the next), take over, return control, stop, emergency stop. Agents are refused with `session_paused`, `human_control`, `observation_required` or `session_stopped` and are told what to do; nothing is queued. A scan or sweep that is interrupted reports `incomplete` and lists what it skipped.
- Privacy-safe recording of a person's actions: role and short name only, never typed text.
- Dashboard control: in-browser tap, scroll, text and key input, or the headed window directly. A view-only dashboard link for agents and a control link (from `agentlab ui`) for the person.
- CI mode: `agentlab test`, `sweep --project`, `scenario --project` and `report`; the profile's `ci` section; exit codes 0, 1, 2, 3 (130, 143, 129 for signals); `ci-result.json`, `summary.txt`, `report.html`, `junit.xml`, evidence frames, bundles and traces; `--validate-only`; `AGENTLAB_AUTH_STATE`. An example for GitHub Actions in `examples/ci/`.
- Failure bundles: `agentlab bundle`, the `bundle` tool, and `agentlab bundles list | show | rm | prune`. A bundle is secret-free by construction, and by a final check that refuses to write one that holds a known secret.
- `agentlab replay <bundle>`: re-runs the recorded agent actions against the live profile and reports `reproduced`, `not-reproduced`, `diverged` or `blocked`.
- `start --trace` and a fail-closed Playwright trace sanitizer, so a trace can travel in a bundle or a CI artifact.
- `agentlab migrate` (schemaVersion 1 to 2, with a backup), `agentlab clean`, and `agentlab version` listing the contract versions.
- Ownership records (`owned/<session>.json`) and orphan reaping.
- A new settle cause, `empty`, and a settle rule for client-side route changes (`route`).
- Documentation: architecture, configuration, CLI, MCP, dashboard, security, troubleshooting, compatibility and limitations.

### Changed

- **Profiles are parsed strictly.** A key the installed version does not know is an error (with a did-you-mean hint) instead of being ignored. `description`, `comment` and `//` keys are allowed for notes.
- **A newer profile is refused** (`profile_too_new`) before anything else is read.
- **The dashboard URL in `start` and `status` results is view-only.** The control link comes from `agentlab ui` (or the MCP server's stderr) and is never in a command or MCP result.
- The dashboard is no longer monitoring-only: it accepts supervision requests and, while a person has control, input, over `POST /api/control` and `POST /api/input` with the control token.
- The MCP server now exposes 25 tools (`scan` and `bundle` were added after the first 23).
- A sweep measures each width through the same engine as `scan`, so it reports the newer detectors too.
- State, run and ownership directories are created 0700 and their files 0600; the daemon socket is 0600.
- Bounded growth: service logs capped at 20 MB, the daemon's echo at 5 MB, history, console, network and finding lists capped, runs and bundles pruned.
- `agentlab stop` after a crash now sends SIGTERM and then SIGKILL after the service's grace period, and also reaps orphans recorded by other sessions.
- The flow runner prints `‹secret›` instead of the value of a step aimed at a password-like field.

### Fixed

- A service's grace period was never honoured: the shell's exit was taken for the service's, and the real server was SIGKILLed at once.
- `back` could return to the initial `about:blank`.
- A tap just after a vertical swipe was swallowed by Chromium's gesture state.
- A pop-up that closes itself during the tap was reported as a failure.
- A POST whose response body the page never read, followed by a GET of the same URL, held every action for the full `settle.maxMs`.
- Settling no longer observes the old page under a new address after a client-side route change (React Router 7 renders inside a transition scheduled through `MessageChannel`).
- Settling no longer returns on an empty document that has scripts and has drawn nothing yet (Vite dev server with lazy routes): `empty`, bounded by `maxMs`.
- `text-clipped` ignores text that is hidden on purpose (image replacement with `text-indent: -3000px`), and `container-clipped` and `text-clipped` ignore the options of a native listbox. (Detector versions 2.)
- A false `control-obstructed` for an inline link wrapped over two lines, and several scan false positives found while validating the seeded fixture (modal overflow, layout shift and fixed-collision grouping; off-canvas drawer links; footer links outside a border-only container).
- Release-candidate validation fixes: a service whose shell wrapper (the process-group leader) died while the real server survived was reported "stopped (already exited)" and left running with no record; the lab now records the identity of every group member while the leader is alive and stops the survivors by identity, reporting (never signalling) any unrecorded process left in the group. Items of an infinite CSS marquee or a transform-animated strip are no longer reported as clipped (`container-clipped` v3, `text-clipped` v3, `unreachable-content` v2). `content-scroll-x` (v2) skips native `<select>` listboxes. A person's typing is now described when they leave the field, press Enter or Tab, or hand control back, instead of being lost to a 700 ms debounce. A sweep of a route answering HTTP 400 or above is an `http_status` error with the status, and a width that settled by timeout records its cause. A killed browser ends the session as `browser disconnected or crashed`.
- The MCP server republishes the person's control link when a new session starts (the tokens rotate), so it does not stop working after the agent's second `start`.
- `migrate` no longer shows secret-looking `env` values, and neither `migrate` nor CI validation echoes a JSON parser's message (which can quote the file).

### Security

- The dashboard has a view token and a control token; only the control token may POST, and only with an `Authorization` header from the dashboard's own origin. See [docs/security.md](docs/security.md).
- Nothing is signalled unless a process's identity (PID, start time, boot id) still matches the record; orphan reaping never touches a live owner, a reused PID or a one-shot service's containers.
- One redaction set (values typed into password-like fields, `requiredEnv` values, secret-named variables, long service `env` values, sign-in state values) applies to bundles and every CI output, followed by a leak check that refuses to write.
- The trace sanitizer removes sign-in state, bodies, sensitive headers, input and typed values, and masks code evaluated in the page; an entry it does not know fails closed.
- `AGENTLAB_AUTH_STATE` is held in memory and never written to disk.
- Bundles are untrusted input to replay: shape-validated, and replay takes no command, environment or path from them.
- `npm audit`: 0 vulnerabilities (production and development), 2026-09-30.

## Earlier work

### Slice 4: independent application and responsive sweep (2026-09-29)

- Validated on an independent app (Talk to a Brother) the lab was not written for; the general runtime issues it exposed were fixed: settling for entrance animations, `aria-busy` loaders and timer-driven mock APIs, context for repeated link text, toggle (`aria-pressed`) state, fixed tab bars causing false "obstructed" findings, smooth scrolling slowing the sweep, and password fill values in the action log.
- Added `agentlab sweep`: one route at 320, 390, 768 and 1440 px, one isolated context per width.
- Added `confidence` to findings, and a control partly visible above a fixed bar is scrolled clear before it is hit-tested, so `click` no longer fails with `obstructed` where a person would simply scroll.

### Slice 3: live dashboard (2026-09-28)

- A local monitoring dashboard on `127.0.0.1` with a per-session token: live viewport (viewer-gated screencast), action timeline, session status and findings with evidence frames. `agentlab ui`, `--no-ui`, `agentlab run --ui`.

### Slice 2: hardening, MCP and benchmark (2026-09-28)

- Process identity checks for crash recovery, a configurable settle policy, session findings (including `horizontal-pan-required`), a stdio MCP server over the same command table, and a reproducible benchmark against Playwright MCP.

### Slice 1: first vertical slice (2026-09-28)

- An approved project profile, dev-server launch and reuse, one headed Chromium mobile profile, compact observation with session refs, `click` and `fill`, a change account after every action, a clean fixture flow and one seeded mobile defect.
