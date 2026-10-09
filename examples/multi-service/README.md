# Multi-service example

A tiny task tracker made of three dependency-free Node processes plus an optional Redis
container. The lab uses it to test multi-service startup, reuse, failure and shutdown with
schemaVersion 2 profiles.

| process | file | port | what it does |
| --- | --- | --- | --- |
| api | `api/server.mjs` | 5341 | In-memory task API. `GET /health` is open; every `/tasks` route needs `Authorization: Bearer $DEMO_API_TOKEN` (401 otherwise). `GET /tasks`, `POST /tasks {title}` (201, status `queued`), `POST /tasks/:id/done`. Logs one line per request, never headers. |
| worker | `worker/worker.mjs` | none | Polls the API. Prints `worker ready` once the first `GET /tasks` succeeds, then marks each task done once it has been queued for at least 600 ms (`worker: done <id>`). |
| web | `web/server.mjs` | 5342 | Serves the mobile page at `/`, proxies `/api/*` to the API and adds the bearer token server-side, so the browser never sees it. `/health` is 200 only while the API's `/health` is 200, otherwise 503. |
| cache | `compose.yaml` | 5349 | `redis:7-alpine` on `127.0.0.1:5349`. Nothing talks to it; it exercises a oneshot `docker compose` service with TCP readiness. |

All three processes exit 0 on SIGTERM or SIGINT after printing `<name>: shutting down`.

Test switches:

- `API_CRASH=1`: the api prints `api: simulated startup crash` and exits 3 immediately.
- A missing `DEMO_API_TOKEN`: the api prints `api: DEMO_API_TOKEN is not set` and exits 1 (the worker and web do the same with their own prefix).
- `WEB_SLOW_SHUTDOWN=1`: web ignores the first SIGTERM (`web: ignoring SIGTERM`), so a supervisor has to fall back to SIGKILL after its grace period.

## Running by hand

From this directory, with a token of your choice in the environment (see `.env.example`):

```bash
export DEMO_API_TOKEN=test-token
node api/server.mjs       # or: npm run api
node worker/worker.mjs    # or: npm run worker
node web/server.mjs       # or: npm run web, then open http://127.0.0.1:5342/
docker compose up -d cache   # optional; docker compose stop cache && docker compose rm -f cache
```

`PORT` and `API_URL` override the defaults (5341, 5342, `http://127.0.0.1:5341`).

## Profiles

- `agentlab.json`: api (readiness `/health`), worker (log readiness `worker ready`, after api) and web (readiness `/health`, after api, 3 s shutdown grace). The app is `web` on the `mobile-390` device.
- `compose.agentlab.json`: the same plus the `cache` service (`docker compose up -d cache` as a oneshot, TCP readiness on 5349, stopped with `docker compose stop cache` only if the lab started it); api depends on cache.
- `broken.agentlab.json`: the same as `agentlab.json` but the api starts with `API_CRASH=1`, so startup fails and its dependents are never started.

## The token

`DEMO_API_TOKEN` is only ever named: the profiles list it under `requiredEnv`, and the
processes read it from the environment. No file in this example holds a value, and no process
prints it.
