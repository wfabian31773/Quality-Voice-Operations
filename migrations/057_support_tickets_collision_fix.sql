-- Resolve a pre-existing schema collision blocking the help-center support inbox.
--
-- Migration 002 created a "support_tickets" table with columns subject/description
-- intended for tenant-side call tickets (no current code references it). When
-- migration 055_help_support.sql later issued `CREATE TABLE IF NOT EXISTS
-- support_tickets (...)` for the admin help inbox, the existing table caused the
-- new schema to be silently skipped. As a result, the support-inbox INSERT in
-- server/admin-api/routes/support.ts has been failing with `column "user_id" of
-- relation "support_tickets" does not exist` and tickets never persisted.
--
-- Fix: detect the old shape (presence of a "subject" column) and replace it with
-- the intended help-center schema. No production code references the old table;
-- the destructive drop is therefore safe. We also re-create support_ticket_replies
-- (introduced in migration 056) since it depended on the wrong parent table.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'support_tickets' AND column_name = 'subject'
  ) THEN
    DROP TABLE IF EXISTS support_ticket_replies CASCADE;
    DROP TABLE IF EXISTS support_tickets CASCADE;
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS support_tickets (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id UUID,
  user_id UUID,
  user_email VARCHAR(255),
  plan VARCHAR(50),
  topic VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  recent_errors TEXT,
  context JSONB DEFAULT '{}'::jsonb,
  routed_to VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  email_message_id VARCHAR(255),
  email_error TEXT,
  inbound_token VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS support_tickets_created_idx ON support_tickets(created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_tenant_idx ON support_tickets(tenant_id);
CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets(status);
CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_inbound_token_idx
  ON support_tickets(inbound_token)
  WHERE inbound_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS support_ticket_replies (
  id SERIAL PRIMARY KEY,
  ticket_id VARCHAR(64) NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  direction VARCHAR(16) NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  author_user_id UUID,
  author_email VARCHAR(255),
  body TEXT NOT NULL,
  email_message_id VARCHAR(255),
  email_error TEXT,
  source VARCHAR(32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS support_ticket_replies_ticket_idx
  ON support_ticket_replies(ticket_id, created_at);
