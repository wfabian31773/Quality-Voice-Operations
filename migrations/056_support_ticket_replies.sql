-- Threaded replies for support tickets: outbound from admins (sent via SMTP) and
-- inbound from end-users (delivered via reply-to webhook).

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS inbound_token VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_inbound_token_idx
  ON support_tickets(inbound_token)
  WHERE inbound_token IS NOT NULL;

-- Backfill inbound_token for existing rows so older tickets can also accept inbound replies.
UPDATE support_tickets
SET inbound_token = md5(random()::text || clock_timestamp()::text || id)
WHERE inbound_token IS NULL;

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
