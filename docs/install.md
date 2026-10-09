# Install, upgrade and uninstall

Everything on this page was run, not assumed: [scripts/verify-package.mjs](../scripts/verify-package.mjs) installs the packed tarball in a clean prefix and drives it, and [scripts/verify-docker.mjs](../scripts/verify-docker.mjs) repeats the install in fresh containers. The verification installs the tarball that `npm pack` produces, which is the same file npm serves, so the results apply to an install from npm as well.

## Supported platforms

| platform | status |
| --- | --- |
| Linux x64, glibc (Debian 12 and Ubuntu 24.04 tested) | supported |
| Linux x64, musl (Alpine) | **does not work**: Playwright's Chromium is built for glibc. The package installs and `agentlab version` runs, and `install-browser` downloads the (glibc) build, but the browser cannot start (`spawn ... ENOENT`). `install-browser --with-deps` fails because it needs `apt-get` (exit 127). `agentlab doctor` says so on musl. Use a Debian or Ubuntu base image. |
| Linux arm64, macOS, Windows | untested |
| Node.js 22 and 24 | supported (both tested) |
| Node.js 18 and 20 | refused by a version gate (see below) |

**Node.js 22 or newer.** `package.json` says `"engines": {"node": ">=22"}`. npm only warns about engines, so installing on Node 20 succeeds. The gate is in `bin/agentlab.js`: it checks the major version before importing anything, prints `agentlab needs Node.js 22 or newer; this is 20.x.y.` to stderr and exits 1. Every command is refused, including `version` and `doctor`. Checked on Node 20.20.2 (container) and on the nvm-installed 20.18.1 and 18.20.5.

## Playwright and the browser

Playwright is pinned to an exact version (`1.63.0`, no range) and `agentlab install-browser` runs **the Playwright CLI that ships inside the package**. That matters: a global `npx playwright install` could fetch the browser of whatever Playwright version npx resolves, and the lab launches exactly the build its own Playwright expects (`chromium-1243`). Upgrading agentlab can therefore need a new browser: run `agentlab install-browser` again (it is a no-op when the build is already there).

```bash
agentlab install-browser               # the matching Chromium build, into ~/.cache/ms-playwright
agentlab install-browser --with-deps   # the same, plus the system libraries (apt): needs root, Debian/Ubuntu only
```

`PLAYWRIGHT_BROWSERS_PATH` moves the browser cache (set it the same way for `install-browser` and for every later command; in a container image `/opt/ms-playwright` works). If Chromium installs but does not start, `agentlab doctor` says `System libraries are missing`; fix with `--with-deps` or `sudo npx playwright@1.63.0 install-deps chromium`.

The browser is Playwright's own download (Chromium, the headless shell and ffmpeg: about 660 MB on disk). It is shared with any other Playwright install on the machine and the lab never removes it.

**System dependencies.** On a bare Debian/Ubuntu image Chromium needs a few dozen packages (libnss3, libatk1.0-0, libgbm1, ...). `--with-deps` installs them with `apt-get`, so it needs root (in a container, it runs as root; on a workstation use `sudo` for the dependency step). Headed runs additionally need a display (`DISPLAY` or `WAYLAND_DISPLAY`); without one leave `--headed` off (the default) or use `xvfb-run`. Running as root inside a container works: `doctor` passed as root and as the non-root `node` user, and `test` and the MCP server ran as root without any sandbox flags.

## Install

The package is `agent-device-lab` and the command it installs is `agentlab`.

```bash
# A. global: `agentlab` on PATH
npm install -g agent-device-lab
agentlab install-browser
agentlab version && agentlab doctor

# B. per project (pin the exact version so the whole team runs the same one)
npm install --save-dev --save-exact agent-device-lab@0.3.0 && npx agentlab version

# C. once, with nothing installed
npx --yes --package agent-device-lab agentlab version
```

Always name the package with `--package` when you use `npx` without an install: `npx agentlab` on its own would fetch a different, unrelated npm package that happens to be called `agentlab`. After a per-project install, `npx agentlab` runs the one in your `node_modules`.

### From source

