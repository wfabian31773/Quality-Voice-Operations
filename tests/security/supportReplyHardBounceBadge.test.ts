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
    // We allow other named imports from the same module (e.g. the wider
    // `describeRetrySkippedReason` family used by the new skip-reason
    // badges) — the spec is "isHardBounce comes from this exact module",
    // not "isHardBounce is the only thing imported from it".
    expect(adminUiFile).toMatch(
      /import\s*\{[^}]*\bisHardBounce\b[^}]*\}\s*from\s*'\.\.\/lib\/smtpErrorClass'/,
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

describe('retry_skipped_reason — distinct badge per known reason', () => {
  // The four reasons the server can stamp today. The describeRetrySkippedReason
  // helper must return a distinct shortLabel + tone for each so the admin UI
  // doesn't collapse them into one indistinguishable pill, and an unknown
  // value must fall through to a generic badge so a server upgrade can't
  // crash the UI.
  const reasonMatrix: Array<{ reason: string; shortLabel: RegExp; tone: string }> = [
    { reason: 'permanent_smtp_failure',  shortLabel: /Hard bounce/,             tone: 'hard_bounce' },
    { reason: 'suppression_list',        shortLabel: /Suppressed by ops/,       tone: 'suppression' },
    { reason: 'manual_cancel',           shortLabel: /Manually cancelled/,      tone: 'manual_cancel' },
    { reason: 'recipient_unsubscribed',  shortLabel: /Recipient unsubscribed/,  tone: 'unsubscribed' },
  ];

  for (const { reason, shortLabel, tone } of reasonMatrix) {
    it(`describeRetrySkippedReason returns a distinct badge for '${reason}'`, () => {
      // Source-level assertions: the case arm exists, points at the right
      // tone, and the shortLabel string is in the file. Done as a source
      // scan (instead of importing the module) to stay consistent with the
      // rest of this suite — it intentionally has no jsdom / TS-loader
      // dependency so it runs in any environment.
      const arm = new RegExp(
        `case\\s+RETRY_SKIPPED_REASON_[A-Z_]+:\\s*[\\s\\S]{0,400}?shortLabel:\\s*['"]${shortLabel.source.replace(/\//g, '')}.*?['"][\\s\\S]{0,400}?tone:\\s*'${tone}'`,
      );
      expect(clientClassifier).toMatch(arm);
      expect(clientClassifier).toContain(`'${reason}'`);
    });
  }

  it('falls through to a generic "Auto-retry skipped" badge with tone "unknown" for an unrecognised reason', () => {
    // Critical for forward compatibility: a server that starts writing a new
    // reason before the client knows about it must still render *something*.
    expect(clientClassifier).toMatch(
      /default:[\s\S]{0,300}?shortLabel:\s*'Auto-retry skipped'[\s\S]{0,300}?tone:\s*'unknown'/,
    );
  });

  it('returns null when the column is unset (no badge for in-flight rows)', () => {
    // Guards against accidentally rendering a "skipped" badge on rows that
    // are still in the auto-retry pool.
    expect(clientClassifier).toMatch(/if\s*\(!reason\)\s*return\s+null/);
  });
});

