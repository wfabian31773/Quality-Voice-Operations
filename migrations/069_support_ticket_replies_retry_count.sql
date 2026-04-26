-- Track auto-retry attempts on outbound support replies so the background
-- SupportReplyRetryScheduler can stop after N tries and so the admin UI can
-- see how many retries happened before a Failed badge sticks.

ALTER TABLE support_ticket_replies
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE support_ticket_replies
  ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ;

-- Partial index used by the auto-retry scheduler to cheaply find the small set
-- of recently-failed outbound replies that still have retries remaining.
CREATE INDEX IF NOT EXISTS support_ticket_replies_retry_idx
  ON support_ticket_replies(created_at)
  WHERE direction = 'outbound' AND email_error IS NOT NULL;
