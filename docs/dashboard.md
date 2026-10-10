# Live dashboard

Every session serves a local dashboard on `127.0.0.1`. It shows the device's live viewport, the action timeline, session status and findings, and, for a person with the control link, lets them pause the agent, take over the browser, hand control back, and stop the run.

The CLI daemon, the MCP server and `agentlab run --ui` / `scan --project --ui` each host one. The browser itself has no window unless you pass `--headed`: the dashboard is where you watch.

## Opening it

```bash
agentlab start --project fixtures/invoice-app     # prints "dashboard: http://127.0.0.1:<port>/#token=…"  (view-only)
agentlab ui                                       # the URL with controls; opens it with xdg-open when DISPLAY or WAYLAND_DISPLAY is set
agentlab ui --no-open                             # only print it (headless box); --json for {url, opened}
agentlab run flows/mobile-defect.flow.json --ui   # a flow with the dashboard; waits up to 30 s for a viewer to connect
agentlab start --project fixtures/invoice-app --no-ui   # no dashboard at all (also: agentlab mcp --no-ui)
```

From another machine, forward the port and open the URL locally: `ssh -L <port>:127.0.0.1:<port> <devbox>`.

### View link or control link

There are two links, and they differ in what they may do:

| | view-only link | control link |
| --- | --- | --- |
| Where you get it | the `dashboard.url` in `start` and `status` results (what an agent is given); what `agentlab start` prints | `agentlab ui` |
| Shows the viewport, timeline, status and findings | yes | yes |
| Pause, take over, return, stop, emergency stop; send input | no: the page says "view-only link: controls need the URL from `agentlab ui`", and the server refuses with 401 | yes |

