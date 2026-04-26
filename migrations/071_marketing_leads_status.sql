-- Add triage status fields to marketing_leads so the Sales Inbox in the
-- Platform Admin can mark leads as contacted/closed and surface who did it.
--
-- The marketing_leads table is created lazily on first write by
-- server/admin-api/services/marketing-leads.ts. On a fresh database the
-- migration runner runs before the service has ever booted, so this
-- migration must be self-sufficient: ensure the base table + base indexes
-- exist (matching the service definition), then add the new columns and
-- the triage index.
--
-- status defaults to 'new' so historical rows show up in the inbox until
-- an operator triages them. status_notes is free-text scratchpad; the
-- updated_at/updated_by columns let us audit triage activity.

CREATE TABLE IF NOT EXISTS marketing_leads (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  name TEXT,
  email TEXT NOT NULL,
  company TEXT,
  phone TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  notified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS marketing_leads_source_created_at_idx
  ON marketing_leads (source, created_at DESC);

CREATE INDEX IF NOT EXISTS marketing_leads_email_lower_idx
  ON marketing_leads (LOWER(email));

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS status_notes TEXT,
  ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_updated_by TEXT;

CREATE INDEX IF NOT EXISTS marketing_leads_status_idx
  ON marketing_leads (status, created_at DESC);
