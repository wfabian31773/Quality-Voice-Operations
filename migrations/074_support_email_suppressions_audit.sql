-- Audit columns for support_email_suppressions.
--
-- Migration 073 introduced the suppression list with reason / source /
-- last_error so the auto-bounce path could short-circuit future sends. Now
-- that admins can manually suppress an address from the Bounced recipients
-- panel we need a small audit trail so support can answer "who decided to
-- stop emailing this address?" without correlating logs to timestamps.
--
-- added_by_user_id is the platform-admin user id taken from the request
-- (req.user.userId) at suppression time. NULL for entries created by the
-- automated bounce path — those already record `source` (e.g.
-- 'support_reply_retry_scheduler') which is enough forensics. Stored as
-- TEXT instead of UUID + FK so a deleted admin user doesn't break the
-- audit trail (or the row).
--
-- notes is a free-form admin-written justification (e.g. "user moved to
-- new email per ticket #1234"). Optional. Capped softly at the app layer.

ALTER TABLE support_email_suppressions
  ADD COLUMN IF NOT EXISTS added_by_user_id TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT;
