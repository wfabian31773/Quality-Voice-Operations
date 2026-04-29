-- Soft-archive support for the integrations outbox.
--
-- The Platform Admin Connector Health panel exposes a "Stuck connector
-- messages" subview that lists `failed` / `dead_letter` rows from
-- `outbox_events`. Ops teams need a way to dismiss a `dead_letter` row that
-- has been triaged (e.g. the customer cancelled the action, the row will
-- never recover) without losing the audit trail or the original payload —
-- so we soft-archive instead of deleting.
--
-- `archived_at IS NULL` is the active set; archived rows stay in the table
-- for forensics but are filtered out of the Stuck panel and skipped by the
-- drain worker's claim query.

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;

-- Active-set partial index keeps the Stuck panel and drain worker queries
-- cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_outbox_events_active_status
  ON outbox_events(tenant_id, status, next_attempt_at)
  WHERE archived_at IS NULL;
