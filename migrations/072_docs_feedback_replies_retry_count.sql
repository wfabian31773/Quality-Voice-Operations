-- Track auto-retry attempts on outbound docs feedback replies so the background
-- DocsFeedbackReplyRetryScheduler can stop after N tries and so the admin UI
-- can see how many retries happened before a Failed badge sticks.
--
-- Mirrors migrations/069_support_ticket_replies_retry_count.sql so the docs
-- feedback reply pipeline stays symmetric with the support reply pipeline:
-- the same column shape lets a single auto-retry pattern apply to both.

ALTER TABLE docs_feedback_replies
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE docs_feedback_replies
  ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ;

-- Partial index used by the auto-retry scheduler to cheaply find the small set
-- of recently-failed outbound replies that still have retries remaining.
CREATE INDEX IF NOT EXISTS docs_feedback_replies_retry_idx
  ON docs_feedback_replies(created_at)
  WHERE email_error IS NOT NULL;
