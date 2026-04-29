/**
 * Audit guard for task #1006.
 *
 * "Done = grep for hardcoded `$` / `USD` in client-app/server returns
 * no business-logic matches."
 *
 * This test mechanizes that grep so the criterion stays enforced over
 * time. It scans the relevant business-logic source trees and fails if
 * a money-shaped hardcoded "$N" / "$ {N}" literal or a hardcoded "USD"
 * string sneaks into the codebase outside the documented allow-list.
 *
 * Allow-listed surfaces (intentional and documented in task #1006's
 * audit notes):
 *   - useTenantCurrency.ts / formatCurrency.ts default-fallback constants
 *   - BillingEstimator's optional `currency` prop default
 *   - PlatformAdmin / AdminAnalytics: platform-aggregate USD figures
 *     across tenants of mixed currencies (intentional design)
 *   - Public marketing pages (Pricing, Signup, ROICalculator,
 *     MinutesPricingCalculator, Product schema.org metadata): no tenant
 *     context yet
 *   - Demo voice tool handler: scripted USD scenario, formatted via Intl
 *   - Tests, migrations, comments, SQL parameter placeholders ($1, $2)
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  // --- Default-fallback constants ---
  'client-app/src/hooks/useTenantCurrency.ts',
  'client-app/src/lib/formatCurrency.ts',
  // --- BillingEstimator optional prop default ---
  'client-app/src/components/BillingEstimator.tsx',
  // --- Platform-aggregate (cross-tenant) USD figures, by design ---
  'client-app/src/pages/PlatformAdmin.tsx',
  'client-app/src/pages/AdminAnalytics.tsx',
  // --- Public marketing / pre-tenant surfaces ---
  'client-app/src/pages/public/Pricing.tsx',
  'client-app/src/pages/public/Signup.tsx',
  'client-app/src/pages/public/ROICalculator.tsx',
  'client-app/src/pages/public/MinutesPricingCalculator.tsx',
  'client-app/src/pages/public/Product.tsx',
  'client-app/src/pages/public/CaseStudies.tsx',
  'client-app/src/pages/public/BlogArticle.tsx',
  'client-app/src/pages/public/Landing.tsx',
  'client-app/src/components/ROICalculator.tsx',
  'client-app/src/components/IndustryShowcase.tsx',
  'client-app/src/components/LiveTranscriptMock.tsx',
  // --- Public marketing: blog article body copy with US-stats prose ---
  'client-app/src/data/blogArticles.ts',
  // --- Server: demo voice scenario (scripted USD), formatted via Intl ---
  'server/voice-gateway/services/demoToolHandler.ts',
  // --- Server: tenants/platformAdmin queries COALESCE missing
  //     billing_currency to 'usd' as a DB-level default (not copy). ---
  'server/admin-api/routes/tenants.ts',
  'server/admin-api/routes/platformAdmin.ts',
]);

function runRipgrep(args: string[]): string {
  try {
    return execFileSync('rg', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      // ripgrep exits 1 when no matches; treat that as "no output"
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const exec = err as { status?: number; stdout?: string };
    if (exec.status === 1) return '';
    throw err;
  }
}

interface Match {
  file: string;
  line: number;
  text: string;
}

function parseMatches(out: string): Match[] {
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      // ripgrep -n format: "<file>:<line>:<text>"
      const firstColon = row.indexOf(':');
      const secondColon = row.indexOf(':', firstColon + 1);
      const file = row.slice(0, firstColon);
      const line = Number(row.slice(firstColon + 1, secondColon));
      const text = row.slice(secondColon + 1);
      return { file, line, text };
    });
}

function isExcludedPath(file: string): boolean {
  if (file.startsWith('tests/') || file.startsWith('client-app/tests/')) return true;
  if (file.includes('/__tests__/') || file.includes('.test.') || file.includes('.spec.')) {
    return true;
  }
  if (file.includes('/migrations/')) return true;
  if (file.endsWith('.md') || file.endsWith('.json') || file.endsWith('.snap')) {
    return true;
  }
  return false;
}

function isCommentLine(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('#')
  );
}

function isSqlPlaceholder(text: string): boolean {
  // (a) Template-literal SQL builders use `$${...}` to render $1, $2, etc.
  if (/\$\$\{[^}]+\}/.test(text)) return true;
  // (b) Plain SQL strings include `$1`, `$2`, ... `$N` as parameter
  //     placeholders. Several detection heuristics for SQL-shaped lines:
  const hasNumberedPlaceholder = /\$\d+/.test(text);
  if (!hasNumberedPlaceholder) return false;

  // SQL keywords / idioms.
  if (
    /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|VALUES|RETURNING|JOIN|SET|AND|OR|LIMIT|OFFSET|ANY|COALESCE|GREATEST|LEAST|NOW\s*\(|CASE|WHEN|THEN|ELSE|END|IS\s+NULL|NOT\s+NULL|NULL)\b/.test(text)
  ) {
    return true;
  }
  // `column = $N` or `column = column + $N` style fragment.
  if (/\b[a-z_][a-z0-9_]*\s*=\s*[a-z_0-9.+\s]*\$\d+/.test(text)) return true;
  // Continuation row of a VALUES clause: e.g. "$5, $6, $7, NULL,".
  if (/^\s*\$\d+\s*,/.test(text) || /,\s*\$\d+\s*[,)]/.test(text)) return true;
  // Postgres type cast on a placeholder: $3::text[]
  if (/\$\d+::/.test(text)) return true;
  return false;
}

function isRegexBackref(text: string): boolean {
  // Matches `.replace(..., '...$1...')` style backreferences in any
  // form: replace second arg can be a quoted string OR a regex literal
  // that contains `$1`. Accept either form on the same line.
  if (/\.replace\s*\(/.test(text) && /\$\d/.test(text)) return true;
  // Stand-alone regex literal carrying a backref (e.g. assigned to a const).
  if (/\/[^/\n]*\$\d[^/\n]*\/[gimsuy]*/.test(text)) return true;
  return false;
}

