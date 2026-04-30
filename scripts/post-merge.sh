#!/bin/bash
set -e

echo "=== Post-merge setup ==="

echo "Installing dependencies..."
npm install --prefer-offline --no-audit --no-fund 2>&1 || true

echo "Running database migrations..."
npx tsx scripts/run-migrations.ts 2>&1

echo "Running client-app typecheck (tsc --noEmit)..."
npm run --silent typecheck:client

echo "Running i18n key + same-as-English value check..."
npm run --silent check:i18n-keys

echo "Running sitemap coverage check..."
npm run --silent check:sitemap-coverage

echo "Running client-app unit tests (vitest)..."
pnpm --filter client-app test

echo "Running design-system regression checks..."
bash scripts/ci-design-checks.sh

echo "=== Post-merge setup complete ==="
