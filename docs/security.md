# Security

What Agent Device Lab protects, from whom, how, and where the protection stops. This page describes Web V1 (0.3.x). It is written to be checked: each control names the code or test that holds it.

## What it is, and what it is not

Agent Device Lab is a **local developer tool**. It runs on your machine, as you. It starts the commands your `agentlab.json` declares, drives a browser against your app, and serves a dashboard on the loopback interface. It is not a sandbox, not a multi-user service, and not a security scanner.

### Threat model

| concern | in scope | what the lab does |
| --- | --- | --- |
| Another machine on the network reaching the dashboard | yes | The dashboard binds to `127.0.0.1` only. |
| Another local user, or a web page in your browser, reaching the dashboard or the daemon | yes | Per-session tokens, exact Host and Origin checks, an owner-only daemon socket, owner-only state files. |
| A hostile page under test trying to attack the dashboard, the lab or you | yes | The dashboard renders app text with `textContent` under a strict CSP. Page data is treated as untrusted and bounded. Data a page passes to the lab's bindings is reduced to a fixed shape. |
| An agent doing more than the person intended | yes | Agents get only the commands in the command table. They cannot read secrets from results, cannot control the dashboard, and are refused while a person has paused, taken over or stopped the session. See the limit below. |
| The lab harming processes it did not start | yes | Identity-checked, owned-only process control. |
| Secrets leaking into logs, reports, bundles, CI artifacts or traces | yes | Masking, one redaction set, a fail-closed leak check, a trace sanitizer. Limits are listed below. |
| A malicious `agentlab.json` | no | The file declares commands that run with your privileges. Committing it is how a developer approves them. Review a change to it like a change to code, in CI as well. |
| A malicious application server, or a service you start | no | They run as you. The lab does not isolate them. |
| Another process running as your OS user | no | It can read everything you can. |

### The honest limit of supervision

Supervision (pause, takeover, stop) is **cooperative, not a sandbox**. The control link lives in owner-only files (`daemon.json`, `mcp-dashboard.json`, mode 0600) and in the MCP server's stderr. An agent that has shell access as the same OS user can read those files and use the control link, or kill the process. What supervision gives you is that an agent that *uses the lab's commands* cannot get past a pause, a takeover or a stop, cannot see the control link in any result, and says plainly when it was refused. If you need to contain an agent that has a shell, run it as a different user or in a container.

## Controls

### The local dashboard

| control | detail | held by |
| --- | --- | --- |
| Loopback only | `listen(port, '127.0.0.1')` on an ephemeral port | `dashboard.test.mjs` |
| Tokens | Two random 24-byte tokens per session, compared in constant time. The **view** token reads; only the **control** token may POST. Both are in the URL's `#fragment`, so they are never sent in a request or a Referer. They change when a new session starts in the same process. | `dashboard.test.mjs`, `dashboard-control.test.mjs` |
| `/api/*` needs a token | `Authorization: Bearer`, or `?token=` for image and stream requests. Static page code alone is served without one. | `dashboard.test.mjs` |
| Host and Origin | `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, and a present `Origin` must match; otherwise 403. This stops DNS rebinding and cross-site requests. No CORS headers are sent. | `dashboard.test.mjs` |
| POST rules | Only `/api/control` and `/api/input`. Control token in an `Authorization` header only (never a query string), exact `Origin`, `Sec-Fetch-Site: same-origin` when sent, `application/json`, bodies of at most 8 KB. | `dashboard-control.test.mjs` |
| CSP and headers | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`; `X-Frame-Options: DENY`; `Referrer-Policy: no-referrer`; `X-Content-Type-Options: nosniff`; `Cache-Control: no-store` | `src/dashboard/server.ts`; the CSP is also checked in `dashboard.test.mjs` |
| Only recorded files | `/api/frames/...` serves only files the feed recorded (evidence, sweep and scan frames in the run directory). | `feed.test.mjs` |
| Bounded | At most 32 event streams and 8 viewport viewers; frames capped at 5 per second and 390 px; capture only while a viewer is connected. | `dashboard-control.test.mjs` (stream caps), `dashboard.test.mjs` (capture), `dashboard-e2e.test.mjs` (frame rate) |
| No new engine | The page shows only what `SessionFeed` derives from `LabEvent`s. | `feed.test.mjs` |

