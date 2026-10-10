# CI mode

`agentlab test`, `sweep --project`, `scenario --project` and `report` run the lab without a person: they start the project, run what was selected, stop only what the lab started, write artifacts and exit with a code a pipeline can gate on. Nothing here is specific to a CI provider. [examples/ci/github-actions.yml](../examples/ci/github-actions.yml) is one wiring of it.

## Installing agentlab in a pipeline

Pin one exact version:

```bash
npm install --no-save --no-fund --no-audit agent-device-lab@0.4.0
npx agentlab install-browser --with-deps
```

Never `latest`, a range, or a dist-tag such as `next`: the profile, result and report contracts are versioned (see [compatibility.md](compatibility.md)), and a pipeline should change version only in a reviewed commit. If the project already lists `agent-device-lab` as an exact dev dependency, `npm ci` installs it and the first line is not needed.

A pipeline that may not reach the npm registry can instead commit a reviewed tarball (`npm pack` output), pin its SHA-256 next to it, and refuse anything else:

```bash
echo "$AGENTLAB_SHA256  vendor/agent-device-lab-0.4.0.tgz" | sha256sum --check --strict -
npm install --no-save --no-fund --no-audit ./vendor/agent-device-lab-0.4.0.tgz
```

## Commands

```bash
agentlab test [--project <dir>]                      # everything the profile's "ci" section selects
agentlab sweep --project <dir> [/route ...]          # responsive sweep of routes (without --project: the running session)
agentlab scenario --project <dir> [name ...]         # scan of declared scenarios (without --project: `scan` in the running session)
agentlab report <out-dir|ci-result.json> [--format text|json|html|junit] [--out <file>]
agentlab test --validate-only                        # check everything, start nothing
```

`scan --project` keeps working as before (its own report and exit codes). The CI commands add a result document, JUnit, redaction and the limits below.

### Flags

Flags override the profile's `ci` section, which overrides the defaults.

| flag | default | meaning |
| --- | --- | --- |
| `--devices a,b` | the scenario's own; `scan.devices` for sweeps | Device ids for sweeps and the scan. |
| `--flows a.json,b.json` | `ci.flows` | Flow files, relative to the profile. `test` only. |
| `--routes /a,/b` | `ci.routes` | Routes to sweep. |
| `--scenarios A,B` | `ci.scenarios`, else all declared | Scenario names. |
| `--fail-on high\|medium\|low\|none` | `ci.failOn`, else `scan.policy.failOn` (high) | Lowest severity of a confirmed finding that fails the run. |
| `--fail-on-heuristic` | `ci.failOnHeuristic`, else `scan.policy.failOnHeuristic` | Heuristic findings also count. |
| `--scenario-errors fail\|report` | `fail` | A scenario run (or sweep width) that could not complete fails the run, or is only listed as a reason. |
| `--out <dir>` | `ci.out`, else `./agentlab-results` | Artifacts directory (created 0700, files 0600). |
| `--format text,json,html,junit` | all | Files to write. `ci-result.json` is always written; the text report is always printed. |
| `--trace off\|on-failure\|always` | `off` | Record a sanitized Playwright trace. |
| `--evidence off\|on-failure\|always` | `on-failure` | Copy evidence frames into the artifacts. |
| `--timeout 90s\|15m\|2h` | `ci.timeoutMs`, else 30m | Whole-run limit. |
| `--auth fresh\|saved\|env` | `env` when `AGENTLAB_AUTH_STATE` is set, else `fresh` | Where the sign-in state comes from. |
| `--validate-only` | | Print the checks and stop: exit 0 valid, 2 not. |
| `--headed` | headless | For debugging on a machine with a display. |
| `--json` | | Print the result JSON (not the text report) on stdout. Progress goes to stderr. |

What each command selects:

- `test`: flows, routes and scenarios from flags or `ci`. When the profile declares scenarios and nothing else is said, all of them run. When nothing at all is selected, the profile's `startPath` is swept.
- `sweep`: only routes (positionals, `--routes`, `ci.routes`, else the `startPath`).
- `scenario`: only scenarios (positionals, `--scenarios`, `ci.scenarios`, else all declared).

## The `ci` profile section

Strictly parsed like the other sections: an unknown key or a bad value is a problem that stops the run with exit 2.

```json
{
  "ci": {
    "flows": ["flows/checkout.flow.json"],
    "routes": ["/", "/pricing"],
    "scenarios": ["Filters drawer", "Checkout"],
    "devices": ["mobile-320", "mobile-390"],
    "failOn": "high",
    "failOnHeuristic": false,
    "scenarioErrors": "fail",
    "out": "agentlab-results",
    "trace": "on-failure",
    "evidence": "on-failure",
    "timeoutMs": 1200000,
    "auth": "env"
  }
}
```

`scenarios` is a list of names or `"all"`. Sweeps and scenarios use the same suppressions (`scan.suppressions`), so an accepted finding is accepted everywhere.

## What runs

