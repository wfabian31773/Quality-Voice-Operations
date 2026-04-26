import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const scriptPath = join(process.cwd(), 'scripts/backfill-retry-skipped-reason.ts');
const scriptFile = readFileSync(scriptPath, 'utf8');

describe('backfill-retry-skipped-reason script', () => {
  it('exists at the expected path', () => {
    expect(existsSync(scriptPath)).toBe(true);
  });

  it('imports the server-side classifier so the keyword list cannot drift', () => {
    expect(scriptFile).toMatch(
      /import\s*\{\s*isPermanentSmtpError\s*\}\s*from\s*'\.\.\/platform\/email\/smtpErrorClass'/,
    );
  });

  it('walks all three tables that gained the retry_skipped_reason column', () => {
    expect(scriptFile).toMatch(/table:\s*'support_ticket_replies'/);
    expect(scriptFile).toMatch(/table:\s*'support_tickets'/);
    expect(scriptFile).toMatch(/table:\s*'docs_feedback_replies'/);
  });

  it('only scans outbound rows in support_ticket_replies (inbound rows have no delivery error)', () => {
    expect(scriptFile).toMatch(/extraPredicate:\s*"direction = 'outbound'"/);
  });

  it('skips rows that already have a non-NULL retry_skipped_reason so re-runs are no-ops', () => {
    expect(scriptFile).toMatch(/retry_skipped_reason IS NULL/);
  });

  it("only stamps the canonical 'permanent_smtp_failure' value", () => {
    expect(scriptFile).toMatch(/retry_skipped_reason\s*=\s*'permanent_smtp_failure'/);
  });

  it('supports a --dry-run flag for ops to preview the impact before writing', () => {
    expect(scriptFile).toMatch(/--dry-run/);
  });

  it('uses the same DATABASE_URL / PLATFORM_DB_POOL_URL split as run-migrations.ts', () => {
    expect(scriptFile).toMatch(/DATABASE_URL/);
    expect(scriptFile).toMatch(/PLATFORM_DB_POOL_URL/);
  });
});
