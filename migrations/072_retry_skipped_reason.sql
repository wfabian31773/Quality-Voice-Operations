-- Persist *why* the auto-retry pipeline gave up on an outbound email so the
-- "Hard bounce — won't auto-retry" badge in the admin UI is a pure read of
-- authoritative server state. Before this column the badge re-classified the
-- raw email_error string on every render via a client-side mirror of the
-- SMTP classifier; future tweaks to the keyword list had to ship to both the
-- scheduler and the client (kept in sync by a parity test).
--
-- 'permanent_smtp_failure' is the only value the schedulers and routes write
-- today. Stored as TEXT (not an enum) so ops can later record other skip
-- reasons — suppression list, manual cancel, recipient unsubscribed, … —
-- without a follow-on migration. Anything else the server doesn't recognise
-- is treated as legacy data and the client falls back to the historical
-- string-based classifier so older rows keep their badge.

ALTER TABLE support_ticket_replies
  ADD COLUMN IF NOT EXISTS retry_skipped_reason TEXT;

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS retry_skipped_reason TEXT;

ALTER TABLE docs_feedback_replies
  ADD COLUMN IF NOT EXISTS retry_skipped_reason TEXT;
