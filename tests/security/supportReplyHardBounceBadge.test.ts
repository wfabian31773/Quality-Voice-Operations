import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const adminUiFile = readFileSync(
  join(process.cwd(), 'client-app/src/pages/PlatformAdmin.tsx'),
  'utf8',
);
const clientClassifier = readFileSync(
  join(process.cwd(), 'client-app/src/lib/smtpErrorClass.ts'),
  'utf8',
);
const supportRoutes = readFileSync(
  join(process.cwd(), 'server/admin-api/routes/support.ts'),
  'utf8',
);
const schedulerFile = readFileSync(
  join(process.cwd(), 'platform/help/SupportReplyRetryScheduler.ts'),
  'utf8',
);

describe('PlatformAdmin support inbox — hard-bounce badge', () => {
  it('imports the persisted-reason helper from the client classifier module', () => {
    // The badge is driven by `retry_skipped_reason` (server-authoritative)
    // with a fallback to the legacy SMTP classifier for old rows. Both live
    // in the same module so the parity test still guards the keyword list.
    expect(adminUiFile).toMatch(
      /import\s*\{\s*isHardBounce\s*\}\s*from\s*'\.\.\/lib\/smtpErrorClass'/,
    );
  });

  it('keeps the legacy SMTP classifier shape so the parity test still guards both implementations', () => {
    expect(clientClassifier).toMatch(/PERMANENT_KEYWORDS/);
    expect(clientClassifier).toMatch(/4\\d\{2\}/);
    expect(clientClassifier).toMatch(/5\\d\{2\}/);
    expect(clientClassifier).toMatch(/export function isPermanentSmtpError/);
  });

  it('exposes an isHardBounce helper that prefers retry_skipped_reason and falls back to the classifier', () => {
    // Server-authoritative branch: the reason column wins over re-classifying
    // the email_error string client-side.
    expect(clientClassifier).toMatch(
      /retry_skipped_reason\s*===\s*'permanent_smtp_failure'/,
    );
    // Legacy fallback branch: rows written before the column existed still
    // render the badge by classifying email_error.
    expect(clientClassifier).toMatch(
      /return\s+isPermanentSmtpError\(\s*row\.email_error\s*\)/,
    );
    expect(clientClassifier).toMatch(/export function isHardBounce/);
  });

  it('renders a distinct "Hard bounce — won\'t auto-retry" badge for permanent reply failures', () => {
    // Reply badge in the support TicketThread. The string lives in two forms:
    // - JSX text: `Hard bounce — won&rsquo;t auto-retry`
    // - JS literal: `Hard bounce — won\u2019t auto-retry`
    expect(adminUiFile).toMatch(
      /Hard bounce[^"<]*won(?:&rsquo;|\\u2019|\u2019|')t auto-retry/,
    );
    // Driven by the persisted-reason helper, gated on the row having a
    // permanent failure (either via the column or the legacy classifier).
    expect(adminUiFile).toMatch(/isHardBounce\(\s*r\s*\)/);
  });

  it('annotates the docs-feedback "email-failure list" with the same hard-bounce indicator', () => {
    // The DocsFeedbackTab shows last_reply_error rows; they must drive the
    // badge from the same persisted column (exposed as
    // last_reply_retry_skipped_reason on the comment row) so ops can filter
    // and triage in one place.
    expect(adminUiFile).toMatch(
      /isHardBounce\(\{\s*retry_skipped_reason:\s*c\.last_reply_retry_skipped_reason,\s*email_error:\s*c\.last_reply_error,?\s*\}\)/,
    );
  });

  it('annotates the ticket-level email_error indicator on the inbox row', () => {
    expect(adminUiFile).toMatch(/isHardBounce\(\s*t\s*\)/);
    expect(adminUiFile).toMatch(/email failed \(hard bounce\)/);
  });

  it('explains in the failed-reply detail why auto-retry was skipped', () => {
    expect(adminUiFile).toMatch(
      /permanent SMTP failure[\s\S]{0,120}auto-retry/i,
    );
  });
});

describe('retry_skipped_reason — server writes the persisted column', () => {
  it('scheduler stamps `retry_skipped_reason = \'permanent_smtp_failure\'` when marking a row permanently failed', () => {
    // The exhaust UPDATE inside markReplyPermanentlyFailed must set the
    // reason in the same statement that bumps retry_count to MAX so the
    // badge stays in sync with the scheduler's decision.
    expect(schedulerFile).toMatch(
      /retry_skipped_reason\s*=\s*'permanent_smtp_failure'/,
    );
  });

  it('admin support routes write the reason on initial send, manual reply, manual retry, and docs-feedback reply', () => {
    // Every write path that may produce a hard bounce must stamp the column
    // so the admin UI never has to re-classify on the client.
    const reasonWrites = supportRoutes.match(
      /retry_skipped_reason/g,
    );
    expect(reasonWrites?.length ?? 0).toBeGreaterThanOrEqual(8);
    // And the API responses must expose the column so the UI can read it.
    expect(supportRoutes).toMatch(
      /SELECT[\s\S]*?retry_skipped_reason[\s\S]*?FROM support_ticket_replies/,
    );
    expect(supportRoutes).toMatch(
      /SELECT[\s\S]*?retry_skipped_reason[\s\S]*?FROM docs_feedback_replies/,
    );
    expect(supportRoutes).toMatch(
      /SELECT[\s\S]*?t\.retry_skipped_reason[\s\S]*?FROM support_tickets t/,
    );
    expect(supportRoutes).toMatch(
      /lr\.retry_skipped_reason\s+AS\s+last_reply_retry_skipped_reason/,
    );
  });
});
