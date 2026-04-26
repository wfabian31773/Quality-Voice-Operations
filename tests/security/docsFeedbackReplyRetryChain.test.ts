import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const supportFile = readFileSync(
  join(process.cwd(), 'server/admin-api/routes/support.ts'),
  'utf8',
);
const platformAdminFile = readFileSync(
  join(process.cwd(), 'client-app/src/pages/PlatformAdmin.tsx'),
  'utf8',
);
const migration = readFileSync(
  join(process.cwd(), 'migrations/070_docs_feedback_replies_retry_of.sql'),
  'utf8',
);

describe('docs feedback reply retry-chain migration', () => {
  it('adds a self-referencing retry_of column to docs_feedback_replies', () => {
    expect(migration).toMatch(/ALTER TABLE docs_feedback_replies/);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS retry_of INTEGER/);
    expect(migration).toMatch(
      /REFERENCES docs_feedback_replies\(id\) ON DELETE SET NULL/,
    );
  });

  it('creates a partial index on retry_of for chain lookups', () => {
    expect(migration).toMatch(/docs_feedback_replies_retry_of_idx/);
    expect(migration).toMatch(/WHERE retry_of IS NOT NULL/);
  });
});

describe('docs feedback reply retry-chain backend', () => {
  it('persists retry_of when inserting a reply row', () => {
    expect(supportFile).toMatch(
      /INSERT INTO docs_feedback_replies\s*\n\s*\(feedback_id, sent_by, to_email, subject, body, email_message_id, email_error, retry_of\)/,
    );
  });

  it('returns retry_of from the replies list endpoint', () => {
    expect(supportFile).toMatch(
      /SELECT id, feedback_id, sent_by, to_email, subject, body,\s*\n\s*email_message_id, email_error, retry_of, created_at\s*\n\s*FROM docs_feedback_replies/,
    );
  });

  it('threads retry_of through deliverDocsFeedbackReply', () => {
    expect(supportFile).toMatch(/retryOf\?: number \| null/);
    expect(supportFile).toMatch(/retryOf\s*=\s*null\s*\}\s*=\s*input/);
  });

  it('points retry_of at the chain root, not the immediate previous attempt', () => {
    // The retry route should inherit the previous attempt's retry_of when set
    // so that retries-of-retries still hang off the original send.
    expect(supportFile).toMatch(/lastReply\.retry_of\s*\?\?\s*lastReply\.id/);
    expect(supportFile).toMatch(/retryOf:\s*chainRoot/);
  });

  it('reads retry_of off the previous attempt when computing the chain root', () => {
    expect(supportFile).toMatch(
      /SELECT id, subject, body, to_email, email_error, retry_of\s*\n\s*FROM docs_feedback_replies/,
    );
  });
});

describe('docs feedback reply retry-chain UI', () => {
  it('declares retry_of on the DocsFeedbackReply type', () => {
    expect(platformAdminFile).toMatch(/retry_of:\s*number \| null/);
  });

  it('groups retries under their original attempt', () => {
    expect(platformAdminFile).toMatch(/groupDocsFeedbackReplyChains/);
    expect(platformAdminFile).toMatch(/chainsByRoot/);
  });

  it('labels retry rows with a Retry # badge and the attempt count', () => {
    expect(platformAdminFile).toMatch(/Retry #\{idx \+ 1\}/);
    expect(platformAdminFile).toMatch(/\{totalAttempts\} attempts/);
  });

  it('does not repeat the body for each retry row', () => {
    // The retry rows render only timestamp/from/status, not the body again,
    // because retries always carry the same body as the chain root.
    const idx = platformAdminFile.indexOf('Retries of this attempt');
    expect(idx).toBeGreaterThan(-1);
    const after = platformAdminFile.slice(idx, idx + 800);
    expect(after).not.toMatch(/whitespace-pre-wrap/);
  });
});
