#!/usr/bin/env bash
# Reliable `npm ci` for GitHub Actions.
#
# Two failures showed up on every recent main/PR run:
#   1. Lockfiles committed from Replit resolve some packages at
#      http://package-firewall.replit.local/npm/ which does not exist on GHA.
#   2. `npm ci --prefer-offline` on npm 10.8.2 with an empty cache prints
#      "Exit handler never called!" and can exit 0 with an incomplete tree.
#      Later steps then fail with `vitest: not found` / `playwright: not found`
#      or pick up a stray TypeScript 7 `tsc`.
set -euo pipefail

target="${1:-.}"
cd "$target"

if [[ ! -f package-lock.json ]]; then
  echo "::error::package-lock.json missing in $(pwd)"
  exit 1
fi

if grep -q 'package-firewall.replit.local' package-lock.json; then
  echo "Rewriting Replit firewall resolved URLs to registry.npmjs.org"
  sed -i 's|http://package-firewall.replit.local/npm/|https://registry.npmjs.org/|g' package-lock.json
  sed -i 's|https://package-firewall.replit.local/npm/|https://registry.npmjs.org/|g' package-lock.json
fi

attempt=1
max=3
while true; do
  if npm ci --no-audit --no-fund; then
    break
  fi
  if (( attempt >= max )); then
    echo "::error::npm ci failed after ${max} attempts in $(pwd)"
    exit 1
  fi
  echo "npm ci failed (attempt ${attempt}/${max}); retrying..."
  rm -rf node_modules
  sleep $((attempt * 4))
  attempt=$((attempt + 1))
done

if [[ ! -d node_modules ]]; then
  echo "::error::npm ci exited 0 but node_modules is missing in $(pwd)"
  exit 1
fi
