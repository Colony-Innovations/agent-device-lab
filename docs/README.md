# Documentation

New here? Read [getting-started.md](getting-started.md) first. It walks through a full session on a demo app and takes about ten minutes.

## Learn

| page | what you will be able to do |
| --- | --- |
| [getting-started.md](getting-started.md) | Run a session, read observations and findings, watch in the dashboard, set up your own project, hand it to an agent |
| [install.md](install.md) | Install globally, per project or with `npx`; upgrade; uninstall; find where files are kept |
| [dashboard.md](dashboard.md) | Read each panel, pause the agent, take over the browser, hand it back, stop a run |
| [ci.md](ci.md) | Gate a pipeline on findings, and read the artifacts and exit codes |
| [troubleshooting.md](troubleshooting.md) | Go from a symptom to its cause and fix |

## Reference

| page | what it lists |
| --- | --- |
| [cli.md](cli.md) | Every command and flag, exit codes, the `--json` output |
| [configuration.md](configuration.md) | Every setting in `agentlab.json`, with a full example |
| [mcp.md](mcp.md) | MCP setup, the 25 tools, result shape, error codes and what an agent should do on each |
| [web-v1-m2.md](web-v1-m2.md) | Scans: scenarios, exploration and its safety rules, the detectors, suppressions, the pass/fail policy, reports |
| [security.md](security.md) | What the lab protects and what it does not, how secrets are handled, how to report an issue |
| [compatibility.md](compatibility.md) | Supported platforms and versions, the versioned contracts, how Playwright upgrades are handled |
| [limitations.md](limitations.md) | Known limitations and the roadmap |

Worked profiles for real apps are in [../examples/](../examples/): a multi-service app, Django admin, Next.js, and a GitHub Actions workflow.

## Evidence

Measurements of the lab. Each page states how the numbers were produced and what they do not show.

| page | what was measured |
| --- | --- |
| [benchmark.md](benchmark.md) | The lab's MCP server against Playwright MCP on two tasks: time, tool calls, tokens |
| [independent-app.md](independent-app.md) | An app the lab was not built with (Talk to a Brother): lifecycle, a journey, a sweep, a matched comparison |
| [rc-apps.md](rc-apps.md) | Three more independent apps: Django admin, Next.js, Zambezi Market |

## How it works

For contributors and the curious. How the lab is built and what changed.

| page | what it covers |
| --- | --- |
| [architecture.md](architecture.md) | The current map: processes, modules, the command table, supervision, events, ownership, bundles, CI |
| [release-notes-web-v1.md](release-notes-web-v1.md) | Web V1 highlights, upgrade steps and breaking changes |
| [../CHANGELOG.md](../CHANGELOG.md) | Changes by release |

The Evidence pages are records of what was measured at the time. Where one disagrees with a Learn or Reference page, the Learn or Reference page is current.
