# Getting started

This guide takes about ten minutes. You will run the lab on a small demo app that has a layout defect planted in it, watch the session in the dashboard, find the defect, and then set the lab up on your own project and hand it to your coding agent.

Every block of output below is what the lab printed on a real run. Session ids, ports, process ids and timings will differ on your machine.

## Before you start

You need Linux x64 (Debian or Ubuntu), Node.js 22 or newer, and the lab installed:

```bash
npm install -g agent-device-lab
agentlab install-browser
agentlab doctor
```

`doctor` should end without a failed check. If it does not, each failed line names its fix, and [troubleshooting.md](troubleshooting.md) covers the common ones. Other ways to install are in [install.md](install.md).

The demo app lives in this repository, so clone it to follow along:

```bash
git clone https://github.com/Colony-Innovations/agent-device-lab.git
cd agent-device-lab/fixtures/invoice-app
```

The demo is a tiny invoicing app with no dependencies. Its Reports page has a toolbar that does not fit on a phone.

## 1. Start a session

```bash
agentlab start
```

```
session s-20261006132121-0830  device mobile-390 390x844 @3x touch  headless
environment: Chromium 153.0.8010.12 with mobile device emulation on linux (emulation, not a real device)
server: started "npm run dev" pid 770555 → http://127.0.0.1:5199 ready in 1219ms (owned: stopped on close)
gen 1  route /invoices  title "Invoices · Fixture"  viewport 390x844  scroll 0,0
headings: h1 "Invoices"
controls (5):
  e1 link "Invoices"
  e2 link "Reports"
  e3 button "New invoice"
  e4 link "INV-001 Globex · $1200.00 · Open"
  e5 link "INV-002 Initech · $450.00 · Paid"
layout: no flags
console: 0 errors  network: 0 failed requests  findings: 0 in session
dashboard: http://127.0.0.1:45701/#token=…  (live viewport, timeline and findings for a person watching)
```

Three things happened:

1. The lab read `agentlab.json` in this directory and ran the command it names (`npm run dev`). The line that starts with `server:` says the lab started it and so will stop it later. If the app had already been running, the lab would have attached to it and left it running at the end.
2. It opened a browser set up as a 390 px wide phone. There is no browser window; you will watch it in the dashboard in the next step.
3. It printed the first **observation**: the page's headings and the controls a person can see, each with a **ref** such as `e3`. This short list is what an agent works from, in place of a screenshot or the whole page.

The session keeps running in the background until you stop it, so each later command returns quickly.

## 2. Open the dashboard

```bash
agentlab ui
```

