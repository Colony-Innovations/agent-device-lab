# Next.js 14 app router (independent app)

The create-next-app starter in `~/my-app`: Next 14.2.2, React 18, Tailwind 3, `next/font/google` (Inter), one route (`/`). It is not a lab fixture; the original directory is never written to (it has no `node_modules`). Results are in [docs/rc-apps.md](../../docs/rc-apps.md).

## Setup

```bash
examples/nextjs/prepare.sh [scratch-dir]      # default ${TMPDIR:-/tmp}/agentlab-nextjs
```

It copies the app (without `node_modules` and `.next`) into the scratch directory, copies the profiles and flow next to `package.json` (their `cwd` and `project` are `.`), and runs `npm install` there. It needs the npm registry; if the install fails the script prints the tail of `npm-install.log` and exits 1. `NEXTJS_SOURCE` overrides the source. An existing scratch directory is replaced only if this script made it.

## Profiles

- `agentlab.json`: cold start. `npx next dev -p 5382 -H 127.0.0.1`, readiness `GET /` = 200 (60 to 120 s allowed, since the first compile happens on that request), `reuseExisting: false`, `NEXT_TELEMETRY_DISABLED=1`. Two scan scenarios: `/` as loaded and `/` explored (a scenario route that answers 4xx, such as the not-found page, is a failed load and cannot be scanned).
- `attach.agentlab.json`: the "reused development server" check, on 5383 with `reuseExisting: true`.

```bash
S=/tmp/agentlab-nextjs
node bin/agentlab.js start --project $S --headless && node bin/agentlab.js stop      # owned: started and stopped by the lab

(cd $S && npx next dev -p 5383 -H 127.0.0.1) &                                        # started by hand first
node bin/agentlab.js start --project $S/attach.agentlab.json --headless              # "owned: false"
node bin/agentlab.js stop                                                             # the dev server keeps running
# stop the hand-started server yourself (Ctrl-C, or kill the pid you started)

node bin/agentlab.js run $S/home.flow.json --headless                                 # loads /, checks headings and links
node bin/agentlab.js scan --project $S --headless
```
