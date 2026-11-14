#!/usr/bin/env node
/**
 * Fail if a vitest JSON report shows skipped/pending DB tests (or zero passes).
 * The isolation / RLS suites use describe.skipIf(!dbUrl) — a miswired
 * DATABASE_URL would otherwise make CI green without proving anything.
 *
 * Usage: node scripts/ci-assert-vitest-ran.mjs .ci-logs/db-security-vitest.json
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/ci-assert-vitest-ran.mjs <vitest-json-report>');
  process.exit(2);
}

const report = JSON.parse(readFileSync(file, 'utf8'));
const passed = report.numPassedTests ?? 0;
const pending = report.numPendingTests ?? 0;
const todo = report.numTodoTests ?? 0;
const failed = report.numFailedTests ?? 0;

if (pending || todo || !passed) {
  console.error('::error::DB security suites skipped instead of running', {
    passed,
    failed,
    pending,
    todo,
  });
  process.exit(1);
}

console.log(`DB security suites ran: ${passed} passed, 0 skipped`);