1. **Validate** (exit 2 with every problem listed): the profile loads (strict keys, versions); Chromium is installed; every service's `requiredEnv` is set (names are printed, never values); selected flows exist and parse; selected scenarios and devices exist; `--auth saved` has a usable saved state; `--auth env` has a parseable `AGENTLAB_AUTH_STATE`. `--validate-only` stops here.
2. **Flows**, each in its own session, sequentially. A flow that cannot start (a service failed, a bad sign-in state) is "could not run", exit 2.
3. **One session** for the sweeps (each route at each device width) and the scan. Every width and scenario runs in an isolated browser context, as in `scan`.
4. **Decide.** The run fails when:
   - any flow failed;
   - an unsuppressed confirmed finding is at or above `--fail-on` (any confidence with `--fail-on-heuristic`);
   - a scenario run or sweep width could not complete and `--scenario-errors` is `fail`.

   The reasons say what was not counted and why: heuristics, findings below the threshold, suppressed findings. Suppressed findings stay in the result and the report.

## Exit codes

| code | meaning |
| --- | --- |
| 0 | pass |
| 1 | policy failed |
| 2 | could not run: invalid profile or flags, missing environment variable or browser, unknown selection, start failure, or an output that would have leaked a secret |
| 3 | timed out; the partial result is written with verdict `error` and the reason `timed out after …` |
| 130, 143, 129 | cancelled by SIGINT, SIGTERM, SIGHUP; the lab closes, owned services stop, a partial result marked `cancelled` is written. A second signal exits at once with 1 |

## Artifacts

```
agentlab-results/
  ci-result.json     the result: schema "agentlab.ci-result", selections, flows, sweeps, scan summary, findings, groups, suppressions, verdict
  summary.txt        the concise report that is also printed
  report.html        self-contained: verdict, selections, flows, sweeps, scenario matrix, grouped findings with evidence, suppressions
  junit.xml          suites agentlab.flows, agentlab.sweeps, agentlab.scenarios (+ agentlab.run when the run ended in error)
  scan/              the scan's own report.html and result.json (with its frames)
  frames/            evidence frames referenced by the findings (see --evidence)
  bundles/<id>/      a failure bundle per failing flow, and one for the policy-failing findings of the sweeps and scan
  traces/            sanitized traces of passing sessions with --trace always
```

JUnit has one test case per flow, per route and device, and per scenario and device. A case fails when it has a policy-failing finding (or a flow failed) and errors when it could not run (a skipped case with `--scenario-errors report`).

`agentlab report <dir>` re-renders any format from `ci-result.json` without a browser. The result carries `schema` and `version`; a newer version is refused with a message.

## Sign-in state and secrets

- `AGENTLAB_AUTH_STATE` holds a Playwright storage state (what `agentlab auth save` writes) as JSON or base64 JSON. It is checked like a saved one (shape, expiry), kept in memory, never written to disk, and never removes the project's saved state file when the app rejects it. Results say only `sign-in: saved-state`. A flow that declares `"auth": "fresh"` keeps signing in itself.
- The redaction set is: the values of every `requiredEnv` variable and of secret-named environment variables (token, secret, password, key, auth, cookie…), long declared service values, the cookie and storage values of the sign-in state, and everything typed into password-like fields. Every output (text, JSON, HTML, JUnit, printed output, error messages, log tails) has those replaced by `‹redacted›`, then is checked once more. If a value would remain, nothing is written and the exit code is 2; the message names no value.
- Request bodies and headers are never collected. Traces are sanitized (`--trace`); one that cannot be proved clean is dropped and the result says so.
- Evidence frames are screenshots. They show what the page showed, so keep secrets out of test data the app renders. Frames are copied only per `--evidence`.

## Traces and evidence

- `--trace on-failure`: sessions record a trace; a failing flow or the failing findings' bundle carries it (`bundles/<id>/trace.zip`). `always` also saves a trace for passing sessions under `traces/`. Traces cost time and disk; leave them off for the gate and turn them on to diagnose.
- `--evidence on-failure` copies frames only when the run is not a pass; `always` also on pass; `off` never (the frame paths are then dropped from the result).

## Timeouts and cancellation

The run has a wall-clock limit (`--timeout`, default 30m). On expiry, or on SIGINT/SIGTERM/SIGHUP, the lab closes its browser and stops the services it started (never one it reused), writes a partial `ci-result.json` (verdict `error`; `timedOut` or `cancelled` set), and exits 3, or 130/143/129. A scan cut short loses its own partial data; completed flows and sweeps are kept.

## Other pipelines

GitLab CI or any shell:

```yaml
agentlab:
  image: mcr.microsoft.com/playwright:v1.63.0-noble   # or install with `npx agentlab install-browser --with-deps`
  script:
    - npm ci
    - npx agentlab test --out agentlab-results   # exit 1/2/3 fails the job
  artifacts:
    when: always
    paths: [agentlab-results/]
    reports:
      junit: agentlab-results/junit.xml
```

```bash
set -e
npx agentlab test --validate-only
npx agentlab test --out results || code=$?
npx agentlab report results --format text --out results/summary-copy.txt
exit "${code:-0}"
```

## What never goes into artifacts

Environment values, request bodies, headers, the sign-in state, typed passwords (including keys pressed into them), service environment values in bundled profiles, and any value of the redaction set. Page text is untrusted: HTML output escapes every string that came from the app.

## Limits

- A scan that is cut short by a timeout or a signal contributes no findings; only completed flows and sweep routes do.
- Only the findings of the sweeps and the scan count; findings raised by a flow's own steps are in the flow's bundle.
- No failure bundle is written for a scenario that could not run (its error is in the result and JUnit).
- Redaction is by literal value. A secret the app transforms (hashes, splits, re-encodes) before showing it cannot be recognised.
