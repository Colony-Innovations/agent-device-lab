# Known limitations and roadmap

What Web V1 does not do, or does only partly, collected from every milestone document and the release-candidate runs. Each item says what happens and, where there is one, what to do about it. The roadmap at the end is a direction, not a commitment, and has no dates.

## Platforms, packaging and devices

- **Linux x64 with glibc only.** Debian 12 and Ubuntu 24.04 were tested. Alpine (musl) is not supported: Playwright's Chromium is built for glibc, and `doctor` says so. macOS, Windows and Linux arm64 were not run; macOS paths exist in the code (process identity via `ps`) but are unverified. See [compatibility.md](compatibility.md).
- **Node.js 22 or newer.** 18 and 20 are refused by a gate. 22 and 24 were tested.
- **Chromium emulation, not phones.** The four built-in profiles are Chromium device emulation: not iOS Safari, not Android WebView, no on-screen keyboard, no native permission prompts, and touch events are synthesised by the browser. WebKit and Firefox are not built. Fonts decide wrapping, so a result measured on one machine can differ on another.
- **Single-session processes.** One session per process (daemon, MCP server or in-process run). There is no multi-session overview and no hosted, multi-user mode.

## Supervision and the dashboard

- **Supervision is cooperative, not a sandbox.** The control link is in owner-only files, and an agent with shell access as the same OS user can read them (or kill the process). Supervision stops an agent that uses the lab's commands; it does not contain one that has a shell. See [security.md](security.md).
- **Dashboard tap mapping assumes the frame's aspect ratio.** A tap on the viewport picture is sent as a fraction of the picture's width and height. If the picture is stretched or letterboxed differently from the device's viewport, the tap lands off target.
- **The live viewport is a screencast of the emulated screen.** It is capped at 5 frames per second, 800 px wide and JPEG quality 60. During a sweep or scan it shows the width being measured, each for at least 1.2 s while someone is watching. A minimised headed window may stop producing frames. It is not a phone screen.
- **The dashboard lives as long as the process holding the session.** After the process exits, a page that was open shows the last state, and it cannot be reloaded. A CLI daemon whose `start` fails exits at once, so its startup error reaches only a dashboard that was already open (the CLI prints it either way).
- **Server output on the dashboard is redacted by pattern**, which catches common forms (`KEY=value`, bearer tokens, URL credentials) but not every secret.
- **After a person stops a run, the process starts no further session.** This is intentional; the cost is that an MCP server must be restarted to continue.
- **An agent's `stop` needs agent control.** The MCP `stop` tool is refused while a person has paused or taken over the session. `agentlab stop` from a terminal is not refused, so an agent with a shell as your user can also stop a paused session that way (see [security.md](security.md): supervision is cooperative). Such a stop is recorded as `stopped from the terminal`, not as a person's, because the lab cannot tell who typed it.
- **`agentlab stop` waits behind a long command.** The daemon runs one command at a time, so a stop issued during a long scan takes effect when the scan ends. **Stop run** or **Emergency stop** on the dashboard interrupt it.
- **`agentlab scan` in a session exits 1 for any verdict but `pass`**, `incomplete` included, as `scan --project` does; only `scan --project` uses exit 2 for a scan that could not run.

## Recording a person's actions

