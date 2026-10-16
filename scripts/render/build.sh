#!/usr/bin/env bash
# Render build command (PR-00). Usage: bash scripts/render/build.sh <api|voice|worker>
#
# Render sets NODE_ENV=production for builds, which makes `npm ci` skip
# devDependencies, but production starts with `npx tsx` (a devDependency).
# So every install here is `npm ci --include=dev`, via NPM_CONFIG_INCLUDE so
# we reuse scripts/ci-npm-ci.sh (Replit lockfile-URL rewrite + retries).
#
# Only the api build runs the client build, the env validator and the live
# Stripe price check (render-plan §9 B14); voice/worker/cron just install.
set -euo pipefail

role="${1:-}"
case "$role" in
  api|voice|worker) ;;
  *)
    echo "usage: bash scripts/render/build.sh <api|voice|worker>" >&2
    exit 2
    ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

echo "==> [render-build:${role}] node $(node --version), npm $(npm --version)"

export NPM_CONFIG_INCLUDE=dev
bash scripts/ci-npm-ci.sh .

if [[ "$role" == "api" ]]; then
  bash scripts/ci-npm-ci.sh client-app
  npm run validate:env:prod
  npm run verify:stripe-prices
  npx vite build --config client-app/vite.config.ts
fi

echo "==> [render-build:${role}] done"
