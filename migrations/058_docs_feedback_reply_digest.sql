-- Track when an admin digest was sent about a failed docs feedback reply so the
-- scheduler does not re-send the same failure in every cycle.

ALTER TABLE docs_feedback_replies
  ADD COLUMN IF NOT EXISTS digest_notified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS docs_feedback_replies_failed_idx
  ON docs_feedback_replies(created_at DESC)
  WHERE email_error IS NOT NULL;
