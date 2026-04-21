import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const supportFile = readFileSync(
  join(process.cwd(), 'server/admin-api/routes/support.ts'),
  'utf8',
);
const schedulerFile = readFileSync(
  join(process.cwd(), 'platform/help/DocsFeedbackAlertScheduler.ts'),
  'utf8',
);
const migration = readFileSync(
  join(process.cwd(), 'migrations/059_docs_feedback_pending_reply_alerts.sql'),
  'utf8',
);

describe('docs feedback pending-reply alert scheduler', () => {
  it('queries pending-reply rows that match the documented criteria', () => {
    expect(schedulerFile).toMatch(/findPendingReplyComments/);
    expect(schedulerFile).toMatch(/reply_email IS NOT NULL/);
    expect(schedulerFile).toMatch(/reply_count = 0/);
    expect(schedulerFile).toMatch(/status <> 'hidden'/);
    expect(schedulerFile).toMatch(/created_at <= NOW\(\) - \(\$1 \|\| ' hours'\)::interval/);
  });

  it('respects a per-comment cooldown so the inbox is not spammed', () => {
    expect(schedulerFile).toMatch(/pending_reply_alerted_at IS NULL/);
    expect(schedulerFile).toMatch(/pending_reply_alerted_at <= NOW\(\) - \(\$2 \|\| ' hours'\)::interval/);
    expect(schedulerFile).toMatch(/SET pending_reply_alerted_at = NOW\(\)/);
  });

  it('runs alongside the underperforming-article cycle', () => {
    expect(schedulerFile).toMatch(/runDocsFeedbackPendingReplyAlertCycle/);
    expect(schedulerFile).toMatch(/runDocsFeedbackPendingReplyAlertCycle\(\)\.catch/);
  });
});

describe('docs feedback pending-reply admin endpoint', () => {
  it('exposes a manual-run endpoint', () => {
    expect(supportFile).toMatch(/router\.post\(\s*'\/docs\/feedback\/pending-replies\/run'/);
    expect(supportFile).toMatch(/runDocsFeedbackPendingReplyAlertCycle/);
  });
});

describe('docs feedback pending-reply migration', () => {
  it('adds pending_reply_alerted_at to docs_feedback', () => {
    expect(migration).toMatch(/ALTER TABLE docs_feedback/);
    expect(migration).toMatch(/pending_reply_alerted_at TIMESTAMPTZ/);
  });

  it('creates a partial index on pending-reply rows', () => {
    expect(migration).toMatch(/docs_feedback_pending_reply_idx/);
    expect(migration).toMatch(/WHERE reply_email IS NOT NULL AND reply_count = 0 AND status <> 'hidden'/);
  });
});
