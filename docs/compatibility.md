# Compatibility

What Agent Device Lab Web V1 was run on, which versions of its dependencies it needs, which of its interfaces are versioned, and how a change to any of them is handled. Measurements are from the release-candidate build (package version 0.2.0 in `package.json` at the time of measurement), on 2026-09-30. The install guide is [install.md](install.md). To repeat the measurements, run `npm run verify:package` and `node scripts/verify-docker.mjs` from a checkout.

## Platforms and runtimes

| platform | status |
| --- | --- |
| Linux x64, glibc (Debian 12 and Ubuntu 24.04 tested) | supported |
| Linux x64, musl (Alpine) | **does not work.** Playwright's Chromium is built for glibc. The package installs and `agentlab version` runs, then every step that needs Chromium fails (`spawn ... ENOENT`). `doctor` says so. |
| Linux arm64, macOS, Windows | untested. Process identity has a macOS path (`ps`) in the code, unverified. |
| Node.js 22 and 24 | supported (both tested) |
| Node.js 18 and 20 | refused by a version gate in `bin/agentlab.js`: `agentlab needs Node.js 22 or newer; this is 20.x.y.`, exit 1 for every command. Checked on 20.20.2 (container), and nvm 20.18.1 and 18.20.5. |
| Browsers | Chromium only (Playwright's build). WebKit and Firefox are not built. The device profiles are Chromium device emulation, not phones, iOS Safari or Android WebView. |

### Pinned versions

| component | version | how it is held |
| --- | --- | --- |
| Playwright | 1.63.0 | An exact version in `dependencies` (no range). |
| Chromium | 153.0.8010.12 (build `chromium-1243`; the headless shell is `chromium_headless_shell-1243` and ffmpeg `ffmpeg-1011`) | Whatever Playwright 1.63.0 expects. `agentlab install-browser` runs the Playwright CLI that ships inside the package, so the build always matches. |
| MCP SDK (`@modelcontextprotocol/sdk`) | 1.30.1 | An exact version in `dependencies`. |
| Node.js | 22 or newer | `"engines": {"node": ">=22"}` and the gate above. |

### Install matrix (2026-09-30, root in containers)

| environment | `npm install -g <tgz>` | `install-browser --with-deps` | `version` | `doctor` (launch) | `agentlab test` exit 0 / exit 1 | MCP round trip | `npm uninstall -g` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `node:22-bookworm-slim` (Debian 12, glibc 2.36, Node 22.23.3) | ok | ok | ok | ok (root and the non-root `node` user) | ok / ok | ok | ok |
| `node:24-bookworm-slim` (Debian 12, glibc 2.36, Node 24.21.0) | ok | ok | ok | ok (root and the non-root `node` user) | ok / ok | ok | ok |
| `node:22-alpine` (Alpine 3.24, musl, Node 22.23.3) | ok | FAIL (`apt-get: not found`, exit 127) | ok | FAIL | FAIL / FAIL | FAIL | ok |
| host: Ubuntu 24.04.5, glibc 2.39, Node 22.17.1, npm 10.9.2 | ok (temp prefix) | browser already cached | ok | ok | ok / ok | ok | ok |
| `node:20-bookworm-slim` (Node 20.20.2) | installs | | refused by the gate | refused by the gate | | | |

Timings and image digests are in [install.md](install.md#compatibility-matrix). On the host, `npm run verify:package` ran 37 steps and all passed: global install into a temporary prefix, `npx` from an empty directory, upgrade and migration, CI from the installed package, bundle and replay, Claude Code and Codex MCP configuration, the Node gate, uninstall.

What each supported image ran: `npm install -g <tgz>`, `install-browser --with-deps`, `version`, `doctor` with a browser launch, a headless `agentlab test` on the invoice fixture (`/invoices`: exit 0; `/reports`, which has a seeded overflow defect: exit 1 with a JUnit `<failure>`), an MCP round trip with the SDK taken from the global install, and `npm uninstall -g`.

Known gaps: Alpine, arm64, macOS and Windows are not supported or were not run. `install-browser --with-deps` downloads from the Debian mirrors and the Playwright CDN, and is the slowest step (4.5 to 5.5 minutes in these runs).

## MCP clients

| client | version tested | what was verified | what was not |
| --- | --- | --- | --- |
| Claude Code | 2.1.280 | `claude mcp add --scope user`, `get` and `list` all showed `✔ Connected` (Claude Code's health check performs the MCP `initialize` handshake over stdio; no login, no model call). The entry lands in `~/.claude.json`. A project-scope entry in `.mcp.json` shows `⏸ Pending approval`. The configured command listed 25 tools. | Approving a project-scope entry, which needs an interactive session. |
| Codex CLI | 0.151.0 | `codex mcp add` wrote `[mcp_servers.agentlab]` to `$CODEX_HOME/config.toml`; `mcp list --json` and `mcp get --json` show it enabled (stdio). The `command` and `args` Codex reads back were launched through the MCP SDK client, which listed the 25 tools and ran `start`, `observe`, `stop`. | Codex's own connection to the server, which needs a model session. |
| other MCP clients | | | Not tested. Any client that can launch a stdio server should work. |

Claude Code passes `structuredContent` to the model instead of the text `content`, so agents there read the JSON result. The setup commands are in [mcp.md](mcp.md#setup).

## Versioned contracts

`agentlab version` prints them (`--json` has them as `contracts`):

```
contracts: profile 2 (reads 1–2), results 1, mcp tools 1, report 1, bundle 1, events 1
```

| contract | now | what it covers | where a newer value is refused |
| --- | --- | --- | --- |
| `profile` | 2, reads 1 and 2 | The `schemaVersion` of `agentlab.json` | `start`, `doctor`, `migrate`, `test`: `profile_too_new`; the file is not touched |
| `results` | 1 | The `schemaVersion` on CLI and MCP JSON results | |
| `mcpTools` | 1 | The MCP tool names and their input schemas | |
| `report` | 1 | The scan and CI report JSON; `ci-result.json` carries `schema: "agentlab.ci-result"` and `version` | `agentlab report`: "This CI result is version N; this agentlab reads up to 1" |
| `bundle` | 1 | `bundleVersion` in `bundle.json` | `replay` and `bundles`: `bundle_too_new` |
| `events` | 1 | The dashboard's feed messages | |

### The compatibility policy

- **A number changes only when its shape changes incompatibly** (`src/core/versions.ts`). Removing or renaming a field, changing a type or meaning, removing a tool or argument, or making an optional argument required are incompatible. Adding an optional field, a new tool, a new optional argument, a new event type, a new error code or a new finding kind is not, and does not bump a number. Consumers should ignore fields they do not know.
- **Profiles are strict.** A key the installed version does not know is an error, so a profile written for a newer version fails loudly instead of silently turning a setting off. The converse holds as well: a profile that uses a key added in a later version is refused by an older agentlab (unknown key). That is intended, and the release notes list every new key. Removing a key, or changing what an existing key means, bumps `profile`.
- **A reader refuses what is newer than it understands.** `profile`, `bundle` and the CI result each say so with a message that names the fix (upgrade agentlab). An older document is read: this version reads profile versions 1 and 2, and bundles and CI results up to version 1. `migrate` rewrites an older profile as the current one, keeps the original as `agentlab.json.v1.bak`, and never runs on its own.
- **MCP clients follow the installed version.** A client sees the tools of the installed version on its next `tools/list`; nothing in its configuration changes when agentlab is upgraded. Tool schemas reject unknown arguments (`invalid_request`).
- **Error codes** are strings in a closed list (`LabErrorCode` in `schema.ts`); each has a `recoverable` flag that tells an agent whether it can fix the problem within the session. New codes may be added.
- **The product version is separate from the contracts.** The package version says which build you have; the contract numbers say which formats it speaks. After an upgrade, run `agentlab install-browser` (a new Playwright can need a new Chromium) and `agentlab doctor`.

## Playwright upgrade strategy

Playwright is the lab's one large dependency, and the lab uses parts of it that are not covered by its semantic-versioning promises: the trace format, the screencast API and the Chrome DevTools Protocol. So it is **pinned to an exact version** (1.63.0, no range) and upgraded deliberately, never by a range resolving to something new.

**Why the browser is tied to the package.** `agentlab install-browser` runs the Playwright CLI inside the installed package, so the Chromium it downloads is exactly the build that version launches. A global `npx playwright install` could fetch the browser of whatever version npx resolves. The browser cache (`~/.cache/ms-playwright`, or `PLAYWRIGHT_BROWSERS_PATH`) is shared with any other Playwright install, and the lab never removes it.

**What depends on Playwright's internals:**

| use | where | why it can break |
| --- | --- | --- |
| The trace format | `src/core/trace-sanitize.ts`, `src/core/zip.ts` | The sanitizer knows the entries and fields of a 1.63 trace (`trace.trace`, `trace.network`, `trace.stacks`, `resources/`, `screencast/`). An entry it does not know is an error: it fails closed and the trace is dropped. |
| The live viewport | `page.screencast.start({ onFrame, size, quality })` (public API, backed by CDP `Page.startScreencast`) | Frame delivery and acknowledgement. |
| CDP calls | `Input.dispatchTouchEvent` (swipe), `Network.*` body-activity events (settling), the navigation history | Protocol changes between Chromium versions. |
| Device emulation | `devices.ts` | The built-in user-agent strings name `Chrome/153.0.0.0`. |

**Before bumping Playwright**, in order:

1. Change the exact version in `package.json`, install, and run `npm run build` and `npm run typecheck`.
2. Run the format-compatibility test for traces: `node --test test/trace-sanitize.test.mjs`. Its end-to-end case ("Playwright 1.63 trace format: sanitizer removes secrets") records a real trace and checks that no secret survives; a Playwright upgrade that changes the format fails there. Update the sanitizer for the new format, never loosen it to pass.
3. Run the screencast tests: `test/dashboard.test.mjs`, `test/dashboard-control.test.mjs`, `test/dashboard-control-ui.test.mjs` and `test/dashboard-e2e.test.mjs` (viewer-gated capture, the frame-rate cap, a real daemon session). Check the live viewport by eye.
4. Run the full suite (`npm test`), both fixture flows, and a responsive scan of `fixtures/responsive-app` (its seeded defects must all be found with no false positives; settling and the click path depend on CDP behaviour).
5. Update the user-agent strings in `devices.ts` if the Chromium major changed, and the browser-build names in [install.md](install.md) and this page.
6. Run `npm run verify:package` and `node scripts/verify-docker.mjs` from the packed tarball, including `install-browser --with-deps` on both supported Node versions.
7. Update the Playwright image tag in CI examples (`mcr.microsoft.com/playwright:v1.63.0-noble` in [ci.md](ci.md)).
8. Record the new versions here and in the changelog, and say in the release notes that users must run `agentlab install-browser` after upgrading.

The same applies to the MCP SDK (pinned exactly, `1.30.1`): run `test/mcp.test.mjs`, `test/mcp-actions.test.mjs` and `test/mcp-supervision.test.mjs`, and check that `claude mcp get` still reports `Connected`.
