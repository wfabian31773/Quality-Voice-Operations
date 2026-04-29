#!/bin/bash
set -e

echo "=== Post-merge setup ==="

echo "Installing dependencies..."
npm install --prefer-offline --no-audit --no-fund 2>&1 || true

echo "Running database migrations..."
npx tsx scripts/run-migrations.ts 2>&1

echo "Running client-app typecheck (tsc --noEmit)..."
npm run --silent typecheck:client

echo "Running design-system regression checks..."
bash scripts/ci-design-checks.sh

echo "=== Post-merge setup complete ==="
