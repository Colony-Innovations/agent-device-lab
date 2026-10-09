# Agent Device Lab Web V1: release notes (0.3.0)

Agent Device Lab is a local runtime that lets a coding agent launch your project, drive it in a Chromium mobile profile, see what changed after every action, and find responsive and usability defects, while a person watches and can take the wheel. Web V1 is the first release meant for ordinary Linux web projects.

Version 0.3.0 is the release-candidate build (0.3.0-rc.1) with the fixes listed in the changelog. The full list of changes is [../CHANGELOG.md](../CHANGELOG.md).

## Highlights

- **Install and set up in minutes.** One package (`npm install -g agent-device-lab`), `agentlab install-browser`, then `agentlab init`, `agentlab doctor`, `agentlab start`. `init` and `doctor` are read-only until you confirm. See [install.md](install.md), and [getting-started.md](getting-started.md) for a guided first session.
- **Real projects.** A profile declares named services (frontend, API, worker, Docker Compose) with readiness checks and dependencies. The lab starts them in order, reuses ones already running, and stops only what it started. See [configuration.md](configuration.md).
- **A full set of actions.** Click, fill, press, select, check, scroll, swipe, back and forward, hover, upload, drag, and tabs and pop-ups, each returning only what changed. See [cli.md](cli.md).
- **Stateful responsive scans.** Declare UI states (an open drawer, a dialog, an error message) and scan them at 320, 390, 768 and 1440 px in isolated contexts, with optional safe exploration. Findings are `confirmed` only when a measurement shows a person is affected. See [web-v1-m2.md](web-v1-m2.md).
- **Supervision.** A person watching the dashboard can pause the agent, take over the browser, return control, and stop the run. The agent is told, in words it can act on, when it has been paused, replaced or stopped. See [dashboard.md](dashboard.md).
- **CI mode.** `agentlab test` validates, runs flows, sweeps and scans, and exits 0, 1, 2 or 3, writing a JSON result, JUnit, an HTML report, evidence and failure bundles, with nothing secret in any artifact. See [ci.md](ci.md).
- **Failure bundles and replay.** A bundle is a secret-free folder that explains a failure; `agentlab replay` re-runs the agent's steps against your project and tells you whether the failure happens again, or where the app has moved. See [cli.md](cli.md#failure-bundles-and-replay).
- **MCP for Claude Code and Codex.** A stdio MCP server with 25 tools, over the same commands as the CLI. See [mcp.md](mcp.md).
- **Hardened.** Owner-only files, capped logs and lists, ownership records and orphan cleanup, identity-checked process control, a fail-closed trace sanitizer, and a leak check on every CI output. See [security.md](security.md).

## Upgrade steps

From an earlier build (0.1.x, or a 0.2.0 build from before this release):

```bash
npm install -g ./agent-device-lab-<new>.tgz
agentlab install-browser            # a new Playwright can need a new Chromium build (a no-op if it is already there)
agentlab version                    # check the contract versions
agentlab doctor
```

Then, in each project:

1. **Check your profile.** Run `agentlab doctor` or `agentlab test --validate-only`. Profiles are now parsed strictly: an unknown key is an error with a did-you-mean hint. Fix typos, and remove keys this version does not know.
2. **Optionally migrate.** A schemaVersion 1 profile still works. `agentlab migrate --print` shows the schemaVersion 2 form; `agentlab migrate --yes` writes it and keeps the original as `agentlab.json.v1.bak`.
3. **Tighten old state directories.** Directories and files created by this version are owner-only. A `.agentlab/` created by an earlier version keeps its old modes; run `chmod -R go-rwx .agentlab` if it was created with a permissive umask.
4. **MCP clients need no change.** A client sees the new tools on its next `tools/list`. `agentlab mcp` registrations keep working. See [mcp.md](mcp.md#setup).
5. **Agents that run unattended** should handle the new error codes below.
6. **Pipelines:** add a `ci` section to `agentlab.json` and run `agentlab test`. See [ci.md](ci.md).

To go back, install the older tarball. Older builds do not understand the keys and files added in this release (the profile's `ci` section, failure bundles), so remove or ignore them there.

## Breaking changes

- **Strict profile keys.** A profile with a key the installed version does not know now fails (`invalid_profile`, exit 2 in CI) instead of being ignored. This is deliberate: a typo cannot silently turn a setting off. `description`, `comment` and `//` keys are always allowed.
- **A newer profile is refused.** A profile whose `schemaVersion` is newer than this version reads fails with `profile_too_new`, and the file is not touched.
- **The dashboard link agents receive is view-only.** The `dashboard.url` in `start` and `status` results can watch but cannot pause, take over or stop. The person's control link comes from `agentlab ui`, and is never in a command or MCP result. Anything that used the `start` link to supervise must use `agentlab ui`.
- **The dashboard is no longer monitoring-only.** It now serves `POST /api/control` and `POST /api/input`, accepted only with the control token. The read side is unchanged.
- **New error codes.** An agent that handled the earlier codes must now also handle:
  - `session_paused`, `human_control`, `observation_required` (all recoverable: wait, or `observe`, then retry; nothing ran and nothing is queued);
  - `session_stopped` (not recoverable: a person ended the session; ask the user before starting another);
  - `invalid_control` (dashboard requests only);
  - `profile_too_new`, `trace_unsanitizable`, `bundle_invalid`, `bundle_too_new`, `bundle_unsafe`.

  A person's stop is final for the process: `start` is refused afterwards. See [mcp.md](mcp.md#errors).
- **The `stop` tool can be refused.** While a person has paused or taken over the session, an agent's MCP `stop` fails with `session_paused` or `human_control`. `agentlab stop` from a terminal still works then; it is recorded as `stopped from the terminal`.
- **More findings from a sweep.** A sweep now measures each width with the same detector engine as `scan`, so it can report findings (tap targets, clipping, fixed-bar collisions) that earlier builds did not.
- **MCP tool set.** 25 tools: `scan` and `bundle` were added. Existing tools and their arguments are unchanged.

Contract versions in this release: profile 2 (reads 1 and 2), results 1, MCP tools 1, report 1, bundle 1, events 1.

## Known limitations

The main ones: Linux x64 with glibc only (Alpine is not supported; macOS, Windows and arm64 untested); Chromium emulation, not real phones; supervision is cooperative and not a sandbox; a person's actions are recorded as descriptions and cannot be replayed; consequential-step detection is name-based; replay of sweep-only findings is usually not reproduced; a CI timeout or cancel loses a scan's partial findings; redaction is by literal value and screenshots can show anything the page renders. The full list, and the roadmap (Android first, then iOS), is in [limitations.md](limitations.md).

## Where to go next

| I want to | read |
| --- | --- |
| install it | [install.md](install.md) |
| configure a project | [configuration.md](configuration.md) |
| run it from the command line | [cli.md](cli.md) |
| connect an agent | [mcp.md](mcp.md) |
| watch or supervise a run | [dashboard.md](dashboard.md) |
| wire it into CI | [ci.md](ci.md) |
| understand how it works | [architecture.md](architecture.md) |
| something went wrong | [troubleshooting.md](troubleshooting.md) |