describe('task #1006 audit: no hardcoded business-logic $ / USD outside the allow-list', () => {
  it('no $-shaped money literal appears in client-app/src or server source', () => {
    // Money-shaped: a literal $ followed by a digit, optionally with
    // a space, in a string or template literal context. We deliberately
    // exclude template-literal SQL placeholders ($${...}) below.
    const out = runRipgrep([
      '-n',
      '--type', 'ts',
      '-e', '\\$\\s*[0-9]',
      'client-app/src',
      'server',
    ]);
    const matches = parseMatches(out)
      .filter((m) => !isExcludedPath(m.file))
      .filter((m) => !isCommentLine(m.text))
      .filter((m) => !isSqlPlaceholder(m.text))
      .filter((m) => !isRegexBackref(m.text))
      .filter((m) => !ALLOWED_FILES.has(m.file));

    if (matches.length > 0) {
      const detail = matches
        .map((m) => `  ${m.file}:${m.line}: ${m.text.trim()}`)
        .join('\n');
      throw new Error(
        `Found hardcoded money-shaped $ literals in business logic:\n${detail}\n\n` +
        `These should use useTenantCurrency() + formatCents (client) or the ` +
        `tenant's billing_currency (server). If a match is intentional, add the ` +
        `file path to ALLOWED_FILES in tests/lint/noHardcodedCurrency.test.ts ` +
        `with a comment explaining why.`,
      );
    }
    expect(matches).toEqual([]);
  });

  it("no hardcoded 'USD' string literal appears outside the allow-list", () => {
    const out = runRipgrep([
      '-n',
      '--type', 'ts',
      '-e', "['\"]USD['\"]",
      'client-app/src',
      'server',
    ]);
    const matches = parseMatches(out)
      .filter((m) => !isExcludedPath(m.file))
      .filter((m) => !isCommentLine(m.text))
      .filter((m) => !ALLOWED_FILES.has(m.file));

    if (matches.length > 0) {
      const detail = matches
        .map((m) => `  ${m.file}:${m.line}: ${m.text.trim()}`)
        .join('\n');
      throw new Error(
        `Found hardcoded 'USD' literals in business logic:\n${detail}\n\n` +
        `These should read the tenant's billing_currency. If a match is ` +
        `intentional, add the file path to ALLOWED_FILES in ` +
        `tests/lint/noHardcodedCurrency.test.ts with a comment explaining why.`,
      );
    }
    expect(matches).toEqual([]);
  });
});
