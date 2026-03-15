#!/bin/bash
pkill -f "legacy/server" 2>/dev/null || true
pkill -f "vite --config client-app" 2>/dev/null || true
pkill -f "server/admin-api/start" 2>/dev/null || true
pkill -f "server/voice-gateway/start" 2>/dev/null || true
sleep 1

trap 'kill 0' EXIT

npx vite --config client-app/vite.config.ts &
npx tsx server/admin-api/start.ts &
npx tsx server/voice-gateway/start.ts &
wait
