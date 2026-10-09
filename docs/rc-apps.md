# Independent apps for the Web V1 release candidate (30 September 2026)

Draft, factual. Three more applications beside Talk to a Brother ([independent-app.md](independent-app.md)), each on a different stack. All ran headless with the build at commit `3ee465d` (development), Node 22.17.1, Chromium 153.0.8010.12. No app directory was modified: each profile runs against a scratch copy made by a `prepare.sh`. Nothing in `src/` was changed.

| App | Stack | Profile | Port |
| --- | --- | --- | --- |
| Django admin (`~/learning_log`) | Django 5.1.4, server-rendered, forms, CSRF, session cookie, SQLite | [examples/django-admin/](../examples/django-admin/) | 5381 |
| Next.js starter (`~/my-app`) | Next 14.2.2 app router, React 18, Tailwind 3, `next/font/google` | [examples/nextjs/](../examples/nextjs/) | 5382 (cold), 5383 (attach) |
| Zambezi Market (`~/zambezi-market`) | Vite 7, React 19, React Router 7, Tailwind 4, mock data only | not published | 5384 |

Zambezi Market has no backend and needs no environment, so it was included.

## Reproduce

```bash
DJANGO_ADMIN_PASSWORD=... examples/django-admin/prepare.sh   # /tmp/agentlab-django-admin
examples/nextjs/prepare.sh                                    # /tmp/agentlab-nextjs (npm install, about 2.5 min)
node bin/agentlab.js start --project /tmp/agentlab-<app> --headless
node bin/agentlab.js run /tmp/agentlab-<app>/<flow> --headless    # login.flow.json, home.flow.json, browse.flow.json
node bin/agentlab.js scan --project /tmp/agentlab-<app> --headless [--auth saved]
```

Each app's README has the details. The scratch directory holds the profile, so `cwd` is `.` and saved sign-in state stays in the copy's `.agentlab/`.

## Timings

| | Django admin | Next.js | Zambezi Market |
| --- | --- | --- | --- |
| Server ready (cold start) | 0.9 to 1.9 s | 21.1 s (first compile of `/`) | 1.2 to 1.7 s |
| `start` end to end | 5.2 to 7.1 s | 26.7 s | 12.3 s |
| Attach (`reuseExisting`) | not run | 6.2 s, `owned: false` | not run |
| Flow | 8 of 8 steps, 7.8 s | 2 of 2 steps, 13.9 s | 2 of 2 steps, 10.9 s |
| `sweep` of one route, 4 widths | 5.1 to 6.8 s (`/admin/`, `/admin/auth/user/`); 23.5 s once (`/`) | 6.8 s | 33.5 to 34.6 s |
| Standalone `scan` | 20.2 s wall (8 scenario runs), exit 1 | 61 s wall (5 runs, includes the 21 s server start), exit 1 | 69 s wall (5 runs) |

Lifecycle: after every `stop`, ports 5381 to 5384 were free and no process the lab started remained. The reused Next.js dev server (started by hand, pid 830813) kept answering 200 after `stop` and was stopped by me afterwards. Django: `--auth saved` started signed in on `/admin/` in 5.2 s; `agentlab doctor` reported `auth: saved sign-in state ... (2 cookies, owner-only)` and, with the session stopped, the service as free.

## Profile settings that were needed

- **Zambezi Market: `settle.quietMs` (no longer needed for the first observation).** Fixed in the lab after this run (settling treats a document with scripts and an empty body as not settled; finding 2). On the same copy with the default 120 ms, `start` gave 25 controls in 4 of 4 cold-start runs (9.3 to 12.5 s end to end). The original observation: with the default 120 ms, the first observation after `start` was empty (`controls (0)`) in 4 of 4 runs, without any settle notice; a later `observe` showed 25 controls. `quietMs` 300 gave a full observation in 2 of 4 runs; 600 and 1000 gave 4 of 4 each. The profile uses 600. Cost: sweeps take about 34 s instead of about 6 s.
- **Django admin:** nothing beyond `auth.loginPath`. Every `fill` reported `settled quiet in` about 720 ms, against about 130 ms on Next.js; the cause was not investigated.
- **Next.js:** a 120 s readiness timeout for the first compile.
- Scenario `auth` defaults to the session's state, so the Django "add group" scenario needs a session that is signed in (`start --auth saved`).

## Sign-in flow (Django)

`login.flow.json` signs in as `labadmin`, opens Groups and Add group, saves "Lab reviewers" and checks that the group is listed: 8 of 8 steps. A flow `value` is a literal, so `prepare.sh` writes the disposable password into the scratch copy of the flow (mode 0600). An RC run that must not keep a password in a file should sign in through MCP or the CLI and use `auth save`, which is what was run for the saved-state check. Django's flash message is a plain `<ul class="messagelist">` with no ARIA role, so the observation has no `messages` and a `message` expectation cannot match; the flow checks the new list row instead.

## Findings and failures

Classes: **lab** (product bug or gap), **app** (defect in the application), **env** (environment).