```bash
git clone https://github.com/Colony-Innovations/agent-device-lab.git && cd agent-device-lab
npm ci && npm pack                                   # builds and writes agent-device-lab-<version>.tgz
npm install -g ./agent-device-lab-*.tgz              # or use the tarball's path in B and C above
```

Notes from the runs:

- `npm install -g --prefix <dir> <tgz>` installs into `<dir>` without touching the system prefix, which is how the verification runs it. `<dir>/bin/agentlab` is the entry.
- `agentlab version --json` shows the package, Node.js and Playwright versions, whether Chromium is installed, where the package lives, the state directory and the **contract versions** (next section).
- **npx leaves nothing behind in the directory you ran it from.** Run from an empty directory, `npx ... agentlab version` and even `agentlab start --project <dir>` left the directory empty and the project untouched. The session's state went to `$XDG_STATE_HOME/agentlab/projects/<dir>-<hash>/` (daemon log, runs). npx's own copy of the package is in npm's cache (`~/.npm/_npx/<hash>`); that is npm's, not the lab's.
- `agentlab doctor --no-launch` checks the environment without starting a browser; `agentlab doctor` also launches Chromium headless.

## Set up a project

```bash
cd /path/to/your-app
agentlab init            # shows the detected profile; nothing is written until you confirm (--yes, or answer y)
agentlab doctor          # Node, browser launch, display, permissions, ports, the profile and its services
agentlab start           # no browser window: watch with `agentlab ui` (add --headed for a window)
```

`init` and `doctor` are read-only until you confirm: they run no project commands and read no `.env` values. The profile is `agentlab.json` ([configuration.md](configuration.md)).

For a pipeline, skip the session commands and use [CI mode](ci.md): `agentlab test --validate-only` (exit 2 when something the run needs is missing, such as a `requiredEnv` variable, which is named but never printed) and then `agentlab test --out results`. Exit codes: 0 pass, 1 policy failed, 2 could not run, 3 timed out.

## Upgrade

Install the newer version over the old one, refresh the browser, and check:

```bash
npm install -g agent-device-lab@<new version>
agentlab install-browser      # a new Playwright can need a new Chromium build
agentlab doctor
```

The things that can change between versions are the versioned contracts, reported by `agentlab version`:

```
contracts: profile 2 (reads 1–2), results 1, mcp tools 1, report 1, bundle 1, events 1
```

| contract | what it is | when it matters |
| --- | --- | --- |
| profile | the `agentlab.json` schemaVersion; the version reads an older range too | an older profile keeps working, and `doctor` tells you to migrate |
| results | the command and CI result JSON (`schemaVersion`, `agentlab.ci-result`) | `agentlab report` refuses a result written by a newer version, with a message |
| mcp tools | the MCP tool set and its argument schemas | a client sees the tools of the installed version on its next `tools/list`; nothing in its configuration changes |
| report | the HTML/JSON scan report | |
| bundle | failure bundles, as read by `agentlab replay` | |
| events | the dashboard's event stream | |

**An older profile (schemaVersion 1).** It still works. `doctor` warns and names the fix:

```
warn  profile version: agentlab.json is schemaVersion 1
        → Run `agentlab migrate` to rewrite it as schemaVersion 2.
```

```bash
agentlab migrate --print     # show the result, write nothing
agentlab migrate --yes       # rewrite as schemaVersion 2; the original is kept as agentlab.json.v1.bak
```

The `web` section becomes `services.web`, `"app": {"service": "web"}` is added and everything else stays. A second `migrate` says it is already current. `start` and `stop` worked on the migrated profile. Secret-looking env values are masked in what `migrate` shows, never in the file it writes.

**A profile from the future.** A profile whose `schemaVersion` is newer than the installed version reads is refused, by `start`, `doctor`, `migrate` and `test`, with `profile_too_new`:

```
error profile_too_new: agentlab.json has schemaVersion 3; this agentlab 0.3.0 reads schemaVersion 1–2
hint: Upgrade agentlab (see docs/install.md), or use a profile written for this version.
```

The file is not touched. Install a newer agentlab.

**The strict-key error.** Profiles are parsed strictly: a key the version does not know is an error, not something to ignore, so a typo cannot silently turn a setting off. The message names the place and, when it is close to a known key, the fix:

