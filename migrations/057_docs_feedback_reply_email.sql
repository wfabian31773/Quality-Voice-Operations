-- Capture an optional contact email with each docs feedback comment so admins
-- can reply directly via email, and persist a log of those replies.

ALTER TABLE docs_feedback
  ADD COLUMN IF NOT EXISTS reply_email VARCHAR(320),
  ADD COLUMN IF NOT EXISTS reply_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS docs_feedback_replies (
  id SERIAL PRIMARY KEY,
  feedback_id INTEGER NOT NULL REFERENCES docs_feedback(id) ON DELETE CASCADE,
  sent_by VARCHAR(256),
  to_email VARCHAR(320) NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  email_message_id TEXT,
  email_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS docs_feedback_replies_feedback_idx
  ON docs_feedback_replies(feedback_id, created_at DESC);