### Agent and person capabilities

| | agent (CLI, MCP, flows) | person with the control link |
| --- | --- | --- |
| Observe the page and act in it | yes, through the command table, while it has control | only while they hold the browser |
| Evaluate arbitrary script in the page | no: not a command | no |
| Read a saved sign-in state, the control link or typed passwords | no: they never appear in results | the link is theirs; passwords typed in the page are not recorded |
| Pause, take over, stop, send input | no | yes |
| Get refused with an explanation | yes: `session_paused`, `human_control`, `observation_required`, `session_stopped` | |
| Start a new session after a person stopped the run | no: `session_stopped` | by restarting the process |

Details of the refusals: [architecture.md](architecture.md#supervision), [mcp.md](mcp.md#errors).

### Process safety

| control | detail | held by |
| --- | --- | --- |
| Identity before signal | Every process the lab may signal is recorded with its PID, kernel start time and boot id. Nothing is signalled unless the current process with that PID has the same identity (`checkIdentity(...) === 'same'`). A reused PID, a missing identity, or a group leader that has exited while its children remain is never signalled; the lab names it for manual cleanup. | `process-identity.test.mjs` |
| Owned only | A service the lab found already running is *reused*: it is never signalled, never stopped. A port answering with the wrong status is `port_conflict`, never "start a second copy" or "stop the other". | `services.test.mjs` |
| Process groups | Services run in their own process group. Stop sends the declared signal to the group, waits for it to empty, and sends SIGKILL only after `graceMs`. | `services.test.mjs` |
| Orphan reaping | Ownership records name what each session started. A later start, `stop` or `clean` stops orphans only when the record's owner is gone or reused *and* the service identity is `same`. A live owner's record is never touched. A one-shot service's stop command is printed, not run. | `hardening.test.mjs` |
| Ambiguity | An ambiguous target is `ambiguous_target`; the lab never guesses. | `e2e.test.mjs`, `mcp-actions.test.mjs` |
| Signals | In-process commands close their session on SIGINT, SIGTERM and SIGHUP; a second signal exits at once and says what may remain. | `hardening.test.mjs` |

### Secrets

**Passwords and similar fields.** A value typed into a password field, a one-time-code or card-number field (input type `password`, or `autocomplete` of `password`, `one-time-code`, `cc-number` or `cc-csc`), and keys pressed while one has focus, appear as `‹secret›` in history, logs, reproduction steps and the dashboard. The observation shows the field's value as `••••`. When the lab cannot inspect the field (an action failed first), a name containing `pass`, `secret`, `token`, `otp`, `pin`, `cvv` or `cvc` is treated the same. A flow step's printed label never includes a `fill` value, for any field, because it is printed before the lab can see the field's type; the action line that follows shows the value only when the field is not password-like. What a person types is never recorded (see [dashboard.md](dashboard.md#what-is-recorded-about-a-persons-actions)).

**Saved sign-in state.** `agentlab auth save` stores cookies and `localStorage` so later sessions start signed in. Only `src/core/auth.ts` reads or writes the file.

- It is written mode 0600 in a 0700 directory, atomically, and only when git would ignore it (otherwise `auth_not_ignored`). `agentlab init` adds `.agentlab/` to `.gitignore`.
- Its contents never appear in results, events, logs or MCP output. Callers see counts and the path.
- A file readable by other users is refused and kept (`auth_invalid`); an unreadable or fully expired one is removed; one the browser rejects, or that lands on `auth.loginPath`, is removed and the start fails with `auth_invalid`.
- `agentlab auth status` shows its mode, counts, expiry and whether git ignores it; `agentlab auth clear` removes it.

**`AGENTLAB_AUTH_STATE`.** For CI, a Playwright storage state (JSON or base64 JSON) in an environment variable. It is checked like a saved one (shape, expiry), held in memory, never written to disk, and never removes the project's saved file when the app rejects it. Results say only `sign-in: saved-state`. Store it as a CI secret.

**The redaction set.** Bundles, a flow's `flow-result.json`, and every CI output (text, JSON, HTML, JUnit, printed output, error messages, log tails) are redacted with one set of literal values: the values of every `requiredEnv` variable and of secret-named environment variables (names matching secret, token, password, key, auth, cookie and similar), long declared service `env` values, the cookie and storage values of the sign-in state, and everything typed into password-like fields. Each is replaced by `‹redacted›`, URL-encoded and JSON-escaped forms included. Then the output is checked once more: if a known value would remain, **nothing is written** (`bundle_unsafe`, or exit 2 in CI), and the message names no value.

**Other masking.** Dashboard and log text is masked by pattern: `key=value` secrets, bearer and basic tokens, and URL credentials. Page URLs are shown as origin and path only. `migrate` masks secret-looking `env` values in what it shows. A JSON parser's own error message, which can quote the file, is never echoed by `migrate` or CI validation.

**The trace sanitizer.** A Playwright trace records far more than a person expects: sign-in state, request bodies, headers, input values, and screenshots. Before a trace is put in a bundle or a CI artifact it goes through `src/core/trace-sanitize.ts`, which is fail-closed:

- Removed or masked: the context's stored sign-in state, HTTP credentials and client certificates; request and response bodies (response bodies are kept only for documents, stylesheets, scripts, images, fonts and media); sensitive headers (authorization, cookie, set-cookie, API-key and CSRF headers, and any header whose name looks secret); typed text and `fill` values; the `value` of every input in DOM snapshots; sensitive query parameters; and the expressions, arguments and results of code evaluated in the page, masked wholesale.
- Every known secret (the caller's, plus values learned while sanitizing) is then searched for in raw, JSON-escaped, URL-encoded, HTML-escaped and base64 forms across every entry. A residual is an error.
- An entry the sanitizer does not know is an error, and the trace is dropped; the result says so (`traceDropped`). The zip reader is strict about structure (no zip64, encryption, duplicate or unsafe names, overlapping entries, bad CRCs, oversized archives).
- **Limits:** screenshots are kept: they show what the page showed, so keep secrets out of test data the app renders (password fields render as dots). Console text and page-owned DOM text are covered only by the known-secret pass. Keys pressed one at a time are masked only when they are a single character. Redaction is by literal value: a secret the app transforms (hashes, splits, re-encodes) before showing it cannot be recognised.

**Evidence frames** are screenshots too, with the same limit. In CI they are copied only per `--evidence` (default: on failure).

### Files and uploads

| control | detail | held by |
| --- | --- | --- |
| `uploads.allow` | `upload` reads only files that resolve, after following symlinks (realpath), inside the profile's `uploads.allow` entries. Nothing is allowed by default. The check is the same for an agent's upload and for a replay (both go through `act()`). | `actions.test.mjs` |
| Owner-only state | State, run and ownership directories are created 0700 and files 0600 even under `umask 002`. The daemon socket is 0600. `daemon.json` (it holds the dashboard control link) is 0600. | `hardening.test.mjs` |
| Bundles and CI artifacts | Directories 0700, files 0600. Frames are copied only from the run directory (realpath-checked). agentlab never uploads a bundle. | `bundle.test.mjs`, `ci.test.mjs` |
| `init` and `doctor` | Read-only until you confirm: no project commands, no `.env` values, no directories created. | `init.test.mjs`, `doctor.test.mjs` |
| Network | The only requests agentlab itself makes are readiness probes to the URLs your profile declares, and the daemon's unix socket. (`install-browser` downloads through Playwright's own CLI.) | |

### Input validation and bounds

| input | bound |
| --- | --- |
| Command and tool arguments | Validated against a flat schema; unknown argument, wrong type, enum and range errors are `invalid_request`. Strings are at most 4096 characters and lists at most 100 items unless the command sets its own limit. |
| `agentlab.json` | Strict keys, types and ranges; every problem reported at once; a newer `schemaVersion` is refused untouched. |
| A failure bundle | Untrusted: its shape and every field replay uses are validated; a newer version is refused. Replay takes nothing that runs from it. |
| A trace zip | A strict reader with limits (at most 20,000 entries, 1 GiB in total). |
| Dashboard input | Control bodies at most 8 KB; typed text 1 to 500 characters; scroll within ±5000 px; keys from a fixed list; taps 0 to 1 in each axis; at most 10 recorded interactions a second. |
| Page-supplied data | The in-page recorder's reports and the click-verification binding are reduced to the expected shape, and every string is clipped. |

### Retention and growth caps

| what | cap |
| --- | --- |
| Each service log | 20 MB (`AGENTLAB_SERVICE_LOG_MAX_BYTES`), one note when it is reached |
| Server output echoed into `daemon.log` | 5 MB (`AGENTLAB_DAEMON_ECHO_MAX_BYTES`) |
| Session history | the first step and the latest 200 |
| Console errors and failed requests | the latest 500 each (the counters stay exact) |
| Findings | 2000 per session; later ones are counted |
| Action log | the last 500 actions; the last 10 observations |
| Runs | the newest 20 (`AGENTLAB_KEEP_RUNS`); never one a live session owns |
| Bundles | the newest 20 and at most 14 days (`AGENTLAB_KEEP_BUNDLES`, `AGENTLAB_BUNDLE_DAYS`); at most 60 frames each |
| CI evidence frames | 200 per run |

### Dependencies

`npm audit` reported **0 vulnerabilities** on 2026-09-30, for production and development dependencies. The package has two runtime dependencies, both pinned to an exact version: `playwright` 1.63.0 and `@modelcontextprotocol/sdk` 1.30.1. The package ships only `bin/`, the compiled `dist/**/*.js`, the dashboard assets and the README. See [compatibility.md](compatibility.md#playwright-upgrade-strategy) for how a Playwright upgrade is handled.

## Operating it safely

- Review changes to `agentlab.json` like code. It decides which commands run.
- Export secrets in the environment and name them in `requiredEnv`; do not write them in `env`. `doctor` warns when a secret-looking name has a literal value.
- Keep `.agentlab/` out of git (`init` does this). Do not attach `.agentlab/` runs, saved sign-in state or the raw output of a failing CI job to a public issue. Use a failure bundle: it is built to leave the machine.
- Share the **view-only** dashboard link freely on your machine; treat the **control** link like a password.
- Keep test data free of real secrets: screenshots can show anything the page renders.
- In CI, give the run a test account, store `AGENTLAB_AUTH_STATE` as a secret, and publish `agentlab-results/` (it is redacted and leak-checked), not the runner's workspace.

## Tokens in URLs

A page URL can carry a secret: a sign-in token in the fragment (`#access_token=…`), an API key in the query. The lab replaces the value of any query or fragment parameter whose name looks secret (any name containing `token`, `secret`, `password`, `api_key`, `signature`, `jwt`, `credential`, `bearer` or `session`, in any style such as `accessToken` or `X-Amz-Signature`; and `sig`, `auth`, `otp`, `pin`, `pass` or `sid` as a whole word or part) with `‹redacted›` before a route or URL is output, so it does not reach observations, results, events, logs, reports or bundles. The same replacement is applied to every error message and hint (a failed navigation quotes the URL), to a URL nested percent-encoded inside a parameter, and to a `user:password@` part of a URL. The browser keeps the real URL, and a sweep of the current route still opens it. A one-time `code` parameter is not redacted, because many apps use that name for ordinary values. A replay of a bundle whose route carried a token therefore opens the route without it.

## Reporting a security issue

Please report a suspected vulnerability privately to the maintainers, and not in a public issue. Include the output of `agentlab version`, the steps to reproduce, and what you expected. Do not attach `.agentlab/` runs, saved sign-in state or raw traces; if a bundle is relevant, attach a failure bundle, which is built to be shareable (a bundle that still held a secret fails with `bundle_unsafe` and is itself a bug to report).

Maintainer contact: [kwaleyelamusil@gmail.com](mailto:kwaleyelamusil@gmail.com) (Colony Innovations). Please put "agentlab security" in the subject.