For an MCP server, run `agentlab ui` in the directory the server was started from. The MCP server also prints the control link to its stderr (the client's log) when a session starts. A new session in the same process changes both tokens, so a page left open from the previous session loses access; reload it with the new link.

The token is in the URL's `#fragment`, so it is never sent in a request or a Referer header. Treat the control link like a password for the session.

## What each panel shows

| panel | content |
| --- | --- |
| **Header** | The session state (idle, starting, active, ended, failed), the session id, and whether the page is connected to the event stream. |
| **Status** | Project, device, current URL (origin and path only), counts of console errors, failed requests and findings, and the server: owned or reused, plus startup errors and output. |
| **Supervision bar** | (Control link only.) Who is in control, and the seven supervision buttons. |
| **Viewport** | The centre of the page, with a line above it saying what is on screen ("The agent's page · mobile-390 · 390×844", or "Sweep of /reports · tablet-768 · 768×1024"). It is Chromium's screencast of the emulated screen, including a sideways pan. During a sweep or scan the frame resizes to each width as it is measured, then returns to the agent's page. When a person has taken control, the panel for tapping, typing and keys appears here. A sweep's per-width progress, with thumbnails, sits under it. |
| **Scan** | Progress of a scan, the scenario-by-device matrix, exploration states and skipped controls (with the reason for each), the verdict, and the suppression statuses. |
| **Timeline** | (Left column.) One entry per start, observe, action, sweep, scan, stop and authentication event, with target, outcome, duration, UI changes, notes and any settle timeout. Supervision changes (`control`), what a person did (`human`) and commands that were refused (`refused`) appear here too. A successful action that needed a sideways pan carries a warning banner. |
| **Server output** | The services' output, redacted by pattern. Collapsed by default. |
| **Findings** | (Right column.) Findings as they are recorded, filterable by device, confidence and scenario, optionally grouped by problem. Selecting one shows its severity, measured evidence, reproduction steps and the frame captured when it was recorded (or side-by-side frames for a width comparison or a layout shift). Suppressed findings are listed apart. |

![Dashboard after the seeded-defect flow: the Export CSV tap succeeded but is flagged as needing a sideways pan; F4 is selected with its evidence, reproduction steps and the frame captured before the pan](images/dashboard.png)

What to expect:

- **Closing the tab never stops the run.** Stopping the session closes the dashboard's streams and releases its port, along with the browser and any service the lab started.
- **Refresh.** Refreshing the page restores the status, the recent timeline (the last 200 entries) and all findings.
- **After the session ends.** A page that was open keeps showing the last state and frame. Reloading it then fails, because the process that served it has exited. Run artifacts, including evidence frames in `runs/<session>/frames/`, stay in `.agentlab/`.
- **Frames never reach the agent.** They are not in any command or MCP result.

### Expanding the viewport

Use **Expand view** to give the live screen most of the window, or **Full screen** to hide the browser chrome as well. The same stream continues in either mode, with the device's aspect ratio preserved; opening the larger view does not change the application's viewport or start a second capture. Desktop frames retain their native CSS resolution up to 1920 pixels wide, with higher JPEG quality for clearer text.

The session controls remain available when using a control link. **Exit full screen** returns to the expanded view; **Close view** returns to the timeline and findings and restores keyboard focus. Escape exits full screen first, then closes the expanded view. Browsers that refuse full screen still offer the expanded view. Smaller devices fit the available height without being stretched beyond their native CSS size.

## Supervision workflow

Supervision needs the control link. The state machine, and what the agent is told, are in [architecture.md](architecture.md#supervision).

The supervision bar shows a badge: **Agent in control**, **Pausing after click…**, **Paused**, **Taking over after scan…**, **You have control**, **Stopping after scan…**, or **Stopped**. A button is enabled only when its request makes sense in the current mode; the server decides, and explains a refusal below the buttons.

### Pause and resume

1. Click **Pause after this action**. If the agent is idle the session is **Paused** at once. If a command is running, the badge says **Pausing after &lt;command&gt;…** and becomes **Paused** when it ends. A long command (a scan, a sweep, a flow) stops at its next checkpoint: between scenario runs or widths.
2. Or click **Pause before next action** to let a long command run to the end before pausing. For a single action the two behave the same.
3. While paused, the agent's actions are refused with `session_paused`. `observe`, `inspect`, `tabs` and `bundle` still work. Look around: the viewport stays live.
4. Click **Resume**. The agent continues. If you used the browser window while paused, the agent must `observe` before it acts again (the supervision bar says so).

### Take over

1. Click **Take over** (from Agent in control, Pausing or Paused). If a command is running, the badge says **Taking over after &lt;command&gt;…** and then **You have control**. The agent's `observe` and actions are refused with `human_control`.
2. Use the browser in either of two ways. They are recorded the same way.
   - **In the dashboard.** Click the viewport to tap; scroll the wheel over it to scroll; type into the text box and click **Type** (up to 500 characters at a time), or use the key buttons (Enter, Tab, Shift+Tab, Escape, Backspace, the arrow keys). "Hide what I type on this screen" only masks your text box on the page; it does not change what is recorded.
   - **In the headed browser window.** For a headed session you can use the window directly.
3. Click **Return control to agent**. The agent must `observe` before it acts, and every ref it held is stale.

Dashboard input is accepted only while you have control; at any other time the server refuses it. A tap is mapped from the position on the picture to the page, which assumes the picture keeps the device's aspect ratio.

### Stop

- **Stop run** closes the session once the command in flight finishes. A scan or sweep stops at its next checkpoint, and keeps what it has measured: the scan's verdict is `incomplete`.
- **Emergency stop** closes the browser at once. A command in flight fails with `browser_closed`.

Both buttons ask for confirmation: the first click turns the button into **Confirm stop run** or **Confirm emergency stop**, and a second click within 5 seconds does it. Both stop only the services the lab started (a reused service keeps running). After either, the host process starts no further session: an agent's `start` fails with `session_stopped`. To continue, restart the MCP server or run `agentlab start` again yourself.

`agentlab stop` in a terminal does the same as **Stop run**, also while the session is paused or under your control; it shows on the timeline as a stop by `terminal`.

## What is recorded about a person's actions

While the session is paused or under your control, the page's own events (taps, typing, choices, submits) are reported to the lab as **descriptions**, so the agent's history, findings' reproduction steps and a failure bundle can say what changed.

| recorded | never recorded |
| --- | --- |
| A tap: the control's role and short name | Typed text |
| Typing: the field and how many characters it holds (described when you leave the field, press Enter or Tab, or return control; otherwise after a 700 ms pause) | Even the length, for a password-like field |
| Enter, Escape, Tab, Shift+Tab | Any other key |
| A choice in a select (how many options), a check or uncheck, how many files were chosen | Option labels, file names, file contents |
| A form submit; where the page navigated (path only) | Query strings and fragments |

More than 10 interactions in a second are counted, not listed. The recording goes to the dashboard timeline (`human` entries), `daemon.log`, the session history and a bundle's action log. A replay cannot re-run a person's interaction.

What the dashboard shows of what the *agent* typed: a typed value appears only when the page itself displays it back in the control (a password reads back as `••••`); otherwise only its length (`‹N chars›`). It never shows request bodies, console text, query strings or profile `env`. Secret-looking `key=value` pairs, bearer tokens and URL credentials in server output are masked.

## Limits

| limit | value |
| --- | --- |
| Live viewport frame rate | at most 5 frames per second; a frame is sent only when the screen changes |
| Frame size | at most 1920 px wide, JPEG quality 85; smaller devices remain at their native CSS size |
| When capture runs | only while a viewport viewer is connected and its tab is visible; stops when the last viewer leaves |
| Open event streams | 32 per dashboard; more get 503 |
| Open viewport viewers | 8 per dashboard; more get 503 |
| A slow viewer | skips frames rather than buffering more than 512 KB |
| Feed replay buffer | the last 1000 messages; the snapshot holds the last 200 timeline entries and 200 server output lines |
| Control and input requests | JSON bodies of at most 8 KB |
| Text typed in one request | 1 to 500 characters |
| Scroll in one request | within ±5000 px |
| One session per process | there is no multi-session overview |

Chromium may produce frames more often than the 5 fps delivered, and a minimised headed window may stop producing frames. The viewport is the emulated screen, not a phone.

The 5 fps cap is a resource budget: it limits JPEG encoding, transfer and viewer decoding while keeping the newest changed frame visible. It is suitable for following clicks, forms and navigation, but is not smooth video for judging animations. It does not slow actions down for readability. Higher resolution uses more bandwidth while watching; no live frames are captured without a viewport viewer, and these frames never contribute to agent tokens. Sweeps and scans separately hold each watched state briefly so a person can see it.

The [10 October benchmark](benchmark-2026-10-10-viewport-efficiency.md) compared the old stream, sharp 5 fps and sharp 10 fps on mobile and desktop. Sharp 10 fps roughly doubled animation bandwidth and increased CPU use, without a consistent improvement in ordinary action timing.

## Security notes

- Bound to `127.0.0.1` on an ephemeral port. Another machine cannot reach it, except through a tunnel you set up.
- A token is required on every `/api/*` route (in the `Authorization` header, or `?token=` on image and stream requests), compared in constant time. Without it the answer is 401. Only static page code is served without one.
- `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, and a present `Origin` must match; otherwise 403. There are no CORS headers.
- `POST /api/control` and `/api/input` need the **control** token in an `Authorization: Bearer` header (never a query string), the dashboard's own `Origin`, `Sec-Fetch-Site: same-origin` when sent, and `Content-Type: application/json`. A cross-site page cannot send that header without a CORS preflight, which is never answered.
- The page's CSP is `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, and every string that came from the app is rendered with `textContent`.
- Supervision is cooperative: a process running as the same OS user can read the owner-only files that hold the control link. See [security.md](security.md).

## Cost

The dashboard is cheap while nobody streams. These measurements were taken on 28 September 2026 (before the supervision controls were added): both fixture flows headless on a 2-core Celeron 5205U, with 5 interleaved runs per mode. Values are medians with ranges.

| flow | mode | wall time | time in actions | CPU, process + Chromium | frames / bytes to viewer |
| --- | --- | --- | --- | --- | --- |
| clean | no dashboard | 4381 ms (4244–4651) | 2875 ms (2804–3042) | 2.87 s (2.78–2.98) | — |
| clean | dashboard, no viewer | 4391 ms (4313–4659) | 3037 ms (2822–3072) | 2.90 s (2.84–3.18) | 0 |
| clean | 1 viewer streaming | 4578 ms (4495–4678) | 3049 ms (3001–3143) | 3.34 s (3.12–3.39) | 13 / 185 KB |
| defect | no dashboard | 2461 ms (2299–2539) | 878 ms (762–916) | 2.45 s (2.33–2.59) | — |
| defect | dashboard, no viewer | 2459 ms (2434–2617) | 992 ms (977–1088) | 2.51 s (2.35–2.53) | 0 |
| defect | 1 viewer streaming | 2540 ms (2382–2859) | 1044 ms (889–1226) | 2.54 s (2.19–2.69) | 5 / 47 KB |

Only two differences have non-overlapping ranges:

- **Streaming CPU.** Streaming the clean flow costs about 0.47 s of CPU, roughly +16%.
- **Evidence frames.** Capturing them adds about 115 ms of action time to the defect flow: two viewport screenshots, one on arrival at `/reports` and one before the pan.

The wall-time differences overlap, so no slowdown of the agent's actions is supported by this data.
