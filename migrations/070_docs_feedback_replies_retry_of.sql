-- Track which docs_feedback_replies rows were created by the "Retry send"
-- button so the admin reply history can group/label retry attempts under
-- the original send instead of showing them as indistinguishable duplicates.
--
-- retry_of points at the *chain root* (the original, non-retry attempt) so
-- a single `WHERE retry_of = $root` selects every retry in the chain. For
-- the original attempt itself retry_of stays NULL.

ALTER TABLE docs_feedback_replies
  ADD COLUMN IF NOT EXISTS retry_of INTEGER
    REFERENCES docs_feedback_replies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS docs_feedback_replies_retry_of_idx
  ON docs_feedback_replies(retry_of)
  WHERE retry_of IS NOT NULL;
