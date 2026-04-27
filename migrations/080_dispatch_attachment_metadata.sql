-- Add metadata columns for richer dispatch_job_attachments (mobile uploads).
ALTER TABLE dispatch_job_attachments
  ADD COLUMN IF NOT EXISTS mime_type VARCHAR(100) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS object_path VARCHAR(1000) DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_dispatch_job_attachments_object_path
  ON dispatch_job_attachments(object_path);
