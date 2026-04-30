#!/bin/bash
pkill -f "legacy/server" 2>/dev/null || true
pkill -f "vite --config client-app" 2>/dev/null || true
pkill -f "server/admin-api/start" 2>/dev/null || true
pkill -f "server/voice-gateway/start" 2>/dev/null || true
sleep 1

# Local dev cap for the per-tenant live-stream/SSE rate limiter
# (callsLive + operations). Production keeps the conservative 20
# default; in dev/CI we bump it so e2e specs that re-mount Dashboard
# many times in a 60s window don't false-trip the 429 path.
export TENANT_LIVE_STREAM_CAP="${TENANT_LIVE_STREAM_CAP:-500}"

trap 'kill 0' EXIT

npx vite --config client-app/vite.config.ts &
npx tsx server/admin-api/start.ts &
npx tsx server/voice-gateway/start.ts &
wait
