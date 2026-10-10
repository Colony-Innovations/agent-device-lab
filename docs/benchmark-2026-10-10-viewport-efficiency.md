# Viewport benchmark — 10 October 2026

This measures what the clearer live viewport costs, and what doubling its frame-rate cap would cost, on the workspace based on commit `2973afe`.

## Verdict

Desktop frames now arrive at their native CSS size instead of being downsampled to 800 px. While a viewer is connected, that costs more bandwidth and CPU, most of all during continuous animation. Raising the cap from 5 to 10 fps roughly doubles animation bandwidth again without a consistent benefit to ordinary action timing, so the default stays at 5 fps.

## Method

- Forty-eight viewport runs: two workloads × two devices × four modes × three repetitions, interleaved and run serially; no tests or other benchmark ran alongside them.
- Browser: Playwright 1.63.0 with Chromium 153 (`chromium-1243`), headless, on mobile-390 (390×844 @3x) and desktop-1440 (1440×900 @1x).
- Machine: Linux 7.0.0-38-generic, 2× Intel Celeron 5205U @1.90GHz, 11 GB RAM, Node 22.17.1.
- Viewport workload 1 executes all nine checks of the existing clean flow. Workload 2 repaints a local invoice-style page continuously and samples the stream for five seconds after its first frame.
- CPU is GNU time user+system time for the measured process and its reaped children, including application Chromium. Animation CPU includes session startup and shutdown as well as the five-second sample. The viewport receiver is an HTTP MJPEG client: desktop dashboard-browser decoding/rendering is not included.
- Values are median (min–max). A directional difference is supported only when the ranges do not overlap. Three runs on a fixture do not establish the cost for every application.

## Viewport settings

| Mode | Rate cap | Width cap | JPEG quality |
| --- | --- | --- | --- |
| off | none captured | — | — |
| legacy | 5 fps | 800 px | 60 |
| sharp5 | 5 fps | 1920 px | 85 |
| sharp10 | 10 fps | 1920 px | 85 |

Smaller devices are never upscaled. Quality and resolution change together in legacy→sharp5, so their individual contributions cannot be separated.

## Real clean-flow viewport cost

### mobile-390

| Mode | Flow wall (s) | Actions (s) | CPU (s) | Stream KiB |
| --- | --- | --- | --- | --- |
| off | 5.26 (5.20–5.38) | 3.63 (3.55–3.69) | 2.48 (2.43–2.54) | 0.0 (0.0–0.0) |
| legacy | 5.29 (5.25–5.38) | 3.87 (3.78–3.87) | 2.82 (2.76–2.86) | 201.8 (201.8–218.6) |
| sharp5 | 5.17 (5.08–6.32) | 3.67 (3.67–4.51) | 2.71 (2.65–2.81) | 316.2 (305.7–316.2) |
| sharp10 | 5.41 (5.26–6.12) | 3.69 (3.63–3.85) | 2.69 (2.66–2.71) | 316.2 (316.2–316.2) |

### desktop-1440

| Mode | Flow wall (s) | Actions (s) | CPU (s) | Stream KiB |
| --- | --- | --- | --- | --- |
| off | 6.15 (5.25–6.25) | 4.48 (3.70–4.66) | 2.50 (2.37–2.61) | 0.0 (0.0–0.0) |
| legacy | 5.42 (5.16–7.13) | 3.83 (3.65–3.92) | 2.66 (2.60–2.70) | 135.8 (133.7–135.8) |
| sharp5 | 5.23 (5.21–5.24) | 3.70 (3.68–3.74) | 2.83 (2.81–2.88) | 440.2 (433.7–440.2) |
| sharp10 | 5.16 (5.13–5.32) | 3.67 (3.63–3.71) | 2.88 (2.78–2.91) | 460.1 (440.2–495.6) |

## Continuous-animation viewport cost

### mobile-390