This opens the dashboard in your browser. On a machine with no display it prints the link instead; see [dashboard.md](dashboard.md#opening-it) for viewing it from another machine.

- **Centre:** the phone's screen, live. The line above it says what you are looking at.
- **Left:** the timeline, one entry for each thing the lab does.
- **Right:** the findings, empty for now.
- **Top:** the buttons to pause the agent, take over the browser, or stop the run.

Keep it open beside your terminal for the rest of the guide.

## 3. Act, and read what changed

Click the "New invoice" button by its ref:

```bash
agentlab click e3
```

```
click e3 button "New invoice" → ok (tap, 641ms, settled quiet in 145ms)
changed: + dialog "Create invoice"; + textbox "Customer" e6; + textbox "Amount" e7; + button "Cancel" e8; + button "Save" e9; 5 background controls now behind the dialog; focus none → e6
console: 0 new errors  network: 0 new failures
```

The result is not a new copy of the page. It is only what changed: a dialog opened, four controls appeared (`+`), and focus moved to the Customer field. "settled quiet" means the lab waited until the page stopped loading and changing before it looked.

You can also name a control instead of using its ref. Save the empty form:

```bash
agentlab click --name Save --role button
```

```
click e9 button "Save" → ok (tap, 262ms, settled quiet in 139ms)
changed: ~ textbox e6 invalid; + alert "Customer is required"
console: 0 new errors  network: 0 new failures
```

The app showed a validation message, and the lab reports it: the Customer field changed (`~`) to invalid and an alert appeared. Fill the field in:

```bash
agentlab fill e6 "Acme Ltd"
```

```
fill e6 textbox "Customer" → ok (fill, 961ms, settled quiet in 727ms)
changed: ~ textbox e6 value ""→"Acme Ltd"
```

Close the dialog with `agentlab click --name Cancel --role button`. Each of these steps also appeared in the dashboard's timeline, and you saw the dialog open and close in the viewport.

If you lose track of the page, `agentlab observe` prints the full list of controls again. All the actions (select, check, scroll, swipe, hover, upload, drag, tabs and more) are in [cli.md](cli.md).

## 4. Find a defect

Go to the Reports page:

```bash
agentlab click --name Reports --role link
```

```
click e2 link "Reports" → ok (tap, 611ms, settled quiet in 255ms)
finding: F1 [medium, heuristic] horizontal-overflow @mobile-390: document is 598px wide, viewport is 390px (page pans sideways); mobile browser widened the layout viewport to 598px on /reports
finding: F2 [medium, heuristic] control-clipped @mobile-390: textbox "To" extends 80px past the right edge of the 390px viewport (44% outside) on /reports
finding: F3 [high, heuristic] control-clipped @mobile-390: button "Export CSV" extends 208px past the right edge of the 390px viewport (entirely outside the initial view) on /reports
changed: route /invoices → /reports; new document, baseline reset; refs from the previous page are stale
gen 2  route /reports  title "Reports · Fixture"  viewport 390x844  scroll 0,0
headings: h1 "Reports"
controls (5):
  e6 link "Invoices"
  e7 link "Reports"
  e8 textbox "From" value="2026-09-01"
  e9 textbox "To" value="2026-09-30" CLIPPED-right 80px
  e10 button "Export CSV" CLIPPED-right 208px
layout: 3 flag(s)
  ...
```

The page is 598 px wide on a 390 px screen, and the "Export CSV" button sits entirely off the right edge. The lab recorded three **findings**, `F1` to `F3`. Because this was a new page, it also printed a full observation with new refs; the old ones no longer work.

Now click the button that is off screen:

```bash
agentlab click --name "Export CSV" --role button
```

```
click e10 button "Export CSV" → ok (tap, 671ms, settled quiet in 133ms)
note: view panned sideways 208px to reach the target: it starts outside the 390px-wide view, so a person must discover a horizontal pan
finding: F4 [high, confirmed] horizontal-pan-required @mobile-390: button "Export CSV" on /reports could only be reached after panning 208px sideways; on a 390px-wide screen a person must first discover the horizontal pan
changed: + status "Export ready: 2 invoices"; focus none → e10
```

This is the reason the lab exists. The click **succeeded**, so an ordinary automated test would pass. But the lab had to pan the screen sideways to reach the button, and it says so: a person on a phone would not see the button at all. In the dashboard you saw the screen slide sideways.

Notice the two words in brackets on each finding:

- The first is the **severity**: `high`, `medium` or `low`.
- The second is the **confidence**. `confirmed` means a measurement showed a person is affected; here the lab really had to pan to reach the button. `heuristic` means the layout looks wrong but the lab has not shown that it hurts anyone.

`F3` was a heuristic until the click proved the problem, which produced the confirmed `F4`.

## 5. Read a finding

```bash
agentlab inspect F4
```

```
F4 [high, confirmed] horizontal-pan-required @mobile-390: button "Export CSV" on /reports could only be reached after panning 208px sideways; on a 390px-wide screen a person must first discover the horizontal pan
  device mobile-390 (390px) · route /reports · source interaction · seen 1x (gen 2–2)
  evidence: panPx=208 viewportWidth=390 documentWidth=598 targetLeft=482 targetRight=598 targetWidth=116
  reproduce:
    1. open http://127.0.0.1:5199/invoices in Chromium with device mobile-390 (390x844)
    2. click link "Reports"
    3. click button "Export CSV"
```

A finding carries its measurements in CSS pixels and the steps to reproduce it from the start of the session. That is what you, or your agent, need to fix it: here, a toolbar that does not wrap. `agentlab inspect` with no id lists every finding. In the dashboard, select a finding on the right to see the same evidence and the frame captured when it was recorded.

Findings stay recorded for the whole session, even after later actions succeed.

## 6. Check every width at once

So far you have looked at one width. A **sweep** loads one page at four widths and measures each:

```bash
agentlab sweep /reports
```

```
sweep S1 of /reports: 4 widths in 4260ms (serial, isolated contexts)
  mobile-320 (320px): document 598px, 5 controls, 5 reach-checked → 2 confirmed, 3 heuristic
    F1 [medium, heuristic] horizontal-overflow
    F2 [high, heuristic] control-clipped textbox "To"
    F3 [high, heuristic] control-clipped button "Export CSV"
    F4 [medium, confirmed] horizontal-pan-required textbox "To"
    F5 [high, confirmed] horizontal-pan-required button "Export CSV"
  mobile-390 (390px): document 598px, 5 controls, 5 reach-checked → 2 confirmed, 3 heuristic
    ...
  tablet-768 (768px): document 768px, 5 controls, 5 reach-checked → clean
  desktop-1440 (1440px): document 1440px, 5 controls, 5 reach-checked → clean
```

(This output is from a fresh session, so its finding numbers start at `F1`.) The page breaks at 320 and 390 px and is clean at 768 and 1440 px. If the dashboard is open, the viewport shows each width in turn while it is measured.

A sweep sees a page only as it first loads. For a state you have to open, such as a menu, a filter drawer or a dialog, you declare a **scenario** in `agentlab.json` and run `agentlab scan`. See [web-v1-m2.md](web-v1-m2.md) and the `scan` section of [configuration.md](configuration.md#scan).

## 7. Stop

```bash
agentlab stop
```

```
closed (requested): browser closed; server stopped (SIGTERM)
```

The lab closed the browser and stopped the demo server, because the lab had started it. It never stops a process it did not start.

## 8. Set it up on your own project

```bash
cd /path/to/your-app
agentlab init
```

`init` looks at your project (its `package.json` scripts, framework and ports) and shows the `agentlab.json` it proposes. It runs nothing, reads no `.env` values and writes nothing until you confirm. Read the proposal, since the `command` in it is what the lab will run, then accept it or edit the file afterwards.

```bash
agentlab doctor     # checks the profile, each service's command and port, and your environment
agentlab start
agentlab ui
```

If your app needs more than one process (an API, a worker, a database in Docker), declare each as a service with what it depends on and how to tell it is ready. If it needs a signed-in user, sign in once and save the state with `agentlab auth save`. Both are covered in [configuration.md](configuration.md), and there are worked profiles in [examples/](../examples/).

Commit `agentlab.json`: committing it is how your team approves the commands the lab may run. Keep secrets out of it. Name the variables a service needs in `requiredEnv` and export them in your shell; `doctor` warns when a value in the file looks like a secret.

## 9. Hand it to your coding agent

Everything you just typed is also available to an agent over MCP. Register the server once:

```bash
claude mcp add --scope user agentlab -- "$(command -v agentlab)" mcp --headless     # Claude Code
codex mcp add agentlab -- "$(command -v agentlab)" mcp --headless                   # Codex CLI
```

Then, in a session in your project, ask for what you want in plain words:

> Start the lab on this project. Go through the checkout on a phone-sized screen, sweep the cart page, and fix any confirmed finding. Show me the findings before you change code.

To watch, run `agentlab ui` in the directory the agent is working in. From the dashboard you can:

- **Pause** the agent, after its current action or before its next one.
- **Take over** the browser and click or type yourself, for example to get past a sign-in step. What you type is never recorded.
- **Return** control. The agent is told the page may have changed and looks again before it acts.
- **Stop** the run.

While you have control the agent's commands are refused with a message that tells it to wait. See [mcp.md](mcp.md) for the tools and error codes, and [dashboard.md](dashboard.md#supervision-workflow) for supervision step by step.

## Where to go next

| you want to | read |
| --- | --- |
| describe a project with several services, sign-in or uploads | [configuration.md](configuration.md) |
| scan menus, drawers and dialogs at every width | [web-v1-m2.md](web-v1-m2.md) |
| fail a pull request when a confirmed defect appears | [ci.md](ci.md) |
| share a failure and re-run it later | [cli.md](cli.md#failure-bundles-and-replay) |
| look up a command | [cli.md](cli.md) |
| fix an error | [troubleshooting.md](troubleshooting.md) |
| know what the lab does not do | [limitations.md](limitations.md) |
