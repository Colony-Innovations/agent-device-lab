# Troubleshooting

Start with `agentlab doctor` (add `--project <dir>`, or `--json`). It checks Node.js, that Chromium launches, the display, writable state and temp directories, a stale session record, the profile, each service's command, working directory, required environment names and port, the saved sign-in file, and whether `.agentlab/` is git-ignored. It changes nothing.

Each entry below is **symptom**, then **cause**, then **fix**. Error codes are in `code: message` form as the CLI and MCP print them; the full list is in [mcp.md](mcp.md#errors).

- [Install and environment](#install-and-environment)
- [Starting a project](#starting-a-project)
- [Profile errors](#profile-errors)
- [Settle timeouts](#settle-timeouts)
- [Refs and supervision](#refs-and-supervision)
- [Sign-in state](#sign-in-state)
- [Orphaned services and cleanup](#orphaned-services-and-cleanup)
- [Dashboard](#dashboard)
- [CI](#ci)
- [Bundles, replay and traces](#bundles-replay-and-traces)
- [MCP clients](#mcp-clients)

## Install and environment

**`agentlab needs Node.js 22 or newer; this is 20.x.y.`**
Cause: `bin/agentlab.js` checks the Node.js major before loading anything; every command is refused, including `version` and `doctor`. Fix: install Node.js 22 or newer (for example `nvm install 22`) and reinstall the package with it. npm only warns about `engines`, so installing under Node 20 succeeds.

**No display: `no_display`, or a headed browser that will not open.**
Cause: neither `DISPLAY` nor `WAYLAND_DISPLAY` is set (a server, a container, an SSH session). This only happens when a window was asked for (`--headed`, or `headed: true` from an MCP client). Fix: drop `--headed`, or run under a virtual display: `xvfb-run agentlab start --headed`. The dashboard works without a display: forward its port with `ssh -L <port>:127.0.0.1:<port> <host>` and open the link locally.

**doctor: `Chromium for Playwright 1.63.0 is not installed`.**
Cause: the browser build that matches the bundled Playwright has not been downloaded. Fix: `agentlab install-browser`. After upgrading agentlab, run it again: a new Playwright can need a new Chromium build (it is a no-op when the build is already there). If you moved the cache with `PLAYWRIGHT_BROWSERS_PATH`, set it the same way for `install-browser` and for every later command.

**doctor: `Chromium is installed but did not launch` with a shared-library message.**
Cause: system libraries are missing, typical on a bare Debian or Ubuntu image. Fix: `agentlab install-browser --with-deps` (needs root, Debian or Ubuntu), or `sudo npx playwright@1.63.0 install-deps chromium`.

**doctor: `this Linux uses musl libc (Alpine)`, or `spawn ... ENOENT` when launching Chromium.**
Cause: Playwright's Chromium is built for glibc and cannot start on Alpine. The package installs and `agentlab version` runs, then every step that needs Chromium fails. Fix: use a Debian or Ubuntu based image or host (for example `node:22-bookworm-slim`). Alpine is not supported ([compatibility.md](compatibility.md)).

**`install-browser --with-deps` fails with `apt-get: not found`.** Cause: not a Debian-based system. Fix: install Chromium's system libraries with your distribution's package manager, then run `agentlab install-browser` without `--with-deps`.

**An `npx` run left nothing in my directory, and I cannot find the runs.**
Cause: that is by design. In a directory with no `agentlab.json` and no `.agentlab/`, state goes to `$XDG_STATE_HOME/agentlab/projects/<dir>-<hash>/` (default `~/.local/state/agentlab/...`). Fix: `agentlab state-dir` prints it for the current directory.

## Starting a project

**`port_conflict`.**
Cause: something answers where a service should run, but not with the expected status, or the service says `reuseExisting: false` and something is already ready there. The lab never starts a second copy or stops a process it did not start. Fix: find it with `ss -ltnp 'sport = :5173'`, stop it yourself, or (if it is the same app) leave `reuseExisting` at its default so the lab reuses it.

**`startup_failed` or `readiness_timeout`.**
Cause: the command exited early, or never became ready within `readiness.timeoutMs`. Fix: read the log tail in the error and `.agentlab/runs/<session>/<service>.log`. Check that the readiness path returns the expected status (`curl -i <url><path>`). Raise `readiness.timeoutMs` for a slow first build (a framework's first compile can take tens of seconds). The error lists every service as ready, reused, failed, skipped or aborted, and what was stopped.

**`missing_env: ... DEMO_API_TOKEN`.**
Cause: a service's `requiredEnv` names a variable that is not set where agentlab runs. Fix: export it in the shell. Under MCP, put it in the client's `env` for the server. Only names are ever printed, never values. `agentlab test --validate-only` reports it with exit 2.

**`session_exists`.** Cause: a daemon already runs for this directory. Fix: use it, or run `agentlab stop` first.

**`no_session` after a crash, or `stale record`.**
Cause: the daemon died and left a record. Fix: `agentlab stop` clears the record and stops the services it started whose identity still matches; it prints what it could not verify. See [Orphaned services](#orphaned-services-and-cleanup).

**A Docker Compose service fails.**
Cause: `docker info` fails for your user, or the one-shot's command failed. Fix: make `docker info` work, and read the one-shot's log tail in the error. After a crash, run the printed `docker compose stop ...` yourself: the lab never runs a one-shot's stop command from crash recovery, because it cannot prove the containers are the ones it started.

**The first observation after `start` has no controls on a lazy-loaded (Vite) app.**
Cause: an older build settled before the first render. A document that has scripts but has drawn nothing is now held until it renders, up to `settle.maxMs`. Fix: use a current build. If your page is meant to be blank, see the `empty` cause below.

**`upload_not_allowed`.** Cause: the file is outside the profile's `uploads.allow` (symlinks are followed before the check). Fix: put the file inside an allowed directory, or add the directory to `uploads.allow` (paths are relative to the project).

## Profile errors

**`invalid_profile: ... unknown key "readines" in "services.web" (did you mean "readiness"?)`.**
Cause: profiles are parsed strictly; a key the installed version does not know is an error, so a typo cannot silently turn a setting off. Fix: correct the key. If it is spelled right, it probably belongs to a newer agentlab: upgrade. `description`, `comment` and keys starting with `//` are always allowed. `start`, `doctor` and `test --validate-only` all report it (exit 2 for the last).

**`invalid_profile` with several problems.** The message lists every one, with the path of each (`services.api.readiness`, `scan.scenarios[0].steps[1]`). `agentlab init --print` shows a valid proposal to compare with. The full key reference is [configuration.md](configuration.md).

**`profile_too_new: agentlab.json has schemaVersion 3; this agentlab 0.x reads schemaVersion 1–2`.**
Cause: the profile was written for a newer agentlab. The file is not touched. Fix: upgrade agentlab ([install.md](install.md#upgrade)), or use a profile written for this version.

**doctor: `agentlab.json is schemaVersion 1`.** Not an error: a version 1 profile keeps working. Fix: `agentlab migrate --print` to see the rewrite, `agentlab migrate --yes` to apply it (the original is kept as `agentlab.json.v1.bak`).

**`url_not_allowed: ... is not a local or private development host`.** Cause: a service or app URL points at a public host. Fix: if that is intended, set `"allowExternalUrl": true`. It is your decision; the default exists so a profile cannot aim the browser at an arbitrary site by accident.

**`unknown scenario "X"`, or an unknown device, from `test --validate-only`.** Selections are validated before anything starts (exit 2); the message names the unknown scenario or device and lists the declared ones.

## Settle timeouts

After an action the lab waits for the page to stop changing, up to `settle.maxMs` (5000 ms). When that runs out, **the action still succeeds**; the result says `settle timed out after Nms (...)` with a cause. A timeout is reported, never thrown. It means the next observation may be taken while the page is still changing. Tune the policy in the profile's `settle` section ([configuration.md](configuration.md#settle)), not in code.

| cause | what it means | fix |
| --- | --- | --- |
| `dom` | The DOM kept changing: a clock, a ticker, an animation that rewrites the DOM, a carousel. | Usually nothing: the page never stops. Raise `quietMs` only if you need a calm page; lower `maxMs` to stop waiting sooner. |
| `network` | A request started by the action was still open. The message names it: `request still open: GET /api/stream`. | If it is long-lived by design (a poll, a stream), add a substring of its URL to `settle.backgroundRequests`. Otherwise it is a slow request: raise `maxMs`. The lab never guesses that a slow request is background. |
| `busy` | A visible `aria-busy="true"` region stayed in the page: the page says it is still loading. | If the page never clears it, that is an app bug; otherwise raise `maxMs`. |
| `timers` | Short one-shot `setTimeout` timers kept being scheduled (a promise-based sleep loop, a polling loop that is not `setInterval`). | Lower `settle.timerMaxMs`, or set it to `0` to stop waiting for timers. |
| `route` | The address changed to a new route but the page never rendered it: no elements were added or removed. | Usually an app bug, or a route that renders only text. Check the page in the dashboard; raise `maxMs` if the render is slow. |
| `empty` | The page has scripts but nothing was drawn: the app's root is still empty. A page that is meant to be blank will always time out here. | For a normal app, raise `maxMs` if it renders slowly. For a deliberately blank page with a script, lower `maxMs`; the wait is bounded by it. |

A scan or sweep reports timeouts per state or width. A click that is slow *without* a timeout is fine: `settled quiet in 720ms` is a normal result, not a problem.

## Refs and supervision

**`stale_ref: e4 is no longer attached to the page`** (hint: `The same control was re-rendered as e10.`)
Cause: the element was re-rendered, or the page navigated since the ref was issued. Fix: use the successor ref the hint names, or run `observe` and use a fresh ref.

**`stale_ref: ... belongs to tab t1, not the active tab t2`.** Cause: refs belong to their tab. Fix: `switch_tab t1`, or `observe` the active tab.

**`stale_ref: ... was issued before a person used the browser`.** Cause: a person took over or paused and used the page, then handed control back. Fix: `observe`, then use fresh refs.

**`observation_required: ... a person used the browser since the last observation`.** Fix: run `observe`, then act. See [mcp.md](mcp.md#supervision-errors).

**`session_paused`.** Cause: a person paused the session from the dashboard. Nothing ran and nothing is queued. `observe`, `inspect`, `tabs` and `bundle` still work. Fix: tell the user you are waiting; retry after they resume.

**`human_control`.** Cause: a person has taken control of the browser. Fix: wait for them to hand it back, then `observe`.

**`session_stopped`.** Cause: a person stopped the session (or an emergency stop). It is final for that process, and `start` is refused too. Fix: ask the user; they restart the MCP server or run `agentlab start` themselves.

**The agent's `stop` tool says `session_paused` or `human_control`.** Cause: over MCP, `stop` needs agent control, like any action. Fix: resume or return control from the dashboard, use **Stop run** there, or run `agentlab stop` in a terminal, which goes through a pause or a takeover. (If the daemon process is gone, `agentlab stop` recovers without it.)

**`ambiguous_target`.** Cause: more than one control matches the role and name. Fix: use a ref from the latest observation, or add `role`. The lab never guesses.

**`obstructed`.** Cause: a hit test at the control's centre lands on another element (a banner, a chat bubble), so the control was not activated. Fix: close or scroll the overlay and retry. A covered control is also what a person would hit: sweeps and scans record it as a finding.

## Sign-in state

**`auth_invalid`.**
Cause: the saved sign-in state could not be used. The message says why: it is readable by other users (the file is kept; `chmod 600` it), it is unreadable or every cookie has expired (the file is removed), the browser rejected it, or the session landed on `auth.loginPath` (removed). Fix: start with `--auth fresh`, sign in, then `agentlab auth save`. For `AGENTLAB_AUTH_STATE`, export a fresh state and update the CI secret; a rejected in-memory state never removes the project's saved file.

**`auth_not_ignored`.** Cause: git would track the state file, so it was not saved. Fix: run `agentlab init` (it adds `.agentlab/` to `.gitignore`), or add the file to `.gitignore` yourself.

**`auth_missing` with `--auth saved`.** Cause: there is no saved state. Fix: sign in in a fresh session and `auth save`; `agentlab auth status` shows what exists.

**A scan scenario runs signed out.** Cause: a scenario's `auth` defaults to `session` (the running session's state). Fix: start the session with `--auth saved`, or set the scenario's `auth` to `saved`.

## Orphaned services and cleanup

**A service the lab started is still running after a crash or `kill -9`.**
Cause: a session killed without cleanup cannot stop its services. Every session writes an ownership record (`<state dir>/owned/<session>.json`) right after its services start, so they can be found. Fix: run `agentlab clean` (or `agentlab stop`, or just start a new session: `start` reaps first). It stops an owned process group only when the record's owner is gone or reused and the process identity still matches (SIGTERM, then SIGKILL after the grace period). It prints one note per service. It also prunes old runs (the newest 20 are kept).

A service's command normally runs under a shell (`sh -c`) that leads its process group. If that shell dies while the real server lives on, the record also names the group's other processes, each with its own identity (recorded while the shell was alive). `clean` then says `had already exited; stopped recorded member node server.mjs (pid N)`. A process in the group that was never recorded is listed as `N process remains in the group unverified and was not signalled: <command> (pid N)`; stop it yourself if it is part of the service.

**`clean` says `now belongs to another process; not signalled`, or `cannot be verified`.** Cause: the PID was reused, or the record has no identity. The lab prefers to leak a process over killing one it cannot prove it started. Fix: look at the process yourself and stop it if it is yours.

**`clean` says `was started by a one-shot command; to stop it, run ...`.** Fix: run the printed command (for example `docker compose stop`). The lab never runs it from crash recovery.

**A service that was *starting* when the session was killed is not found.** Cause: ownership is recorded after the services are ready, so a service still starting when the process was killed with SIGKILL has no record ([limitations.md](limitations.md)). Fix: stop it manually.

**`Ctrl-C` during `run`, `scan --project` or a CI command.** The first signal closes the browser and stops what the command started, then exits 130 (SIGINT), 143 (SIGTERM) or 129 (SIGHUP). A second signal exits at once with 1 and says what may still be running: run `agentlab clean`.

## Dashboard

**401 on `/api/...`: `missing or invalid dashboard token`.**
Cause: the URL lacks a token, the token is old (a new session in the same process changes both), or you used a link from another session. Fix: run `agentlab ui` for the current link, and open it whole, including the `#token=...` part.

**The page says `view-only link: controls need the URL from agentlab ui`, or a control request gets 401.**
Cause: you opened the link from a `start` or `status` result, which is view-only. Fix: use the link `agentlab ui` prints.

**403 `forbidden host` or `forbidden origin`.**
Cause: the request's `Host` or `Origin` is not `127.0.0.1:<port>` or `localhost:<port>`: a proxy, a different hostname, or a port that does not match. Fix: use the exact printed address. Over SSH, forward the same port number on both sides (`ssh -L <port>:127.0.0.1:<port>`) and open `http://127.0.0.1:<port>/...` locally.

**503 `too many open dashboards` or `too many viewport viewers`.** Cause: 32 event streams or 8 viewport viewers are already open. Fix: close other tabs, then retry (the response carries `Retry-After: 5`).

**409 when pausing or sending input.** Cause: the request does not fit the current mode: `resume` while a person has control, or input when no one has taken over. The message says why.

**The page does not reload after the session ended.** Cause: the process that served it has exited. Fix: none needed; run artifacts, including evidence frames, are in `.agentlab/runs/<session>/`.

**The viewport is blank.** Cause: capture runs only while a viewer is connected and its tab is visible. A minimised headed window may stop producing frames. Fix: bring the tab to the front.

**No dashboard.** Cause: the session was started with `--no-ui` (`agentlab ui` says so). Fix: stop and start again without it.

## CI

| exit | meaning | what to do |
| --- | --- | --- |
| 0 | pass | |
| 1 | the policy failed: a flow failed, an unsuppressed confirmed finding is at or above `--fail-on`, or a scenario run or sweep width could not complete (with `--scenario-errors fail`) | Open `report.html` or `summary.txt`; the reasons say what failed and what was not counted. Failing flows and findings have bundles in `bundles/`. To accept a known finding, add a suppression with a reason. |
| 2 | could not run: an invalid profile or flag, a missing `requiredEnv` variable or browser, an unknown scenario or device, a service that did not start, an unusable sign-in state, or an output that would have leaked a secret | Run `agentlab test --validate-only`: it lists every problem without starting anything. The message names a missing variable but never prints its value. |
| 3 | timed out (`--timeout`, default 30 minutes) | A partial `ci-result.json` is written, verdict `error`. Raise `--timeout`, run fewer scenarios, or split the job. |
| 130, 143, 129 | cancelled by SIGINT, SIGTERM, SIGHUP | The job was cancelled. Services were stopped and a partial result written. |

**A scan passes although a scenario did not run.** Cause: `scan` does not fail on errors by default (`failOnErrors` is off); failed runs are listed in the verdict's reasons. CI mode does fail (`--scenario-errors fail` is its default). Fix: set `scan.policy.failOnErrors` too if you use `scan --project` as a gate.

**Chromium fails to launch in the CI image.** Fix: use an image with Chromium's libraries (`mcr.microsoft.com/playwright:v1.63.0-noble`), or run `agentlab install-browser --with-deps` first. Containers running as root need no sandbox flags.

**Findings appear in CI that you do not see locally.** Cause: CI runs headless at the widths of `scan.devices` with a fresh session by default (`--auth fresh`), and fonts differ between machines (wrapping depends on them). Fix: reproduce with the same image, `--auth` mode and device list.

**`--auth env` fails: `AGENTLAB_AUTH_STATE is not a usable sign-in state`.** Cause: the variable is empty, not JSON or base64 JSON, lacks `cookies` and `origins`, or every cookie expired. Fix: export a fresh state (`agentlab auth save`, then `base64 -w0` the file) into the CI secret.

**A secret appears in a log of the job.** CI mode redacts its own outputs, but it cannot redact what your app prints. Server output echoed into `daemon.log` is masked by pattern only. Keep secrets out of test data and out of the app's logs.

## Bundles, replay and traces

**`replay` says `diverged`.**
Cause: the app no longer matches the recording at that step: the route or dialog before or after differs, the recorded control (role and name) is gone or ambiguous, or the step's outcome changed. Expected and actual are printed and the replay stops there (exit 3). Fix: if the change is intended, the bundle is out of date. If not, you found a regression: the step that diverged is where to look.

**`replay` says `blocked`.**
Cause and fix, by the reason printed:

- a person's interaction comes before the failure: it was recorded as a description and cannot be replayed;
- `the recorded value is masked; supply it with --secret <step>=<ENV_NAME>`: export the value in an environment variable and pass `--secret 2=MY_PASSWORD`;
- the target's name suggests a consequential action (delete, pay, send and similar). Pass `--allow-consequential` only against disposable data;
- `the typed value was longer than the log keeps`, or the bundle's log dropped its first actions (it keeps the last 500): the session cannot be rebuilt.

**`replay` says `not-reproduced` (exit 1).** The failure did not happen again: it may be fixed, flaky, or depend on data that changed. A bundle of findings that only a sweep produced is usually not reproduced, because replay re-runs the agent's steps, not the sweep.

**`replay` could not run (exit 2): `bundle_invalid` or `bundle_too_new`.** The bundle is malformed, or was written by a newer agentlab ("Upgrade agentlab to replay it").

**`replay` warns `agentlab.json differs from the one the bundle was recorded with`.** A warning only: it replays against the current profile and takes commands and environment from it, never from the bundle.

**The bundle has no trace: `traceDropped` says `a secret value was still present in the trace after sanitizing`, `the trace could not be verified`, or the bundle result says `trace left out`.**
Cause: a trace is included only when the session was started with `--trace` and the sanitizer could prove it free of secrets; one it cannot prove clean is dropped, never shipped (`trace_unsanitizable`). Fix: start with `--trace` (or `--trace on-failure` in CI) to record one. A dropped trace is the safe outcome; the bundle's actions, observations and frames are still complete.

**`bundle_unsafe`: `The bundle still contained N secret value(s) after redaction; nothing was written`.** The final check found a known secret. Nothing was written. This is a bug in agentlab: report it, without attaching the run.

**No bundle was written for a scenario that could not run.** By design: its error is in the result and JUnit. Bundles are written for failing flows and for the findings that failed the policy.

## MCP clients

**`claude mcp get agentlab` does not say `Connected`.** Fix: check the path with `command -v agentlab` and re-add the server with the absolute path (GUI launchers often do not have your shell's `PATH`). Check that `agentlab version` works for the same user and Node.js.

**Claude Code shows `Pending approval`.** A project-scoped entry (`.mcp.json`) needs a person to approve it in a session. It does not connect until then.

**The tools are listed but `start` fails with `missing_env`.** The MCP server's environment is the one the client gives it: set the variables in the client's `env` for the server, not only in your shell.

**The agent has the dashboard link but the controls are missing.** That link is view-only on purpose. Run `agentlab ui` in the directory the MCP server was started from, or take the link from the server's stderr.

## Where are the logs?

| what | where |
| --- | --- |
| The ordered action log of a daemon | `agentlab log` (`-f` to follow), or `.agentlab/daemon.log` |
| Each service's output | `.agentlab/runs/<session>/<service>.log` |
| A run's actions, findings, frames | `.agentlab/runs/<session>/` (`agentlab state-dir` prints the directory) |
| The MCP server's messages | the MCP client's log for the server (stderr) |
| CI results | the `--out` directory (default `./agentlab-results`) |
