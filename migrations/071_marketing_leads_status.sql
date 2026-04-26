-- Add triage status fields to marketing_leads so the Sales Inbox in the
-- Platform Admin can mark leads as contacted/closed and surface who did it.
--
-- status defaults to 'new' so historical rows show up in the inbox until
-- an operator triages them. status_notes is free-text scratchpad; the
-- updated_at/updated_by columns let us audit triage activity.

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS status_notes TEXT,
  ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_updated_by TEXT;

CREATE INDEX IF NOT EXISTS marketing_leads_status_idx
  ON marketing_leads (status, created_at DESC);
