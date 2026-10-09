# Contributing

Thanks for looking at Agent Device Lab. Bug reports, fixes, new example profiles and documentation corrections are all welcome.

## Reporting a bug

Open an issue with:

- the output of `agentlab version` and `agentlab doctor`
- the command you ran and what it printed (add `--json` if the text is unclear)
- what you expected

If the problem is in a session, `agentlab bundle` writes a failure bundle that is safe to share: it contains no secrets, sign-in state or typed values. Do not attach `.agentlab/` runs or raw traces.

Report security issues privately, as described in [SECURITY.md](SECURITY.md).

## Building and testing

You need Linux x64 and Node.js 22 or newer.

```bash
npm install && npx playwright install chromium   # once
npm run build                                    # tsc → dist/
npm run typecheck
npm test                                         # builds, then runs every test (about 15 minutes)
node --test test/observation.test.mjs            # one test file, after a build
node bin/agentlab.js help                        # the CLI from your checkout
```

The CLI and the tests run from `dist/`, so rebuild after every change to `src/`. The tests start local servers on fixed ports between 5199 and 5399, so stop any lab session in the repository before running them.

Two longer checks are worth running before a change to packaging or the install path:

```bash
npm run verify:package            # packs, installs the tarball in a clean prefix and drives it (about 5 minutes)
node scripts/verify-docker.mjs    # the same in clean containers (needs Docker)
```

## Where things are

[docs/architecture.md](docs/architecture.md) is the map. In short: `src/core/` holds the logic and is shared by everything else; `src/cli/`, `src/daemon/`, `src/mcp/` and `src/dashboard/` are thin layers over it; `assets/dashboard/` is the dashboard page; `fixtures/` are the demo apps the tests use; `examples/` are profiles for real apps.

## Rules a change must keep

A change must keep these:

- A new capability for agents goes through `src/core/commands.ts`, so the CLI and MCP get it together. No command may evaluate arbitrary script.
- Never stop a process the lab did not start, and never signal a process without checking its identity first.
- Never guess between two matching controls. Return `ambiguous_target`.
- Text from a page is untrusted. Keep output bounded and say how much was left out.
- Nothing typed into a password field, no saved sign-in state and no secret value may reach a result, a log, a report or the dashboard.
- A finding is `confirmed` only when a measurement shows a person is affected. Anything else is `heuristic`.
- Keep pure logic free of the browser and cover it with unit tests.

## Sending a change

1. Branch from `development`. Pull requests are merged into `development` and released from `main`.
2. Add or update tests for what you changed, and update the docs page that describes it.
3. Add a line to the Unreleased section of [CHANGELOG.md](CHANGELOG.md) when the change is visible to a user or an agent.
4. Run `npm run typecheck` and `npm test`, and say in the pull request what you ran.

## Licence

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), as section 5 of the licence describes.
