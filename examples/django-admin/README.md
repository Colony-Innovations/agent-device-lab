# Django admin (independent app)

A server-rendered app with forms, CSRF and session sign-in: the Django 5.1.4 admin site of `~/learning_log` (SQLite, only `/admin/` is routed). It is not a lab fixture and the original directory is never written to. Results are in [docs/rc-apps.md](../../docs/rc-apps.md).

## Setup

Django needs its project directory and an `agentlab.json` next to `manage.py`, and the lab keeps saved sign-in state in `<profile dir>/.agentlab/`. So `prepare.sh` builds a disposable scratch copy and writes the profile and flow into it (the files in this directory are templates: `@PYTHON@` and `@ADMIN_PASSWORD@` are filled in).

```bash
DJANGO_ADMIN_PASSWORD='choose-a-disposable-password' examples/django-admin/prepare.sh [scratch-dir]
```

- `scratch-dir` defaults to `${TMPDIR:-/tmp}/agentlab-django-admin`. An existing directory is replaced only if this script made it (`.agentlab-prepared` marker).
- The copy leaves out `ll_env/`, `__pycache__` and `db.sqlite3`. The original venv's python (`~/learning_log/ll_env/bin/python`) is used in place, by absolute path. Override with `DJANGO_SOURCE` and `DJANGO_PYTHON`.
- It runs `migrate` and creates the superuser `labadmin` non-interactively (`DJANGO_SUPERUSER_PASSWORD`). Without `DJANGO_ADMIN_PASSWORD` a fixed disposable value is used. The copy has its own database, so nothing touches `~/learning_log/db.sqlite3`.
- The profile is a schemaVersion 2 profile with one service, `web`: `python manage.py runserver 127.0.0.1:5381 --noreload`, readiness `GET /admin/login/` = 200, `startPath` `/admin/`, `auth.loginPath` `/admin/login/`. No `requiredEnv`.

## Run

```bash
S=/tmp/agentlab-django-admin
node bin/agentlab.js start --project $S --headless        # signed out: lands on /admin/login/?next=/admin/
node bin/agentlab.js run $S/login.flow.json --headless    # sign in, add the group "Lab reviewers"
node bin/agentlab.js scan --project $S --headless         # standalone scan (see below)
```

A flow step's `value` is a literal, so the flow cannot read the password from the environment. `prepare.sh` writes the disposable password into the scratch copy of `login.flow.json` (mode 0600, git-ignored there). For an RC run that must not have a password in a file, sign in through MCP or the CLI instead and use `agentlab auth save`. The flow adds one group, so run `prepare.sh` again (a fresh database) before running it a second time.

Signed-in session for later runs:

```bash
node bin/agentlab.js start --project $S --headless        # sign in: fill e4, fill e5, click "Log in"
node bin/agentlab.js auth save                            # state goes to $S/.agentlab/auth/state.json (0600, git-ignored)
node bin/agentlab.js stop
node bin/agentlab.js start --project $S --headless --auth saved   # lands on /admin/ signed in
node bin/agentlab.js doctor --project $S
```

Django's session cookie survives across `runserver` restarts because the sessions live in the SQLite database.

## Scan scenarios

- `Login page`: `/admin/login/`, signed out (`auth: fresh`).
- `Add group, empty (validation error)`: with the session's sign-in, opens the add-group form and clicks Save with an empty name; expects `textbox "Name:"` to be `invalid`. Start with `--auth saved` (or sign in first) for this scenario to reach the form.

## Notes for observers

- Django's flash messages (`<ul class="messagelist">`) have no ARIA role or live region, so the lab's `message` expectation and observation `messages` do not include them. The flow and scenario check controls instead.
- Link names come from the rendered text (`ADD GROUP`, `VIEW SITE`).