describe('retry_skipped_reason — server writes the new non-bounce reasons', () => {
  it('manual cancel endpoint stamps `manual_cancel` and refuses to downgrade an existing reason', () => {
    // The /cancel-retries route is the source of truth for the manual_cancel
    // reason. It must be idempotent (won't re-stamp once cancelled) and must
    // preserve a more-specific permanent_smtp_failure reason if one already
    // landed (a hard bounce must not be silently rebadged as a manual cancel).
    expect(supportRoutes).toMatch(
      /retry_skipped_reason\s*=\s*'manual_cancel'/,
    );
    expect(supportRoutes).toMatch(
      /retry_skipped_reason\s+IS\s+NULL/i,
    );
  });

  it('every customer-facing send site pre-checks the suppression / unsubscribe list', () => {
    // Three send sites — initial docs-feedback reply, manual /reply, and
    // manual /retry — must short-circuit before sendEmail() if the recipient
    // is on either list, and stamp the matching reason on the row instead.
    const skipChecks = supportRoutes.match(/checkSupportEmailSkip\(/g);
    expect(skipChecks?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('every customer-facing send site auto-adds permanently-failed addresses to the suppression list', () => {
    // Mirror of the pre-check: a real hard bounce at any of the three send
    // sites must seed the suppression list so the next send to that address
    // hits the cheap pre-check path above.
    const suppressionWrites = supportRoutes.match(/addSupportEmailSuppression\(/g);
    expect(suppressionWrites?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('scheduler stamps the list-based reasons (suppression_list / recipient_unsubscribed) before retrying', () => {
    // The auto-retry worker must consult the same lists so a recipient who
    // bounced on one ticket doesn't keep getting retried on others.
    expect(schedulerFile).toMatch(/checkSupportEmailSkip\(/);
    expect(schedulerFile).toMatch(/markReplySkippedByList\(/);
    // And the helper must accept BOTH reasons (the SupportEmailSkipReason
    // union covers suppression_list + recipient_unsubscribed).
    expect(schedulerFile).toMatch(/SupportEmailSkipReason/);
  });

  it('scheduler hard-bounce arm seeds the suppression list so OTHER tickets short-circuit', () => {
    // Without this, a recipient who bounces on one ticket would keep getting
    // the full SMTP round-trip on every other ticket until each one
    // independently classified as permanent.
    expect(schedulerFile).toMatch(/addSupportEmailSuppression\(/);
  });
});

describe('SupportEmailSuppression module — list semantics', () => {
  const suppressionFile = readFileSync(
    join(process.cwd(), 'platform/email/SupportEmailSuppression.ts'),
    'utf8',
  );

  it('keys both lists on the lowercased address so mixed-case retries cannot bypass entries', () => {
    expect(suppressionFile).toMatch(/email\.trim\(\)\.toLowerCase\(\)/);
    expect(suppressionFile).toMatch(/WHERE\s+email_lower\s*=\s*\$1/);
  });

  it('unsubscribe wins over suppression so an admin clearing a suppression cannot re-enable mail to an opted-out address', () => {
    // Precedence rule: inside checkSupportEmailSkip, the unsubscribe SELECT
    // must run first and an early-return `recipient_unsubscribed` decision
    // must happen before the suppression SELECT is even issued. We assert
    // that ordering on the actual SQL/decision lines (anchored on the
    // FROM clause) so the header doc comment doesn't influence the result.
    const unsubSelectIdx = suppressionFile.indexOf('FROM support_email_unsubscribes');
    const suppSelectIdx  = suppressionFile.indexOf('FROM support_email_suppressions');
    expect(unsubSelectIdx).toBeGreaterThan(0);
    expect(suppSelectIdx).toBeGreaterThan(unsubSelectIdx);

    // And the unsubscribe arm must produce the recipient_unsubscribed
    // decision before any suppression branch runs.
    const unsubReturnIdx = suppressionFile.indexOf("reason: 'recipient_unsubscribed'");
    const suppReturnIdx  = suppressionFile.indexOf("reason: 'suppression_list'");
    expect(unsubReturnIdx).toBeGreaterThan(0);
    expect(suppReturnIdx).toBeGreaterThan(unsubReturnIdx);
  });

  it('suppression insert is idempotent via ON CONFLICT so repeated bounces just refresh the row', () => {
    expect(suppressionFile).toMatch(/ON\s+CONFLICT\s*\(\s*email_lower\s*\)\s*DO\s+UPDATE/i);
  });

  it('returns NO_SKIP on a transient DB error so a lookup failure cannot block legitimate sends', () => {
    // Documented fail-open posture (see follow-up note about a future fail-
    // closed compliance toggle for unsubscribed recipients).
    expect(suppressionFile).toMatch(/return\s+NO_SKIP/);
    expect(suppressionFile).toMatch(/proceeding without skip/i);
  });
});
