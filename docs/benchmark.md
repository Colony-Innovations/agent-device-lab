# Benchmark: Agent Device Lab MCP vs Playwright MCP

This is the first measurement of the hypothesis that a small, exact view costs an agent less than a general browser tool on the invoice fixture. It is a **small, home-ground benchmark**, and the caveats below matter as much as the numbers.

A matched comparison on an independent app, Talk to a Brother, with cold startup reported separately, is in [independent-app.md](independent-app.md). Its results don't transfer to this fixture, and this fixture's results don't transfer to it.

## What is held constant

| | Both tools |
| --- | --- |
| Agent | `claude -p` (Claude Code CLI 2.1.280), model `claude-sonnet-5`, the same system prompt and identical task text. Built-in tools are disabled (`--tools ""`), only the MCP server named `browser` is loaded (`--strict-mcp-config`), the working directory is empty (no CLAUDE.md), `--max-turns 60`, and no session persistence. |
| Browser | The same Chromium binary, `ms-playwright/chromium-1243` (Chromium 153), headless. |
| Device | The lab's `mobile-390` profile: 390×844 @3x, `isMobile`, `hasTouch`, and the same user agent. Playwright MCP receives it through `contextOptions`. `browser_resize` is disallowed so the viewport cannot change mid-task; the smoke run showed an agent resizing to 375px. |
| Starting state | Before every run, the harness starts a fresh fixture server on 127.0.0.1:5199 and stops it afterwards. Each run gets a new browser context: the lab's session, or Playwright MCP's `isolated: true`. The lab reuses the running server and does not own it. |
| Machine | Ubuntu 24.04 (Linux 7.0), 2× Celeron 5205U, 11 GB RAM, Node 22.17.1, one run at a time. |
| Order | Interleaved (r1: lab then Playwright; r2: reversed; …) so that drift affects both tools. |

The two tools are Agent Device Lab 0.1.0 (`agentlab mcp --headless`, Playwright 1.63.0; since slice 3 the harness passes `--no-ui`, which keeps this configuration: no dashboard, no evidence frames and the same MCP instructions) and Playwright MCP 0.0.82 (Playwright 1.64.0-alpha, pointed at the same Chromium through `executablePath`).

## Tasks and scoring

- **clean**: create an invoice for "Acme Ltd", amount 120, open it, mark it paid, then report mobile defects on the pages visited. There is no seeded defect on this path.
- **defect**: open Reports, export the CSV, then report mobile defects. The seeded defect is the Reports toolbar overflow ([SEEDED_DEFECTS.md](../fixtures/invoice-app/SEEDED_DEFECTS.md)).

Scoring works as follows:

