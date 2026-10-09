# Security policy

## Reporting a vulnerability

Please report a suspected vulnerability privately, not in a public issue.

Email [kwaleyelamusil@gmail.com](mailto:kwaleyelamusil@gmail.com) (Colony Innovations) with "agentlab security" in the subject. Include:

- the output of `agentlab version`
- the steps to reproduce
- what you expected to happen

Do not attach `.agentlab/` runs, saved sign-in state or raw traces, because they can hold secrets from your project. If a bundle helps, attach a failure bundle (`agentlab bundle`), which is built to be shareable.

## Supported versions

Security fixes go into the latest release. Web V1 (0.3.x) is the first published line, so there is no older supported line.

## What the lab protects

The lab runs on your machine, runs only the commands in your committed `agentlab.json`, and serves its dashboard on `127.0.0.1` behind a per-session token. Supervision is cooperative and is not a sandbox: it does not contain an agent that has a shell. The threat model, every control and how secrets are kept out of output are in [docs/security.md](docs/security.md).
