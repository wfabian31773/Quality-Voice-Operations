-- Add status column to docs_feedback so admins can triage comments.
-- Status values: 'new' (default), 'resolved', 'hidden'.

ALTER TABLE docs_feedback
  ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'new';

ALTER TABLE docs_feedback
  DROP CONSTRAINT IF EXISTS docs_feedback_status_check;

ALTER TABLE docs_feedback
  ADD CONSTRAINT docs_feedback_status_check
  CHECK (status IN ('new', 'resolved', 'hidden'));

ALTER TABLE docs_feedback
  ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_updated_by VARCHAR(128);

CREATE INDEX IF NOT EXISTS docs_feedback_status_idx ON docs_feedback(status);