- **Human recording is descriptions only and cannot be replayed.** A person's taps, typing and choices are recorded as short descriptions (never typed text). A replay that reaches one is `blocked`.
- **Not everything a person does is recorded.** Only taps, typing (as a character count, described when the person leaves the field, presses Enter or Tab, or hands control back, otherwise after a 700 ms pause; typing flushed at the hand-back is labelled `reported as control returned` because it reaches the history just after the control entry), Enter, Escape, Tab, selects, checks, file choices, form submits and navigations. Other keys, drags and hover are not. More than 10 interactions in a second are counted, not listed.
- **Consequential-step detection is name-based.** A replay (and the bundle's `consequential` mark) treats a step as consequential when its target's name contains words such as delete, pay, send or submit. A step that changes data without such a name (pressing Enter in a form, an upload) is not flagged.

## Failure bundles and replay

- **Expectation and manual bundles compare only the end route and dialog.** The expectation itself is not stored, so replay checks that the recorded end route and open dialog were reached.
- **Replay of sweep-only findings is usually `not-reproduced`.** Replay re-runs the agent's steps (and a scenario, for a scenario bundle); a finding that only a sweep produced does not come back.
- **The log keeps the last 500 actions.** A bundle whose log dropped its first actions cannot be replayed from the start (`blocked`).
- **A value longer than 2000 characters is cut** in the log; replay is `blocked` at that step.
- **Replay needs the live profile to match.** A different `agentlab.json` is only a warning; a renamed control diverges.
- **A bundle holds at most 60 frames**, and bundles are kept 14 days and the newest 20 by default.
- **A trace is included only when the session was started with `--trace`** and the sanitizer could prove it clean. Otherwise it is left out, and the bundle says why.
- **No bundle is written for a scenario that could not run.** Its error is in the CI result and JUnit.

## CI mode

- **A timeout or a cancel loses a scan's partial findings.** A scan that is cut short by `--timeout` or a signal contributes no findings; completed flows and sweep routes are kept in the partial result.
- **Only sweep and scan findings count toward the CI policy.** Findings raised by a flow's own steps are in that flow's bundle, not in the policy.
- **Redaction is by literal value.** A secret the app transforms (hashes, splits, re-encodes) before showing it cannot be recognised. Evidence frames and trace screenshots are pictures of what the page showed and can show anything, including a secret the page renders. Keep secrets out of test data.
- **A scan passes when scenario runs failed**, unless `failOnErrors` is on. CI mode fails such runs by default (`--scenario-errors fail`).
- **Provider integration is one example.** [examples/ci/github-actions.yml](../examples/ci/github-actions.yml) is the only wiring; the commands are provider-neutral.

## Services and lifecycle

- **Services killed by SIGKILL while still starting are not recorded for reaping.** Ownership is recorded once the services are up, so a session that is SIGKILLed while a service is starting leaves it running with no record. Stop it by hand.
- **Reuse is detected only for services with an HTTP or TCP readiness check.** `log` and `alive` services are always started.
- **When the daemon is killed, services whose output it was reading may exit with it** (their pipe closes), so crash recovery reports them as already exited.
- **A one-shot service is stopped with its declared command on a normal close, but crash recovery only prints that command**, because it cannot prove the containers are the ones it started.
- **Only recorded group members are stopped when the group's leader is gone.** The lab snapshots the identity of every process in a service's process group when the service becomes ready (and again when it records ownership, when another service exits, and before it stops one while the leader is alive). If the leader (usually the `sh -c` wrapper) dies first, it stops those recorded members one by one, each after an identity check. A process that joined the group after the last snapshot (a worker forked later) is named with its pid and command, never signalled: the lab prefers a leaked process to killing one it cannot prove it owns. A crash of the lab itself cannot refresh the snapshot. Linux scans `/proc`; elsewhere `ps` is used, unverified.
- **Findings beyond 2000 per session are counted, not stored.** `inspect` reports how many more were not recorded; a finding past the cap cannot be inspected. Earlier findings are never dropped, and a known finding still updates.
- **Output is capped.** A service log stops at 20 MB, and the daemon's echo at 5 MB.

## Settling

- **A page meant to be blank but with scripts waits until `settle.maxMs`.** The `empty` rule holds a document that has scripts but has drawn nothing; a deliberately blank page with a script times out with cause `empty`.
- **A long-poll that re-arms itself during an action is awaited until `maxMs`**, unless it is in `settle.backgroundRequests`. The lab does not guess which slow requests are background.
- **A page that never stops mutating the DOM, such as a clock, always reports a timeout with cause `dom`.**
- **Timer tracking is heuristic.** It wraps `window.setTimeout` in the page, which a page could notice. A promise-based sleep loop with delays under `timerMaxMs` holds settling to `maxMs` (cause `timers`); lower `timerMaxMs` or set it to 0.

## Actions and observation

- **`select` works only on native `<select>`.** A custom list box is opened and chosen with clicks.
- **`drag` is a mouse drag** even on touch profiles; touch drag gestures are not emulated. `hover` works but notes that touch devices cannot hover.
- **No `screenshot` action, no free-text `type` action** (use `fill` or `press`), and **no file download handling.**
- **Accessible names are approximated in the page.** This is not the full accname algorithm, and it does not look inside shadow DOM or iframes.
- **Refs.** After a re-render, the diff pairs controls by exact role and name, so two controls with identical names that swap places are not told apart (findings are deduplicated the same way). Repeated labels get a `context` from a heading or a short preceding label; cards with neither still produce indistinguishable duplicates.
- **MCP payload.** Claude Code gives the model `structuredContent`, not the concise text, so the text rendering helps only clients that read `content`.
- **Evidence is full-viewport frames**, not cropped images.
- **`init` detection is heuristic and reads files only.** It cannot know ports set at runtime, or which `.env.example` names are truly required.

## Sweeps, scans and findings

- **A sweep measures a route as loaded.** It does not open menus, drawers or dialogs (a scan does, for declared states), has no contrast check, reach-checks at most 40 controls per width and observes at most 60. Each state in a scan measures up to 2,500 elements and 40 items per detector; the rest are counted, not silently dropped.
- **Exploration is deliberately narrow.** A control with no ARIA state attributes is skipped as ambiguous unless allow-listed; name heuristics are English-only; clicking is the only activation (hover menus and swipe-to-reveal are not explored); depth-2 states that need text input are not reached.
- **The exploration request guard sees network requests only.** State changed purely in the page (an in-memory store, `localStorage`) by a mislabelled control is not blocked. The context is discarded afterwards, but an app that syncs later could send it.
- **Restoring compares signatures, not pixels.** A state that differs only in scroll position or typed values counts as restored.
- **Cleanup is best effort.** The lab isolates browser state, not the backend: scenarios that create server data should declare cleanup steps or run against disposable data.
- **Layout-shift scores depend on the viewport**, as the metric does.
- **`content-scroll-x` and `outside-container` are geometry heuristics** and never fail the default policy.
- **Wrapping alone is never a defect.** `text-wrap-change` is heuristic unless it clips, overlaps, hides a label, grows the control excessively or breaks a declared `noWrap`.
- **Cost.** Each scenario × device opens a fresh context and reloads the route; on a dev server that loads modules per context (Vite), that is most of the time.
- **Findings that need a human look.** Some release-candidate findings were not confirmed visually (for example `text-truncated` on product titles that may be an intentional line clamp). A confirmed finding rests on a measurement; whether it matters is a judgement.

## Measurement and benchmarks

- **Benchmark scope.** The benchmark against Playwright MCP has two fixture tasks designed alongside the lab, plus two tasks on one independent app, 3 runs each, one model, one machine. The fixture and the lab were designed together. Differences are called supported only when ranges do not overlap. See [benchmark.md](benchmark.md) and [independent-app.md](independent-app.md).

## Roadmap after Web V1

The order below is the intended direction after Web V1, not a schedule.

### Native targets

1. **Android first.** A native adapter behind the same command table, so that the CLI, MCP and dashboard work unchanged: launch an app on an emulator or device, observe controls with refs, act, and see what changed. The supervision model (pause, takeover, stop) carries over.
2. **iOS after Android.**

The command table, the contract versions and the dashboard's event feed are the seams an adapter plugs into ([architecture.md](architecture.md)). The Web V1 findings model (confirmed only when a measurement shows a person is affected) is meant to carry over.

### Web items

- Cropped evidence images, and a `screenshot` action.
- A text-only MCP result mode, or a slimmer structured payload, then measure it.
- A larger benchmark: more independent applications, more runs per cell, more than one model.
- Interaction coverage: touch drag, custom list boxes, downloads, shadow DOM and iframes in accessible names.
- Exploration beyond clicks: hover and swipe-to-reveal; depth-2 states that need input.
- Replay that can carry a person's actions (as steps a person approves), and expectations stored in bundles.
- Keeping a scan's partial findings when a CI run times out or is cancelled.
- Publishing the package to npm, and wiring examples for more CI providers.
- More platforms: macOS, Windows and Linux arm64 verification.
