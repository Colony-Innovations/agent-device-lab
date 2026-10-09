#!/usr/bin/env bash
# Prepare a disposable copy of the Next.js 14 app ~/my-app (app router, create-next-app starter) for the lab.
# The original directory is only read. Usage: examples/nextjs/prepare.sh [scratch-dir]
#   scratch-dir defaults to ${TMPDIR:-/tmp}/agentlab-nextjs
# Environment:
#   NEXTJS_SOURCE  project to copy (default: ~/my-app)
# Needs the npm registry (npm install runs in the copy) and, for next/font/google, network on first render.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="${NEXTJS_SOURCE:-$HOME/my-app}"
scratch="${1:-${TMPDIR:-/tmp}/agentlab-nextjs}"

[ -f "$src/package.json" ] || { echo "prepare: $src/package.json not found (set NEXTJS_SOURCE)" >&2; exit 1; }

# Only replace a directory this script made before.
if [ -e "$scratch" ]; then
  [ -f "$scratch/.agentlab-prepared" ] || { echo "prepare: $scratch exists and was not made by this script; choose another directory" >&2; exit 1; }
  rm -rf "$scratch"
fi
mkdir -p "$scratch"
scratch="$(cd "$scratch" && pwd)"
touch "$scratch/.agentlab-prepared"

tar -C "$src" --exclude=node_modules --exclude=.next --exclude=.git -cf - . | tar -C "$scratch" -xf -
cp "$here/agentlab.json" "$here/attach.agentlab.json" "$here/home.flow.json" "$scratch/"
printf 'node_modules/\n.next/\n.agentlab/\n' > "$scratch/.gitignore"

cd "$scratch"
if ! npm install --no-audit --no-fund > "$scratch/npm-install.log" 2>&1; then
  echo "prepare: npm install failed in $scratch (see $scratch/npm-install.log)" >&2
  tail -15 "$scratch/npm-install.log" >&2
  exit 1
fi

echo "prepared $scratch"
echo "  node bin/agentlab.js start --project $scratch --headless"
echo "  node bin/agentlab.js run $scratch/home.flow.json --headless"
echo "  attach: (cd $scratch && npx next dev -p 5383 -H 127.0.0.1) & then start --project $scratch/attach.agentlab.json"