```
Invalid profile .../agentlab.json: unknown key "readines" in "services.web" (did you mean "readiness"?)
```

`start`, `doctor` and `test --validate-only` (exit 2) all report it. If the key is spelled right, it probably belongs to a newer agentlab than the one installed: upgrade.

## MCP setup

`agentlab mcp --headless` is a stdio MCP server. Use the absolute path of the installed binary (`command -v agentlab`) unless you know the client's `PATH` contains it; GUI launchers often do not. Neither client needs a login or any model usage to register the server.

**Claude Code** (verified with 2.1.280):

```bash
claude mcp add --scope user agentlab -- "$(command -v agentlab)" mcp --headless
claude mcp get agentlab       # Status: ✔ Connected
claude mcp list               # agentlab: <path> mcp --headless - ✔ Connected
```

`claude mcp get` and `claude mcp list` health-check the server, which is a real MCP `initialize` over stdio, so "Connected" proves the client can launch and talk to it. The entry lands in `~/.claude.json`. With `--scope project` the entry is written to `.mcp.json` in the project (the file you commit); Claude Code then shows it as `⏸ Pending approval (run claude to approve)` and does not connect until a person approves it in a session. That approval is the part this verification could not do without starting an interactive session.

**Codex CLI** (verified with 0.151.0):

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

`codex mcp list` and `get` only read that file; they do not start the server. Codex's own connection to the server could not be verified without a model session, which was not allowed. What was verified instead: the `command` and `args` Codex read back were launched through the MCP SDK client, which listed the 25 tools (including `bundle`) and ran a `start`, `observe`, `stop` round trip.

Both registrations give the same server. The protocol itself is checked in `verify-package` from the installed package: `tools/list` includes `bundle`, and `start`, `observe`, `select`, `check`, `press`, `back`, `upload`, `tabs` and `stop` round-trip.

## Uninstall

```bash
agentlab stop                                               # in any directory with a running session
npm uninstall -g agent-device-lab                           # or: npm uninstall agent-device-lab in the project
rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/agentlab"      # everything the lab kept outside projects
rm -rf /path/to/your-app/.agentlab                          # per project: runs, logs, bundles, saved sign-in state
rm -f  /path/to/your-app/agentlab.json.v1.bak               # only if `migrate` made one and you no longer want it
rm -rf ~/.cache/ms-playwright                               # the browser; ONLY if nothing else uses Playwright
```

`npm uninstall -g` removes the `agentlab` bin and the package directory and nothing else. After a full verification run with the lab's `HOME` and `XDG_STATE_HOME` redirected, nothing from agentlab was left outside the projects' `.agentlab/` directories and `$XDG_STATE_HOME/agentlab` (which holds the state of any directory that has no `agentlab.json`, for example a session started from an empty directory with `--project`). The only other files in `HOME` belonged to software the lab runs: Chromium's font cache (`~/.cache/fontconfig`) and GPU shader cache (`~/.cache/mesa_shader_cache`), and npm's logs and update stamp (`~/.npm`) from the fixtures' own `npm run dev`. The lab never signals a process it did not start; run `agentlab clean` first if a crashed session may have left services running.

## Where files live

| what | where |
| --- | --- |
| the profile | `agentlab.json` in the project (yours; `migrate` adds `agentlab.json.v1.bak`) |
| runs, logs, the daemon record, ownership records, failure bundles, saved sign-in state | `./.agentlab/` in any directory that has an `agentlab.json` (or an existing `.agentlab/`). `init` adds it to `.gitignore`; saved sign-in state is written only when git would ignore it, mode 0600 |
| the same, for a directory that was never initialised | `$XDG_STATE_HOME/agentlab/projects/<dir>-<hash>/` (default `~/.local/state/agentlab/...`), so running `agentlab` never writes into an unrelated directory |
| failure bundles with no project state dir | `<state dir>/bundles` (kept 14 days, newest 20) |
| CI artifacts | `--out <dir>` (default `./agentlab-results`) |
| the browser | `~/.cache/ms-playwright` (or `PLAYWRIGHT_BROWSERS_PATH`) |
| Chromium's font and shader caches | `~/.cache/fontconfig`, `~/.cache/mesa_shader_cache` (not the lab's) |