| Mode | Frame pixels | Delivered fps | Stream KiB/s | CPU (s, full run) |
| --- | --- | --- | --- | --- |
| off | — | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) | 1.79 (1.73–1.81) |
| legacy | 390×844 | 4.80 (4.80–4.80) | 116.13 (116.10–116.15) | 2.47 (2.46–2.49) |
| sharp5 | 390×844 | 5.00 (4.80–5.00) | 186.28 (178.86–186.31) | 2.69 (2.53–2.74) |
| sharp10 | 390×844 | 10.00 (9.80–10.00) | 372.49 (365.06–372.58) | 3.16 (3.09–3.19) |

### desktop-1440

| Mode | Frame pixels | Delivered fps | Stream KiB/s | CPU (s, full run) |
| --- | --- | --- | --- | --- |
| off | — | 0.00 (0.00–0.00) | 0.00 (0.00–0.00) | 1.73 (1.69–1.89) |
| legacy | 800×500 | 4.80 (4.80–4.80) | 206.75 (206.67–206.76) | 2.53 (2.45–2.62) |
| sharp5 | 1440×900 | 4.80 (4.79–4.80) | 830.38 (829.38–830.48) | 3.91 (3.69–3.93) |
| sharp10 | 1440×900 | 9.80 (9.80–9.80) | 1695.53 (1694.80–1695.60) | 4.70 (4.54–4.90) |

## Supported resource comparisons

- clean-flow-mobile-off-sharp5, CPU time: off lower in every run; second-mode median change +9.3%.
- clean-flow-mobile-legacy-sharp5, streamed bytes: legacy lower in every run; second-mode median change +56.7%.
- clean-flow-desktop-off-sharp5, flow wall time: sharp5 lower in every run; second-mode median change -15.0%.
- clean-flow-desktop-off-sharp5, CPU time: off lower in every run; second-mode median change +13.2%.
- clean-flow-desktop-legacy-sharp5, CPU time: legacy lower in every run; second-mode median change +6.4%.
- clean-flow-desktop-legacy-sharp5, streamed bytes: legacy lower in every run; second-mode median change +224.2%.
- animation-mobile-off-sharp5, CPU time: off lower in every run; second-mode median change +50.3%.
- animation-mobile-legacy-sharp5, CPU time: legacy lower in every run; second-mode median change +8.9%.
- animation-mobile-legacy-sharp5, streamed bytes: legacy lower in every run; second-mode median change +60.4%.
- animation-mobile-sharp5-sharp10, CPU time: sharp5 lower in every run; second-mode median change +17.5%.
- animation-mobile-sharp5-sharp10, streamed bytes: sharp5 lower in every run; second-mode median change +99.9%.
- animation-desktop-off-sharp5, CPU time: off lower in every run; second-mode median change +126.0%.
- animation-desktop-legacy-sharp5, CPU time: legacy lower in every run; second-mode median change +54.5%.
- animation-desktop-legacy-sharp5, streamed bytes: legacy lower in every run; second-mode median change +301.6%.
- animation-desktop-sharp5-sharp10, CPU time: sharp5 lower in every run; second-mode median change +20.2%.
- animation-desktop-sharp5-sharp10, streamed bytes: sharp5 lower in every run; second-mode median change +104.2%.

## Decisions

- Keep 5 fps as the default. It budgets capture and transport, rather than slowing the agent for readability. Ordinary clicks and forms do not necessarily benefit from a higher cap; continuous animation is the workload that exercises it. Frames never contribute to model tokens.
- Keep sharper native desktop frames and expansion. The measured width confirms that desktop-1440 no longer arrives downsampled to 800 px. Higher JPEG quality and resolution cost bandwidth while a viewer is connected.
- A separate viewport optimization worth measuring is adaptive resolution: use the smaller capture while the stage is narrow and native resolution when expanded, while retaining one shared stream and hard resource limits. The current benchmark used fixed capture settings.
