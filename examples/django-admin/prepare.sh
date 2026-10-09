#!/usr/bin/env bash
# Prepare a disposable copy of the Django project ~/learning_log for the lab. The original directory is
# only read. Usage: DJANGO_ADMIN_PASSWORD=... examples/django-admin/prepare.sh [scratch-dir]
#   scratch-dir defaults to ${TMPDIR:-/tmp}/agentlab-django-admin
# Environment:
#   DJANGO_ADMIN_PASSWORD  password for the superuser "labadmin" (default: a fixed disposable value)
#   DJANGO_SOURCE          project to copy (default: ~/learning_log)
#   DJANGO_PYTHON          python of the project's venv (default: $DJANGO_SOURCE/ll_env/bin/python, used in place, never copied)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="${DJANGO_SOURCE:-$HOME/learning_log}"
py="${DJANGO_PYTHON:-$src/ll_env/bin/python}"
scratch="${1:-${TMPDIR:-/tmp}/agentlab-django-admin}"
password="${DJANGO_ADMIN_PASSWORD:-lab-only-Pa55word}"

[ -f "$src/manage.py" ] || { echo "prepare: $src/manage.py not found (set DJANGO_SOURCE)" >&2; exit 1; }
[ -x "$py" ] || { echo "prepare: $py is not executable (set DJANGO_PYTHON)" >&2; exit 1; }
case "$password" in *[\'\"\\\&\|]*) echo "prepare: DJANGO_ADMIN_PASSWORD must not contain quotes, backslashes, & or |" >&2; exit 1;; esac

# Only replace a directory this script made before.
if [ -e "$scratch" ]; then
  [ -f "$scratch/.agentlab-prepared" ] || { echo "prepare: $scratch exists and was not made by this script; choose another directory" >&2; exit 1; }
  rm -rf "$scratch"
fi
mkdir -p "$scratch"
scratch="$(cd "$scratch" && pwd)"
touch "$scratch/.agentlab-prepared"

# The project, without the venv, caches and its database (a fresh one is migrated below).
tar -C "$src" --exclude=ll_env --exclude=__pycache__ --exclude=db.sqlite3 --exclude=.git -cf - . | tar -C "$scratch" -xf -

# Profile and flow: the templates in this directory with this machine's values filled in.
for f in agentlab.json login.flow.json; do
  sed -e "s|@PYTHON@|$py|g" -e "s|@ADMIN_PASSWORD@|$password|g" "$here/$f" > "$scratch/$f"
done
chmod 600 "$scratch/login.flow.json"
printf '.agentlab/\nlogin.flow.json\ndb.sqlite3\n' > "$scratch/.gitignore"

cd "$scratch"
"$py" manage.py migrate --noinput > /dev/null
DJANGO_SUPERUSER_PASSWORD="$password" "$py" manage.py createsuperuser --noinput --username labadmin --email labadmin@example.invalid > /dev/null

echo "prepared $scratch (superuser labadmin)"
echo "  node bin/agentlab.js start --project $scratch --headless"
echo "  node bin/agentlab.js run $scratch/login.flow.json --headless"
