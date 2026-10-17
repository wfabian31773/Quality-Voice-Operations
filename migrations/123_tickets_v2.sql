-- Tickets v2 (PR-10): message/callback kinds, callback due-by, structured
-- intake, urgency, and a per-call reference for agent dedupe.
--
-- Expand-only. Every column is nullable or has a default, so existing rows
-- and existing writers (server/admin-api/routes/tickets.ts,
-- platform/tools/library/handlers/createTicket.ts) keep working unchanged.
-- No drops, renames, type changes, or data rewrites. Safe to re-run.
--
-- Locking: scripts/run-migrations.ts runs this file in one transaction, so
-- the ACCESS EXCLUSIVE lock from the first ALTER TABLE is held to COMMIT.
-- lock_timeout makes the migration fail fast instead of queueing all ticket
-- traffic behind a long-running transaction. The ADD COLUMNs don't rewrite
-- the table (PG11+ constant defaults), and the CHECKs are added NOT VALID so
-- they skip the full-table scan; they still apply to every new or updated
-- row. Existing rows all hold the column defaults, which satisfy them.
-- Follow-up (separate migration): ALTER TABLE tickets VALIDATE CONSTRAINT
-- for the three CHECKs, which only takes SHARE UPDATE EXCLUSIVE.
-- The two plain CREATE INDEX builds briefly block writes, as in 081 and 098.
--
-- RLS is unchanged: tickets keeps tenant_isolation_tickets from
-- 048_mini_systems.sql and FORCE ROW LEVEL SECURITY from
-- 120_qvo_app_restricted_role.sql.

SET LOCAL lock_timeout = '5s';

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'message';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS callback_due_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS intake JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS urgency TEXT NOT NULL DEFAULT 'normal';

-- The action layer's ctx.callId (clipped to 128 chars like action_proposals).
-- tickets.call_id is an FK to call_sessions, so it is only set when that row
-- exists; this column is the dedupe key and is never an FK.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS source_call_ref VARCHAR(128);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tickets_kind_check' AND conrelid = 'tickets'::regclass
  ) THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_kind_check
      CHECK (kind IN ('message', 'callback', 'complaint', 'quote_request', 'intake', 'other')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tickets_urgency_check' AND conrelid = 'tickets'::regclass
  ) THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_urgency_check
      CHECK (urgency IN ('normal', 'urgent')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tickets_intake_object_check' AND conrelid = 'tickets'::regclass
  ) THEN
    ALTER TABLE tickets ADD CONSTRAINT tickets_intake_object_check
      CHECK (jsonb_typeof(intake) = 'object') NOT VALID;
  END IF;
END
$$;

-- "Open / overdue callbacks" list for the owner.
CREATE INDEX IF NOT EXISTS idx_tickets_tenant_status_callback_due
  ON tickets (tenant_id, status, callback_due_at);

-- Same-call dedupe lookup in tickets.open.commit.
CREATE INDEX IF NOT EXISTS idx_tickets_tenant_source_call_ref
  ON tickets (tenant_id, source_call_ref, kind)
  WHERE source_call_ref IS NOT NULL;

-- At most one ticket.opened outbox row per ticket (ticket_outbox is from
-- 002_add_tenant_id_to_existing.sql; RLS from 013/017 is unchanged).
-- tickets.open.commit writes it in the ticket's transaction; this is the
-- backstop against a second alert. Nothing wrote ticket.opened before this
-- migration, so no existing row can violate it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_outbox_ticket_opened
  ON ticket_outbox (tenant_id, (payload->>'ticketId'))
  WHERE event_type = 'ticket.opened';
