import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  partitionFailuresByPermanence,
  renderDigestEmail,
  shouldAutoRetryFailedDocsFeedbackReply,
  type FailedReply,
} from '../../platform/help/DocsFeedbackReplyDigestScheduler';

const supportFile = readFileSync(
  join(process.cwd(), 'server/admin-api/routes/support.ts'),
  'utf8',
);
const schedulerFile = readFileSync(
  join(process.cwd(), 'platform/help/DocsFeedbackReplyDigestScheduler.ts'),
  'utf8',
);
const startFile = readFileSync(
  join(process.cwd(), 'server/admin-api/start.ts'),
  'utf8',
);
const migration = readFileSync(
  join(process.cwd(), 'migrations/058_docs_feedback_reply_digest.sql'),
  'utf8',
);

describe('docs feedback failed-reply surfacing', () => {
  it('GET /docs/feedback/comments joins the latest reply and exposes last_reply_failed', () => {
    expect(supportFile).toMatch(/LEFT JOIN LATERAL/);
    expect(supportFile).toMatch(/last_reply_failed/);
    expect(supportFile).toMatch(/lr\.email_error IS NOT NULL/);
  });

  it('supports a reply_state=failed filter on the comments list', () => {
    expect(supportFile).toMatch(/reply_state/);
    expect(supportFile).toMatch(/replyFailedOnly/);
  });

  it('orders failed replies to the top of the inbox', () => {
    expect(supportFile).toMatch(
      /ORDER BY \(lr\.email_error IS NOT NULL\) DESC, f\.created_at DESC/,
    );
  });

  it('exposes a manual-run endpoint for the reply-failure digest', () => {
    expect(supportFile).toMatch(
      /router\.post\(\s*'\/docs\/feedback\/reply-failures\/run'/,
    );
    expect(supportFile).toMatch(/runDocsFeedbackReplyDigestCycle/);
  });

  it('exposes a one-click retry endpoint that re-sends the previous reply', () => {
    expect(supportFile).toMatch(
      /router\.post\(\s*\n?\s*'\/docs\/feedback\/comments\/:id\/reply\/retry'/,
    );
    expect(supportFile).toMatch(/FROM docs_feedback_replies\s*\n\s*WHERE feedback_id = \$1\s*\n\s*ORDER BY created_at DESC\s*\n\s*LIMIT 1/);
    expect(supportFile).toMatch(/Docs feedback reply retried/);
  });

  it('only allows retry when the latest reply actually failed', () => {
    expect(supportFile).toMatch(/Latest reply already delivered; nothing to retry/);
    expect(supportFile).toMatch(/if \(!lastReply\.email_error\)/);
  });

  it('shares the email-send + persist logic between reply and retry', () => {
    expect(supportFile).toMatch(/deliverDocsFeedbackReply/);
    const occurrences = supportFile.match(/deliverDocsFeedbackReply\(/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });
});

describe('docs feedback reply digest scheduler', () => {
  it('only surfaces failed replies that have not yet been notified', () => {
    expect(schedulerFile).toMatch(/email_error IS NOT NULL/);
    expect(schedulerFile).toMatch(/digest_notified_at IS NULL/);
  });

  it('marks failures as notified after sending', () => {
    expect(schedulerFile).toMatch(/digest_notified_at = NOW\(\)/);
  });

  it('is started and stopped alongside the admin API', () => {
    expect(startFile).toMatch(/startDocsFeedbackReplyDigestScheduler/);
    expect(startFile).toMatch(/stopDocsFeedbackReplyDigestScheduler/);
  });
});

describe('docs feedback reply digest — SMTP classifier wiring', () => {
  it('imports the shared isPermanentSmtpError classifier', () => {
    expect(schedulerFile).toMatch(/isPermanentSmtpError/);
    expect(schedulerFile).toMatch(/from '\.\.\/email\/smtpErrorClass'/);
  });

  it('exposes a gating helper for any future docs-feedback auto-retry scheduler', () => {
    expect(typeof shouldAutoRetryFailedDocsFeedbackReply).toBe('function');
    // Permanent → do NOT auto-retry.
    expect(shouldAutoRetryFailedDocsFeedbackReply('550 5.1.1 user unknown')).toBe(false);
    expect(shouldAutoRetryFailedDocsFeedbackReply('Mailbox not found')).toBe(false);
    expect(shouldAutoRetryFailedDocsFeedbackReply('Recipient address rejected')).toBe(false);
    // Transient → safe to auto-retry.
    expect(shouldAutoRetryFailedDocsFeedbackReply('connection refused')).toBe(true);
    expect(shouldAutoRetryFailedDocsFeedbackReply('ETIMEDOUT')).toBe(true);
    expect(shouldAutoRetryFailedDocsFeedbackReply('451 4.7.1 greylisted')).toBe(true);
    expect(shouldAutoRetryFailedDocsFeedbackReply(null)).toBe(true);
    expect(shouldAutoRetryFailedDocsFeedbackReply(undefined)).toBe(true);
  });

  it('documents that the classifier must gate any future auto-retry path', () => {
    // Future-proofing comment: anyone who lands an auto-retry scheduler for
    // this pipeline must gate on the same classifier as the support-reply
    // path so we don't waste sender reputation on hard bounces.
    expect(schedulerFile).toMatch(/auto-retry/i);
    expect(schedulerFile).toMatch(/lockstep|same classifier|gate/i);
  });
});

describe('partitionFailuresByPermanence', () => {
  const baseReply = (overrides: Partial<FailedReply>): FailedReply => ({
    reply_id: 1,
    feedback_id: 100,
    article_slug: 'getting-started',
    to_email: 'reader@example.com',
    subject: 'Re: feedback',
    email_error: 'connection refused',
    sent_by: 'admin@example.com',
    created_at: new Date('2026-04-01T12:00:00Z'),
    ...overrides,
  });

  it('puts 5xx / mailbox-unknown / recipient-rejected rows into the permanent bucket', () => {
    const replies = [
      baseReply({ reply_id: 1, email_error: '550 5.1.1 user unknown' }),
      baseReply({ reply_id: 2, email_error: 'Mailbox not found' }),
      baseReply({ reply_id: 3, email_error: 'Recipient address rejected' }),
      baseReply({ reply_id: 4, email_error: 'EENVELOPE: invalid envelope address' }),
    ];
    const { permanent, transient } = partitionFailuresByPermanence(replies);
    expect(permanent.map((r) => r.reply_id)).toEqual([1, 2, 3, 4]);
    expect(transient).toEqual([]);
  });

  it('puts timeouts / 4xx / connection failures into the transient bucket', () => {
    const replies = [
      baseReply({ reply_id: 1, email_error: 'connection refused' }),
      baseReply({ reply_id: 2, email_error: 'ETIMEDOUT' }),
      baseReply({ reply_id: 3, email_error: '451 4.7.1 greylisted, try later' }),
      baseReply({ reply_id: 4, email_error: '421 Service not available' }),
    ];
    const { permanent, transient } = partitionFailuresByPermanence(replies);
    expect(transient.map((r) => r.reply_id)).toEqual([1, 2, 3, 4]);
    expect(permanent).toEqual([]);
  });

  it('splits a mixed batch correctly', () => {
    const replies = [
      baseReply({ reply_id: 1, email_error: '550 user unknown' }),
      baseReply({ reply_id: 2, email_error: 'connection refused' }),
      baseReply({ reply_id: 3, email_error: 'mailbox is full' }),
      baseReply({ reply_id: 4, email_error: '450 4.7.1 greylisted' }),
    ];
    const { permanent, transient } = partitionFailuresByPermanence(replies);
    expect(permanent.map((r) => r.reply_id)).toEqual([1, 3]);
    expect(transient.map((r) => r.reply_id)).toEqual([2, 4]);
  });
});

describe('renderDigestEmail — permanent vs transient sections', () => {
  const baseReply = (overrides: Partial<FailedReply>): FailedReply => ({
    reply_id: 1,
    feedback_id: 100,
    article_slug: 'getting-started',
    to_email: 'reader@example.com',
    subject: 'Re: feedback',
    email_error: 'connection refused',
    sent_by: 'admin@example.com',
    created_at: new Date('2026-04-01T12:00:00Z'),
    ...overrides,
  });

  it('renders both sections with explicit headings + counts when both buckets have rows', () => {
    const out = renderDigestEmail([
      baseReply({ reply_id: 1, article_slug: 'hard-bounce-doc', email_error: '550 user unknown' }),
      baseReply({ reply_id: 2, article_slug: 'transient-doc', email_error: 'connection refused' }),
    ]);
    // HTML contains both labelled sections
    expect(out.html).toMatch(/Permanent failures.*hard bounces.*do not auto-retry/);
    expect(out.html).toMatch(/Transient failures.*safe to retry/);
    expect(out.html).toMatch(/\(1\)/); // each section has a (count)
    // The right rows ended up in the right tables
    expect(out.html).toContain('hard-bounce-doc');
    expect(out.html).toContain('transient-doc');
    // Subject shows the breakdown so on-call sees it at a glance
    expect(out.subject).toMatch(/2 feedback replies failed to send.*1 permanent.*1 transient/);
  });

  it('omits the empty-bucket section entirely when only permanent failures exist', () => {
    const out = renderDigestEmail([
      baseReply({ reply_id: 1, email_error: '550 mailbox not found' }),
      baseReply({ reply_id: 2, email_error: 'Recipient address rejected' }),
    ]);
    expect(out.html).toMatch(/Permanent failures/);
    expect(out.html).not.toMatch(/Transient failures/);
    expect(out.text).toMatch(/Permanent failures/);
    expect(out.text).not.toMatch(/Transient failures/);
  });

  it('omits the empty-bucket section entirely when only transient failures exist', () => {
    const out = renderDigestEmail([
      baseReply({ reply_id: 1, email_error: 'connection refused' }),
      baseReply({ reply_id: 2, email_error: 'ETIMEDOUT' }),
    ]);
    expect(out.html).toMatch(/Transient failures/);
    expect(out.html).not.toMatch(/Permanent failures/);
    expect(out.text).toMatch(/Transient failures/);
    expect(out.text).not.toMatch(/Permanent failures/);
  });

  it('plain text body labels each row under its category heading', () => {
    const out = renderDigestEmail([
      baseReply({ reply_id: 1, article_slug: 'hard-doc', email_error: '550 user unknown' }),
      baseReply({ reply_id: 2, article_slug: 'soft-doc', email_error: 'connection refused' }),
    ]);
    const permanentIdx = out.text.indexOf('Permanent failures');
    const transientIdx = out.text.indexOf('Transient failures');
    expect(permanentIdx).toBeGreaterThan(-1);
    expect(transientIdx).toBeGreaterThan(-1);
    // Permanent section comes first and contains hard-doc
    expect(out.text.indexOf('hard-doc')).toBeGreaterThan(permanentIdx);
    expect(out.text.indexOf('hard-doc')).toBeLessThan(transientIdx);
    // Transient section contains soft-doc
    expect(out.text.indexOf('soft-doc')).toBeGreaterThan(transientIdx);
  });

  it('keeps the single-failure subject line stable (no breakdown noise for one row)', () => {
    const out = renderDigestEmail([
      baseReply({ reply_id: 1, email_error: '550 user unknown' }),
    ]);
    expect(out.subject).toBe('[QVO Docs] 1 feedback reply failed to send');
  });

  it('escapes hostile content in error strings even when classifying', () => {
    const out = renderDigestEmail([
      baseReply({
        reply_id: 1,
        email_error: '550 user unknown <script>alert(1)</script>',
      }),
    ]);
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).toContain('&lt;script&gt;');
    // Despite the script tag in the message, it still classified as permanent
    expect(out.html).toMatch(/Permanent failures/);
  });
});

describe('docs feedback reply digest migration', () => {
  it('adds digest_notified_at to docs_feedback_replies', () => {
    expect(migration).toMatch(/ALTER TABLE docs_feedback_replies/);
    expect(migration).toMatch(/digest_notified_at TIMESTAMPTZ/);
  });

  it('creates a partial index on failed replies', () => {
    expect(migration).toMatch(/docs_feedback_replies_failed_idx/);
    expect(migration).toMatch(/WHERE email_error IS NOT NULL/);
  });
});