| # | Class | Observation |
| --- | --- | --- |
| 1 | lab | **Password in flow output.** `agentlab run` prints the step label `fill textbox "Password:" with "<the password>"` and writes it into `flow-result.json` in the run directory. Session history and reproduction steps do redact it (`‹secret›`, "17 characters"); the flow runner's labels (`describeStep` in `src/core/steps.ts`) do not. This breaks the rule that typed values from password-like fields never reach logs or reports. Not fixed here. **Fixed afterwards** (CI mode work): `describeStep` prints `‹secret›` for a value aimed at a password-like field, and CI mode seeds its redaction set with such step values. |
| 2 | lab | **Empty first observation on Vite dev** (Zambezi Market, above): the session reports settled with no controls and no notice. A start observation with zero controls and zero headings could be treated as not settled. Worked around by profile setting only. **Fixed after this run:** the cause was a waterfall of lazy-route module requests on Vite's unbundled dev server (`HomePage`, its five sections, their shared cards), with about 90 ms of evaluation with no request, timer or DOM change between the last response and the React commit; settling now waits while a document with scripts has drawn nothing (cause `empty`, bounded by `maxMs`). |
| 3 | lab | **False positive, high, confirmed.** Django admin's filter-horizontal widget: `text-clipped link "Choose"` and `"Remove"` ("3020 px of text in a 20 px box", `alternative=yes`) at all four widths. Django's `widgets.css` hides the label with `text-indent: -3000px; overflow: hidden` and shows an icon as a background image, a standard icon-replacement technique. Those two findings (4 widths each, 8 in all) alone make the Django scan exit 1. **Fixed after this run** (`text-clipped` v2): text drawn wholly outside its own box is hidden on purpose and is never a target; text cut partway is still reported. The Django scan now reads `PASS · 8 scenario runs (0 failed) · 7 problems (6 confirmed, 1 heuristic)`, all at medium or below. |
| 4 | lab (probable) | Django `container-clipped` text on `<option>` elements of a native multi-select ("Content Types \| content type \| Can delete content type", 91% hidden) and `content-scroll-x` on the same listbox. The select scrolls by design. Not checked visually. **Fixed after this run for `container-clipped` and `text-clipped` (v2):** `option` and `optgroup` are not measured. `content-scroll-x` on the listbox is unchanged. |
| 5 | lab (design) | A scan reports `PASS` when scenario runs failed to run, because `failOnErrors` is off by default: Django's first scan (before sign-in state existed) was "PASS, 8 scenario runs (5 failed)". Next.js `/no-such-page` failed as a load error (HTTP 404), so a not-found page cannot be a scenario; it was replaced by an explored scenario. |
| 6 | env / app | One Django `page.goto` timeout (30 s) in the first scenario of the first scan. The dev server's log shows `base.css` served 27 s after the page HTML, with nothing else in the log; it did not repeat in 6 later runs. Django's `runserver` under load, not the lab. |
| 7 | app | Django admin, mobile-390: `horizontal-overflow` (document 395 px in a 390 px viewport) on the group changelist `/admin/auth/group/`. |
| 8 | app | Django admin: `tap-target` on "VIEW SITE", "LOG OUT" and the theme toggle at 320 px; on the user changelist at 320 to 1440 px for the filter links "All", "Yes", "No". At 768 px on `/admin/auth/user/`, three column-header links ("EMAIL ADDRESS", "FIRST NAME", "STAFF STATUS") are `control-obstructed` (high, confirmed), covered by the filter's "No" link. Not checked visually. |
| 9 | app | Django's changelist search field and the filter-horizontal search boxes have an empty accessible name (`textbox ""`). |
| 10 | app | Next.js starter: the "By Vercel" link (`link "By"`) is `control-obstructed` (high, confirmed) at 320, 390 and 768 px, in the sweep and the scan. The starter's CSS gives it `pointer-events-none` below the `lg` breakpoint and puts a fixed gradient over it, so a visible link cannot be clicked on a phone. Also `low` label wraps at 320 px. |
| 11 | app or lab | Zambezi Market: `text-truncated` (medium, confirmed) on 11 product titles at 320 and 390 px, and `container-clipped` / `unreachable-content` on the category names "Hand-Woven Makenge Baskets" and "Chitenge Fashion" on the home page at all widths. The titles look like an intentional line clamp; whether a person can read the full title elsewhere was not checked. |
| 12 | lab (observation) | Zambezi Market: clicking "Add to cart" (`e45`) worked (`Cart (1 items)`), but the change line listed a dozen controls that were already on the page as `+`. The refs are re-issued after the re-render, so the diff cannot pair them. |
| 13 | lab | On Django, `sweep /` reports findings from Django's technical 404 page (the project routes only `/admin/`). Use `/admin/` as the sweep route. |

Counts, for the record: Django scan (8 runs): 10 confirmed and 1 heuristic problems after grouping, 8 at high (finding 3 above); Next.js scan (5 runs): 2 confirmed, 1 heuristic; Zambezi Market scan (5 runs): 20 confirmed, policy `PASS` because all are medium.

## Not done

- No MCP or dashboard run against these apps; everything used the CLI, headless.
- Django attach, replay and failure bundles were not exercised.
- Findings 4, 8 (768 px) and 11 were not confirmed visually.
- No lab source or fixtures were changed.
