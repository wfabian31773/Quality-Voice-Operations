import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
