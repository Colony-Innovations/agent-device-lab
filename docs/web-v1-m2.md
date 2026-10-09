# Web V1, milestone 2: stateful responsive scans

Milestone 1 made the lab installable and able to start real projects. Its responsive sweep still measured routes **as loaded**. The one real responsive defect on the independent app, a wrapped button inside the Talk to a Brother Filters drawer, was in a state the sweep never opened ([independent-app.md](independent-app.md#responsive-sweep-on-the-app)).

This milestone adds:

- **Stateful scenarios.** A project declares UI states: a route, setup steps, devices, checks and cleanup.
- **Safe exploration.** Optional and bounded, it covers states the page itself marks as openable.
- **An expanded detector engine.** The sweep and the scan share one engine, `checks.ts`.
- **Findings with confidence, deduplication and grouping.**
- **Dashboard views** for scans.
- **HTML and JSON reports**, with a CI-style result policy and documented suppressions.

It does not build:

- pause or human takeover;
- CI provider integration;
- native adapters;
- multi-user hosting;
- npm publication.

## Commands

```bash
agentlab scan                                   # in the running session: every declared scenario
agentlab scan /route                            # one route as loaded (no declared scenarios needed)
agentlab scan --scenario "Filters drawer,Checkout" --devices mobile-320,mobile-390
agentlab scan --explore                         # also explore safe state-opening controls
agentlab scan --project <dir> [--headed] [--auth auto|saved|fresh] [--ui]   # standalone: start, scan, stop
```

- **Daemon mode.** `agentlab scan` without `--project` runs in the session daemon of the current directory. It exits 1 when the policy fails.
- **Standalone mode.** `agentlab scan --project` starts the project headless, scans it and stops only what it started. It exits with:
  - `0` when the policy passes;
  - `1` when the policy fails;
  - `2` when the scan could not run (an invalid profile, a start failure, an unknown scenario).

  `--ui` serves the live dashboard while it runs.
- **MCP and JSON output.** The MCP tool `scan` takes the same arguments (`scenarios`, `route`, `devices`, `explore`). It returns a compact summary: the verdict, each run's outcome, problem groups with finding ids, and the report paths. Frames never go into it; `inspect {id}` gives one finding in full. `--json` prints the same summary.
- **Where results go.** Everything is written to `runs/<session>/scans/R<n>/`: `result.json` (the full result), `report.html`, and `frames/<n>-<scenario>/<device>/*.jpg`.

## Configuration

Everything lives in the profile's optional `scan` section, and every field has a default. A profile without `scan` scans its `startPath` as loaded.

```json
{
  "scan": {
    "devices": ["mobile-320", "mobile-390", "tablet-768", "desktop-1440"],
    "checks": { "disable": ["content-scroll-x"] },
    "tapTargets": { "standard": "wcag22-aa" },
    "noWrap": [{ "role": "button", "name": "Show * results" }],
    "wrapNearbyRatio": 1.35,
    "layoutShiftMin": 0.05,
    "explore": {
      "enabled": false, "maxDepth": 1, "maxStates": 12, "maxActionsPerState": 8, "maxMs": 120000,
      "allow": [{ "role": "button", "name": "Filters" }],
      "deny": [{ "role": "button", "name": "Chat with us" }]
    },
    "scenarios": [
      {
        "name": "Filters drawer",
        "route": "/brothers",
        "auth": "session",
        "devices": ["mobile-320", "mobile-390"],
        "steps": [{ "do": "click", "role": "button", "nameContains": "Filters", "expect": { "dialog": "Refine your search" } }],
        "checks": { "disable": ["layout-shift"] },
        "cleanup": []
      },
      {
        "name": "Contact form with an error",
        "route": "/contact",
        "steps": [
          { "do": "fill", "role": "textbox", "name": "Email", "value": "not-an-email" },
          { "do": "press", "key": "Tab", "expect": { "message": "Enter a valid email address." } }
        ]
      }
    ],
    "suppressions": [
      { "kind": "tap-target", "target": { "name": "Like" }, "route": "/", "reason": "Icon row is being redesigned (DES-142)", "expires": "2026-12-31" }
    ],
    "policy": { "failOn": "high", "failOnErrors": false, "failOnHeuristic": false }
  }
}
```

The `scan` section's fields:

| field | default | meaning |
| --- | --- | --- |
| `devices` | 320, 390, 768, 1440 | Device ids, built-in or the profile's own `devices`. |
| `checks.enable` / `checks.disable` | all on | Check names, listed under "Detectors" below. A scenario's `checks` narrows further. |
| `tapTargets.standard` | `wcag22-aa` | `wcag22-aa` is SC 2.5.8 (24 px, with the spacing exception). `wcag22-aaa` is SC 2.5.5 (44 px, with no spacing exception). |
| `noWrap` | `[]` | Controls (role, and a name with `*`) that must never wrap. A wrap there is a violation, not a warning. |
| `wrapNearbyRatio` | 1.35 | Two widths are compared for wrapping when the wider is at most this many times the narrower (320 and 390 are; 390 and 768 are not). |
| `layoutShiftMin` | 0.05 | The smallest layout-shift score reported. |
| `explore.*` | off; depth 1; 12 states; 8 actions per state; 120 s | See "Exploration". `maxMs` covers the whole scan. |
| `scenarios[]` | none | `name` (unique), `route`, `auth`, `devices`, `steps`, `checks`, `explore`, `cleanup`. |
| `suppressions[]` | none | See "Suppressions". |
| `policy` | fail on confirmed high | See "Result policy". |

**Scenario steps** use the flow step format (`src/core/steps.ts`, shared with `agentlab run`):

- `do` is any action: click, fill, press, select, check, scroll, swipe, hover, upload, drag, back, forward, or a tab action.
- The target is `role` with `name` or `nameContains`, resolved against the latest observation. The lab never guesses: more than one match is `ambiguous_target`.
- `expect` takes `route`, `dialog`, `heading`, `message` or `control`. A failed expectation fails the scenario before its checks run.
- Steps go through `Lab.act()`, the same code as the CLI, MCP and flows. There is no second action engine.

**`auth`** chooses where a scenario's cookies and storage come from:

- `session` (the default) copies the running session's;
- `saved` loads the saved sign-in file through `auth.ts`;
- `fresh` starts signed out.

The copy is never written back.

**`cleanup`** steps run after the checks, in the scenario's context, for example to undo server data the setup created. If exploration left the context in another state and it cannot be closed back, cleanup runs in a fresh context on the route as loaded. Setup is not replayed then, because it may create data. The context itself is always discarded afterwards.

## How a scan runs

For each scenario, for each of its devices, serially:

1. **Context.** `Lab.isolated()` opens a new browser context on the session's browser. It has the device's viewport, scale, touch and user agent, plus the cookies and storage chosen by `auth`, the timer tracker, the click-verification binding and a layout-shift observer. It is a child `Lab` with its own tabs, refs and settle state. Closing it closes only that context: never the browser, never a service. It writes no session artifacts.
2. **Load.** It opens the route (an HTTP status of 400 or more fails the run at `load`) and settles with the profile's `settle` policy.
3. **Setup.** It runs the steps through `act()`. A step error or a failed expectation fails the run at `setup`. A sideways pan needed during setup is kept as a finding of that scenario.
4. **Checks.** It measures the state (`s0`) with `measureState()`. See "Detectors".
5. **Exploration**, when enabled. See the next section.
6. **Cleanup**, then the context is closed.

A failed run records where it stopped (`failedAt`: `context`, `load`, `setup`, `checks` or `cleanup`) and its error. The scan continues with the next device and scenario. Runs never share a context, so one run's writes (local storage, a half-filled form, an open dialog) cannot reach another run, another device or the developer's session. `test/scan.test.mjs` checks this with a page that counts its own visits.

Once every device of a scenario has run, label wrapping is compared across nearby widths for each state that appeared on several devices.

## Exploration

Exploration is off by default. Turn it on with `--explore`, `scan.explore.enabled`, or `explore: true` on one scenario. It works breadth-first from a scenario's state:

- **Candidates.** The controls in the current state that `explore-safety.ts` allows. At depth 2 and deeper, only controls the activation revealed are candidates, and each control is activated at most once per run.
- **Activation.** For each candidate it:
  1. returns to the parent state;
  2. clicks the candidate through `act()`, with the request guard on;
  3. measures the new state;
  4. restores the parent state.
- **Limits.** `maxDepth` (activations deep), `maxStates` (per scenario and device), `maxActionsPerState` and `maxMs` (the whole scan). A limit that cuts exploration short is written to the run's `limits`, for example `maxStates (12): 4 candidate(s) not explored`.

**What may be activated.** The rules apply in this order, and the first that matches decides:

1. The project's `explore.deny` list means **skip**. Deny beats allow.
2. Hard blocks mean **skip**, whatever the allow list says:
   - a file chooser;
   - a link to another origin;
   - a `download` link;
   - `target=_blank`.
3. The project's `explore.allow` list means **explore**. Use it for controls known to only open UI, such as a Filters button with no ARIA attributes.
4. Consequential names mean **skip**. These include delete, remove, archive, cancel, log out or sign out, pay, purchase, buy, checkout, place order, confirm, submit, send, save, apply, book, reset, upload, share and similar.
5. Submitting or resetting a form means **skip**. That covers `type=submit`, a `<button>` with no type inside a form, input submit or image, and `type=reset`.
6. A link to another page on the same origin is not explored, because exploration stays on the route.
7. State-opening semantics mean **explore**:
   - `aria-haspopup` (menu, listbox, dialog…);
   - `aria-expanded="false"` (disclosure; accordion for `<summary>`);
   - a closed `<details>`;
   - an unselected `role=tab`;
   - `aria-controls` naming a hidden element;
   - a toggle button with `aria-pressed="false"`.
8. Anything that could open something, but whose purpose cannot be determined, means **skip** with the reason recorded:
   - a menu item without a popup;
   - a button or link whose name hints at opening something ("Menu", "Filters", "More", "Options", an icon-only button) but with none of the attributes above.

   The skip reason tells the developer to add the control to `explore.allow` if it only opens UI.
9. Everything else (text fields, ordinary controls, open disclosures) is ignored and not recorded.

A control that shares its role, name and context with another is skipped, never guessed.

**Request guard.** While a candidate is being activated, the exploring context aborts every request except GET, HEAD and OPTIONS, and every navigation to another origin. If a candidate triggers a blocked request:

- its state is marked `blocked` with the request;
- the state is not measured;
- the control is recorded as a skip ("sent POST /audit when activated…");
- the context is rebuilt.

So a control that is mislabelled, or allow-listed by mistake, still cannot change data.

**Restoring.** The scan returns to the parent state by the first of these that works:

1. activating the opener again, if it is now expanded or pressed;
2. for a tab, selecting the previously selected tab;
3. pressing Escape;
4. a fresh context, with the setup and the path replayed.

The first three count only when the state signature matches the parent's again. The signature is route, dialog, headings, and each control's role, name and open, pressed, checked and selected state. Each state records how it was restored (`toggle`, `escape`, `fresh-context`).

## Detectors

Every check runs in `measureState()` (`src/core/checks.ts`) on a settled state, and the sweep uses the same function. Measurement is in `extract.ts`, which only reports geometry. Each decision is in `detectors.ts`, a pure module with unit tests. Detector names and versions are in `DETECTORS`, and every finding carries `detector: {name, version}`.

When a modal dialog is open, the checks are scoped to it, since the background is inert. Visually hidden content (1 px or `clip: rect(0 0 0 0)` screen-reader text, `inert` or `aria-hidden` subtrees) is never a target.

| check | what is measured | confirmed when | otherwise |
| --- | --- | --- | --- |
| `horizontal-overflow` (v1) | document scroll width vs viewport | — | heuristic, medium |
| `control-clipped` (v1) | a control past the viewport's left or right edge; a closed off-canvas panel (entirely off-screen in a fixed layer, or entirely left of the origin) is excluded | — | heuristic; high when at least half is outside |
| `horizontal-pan-required` (v1) | reaching the control needed a sideways pan (click path, sweep and scan) | always (interaction) | — |
| `control-obstructed` (v2) | after scrolling into view, and on past a fixed bar, a hit test at the control's centre lands elsewhere; an inline link wrapped over two lines is aimed at its largest line box | always (hit test), high | — |
| `container-clipped` (v3) | a control or text cut by an ancestor with `overflow: hidden\|clip` (the body scroll lock excluded); entirely hidden content, a peeking carousel track, the `option`s of a native listbox (which it scrolls itself) and content in motion (it, or an ancestor between it and the clipper, has a running infinite animation or a running transform animation: a marquee) are ignored | a control whose centre is cut (high), a control ≥ 10 % hidden (medium), or text ≥ 10 % and ≥ 4 px hidden | heuristic low for small nicks |
| `text-clipped` (v3) | text overflowing its own box that hides the rest with no ellipsis or clamp; text drawn wholly outside its own box (image replacement with `text-indent: -3000px`) is hidden on purpose and ignored, and so are listbox `option`s and text in motion (see `container-clipped`) | horizontal cuts: high inside a control when ≥ 25 % is hidden, else medium | heuristic medium for vertical overflow of ordinary text (could be an intended excerpt) |
| `text-truncated` (v1) | ellipsis or line clamp | a control label, heading or form label with no `title` or accessible name giving the full text (medium) | heuristic low, e.g. card titles with a `title` |
| `fixed-collision` (v1) | fixed or sticky layers (sticky only while stuck; backdrops and off-screen panels excluded) overlapping each other | a control's centre is hit-tested onto another fixed layer (high); both stay put, so no scroll helps | heuristic medium (≥ 25 % overlap) or low |
| `content-under-fixed` (v1) | at the page's top and bottom scroll extremes, content under a fixed or sticky bar (skipped while a modal locks scrolling; a control the reach check already found covered is not repeated) | a control whose centre stays covered (high), or text ≥ 50 % hidden (medium) | heuristic low |
| `modal-overflow` (v1) | an open dialog or drawer past the viewport; each control inside is scrolled into view (with its scroll containers) and checked | a control that never comes into view (high; the target is the dialog) | heuristic medium when it overflows with no scrollable area but every control was reachable |
| `unreachable-content` (v2) | content before the scroll origin (left of or above it) of the page or its scroll container, e.g. a centred flex row wider than its scroller; entirely before the origin (off-canvas) and content in motion are ignored | a control (high when its centre is cut), or text ≥ 25 % hidden | heuristic low |
| `outside-container` (v1) | a control sticking ≥ 4 px out of the nearest visible box (background, shadow, or borders on at least three sides); absolutely placed badges are excluded | — | heuristic; medium from 16 px |
| `content-scroll-x` (v2) | an `overflow-x: auto\|scroll` element (not a native `<select>` listbox) that scrolls, with nothing marking it intentional: no list, tab, table, toolbar or region role, carousel, scroll snap, table or code, or a row of three or more items | — | heuristic low (medium with paragraphs and ≥ 25 % excess); never high |
| `tap-target` (v1) | every enabled control's box; see "Tap targets" | a failed WCAG rule, medium | — |
| `layout-shift` (v1) | the browser's Layout Instability entries without recent input, while the state settled (after load or an activation), summed | score ≥ 0.1 (the Core Web Vitals threshold), medium | heuristic low from `layoutShiftMin` |
| `text-wrap-change` (v1) | a control label's line count, from its text line boxes, compared between nearby widths | see "Wrapping" | heuristic low |

### Tap targets

The default standard is WCAG 2.2 SC 2.5.8 Target Size (Minimum), level AA. A target fails when it is smaller than 24 × 24 CSS px **and** none of these exceptions applies:

- **Spacing.** A 24 px circle centred on its box must intersect no other target's box, and no other undersized target's circle (whose centres would then be less than 24 px apart).
- **Inline.** The target sits in a sentence, so its size is set by the line of text around it.
- **User agent.** A native checkbox or radio whose appearance the author has not changed.

The "equivalent" exception (another control that does the same thing meets the size) and the "essential" exception cannot be measured, so they are not applied. `wcag22-aaa` uses SC 2.5.5: 44 × 44, with the inline and user-agent exceptions but no spacing exception.

So a 20 × 20 button whose neighbours are 28 px away passes AA. A control under 44 px is **not** reported under the default standard. `test/detectors.test.mjs` pins these cases.

### Wrapping

Wrapping by itself is not a defect. For each state measured on several devices, each pair of nearby widths is compared. A control whose label has more lines at the narrower width than at the wider one becomes a `text-wrap-change` finding on the narrower device. It carries both widths' frames and this evidence:

- `linesNarrow` and `linesWide`;
- `heightNarrow` and `heightWide`;
- `rowNeighbourHeight`;
- `harm`, which is one of:

| `harm` | when | classification |
| --- | --- | --- |
| `functional` | at the narrower width the label is cut off or truncated with no alternative, or the control's **visible** box overlaps another control's (both clipped by their scroll containers) | confirmed, medium |
| `expectation` | the control matches `scan.noWrap` | confirmed, medium |
| `cosmetic` | nothing is hidden or covered, but the control grows ≥ 1.35× and ≥ 12 px taller than at the wider width, or is ≥ 1.3× taller than the control beside it | confirmed, low |
| `none` | only the line count changed | heuristic, low |

## Findings

Every finding has these fields:

- `id`: F1, F2…, stable within the session.
- `device`, `viewportWidth`, `scenario` and `route`.
- `state`: the first state it was seen in; `states` lists every state it was seen in.
- `severity`.
- `confidence`: `confirmed` or `heuristic`.
- `confidenceScore`: 0 to 1.
- `basis`: what it rests on.
- `evidence`: measurements in CSS px.
- `target`: role, name, context and a short CSS `selector`.
- `reproduction`: the session's steps, then `scan R1: open … in a new mobile-320 context …`, then the setup and exploration steps.
- `frame` (the state's frame, or the moment of obstruction), plus `frames`: the other width for wrapping, or before and after for a layout shift.
- `detector`: name and version.
- `fingerprint`.

**Confidence rules.** A finding is `confirmed` only when a deterministic measurement shows a person is affected:

- `interaction`: a pan was needed;
- `hit-test`: the pointer lands elsewhere;
- `clipping`: content was measured as cut off;
- `standard`: a WCAG rule fails;
- `browser-metric`: the Layout Instability score;
- `comparison` with measured harm.

Otherwise it is `heuristic`. The `FindingStore` refuses to store a heuristic as high severity unless its basis includes one of the deterministic measurements; such a finding is lowered to medium.

`confidenceScore` is fixed per rule:

- 0.95: hit tests and interactions;
- 0.9: clipping and standards;
- 0.85: layout shift at 0.1 or more, and functional wrap harm;
- 0.7: cosmetic wrap;
- 0.6: document overflow and viewport clipping;
- 0.5 or 0.4: geometry-only heuristics.

**Deduplication.** Within a scenario, the same problem seen in several states is one finding. The key is device, scenario, kind, route and the target's role, name and context, not the state. Seeing it again increases `occurrences` and extends `states`.

**Grouping.** The `fingerprint` is a hash of the detector's family, the route (without its fragment) and the target's identity. The families are:

- overflow;
- off-screen;
- covered: obstruction, fixed collision and content under a fixed bar;
- clipped;
- modal;
- target size;
- wrap;
- shift;
- scroll.

The fingerprint leaves out device, scenario and state. Reports and the dashboard group findings by fingerprint, one problem per group, and keep each device's measurements in the group's rows. The fingerprint is stable across runs, so a suppression can name it. A control covered at its centre is one problem whether the reach check or the fixed-bar check found it. A fixed layer covering a control is reported once, as `fixed-collision`, not again by the reach check.

## Result policy and suppressions

The default policy fails only on an unsuppressed **confirmed** finding of **high** severity:

- `failOn: "medium" | "low" | "none"` changes the threshold;
- `failOnHeuristic: true` counts heuristic findings too;
- `failOnErrors: true` fails when a scenario run failed. It is off by default, but failed runs are always listed in the verdict's reasons and shown as "failed before checks completed".

The verdict's `reasons` say what failed and what was not counted, and why.

**Suppressions.** A suppression needs a `reason`, and a `kind` or a `fingerprint`, so a bare rule cannot hide everything. It narrows with any of `route` (glob `*`), `target.role`, `target.name` (glob), `scenario` and `device`, and it may have an `expires` date (`YYYY-MM-DD`). The first matching rule applies. Suppressed findings are **never hidden**:

- they stay in `findings` with `suppressed: {rule, reason, expires}`;
- they appear in the report's "Suppressed findings" section and the dashboard's Suppressed list;
- they are excluded only from the policy.

Every rule gets a status:

- `applied`, with the ids it matched;
- `expired`: its date has passed, so it no longer applies;
- `unmatched`: stale, it matched nothing in a run that covered its scope;
- `not-evaluated`: it names a scenario or device this run did not include.

## Reports and the dashboard

**Reports.** `report.html` is one self-contained page. Every app-derived string is escaped, and images are shown only when they are inside the run directory. Its sections are:

1. the verdict with its reasons and policy;
2. the scenario × device matrix, with failures before checks marked;
3. confirmed problems, then heuristic warnings, each group with its per-device rows and side-by-side frames;
4. suppressed findings;
5. suppression statuses;
6. exploration: states, how each was restored, blocked requests, skipped controls with reasons, and limits.

`result.json` is the full `ScanResult`.

**Dashboard.** The dashboard gets scan events through `SessionFeed`, like everything else. It shows:

- scan progress and the state being measured;
- the scenario matrix; selecting a cell shows that run's states, thumbnails, skipped controls and limits, and filters findings to it;
- findings grouped by problem, filterable by device, confirmed or heuristic, and scenario;
- a finding's frames side by side: the same state at other widths, or before and after a layout shift;
- for a wrap, its per-width line and height table and the harm verdict;
- a separate Suppressed list.

## Known limitations

- **Emulation, not phones.** This is Chromium device emulation. Fonts decide wrapping: the fixture's 390 px no-wrap holds with Noto Sans, and a font about 9 % wider would wrap there too.
- **Exploration is deliberately narrow.**
  - A control with no ARIA state attributes is skipped as ambiguous unless allow-listed. Talk to a Brother's Filters button is one; its drawer is covered by a declared scenario instead.
  - Name heuristics are English-only.
  - Clicking is the only activation; hover menus and swipe-to-reveal are not explored.
  - Depth-2 states that need text input are not reached.
- **The request guard sees network requests only.** State changed purely in the page (an in-memory store, `localStorage`) by a mislabelled control is not blocked. The context is discarded afterwards, but an app that syncs later could still send it.
- **Restoring compares signatures, not pixels.** A state that differs only in scroll position or typed values counts as restored.
- **Cleanup is best effort.** Scenarios that create server data should declare cleanup steps, or run against disposable data. The lab isolates browser state, not the backend.
- **Layout-shift scores depend on the viewport**, as the metric does: the same 120 px push scores lower at 1440 × 900 than at 320 × 568, and can fall below `layoutShiftMin`.
- **`content-scroll-x` and `outside-container` are geometry heuristics.** They never fail the default policy.
- **Budgets.** Each state measures up to 2,500 elements and 40 items per detector, and reach-checks 40 controls. The rest are counted in the run, not silently dropped.
- **Cost.** Each scenario × device opens a fresh context and reloads the route. On a dev server that loads modules per context, such as Vite, that is most of the time.

## Validation (29 September 2026)

All runs are headless on the benchmark machine (2× Celeron 5205U, 11 GB), Chromium 153, Node 22.17.1.

**Seeded fixture** (`fixtures/responsive-app`, 10 declared scenarios, 38 scenario × device runs). The scan reported exactly 12 problem groups, one per seeded defect or intentional warning, and every run completed:

| seeded defect | reported as | widths |
| --- | --- | --- |
| drawer footer "Show 12 results" wraps (320 only) | `text-wrap-change`, confirmed low, harm cosmetic (70.8 vs 48.4 px) | 320 |
| wishlist button label truncated, no alternative | `text-truncated`, confirmed medium | all |
| Like / Share / Save 18 px, 2 px apart | `tap-target`, confirmed medium ×3 (SC 2.5.8) | all |
| Specs tab text hard-clipped | `text-clipped`, confirmed medium, only in the "Specs tab" state | all |
| chat bubble over "Pay now" (fixed-footer collision) | `fixed-collision`, confirmed high | all |
| "Place order" under the fixed footer at max scroll | `control-obstructed`, confirmed high, plus `content-under-fixed` on the paragraph above it | all |
| "Edit profile" dialog taller than the screen | `modal-overflow`, confirmed high, target the dialog | all |
| banner inserted 600 ms after load | `layout-shift`, confirmed medium | 320, 390, 768 (below 0.05 at 1440) |

- **Warnings.** The card-1 title with a `title` attribute is the one heuristic warning (`text-truncated`, low).
- **Missed seeded defects:** none.
- **False positives on the fixture:** none. The snap carousel, the peek carousel, the wide table, the compliant 20 px and 30 px targets, the inline "size guide" link, and the About and Contact pages (including the error state) produced nothing.
- **False positives found and fixed during validation:**
  - an inline link wrapped over two lines reported as obstructed (a reach-check bug the click path shared);
  - modal overflow split into one group per first unreachable control;
  - layout shift split by which element moved most;
  - `fixed-collision` repeated by the reach check;
  - a drawer button's "overlap" with scrolled content that was not visible;
  - footer links "outside" a container that only has a top border;
  - off-canvas drawer links flagged as clipped (a pre-existing flag).

  Each has a regression test.

**Exploration safety** on `/settings` (depth 2):

- It opened only "Account actions", "Advanced options" and "Notifications".
- It skipped 12 controls, each with a reason: consequential names, a form submit, an external link, an upload, the ambiguous "More", and the menu items.
- The audit log stayed empty.
- With "More" allow-listed, the guard blocked its `POST /audit`, marked the state `blocked` and skipped the control. The log still stayed empty.

Exploring `/` at 320 and 390 opened 10 states each, restored by toggle, Escape or a fresh context, and found the Specs-tab clipping and the drawer wrap without declared scenarios.

**Talk to a Brother:** see [independent-app.md](independent-app.md#follow-up-the-filters-drawer-with-stateful-scans-milestone-2).

- The Filters drawer wrap is found at 320 px only: 75.6 vs 50.8 px, confirmed low, cosmetic.
- The marketplace is clean at all four widths.
- Exploration skips the attribute-less Filters button unless it is allow-listed. With the allow entry, it finds the same wrap.

**Duration and resource cost** (3 runs each, median (min–max)):

- *Peak RSS* is the whole process tree: the CLI, the app server and Chromium.
- *CPU* is summed user and system time.

| scan | runs / states | wall time | scan time | peak RSS | CPU | frames |
| --- | --- | --- | --- | --- | --- | --- |
| fixture, all scenarios, 4 widths | 38 / 38 | 59.4 s (58.6–59.5) | 56.4 s (55.6–56.5) | 915 MB (913–920) | 55 s (54.4–56.4) | 49, 1.8 MB |
| fixture `/` with `--explore`, 320 + 390 | 2 / 22 | 40.8 s (40.7–41.4) | 37.9 s (37.7–38.4), 34.2 s exploring | 896 MB (894–900) | 36 s (35.5–36.5) | 22, 0.3 MB |
| Talk to a Brother, marketplace + drawer, 4 widths | 8 / 8 | 30.5 s (30.4–31.2) | 25.3 s (25.0–26.1) | 1186 MB (1182–1193) | 35 s (34.3–35.2) | 8, 0.3 MB |

That is about 1.5 s per scenario × device on the fixture. On Talk to a Brother it is about 3 s, most of it Vite loading modules cold in each new context. An explored state with a toggle or Escape restore costs about 1.5 s; one that needs a fresh context costs about 3 s.

**Tests.** 276 tests: the 131 from milestone 1 and 145 new ones (detectors, explore-safety, findings, scan-policy, scan-report, scan-detectors, scan, scan-cli, feed and dashboard-scan).

The final full run had 274 passes. The 2 failures were exploration-safety tests that read the fixture's audit log after the scan had stopped the fixture server (a test bug, fixed). `test/scan.test.mjs` then passed 20/20. `npm run verify:package` passed 29/29, including a standalone scan from the installed tarball with exit codes 0, 1 and 2. Both fixture flows pass.

**Independent-app MCP journey.** One of three runs failed. After "Sign in", settling reported the route change to `/app/discover` while the DOM still showed the login form.

It was a settle race that milestone 1 already had. React Router 7 renders the navigation in a transition that React schedules through `MessageChannel`, so the URL changed while the DOM stayed quiet. It is now fixed: after a client-side route change, settling waits for the page's element structure to change.

With both cores busy, the milestone 1 code failed this journey 3/3 and the fixed code completed it 3/3. The sign-in tap now settles in 1.1–1.2 s, once the discover page has rendered, instead of returning early at about 0.7 s. The full suite passes 278/278, including `test/settle-route.test.mjs`, which fails without the rule.