- **Completion** comes from the fixture's audit log (`FIXTURE_EVENT_LOG`): `invoice.created` with Acme Ltd / 120 plus `invoice.paid`, or `report.exported`. It is not based on what the agent says.
- **Findings** are labelled by the rule in `tasks.json`, set before the runs. A defect is *true* when it is on Reports and describes the overflow or off-screen symptom. Several true reports of the one seeded defect count as one defect found. Every other reported defect is a *false positive*, pending manual review.
- **Effort** comes from the stream-json transcript:
  - tool calls, by name;
  - screenshots (`*screenshot*` tool calls);
  - bytes of tool-result content returned to the model;
  - output and input tokens for the benchmark model only (the CLI's small helper model is excluded);
  - `total_cost_usd` as reported by the CLI.
- **Wall time** is the whole `claude -p` process: MCP server start, model latency and tool time.

## Results (28 September 2026, 3 runs per cell)

The harness and the raw data (per-run records and transcripts) are kept by the maintainers and are not published with this repository. Values are median (min–max).

### clean

| metric | Agent Device Lab | Playwright MCP |
| --- | --- | --- |
| completed (audit log) | 3/3 | 3/3 |
| wall time | 33.3 s (27.4–39.7) | 56.2 s (47.9–61.7) |
| tool calls | 8 (8–8) | 16 (15–16) |
| output tokens | 787 (773–948) | 1217 (1211–1262) |
| input tokens incl. cache | 67.8k (64.2k–67.9k) | 156.7k (135.2k–156.7k) |
| tool result bytes | 12.5 KB | 120.4 KB (115.4–120.6) |
| screenshots | 0 | 4 per run |
| false positives | 1 (see review) | 0 |

### defect

| metric | Agent Device Lab | Playwright MCP |
| --- | --- | --- |
| completed (audit log) | 3/3 | 3/3 |
| seeded defect found | 3/3 | 3/3 |
| wall time | 25.2 s (25.0–29.6) | 51.3 s (45.3–70.5) |
| tool calls | 4 (4–4) | 9 (9–10) |
| output tokens | 719 (694–738) | 1408 (1131–1698) |
| input tokens incl. cache | 26.2k (26.1k–26.2k) | 81.3k (72.0k–96.3k) |
| tool result bytes | 9.5 KB | 55.2 KB (54.5–78.5) |
| screenshots | 0 | 2 (2–4) |
| tool errors | 0 | 3 |
| false positives | 0 | 0 |

In both tasks, every run with Agent Device Lab was lower than every run with Playwright MCP on:

- wall time: median ratio 1.69× on clean, 2.03× on defect;
- tool calls: 2.0× and 2.25×;
- output tokens: 1.55× and 1.96×;
- input tokens: 2.3× and 3.1×;
- tool-result bytes: 9.6× and 5.8×;
- CLI-reported cost: 1.35× and 1.42×.

With n = 3 and non-overlapping ranges, this is the only claim the data supports: **on these two fixture tasks, on this machine, with this model, the lab was faster and cheaper in every run.** It is not evidence of a general speedup.

### Manual review

- **09-clean-agentlab-r3, the one false positive.** The agent reported that the "Back to invoices" link is a small tap target. Measured, the link is 119×22 px, under the 24 px minimum in WCAG 2.2, although the spacing exception may apply. It was not seeded, and the rule set before the runs counts it as a false positive. On review it is a plausible minor issue, not a fabrication. The agent read the link's `rect` (h 22) from the JSON result; the lab has no target-size detector.
- **Playwright MCP defect runs, tool errors.** In two runs, `browser_click` on "Export CSV" timed out: the "To" input and the nav intercepted pointer events. The agents recovered with `browser_evaluate` / `browser_run_code_unsafe` (JavaScript scrolling or clicking), and export completed in all 3 runs.
- **12-defect-playwright-r3.** The agent correctly reported the button off-screen, but also stated that "the page does not scroll horizontally". That is wrong: the page pans through the visual viewport, and `window.scrollTo` does not move it. The report is labelled true because the core finding is right.
- **Lab defect runs.** In all 3 runs, the agent reported the overflow, the clipped "To" field and the sideways pan to "Export CSV". These are the lab's own findings, restated.

## Caveats (read before citing these numbers)

1. **Home advantage.** The fixture, its seeded defect and the lab's detectors were built together. The defect task measures exactly what the lab reports as a finding, so detection quality is biased towards the lab. A real, independent application journey is still needed, as the plan requires.
2. **Small sample.** There are 3 runs per cell, 2 tasks, 1 model and 1 machine. The ranges don't overlap here, but that is weak evidence against run-to-run variance in a model-driven loop.
3. **Different workflow cost.** Playwright MCP returns a full accessibility snapshot after most actions, and the agents chose to take screenshots. That behaviour is the "current Playwright MCP workflow" being compared, but a prompt telling the agent to avoid screenshots, or `--snapshot-mode none`, would change its numbers. Those configurations were not measured.
4. **Different Playwright versions.** Both tools drive the same Chromium binary, but the Playwright client libraries differ (1.63.0 vs 1.64.0-alpha), because no Playwright MCP release pins 1.63.0.
5. **Project path in the prompt.** Both prompts include the URL and the project directory. Only the lab uses the directory, to read `agentlab.json`. The server was already running for both, so this gave no startup advantage; cold-start cost was not measured in this benchmark.
6. **Uncommitted tree.** The runs were made on a dirty working tree based on commit 5ea37fe (recorded in `env.json`). The code under test is the code in this change.
7. **Cost figures** are the CLI's list-price estimates, not billing data.
8. **What the model reads.** Claude Code passes a tool's `structuredContent` (the full JSON result) to the model, not the concise `content` text. The lab's numbers therefore reflect its JSON output, and its text rendering was not what the agent saw. A text-only result mode would likely shrink the lab's payload further, but it was not measured.
