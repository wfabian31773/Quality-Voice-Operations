#!/usr/bin/env bash
# CI entrypoint for the two design-system regression checks:
#
#   1. `check:design-tokens` — static check that the locked Refined Harbor
#      tokens in `client-app/src/lib/designTokens.ts` match the CSS custom
#      properties in `client-app/src/index.css`.
#
#   2. `check:public-dark-mode` — Playwright-based check that every
#      top-level public route renders with legible contrast in both light
#      and dark mode (catches white-on-white in dark mode, dark-on-dark in
#      light mode, and other near-invisible-text regressions).
#
# Designed to run from `scripts/post-merge.sh` and from any future CI
# pipeline. Boots an ephemeral vite dev server on :5000 only if one is not
# already responding, and tears it down on exit.
#
# Env vars:
#   SKIP_DARK_MODE_CHECK=1  — skip the browser-based check (e.g. in a
#                             headless container without chromium installed).
#   E2E_BASE_URL            — override the URL the dark-mode check hits
#                             (default http://localhost:5000).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "→ check:design-tokens (static)"
npm run --silent check:design-tokens

if [[ "${SKIP_DARK_MODE_CHECK:-0}" == "1" ]]; then
  echo "↷ check:public-dark-mode skipped (SKIP_DARK_MODE_CHECK=1)"
  exit 0
fi

BASE_URL="${E2E_BASE_URL:-http://localhost:5000}"
VITE_PID=""

cleanup() {
  if [[ -n "$VITE_PID" ]] && kill -0 "$VITE_PID" 2>/dev/null; then
    echo "→ stopping ephemeral vite server (pid=$VITE_PID)"
    kill "$VITE_PID" 2>/dev/null || true
    wait "$VITE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Reuse an already-running dev server if there is one — avoids fighting
# the developer's own `Platform Dev` workflow when invoked locally.
if curl -sSf -o /dev/null --max-time 2 "$BASE_URL/" 2>/dev/null; then
  echo "→ reusing existing dev server at $BASE_URL"
else
  echo "→ booting ephemeral vite dev server on :5000"
  npx vite --config client-app/vite.config.ts >/tmp/ci-vite.log 2>&1 &
  VITE_PID=$!
  for _ in $(seq 1 60); do
    if curl -sSf -o /dev/null --max-time 1 "$BASE_URL/" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  if ! curl -sSf -o /dev/null --max-time 2 "$BASE_URL/" 2>/dev/null; then
    echo "✗ vite did not come up on $BASE_URL within 60s; tail of log:"
    tail -n 40 /tmp/ci-vite.log || true
    exit 1
  fi
fi

# Ensure chromium is available; if not, install it on demand. Skip the
# install attempt entirely when a sandbox blocks network egress.
if ! ls "$HOME/.cache/ms-playwright"/chromium-* >/dev/null 2>&1; then
  echo "→ installing playwright chromium (one-time)"
  if ! npx playwright install chromium >/tmp/ci-pw-install.log 2>&1; then
    echo "✗ playwright chromium install failed; tail of log:"
    tail -n 20 /tmp/ci-pw-install.log || true
    echo "  re-run with SKIP_DARK_MODE_CHECK=1 to bypass in this environment."
    exit 1
  fi
fi

echo "→ check:public-dark-mode (browser, ${BASE_URL})"
E2E_BASE_URL="$BASE_URL" npm run --silent check:public-dark-mode
