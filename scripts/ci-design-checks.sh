#!/usr/bin/env bash
# CI entrypoint for the design-system regression checks:
#
#   1. `check:design-tokens` — static check that the locked Refined Harbor
#      tokens in `client-app/src/lib/designTokens.ts` match the CSS custom
#      properties in `client-app/src/styles/_theme.css`.
#
#   2. `check:public-dark-mode` — Playwright-based check that every
#      top-level public route renders with legible contrast in both light
#      and dark mode (catches white-on-white in dark mode, dark-on-dark in
#      light mode, and other near-invisible-text regressions).
#
#   3. `check:public-hero-visual` — Playwright-based visual-regression
#      check that the dominant top-of-section colour of every public
#      route matches its checked-in baseline within tolerance, and that
#      no dark-mode hero accidentally renders as a light/white slab
#      (catches `from-white` and similar gradient-only regressions
#      that the contrast probe can miss when no text sits on the
#      offending layer).
#
#   4. `check:pricing-live-rate-badge` — Playwright-based regression
#      (Task #1304) for the public Pricing page's "Live Stripe rate"
#      pill in the calculator's annual mode. Mocks
#      `/api/billing/effective-rate` and asserts the pill is present
#      when annual base price is Stripe-sourced and absent when only
#      catalog-sourced. Catches the original "annual badge silently
#      uses catalog discount" regression on every PR.
#
# Designed to run from `scripts/post-merge.sh` and from any future CI
# pipeline. Boots an ephemeral vite dev server on :5000 only if one is not
# already responding, and tears it down on exit.
#
# Env vars:
#   SKIP_DARK_MODE_CHECK=1  — skip the browser-based checks (the dark-mode
#                             contrast probe, the hero visual-regression
#                             check, AND the pricing live-rate badge
#                             check), e.g. in a headless container without
#                             chromium installed.
#   E2E_BASE_URL            — override the URL the browser-based checks hit
#                             (default http://localhost:5000).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "→ check:design-tokens (static)"
npm run --silent check:design-tokens

if [[ "${SKIP_DARK_MODE_CHECK:-0}" == "1" ]]; then
  echo "↷ check:public-dark-mode + check:public-hero-visual + check:pricing-live-rate-badge skipped (SKIP_DARK_MODE_CHECK=1)"
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

echo "→ check:public-hero-visual (browser, ${BASE_URL})"
E2E_BASE_URL="$BASE_URL" npm run --silent check:public-hero-visual

echo "→ check:pricing-live-rate-badge (browser, ${BASE_URL})"
E2E_BASE_URL="$BASE_URL" npm run --silent check:pricing-live-rate-badge
