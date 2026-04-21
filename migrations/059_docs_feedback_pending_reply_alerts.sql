-- Track when admins were last alerted about a docs feedback comment whose
-- reader is still waiting for a reply, so the scheduler does not re-page the
-- ops channel every cycle.

ALTER TABLE docs_feedback
  ADD COLUMN IF NOT EXISTS pending_reply_alerted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS docs_feedback_pending_reply_idx
  ON docs_feedback(created_at)
  WHERE reply_email IS NOT NULL AND reply_count = 0 AND status <> 'hidden';
