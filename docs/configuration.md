# Configuration reference: `agentlab.json`

A project opts in to Agent Device Lab with an `agentlab.json` file in its root. The lab runs only the commands declared there, and committing the file is how a developer approves them. `agentlab init` proposes one from the project's files ([cli.md](cli.md#init)); this page documents every key.

Everything here is checked by `src/core/profile.ts`. `agentlab doctor`, `agentlab start` and `agentlab test --validate-only` report every problem at once.

## Rules that apply to the whole file

- **Strict keys.** A key the installed version does not know is an error, not something that is ignored, so a typo cannot silently turn a setting off. The message names the place and, when it is close to a known key, the fix: `unknown key "readines" in "services.web" (did you mean "readiness"?)`. If the key is spelled right, it probably belongs to a newer agentlab: upgrade.
- **Comments.** `description`, `comment` and any key that starts with `//` are allowed in every object. Use them for notes. A top-level `$schema` key is allowed and not interpreted.
- **Versions.** `schemaVersion` is required. This version reads 1 and 2 and writes 2. A newer number is refused with `profile_too_new` before anything else is read. See [Version 1 and migration](#version-1-and-migration).
- **Paths.** `cwd`, `auth.file` and `uploads.allow` entries are relative to the directory holding `agentlab.json`.
- **Numbers.** Where a field says "positive number", zero, negative and non-numbers are errors.
- **Secrets.** Do not put secrets in `env`: the file is committed. Name them in `requiredEnv` and export them where agentlab runs. `doctor` warns about secret-looking names in `env`.

## Top level (schemaVersion 2)

| key | type | default | meaning |
| --- | --- | --- | --- |
| `schemaVersion` | `2` (or `1`) | required | The profile format. |
| `name` | string | `"project"` | A label shown in results, reports and the dashboard. |
| `services` | object | required | Named services. See [Services](#services). Must declare at least one. |
| `app` | object | see below | Which URL is the application under test. |
| `startPath` | string | `"/"` | The first page opened. Must start with `/`. |
| `device` | string | `"mobile-390"` | The device for the session. A built-in id or one from `devices`. |
| `devices` | object | `{}` | Project device profiles. |
| `allowExternalUrl` | boolean | `false` | Allow service and app URLs that are not local or private hosts. |
| `settle` | object | see below | How the lab decides a page has stopped changing. |
| `auth` | object | see below | Saved sign-in state. |
| `uploads` | object | none | Files the `upload` action may read. |
| `scan` | object | see below | Scenarios, exploration, checks, suppressions and the policy for `scan`. |
| `ci` | object | none | What `agentlab test` runs and how it decides. |

### `app`

The primary application URL, used for `startPath`, sweeps and scans.

| form | meaning |
| --- | --- |
| `{"service": "web"}` | Use that service's `url`. The service must exist and have a `url`. |
| `{"url": "http://127.0.0.1:5173"}` | Use this URL. If it equals a service's `url`, that service is the app's service. |
| omitted | The service named `web` if it has a `url`; otherwise the only service that has one. If that is ambiguous, `app` is required. |

### URL policy

Every service `url` and the app URL must be `http` or `https`, and by default a local or private development host: `localhost`, `*.localhost`, `127.x.x.x`, `10.x.x.x`, `192.168.x.x`, `172.16.x.x` to `172.31.x.x`, `::1`, and the IPv6 private ranges (`fc00::/7`, `fe80::/10`). Anything else fails with `url_not_allowed` unless `"allowExternalUrl": true`. Only the value `true` opts in.

## Services

`services` maps a name to a service. A name is letters, digits, `-` and `_`, starting with a letter or digit.

| key | type | default | meaning |
| --- | --- | --- | --- |
| `command` | string | required | A shell command, run in `cwd` in its own process group. |
| `cwd` | string | `"."` | Working directory, relative to the profile. |
| `url` | string | none | The service's base URL. It enables HTTP readiness and reuse detection. |
| `env` | object of strings | `{}` | Literal, non-secret values added to the inherited environment. |
| `requiredEnv` | list of names | `[]` | Environment variables that must be set where agentlab runs (`[A-Za-z_][A-Za-z0-9_]*`). A missing one stops the start before anything runs, with `missing_env`. Only names are checked or reported, never values. |
| `readiness` | object | see below | How the lab knows the service is ready. |
| `dependsOn` | list of service names | `[]` | Start only after these are ready. An unknown name, a self-reference and a cycle are profile errors. |
| `reuseExisting` | boolean | `true` | With an HTTP or TCP check: if the service is already ready, use it and never stop it. With `false`, an existing one is `port_conflict`. Only `false` turns it off. |
| `required` | boolean | `true` | A failed optional service (`false`) is reported and the services that depend on it are skipped; the start carries on. Only `false` makes it optional. |
| `mode` | `"process"` or `"oneshot"` | `"process"` | `oneshot` is for commands that exit once their work is running, such as `docker compose up -d`. The command must exit 0. |
| `shutdown` | object | see below | How to stop the service. |

Services with no dependency between them start concurrently. Each starts as soon as everything it depends on is ready.

### `readiness`

At most one check kind per service. `url` and `path` may appear together but should not: `url` wins.

| key | type | default | meaning |
| --- | --- | --- | --- |
| `path` | string | `"/"` (when the service has a `url`) | HTTP check: GET `url` + `path`. Must start with `/`; needs the service's `url`. |
| `status` | number | `200` | The status the HTTP check expects. |
| `url` | string | none | HTTP check against a full URL (its origin and path are used). |
| `tcp` | `"host:port"` | none | Ready when the port accepts a connection. |
| `log` | string (regular expression) | none | Ready when a line of the service's output matches. |
| `alive` | positive number (ms) | `1000` | Ready when the process is still running after this long. |
| `timeoutMs` | positive number | `60000` | Give up after this long. |
| `intervalMs` | positive number | `250` | Time between HTTP and TCP probes. |

Defaults and rules:

- A service with a `url` and no `readiness` gets `{"path": "/"}`.
- A service with no `url` needs a `tcp`, `log` or `alive` check, unless it is a one-shot.
- A one-shot with no check is ready when its command exits 0 within `timeoutMs`. With a check, the command must still exit 0, and then the check is polled.
- Only `http` and `tcp` checks can detect an instance that is already running. A `log` or `alive` service is always started, and `doctor` warns that `reuseExisting` has no effect.

### `shutdown`

| key | type | default | meaning |
| --- | --- | --- | --- |
| `signal` | `SIGTERM`, `SIGINT`, `SIGHUP` or `SIGQUIT` | `SIGTERM` | Sent to the service's process group. |
| `graceMs` | positive number | `5000` | How long to wait for the group to empty before SIGKILL. |
| `command` | string | none | For `mode: "oneshot"` only, for example `docker compose stop`. Run on stop, and only if the lab ran the start command. |

On stop the lab signals only process groups it started, in reverse ready order, dependents first. A reused service is never signalled.

## `devices` and `device`

Built-in devices (`agentlab devices` lists them):

| id | viewport | scale | touch |
| --- | --- | --- | --- |
| `mobile-320` | 320 × 568 | 2 | yes |
| `mobile-390` | 390 × 844 | 3 | yes |
| `tablet-768` | 768 × 1024 | 2 | yes |
| `desktop-1440` | 1440 × 900 | 1 | no |

These are Chromium device emulation, not phones. A project device is declared as an object under `devices`, and replaces a built-in of the same id.

| key | type | default | meaning |
| --- | --- | --- | --- |
| `extends` | device id | none | A built-in device to start from. |
| `viewport` | `{"width", "height"}` | from `extends` | CSS px, each between 100 and 4000. |
| `label` | string | generated | A display name. |
| `deviceScaleFactor` | number | from `extends`, else 1 | Above 0 and at most 4. |
| `isMobile` | boolean | from `extends`, else `false` | Mobile emulation (a layout viewport that can widen). |
| `hasTouch` | boolean | from `extends`, else the value of `isMobile` | Touch input. |
| `userAgent` | string | from `extends`; else an Android Chrome (mobile) or desktop Chrome string | The user agent. |

A device needs `extends` or `viewport`. Example: `"phone-360": {"extends": "mobile-390", "viewport": {"width": 360, "height": 780}}`.

## `settle`

How the lab decides, after an action, that the page has stopped changing. Tune these per project here, not in code. A timeout is reported on the action (outcome stays `success`), never thrown.

| key | type | default | meaning |
| --- | --- | --- | --- |
| `quietMs` | positive number | `120` | How long the DOM must be free of mutations. |
| `maxMs` | positive number | `5000` | The upper bound on waiting after an action or navigation. |
| `backgroundRequests` | list of non-empty strings | `[]` | URL substrings (for example `"/api/poll"`) for requests that are long-lived by design and never awaited. |
| `timerMaxMs` | number, `0` or positive | `1000` | Also wait for pending one-shot `setTimeout` timers up to this delay. `0` turns it off. |

Settling also waits while a visible `aria-busy="true"` region exists, while a finite animation runs, after a client-side route change until the page has rendered, and while a document with scripts has drawn nothing. EventSource and WebSocket connections and requests already open before the action are never awaited. A timeout names its cause: `dom`, `network`, `busy`, `timers`, `route` or `empty` (see [troubleshooting.md](troubleshooting.md#settle-timeouts)).

## `auth`

Saved sign-in state, written by `agentlab auth save` ([security.md](security.md#secrets)).

| key | type | default | meaning |
| --- | --- | --- | --- |
| `file` | string | `".agentlab/auth/state.json"` | Where the state is saved, relative to the profile. |
| `use` | `"auto"` or `"never"` | `"auto"` | With `auto`, a session started with `--auth auto` (the default) loads the file when it exists. With `never`, it does not; `--auth saved` still loads it. |
| `loginPath` | string | none | A path starting with `/`. A session started from saved state that lands here is treated as signed out: the state is removed and the start fails with `auth_invalid`. |

## `uploads`

| key | type | default | meaning |
| --- | --- | --- | --- |
| `allow` | list of strings | none | Directories or files, relative to the project, that `upload` may read. Absolute paths and paths that leave the project are errors. Nothing is allowed by default. |

Files are resolved with symlinks followed (realpath) before they are checked against these entries.

## `scan`

Scenarios, exploration, detector options, suppressions and the pass/fail policy for `agentlab scan`. A profile without `scan` scans its `startPath` as loaded at the four default widths. The detectors, scenario steps, exploration safety, findings and reports are documented in [web-v1-m2.md](web-v1-m2.md); this table is the key reference.

| key | type | default | meaning |
| --- | --- | --- | --- |
| `devices` | non-empty list of device ids | the four built-ins | Widths for sweeps and for scenarios that name none. |
| `checks.enable`, `checks.disable` | lists of check names | all on | Check names are the finding kinds, such as `tap-target` and `layout-shift`. |
| `tapTargets.standard` | `"wcag22-aa"` or `"wcag22-aaa"` | `"wcag22-aa"` | 24 px with the spacing exception, or 44 px. |
| `noWrap` | list of `{role, name}` matchers | `[]` | Controls that must never wrap. `name` and `route` may use `*`. |
| `wrapNearbyRatio` | number above 1, at most 3 | `1.35` | Two widths are compared for wrapping when the wider is at most this many times the narrower. |
| `layoutShiftMin` | number above 0, at most 1 | `0.05` | The smallest layout-shift score reported. |
| `explore` | object | see below | Exploration of state-opening controls. |
| `scenarios` | list | `[]` | Declared UI states. |
| `suppressions` | list | `[]` | Accepted findings. |
| `policy` | object | see below | When a scan fails. |

`explore`:

| key | type | default | meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Explore safe controls too. |
| `maxDepth` | whole number, 1 to 4 | `1` | |
| `maxStates` | whole number, 1 to 100 | `12` | |
| `maxActionsPerState` | whole number, 1 to 50 | `8` | |
| `maxMs` | whole number, 1 to 3600000 | `120000` | Covers the whole scan. |
| `allow`, `deny` | lists of `{role, name, route}` matchers | `[]` | Allow-list a control exploration would skip as ambiguous; deny-list one it must not touch. Each needs `role` or `name`. |

A scenario:

| key | type | default | meaning |
| --- | --- | --- | --- |
| `name` | string | required | Unique in the profile. |
| `route` | string | required | Starts with `/`. |
| `auth` | `"session"`, `"saved"` or `"fresh"` | `"session"` | Where the scenario's cookies and storage come from. |
| `devices` | non-empty list | `scan.devices` | |
| `steps` | list of steps | `[]` | Setup, run through the same code as a flow. |
| `cleanup` | list of steps | `[]` | Run after the checks. |
| `checks` | `{enable, disable}` | none | Narrows `scan.checks` for this scenario. |
| `explore` | boolean | the profile's | Override exploration for this scenario. |

A step:

| key | meaning |
| --- | --- |
| `do` | One of `click`, `fill`, `press`, `select`, `check`, `uncheck`, `scroll`, `swipe`, `back`, `forward`, `hover`, `upload`, `drag`, `open_tab`, `switch_tab`, `close_tab`. |
| `role`, `name`, `nameContains` | The target, resolved against the latest observation. Targeted actions (`click`, `fill`, `select`, `check`, `uncheck`, `hover`, `upload`, `drag`) need `name` or `nameContains`. More than one match is `ambiguous_target`. |
| `value` | `fill` (required). A value aimed at a password-like field is never printed. |
| `key`, `values`, `direction`, `amount`, `to`, `dx`, `dy`, `files`, `tab`, `path` | The arguments of the action: `press` needs `key`; `select` takes `values`; `scroll` and `swipe` take `direction` and `amount`; `drag` takes `to` (a target) or `dx` and `dy`; `upload` takes `files`; tab actions take `tab` or `path`. |
| `label` | A name for the step in output. |
| `expect` | What must hold after the step: `route`, `heading`, `dialog` (or `null` for none), `message`, `control`, `noControl`, `layout`, `note`, `navigated`, `tab`, `findings`. A failed expectation fails the run before its checks. |

A suppression:

| key | type | meaning |
| --- | --- | --- |
| `reason` | string | Required. Why the finding is accepted. |
| `kind` | check name, or a list | One of `kind` or `fingerprint` is required, so a rule cannot hide everything. |
| `fingerprint` | string | A finding's fingerprint. |
| `route`, `scenario`, `device` | string | Narrow the rule. `route` may use `*`. |
| `target` | `{role, name}` | Narrow to a control. `name` may use `*`. |
| `expires` | `YYYY-MM-DD` | After this date the rule no longer applies, and says so. |

`policy`:

| key | type | default | meaning |
| --- | --- | --- | --- |
| `failOn` | `high`, `medium`, `low` or `none` | `high` | The lowest severity of an unsuppressed confirmed finding that fails the scan. |
| `failOnErrors` | boolean | `false` | A scenario run that could not complete fails the scan. |
| `failOnHeuristic` | boolean | `false` | Heuristic findings count too. |

## `ci`

What `agentlab test` runs and how it decides. Every key is optional, and flags override these values. Full behaviour, flags and exit codes are in [ci.md](ci.md).

| key | type | default | meaning |
| --- | --- | --- | --- |
| `flows` | list of strings | `[]` | Flow files, relative to the profile. |
| `routes` | list of paths | `[]` | Routes to sweep. Each starts with `/`. When nothing at all is selected, the `startPath` is swept. |
| `scenarios` | list of names, or `"all"` | all declared scenarios | Scenarios to scan. |
| `devices` | list of device ids | each scenario's own; `scan.devices` for sweeps | |
| `failOn` | `high`, `medium`, `low` or `none` | `scan.policy.failOn` | |
| `failOnHeuristic` | boolean | `scan.policy.failOnHeuristic` | |
| `scenarioErrors` | `"fail"` or `"report"` | `"fail"` | A scenario run or sweep width that could not complete fails the run, or is only listed. |
| `out` | string | `"./agentlab-results"` | The artifacts directory. |
| `trace` | `"off"`, `"on-failure"` or `"always"` | `"off"` | Record a sanitized Playwright trace. |
| `evidence` | `"off"`, `"on-failure"` or `"always"` | `"on-failure"` | Copy evidence frames into the artifacts. |
| `timeoutMs` | number, at least 1000 | `1800000` (30 minutes) | The whole-run limit. |
| `auth` | `"fresh"`, `"saved"` or `"env"` | `"env"` when `AGENTLAB_AUTH_STATE` is set, else `"fresh"` | Where the sign-in state comes from. |

## A full example

This profile exercises every section. It is a schemaVersion 2 profile for a web frontend, an API, a worker and a Docker Compose cache. (`examples/multi-service/` holds a runnable multi-service profile.)

```json
{
  "schemaVersion": 2,
  "name": "shop",
  "// note": "Keys that start with // are ignored: use them for comments.",
  "services": {
    "cache": {
      "command": "docker compose up -d redis",
      "mode": "oneshot",
      "readiness": { "tcp": "127.0.0.1:6379", "timeoutMs": 30000 },
      "shutdown": { "command": "docker compose stop redis" }
    },
    "api": {
      "command": "npm run dev --workspace api",
      "cwd": ".",
      "url": "http://127.0.0.1:4000",
      "env": { "PORT": "4000" },
      "requiredEnv": ["SHOP_API_TOKEN"],
      "readiness": { "path": "/health", "status": 200, "timeoutMs": 30000 },
      "dependsOn": ["cache"]
    },
    "worker": {
      "command": "npm run worker",
      "requiredEnv": ["SHOP_API_TOKEN"],
      "readiness": { "log": "worker ready", "timeoutMs": 15000 },
      "dependsOn": ["api"],
      "required": false
    },
    "web": {
      "command": "npm run dev --workspace web -- --host 127.0.0.1 --port 5173 --strictPort",
      "url": "http://127.0.0.1:5173",
      "readiness": { "path": "/", "timeoutMs": 60000 },
      "dependsOn": ["api"],
      "shutdown": { "signal": "SIGTERM", "graceMs": 3000 }
    }
  },
  "app": { "service": "web" },
  "startPath": "/",
  "device": "mobile-390",
  "devices": {
    "phone-360": { "extends": "mobile-390", "viewport": { "width": 360, "height": 780 } }
  },
  "settle": { "quietMs": 150, "maxMs": 6000, "backgroundRequests": ["/api/poll"], "timerMaxMs": 1000 },
  "auth": { "file": ".agentlab/auth/state.json", "use": "auto", "loginPath": "/sign-in" },
  "uploads": { "allow": ["test-files"] },
  "scan": {
    "devices": ["mobile-320", "phone-360", "tablet-768"],
    "checks": { "disable": ["content-scroll-x"] },
    "tapTargets": { "standard": "wcag22-aa" },
    "noWrap": [{ "role": "button", "name": "Add to cart" }],
    "explore": { "enabled": false, "maxDepth": 1, "maxStates": 12, "maxActionsPerState": 8, "maxMs": 120000, "deny": [{ "role": "button", "name": "Chat with us" }] },
    "scenarios": [
      {
        "name": "Filters drawer",
        "route": "/products",
        "devices": ["mobile-320", "phone-360"],
        "steps": [{ "do": "click", "role": "button", "nameContains": "Filters", "expect": { "dialog": "Refine your search" } }],
        "cleanup": []
      }
    ],
    "suppressions": [
      { "kind": "tap-target", "target": { "name": "Like" }, "route": "/", "reason": "Icon row is being redesigned (DES-142)", "expires": "2026-12-31" }
    ],
    "policy": { "failOn": "high", "failOnErrors": false, "failOnHeuristic": false }
  },
  "ci": {
    "flows": ["flows/checkout.flow.json"],
    "routes": ["/", "/products"],
    "scenarios": "all",
    "failOn": "high",
    "scenarioErrors": "fail",
    "out": "agentlab-results",
    "trace": "on-failure",
    "evidence": "on-failure",
    "timeoutMs": 1200000,
    "auth": "env"
  }
}
```

## Version 1 and migration

A schemaVersion 1 profile has one `web` section instead of `services`, and still loads (as one service named `web`).

```json
{
  "schemaVersion": 1,
  "name": "invoice-app",
  "web": {
    "command": "npm run dev",
    "cwd": ".",
    "url": "http://127.0.0.1:5199",
    "env": { "PORT": "5199" },
    "readiness": { "path": "/", "status": 200, "timeoutMs": 60000, "intervalMs": 250 },
    "reuseExisting": true
  },
  "startPath": "/",
  "device": "mobile-390"
}
```

`web` takes `command` (required), `url` (required), `cwd`, `env`, `readiness` (`path`, `status`, `timeoutMs`, `intervalMs`) and `reuseExisting`, with the same meanings and defaults as a service. It has no `requiredEnv`, `dependsOn`, `required`, `mode`, `shutdown`, or `log`, `tcp` and `alive` checks. `web` and `services` cannot appear together, and a profile with `services` must say `"schemaVersion": 2`. The top-level keys other than `services` and `app` (`startPath`, `device`, `devices`, `settle`, `auth`, `uploads`, `scan`, `ci`) mean the same in both versions.

`agentlab doctor` warns about a version 1 profile and names the fix:

```bash
agentlab migrate --print     # show the result, write nothing
agentlab migrate --yes       # rewrite as schemaVersion 2; the original is kept as agentlab.json.v1.bak
```

`web` becomes `services.web`, `"app": {"service": "web"}` is added, everything else stays. A second `migrate` says the profile is already current. See [compatibility.md](compatibility.md#versioned-contracts).