`AGENTLAB_HOME` overrides the state directory. `agentlab version`, `doctor`, `init --print`, `migrate --print` and `test --validate-only` write nothing.

## Compatibility matrix

Measured on 2026-09-30 with agent-device-lab 0.2.0 (tarball 236.7 kB, 832 kB unpacked, 50 files), Playwright 1.63.0, Chromium 153.0.8010.12. Containers ran as root; the image digests are in the results file.

| environment | `npm install -g <tgz>` | `install-browser --with-deps` | `version` | `doctor` (launch) | `agentlab test` exit 0 / exit 1 | MCP round trip | `npm uninstall -g` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `node:22-bookworm-slim` (Debian 12 (bookworm), GLIBC 2.36; Node 22.23.3) | ok (32 s) | ok (333 s) | ok (5.8 s) | ok (7.3 s) | ok / ok | ok (13 s) | ok (3.5 s) |
| `node:24-bookworm-slim` (Debian 12 (bookworm), GLIBC 2.36; Node 24.21.0) | ok (60 s) | ok (276 s) | ok (1.8 s) | ok (12 s) | ok / ok | ok (10 s) | ok (1.4 s) |
| `node:22-alpine` (Alpine Linux v3.24, musl; Node 22.23.3) | ok (58 s) | FAIL (6.9 s) | ok (3.3 s) | FAIL (3.4 s) | FAIL / FAIL | FAIL (3.7 s) | ok (4.1 s) |
| host: Ubuntu 24.04.5, glibc 2.39; Node 22.17.1, npm 10.9.2 (temp prefix, real `~/.cache/ms-playwright`) | ok (20 s) | browser already cached | ok (12 s) | ok (7.4 s) | ok / ok (CI pass 0, fail 1) | ok (6.7 s) | ok (2.4 s) |

| Node.js gate | result |
| --- | --- |
| `node:20-bookworm-slim` (Node 20.20.2), installed from the tarball | `agentlab version` and `doctor` exit 1: "agentlab needs Node.js 22 or newer; this is 20.20.2." |
| host nvm v20.18.1 | `agentlab version` exit 1: "agentlab needs Node.js 22 or newer; this is 20.18.1." |
| host nvm v18.20.5 | `agentlab version` exit 1: "agentlab needs Node.js 22 or newer; this is 18.20.5." |

Image digests (from `docker pull`; the tags move):

- `node:22-bookworm-slim`: `node@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c`
- `node:24-bookworm-slim`: `node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`
- `node:22-alpine`: `node@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402`
- `node:20-bookworm-slim`: `node@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0`

Alpine is a finding, not a pass: `node:22-alpine` installs the package and runs `agentlab version`, then fails at every step that needs Chromium. `install-browser --with-deps` exits 127 (`apt-get: not found`), `install-browser` alone downloads the glibc build, `doctor` reports `this Linux uses musl libc (Alpine): Playwright's Chromium 1.63.0 is built for glibc and cannot start here`, and `test` exits 2 with `spawn ... chrome-headless-shell ENOENT`. Not supported; not forced.

Host checks from `verify-package` (Ubuntu 24.04.5, 37 steps): global install into a temp prefix, `npx` from an empty directory, upgrade and migration, CI from the installed package, bundle and replay, Claude Code and Codex MCP configuration, Node gate, uninstall. All 37 passed.

Checks per supported image: `npm install -g <tgz>`, `install-browser --with-deps`, `version`, `doctor` with a browser launch (root and non-root), headless `agentlab test` on the invoice fixture (`/invoices` exit 0; `/reports`, which has a seeded overflow defect, exit 1 with a JUnit `<failure>`), an MCP round trip with the SDK taken from the global install, and `npm uninstall -g`.

Known limits: Alpine is not supported (above). arm64, macOS and Windows were not run. `install-browser --with-deps` downloads from the Debian mirrors and the Playwright CDN, so it is the slowest step (4.5 to 5.5 minutes here) and the only one that ever failed from network slowness during verification (two attempts of `npm install -g` and one of `--with-deps` timed out on a slow mirror; `verify-docker` now retries each once and records it).
