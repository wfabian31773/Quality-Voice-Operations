-- Lease-with-expiry recovery for the connector outbox drain worker.
--
-- Background: the connector outbox drain worker (Task #248 / BL-014) claims a
-- row by transitioning it to status='processing' and committing that status
-- BEFORE it actually attempts to dispatch the event through the connector
-- adapters. If the worker process crashes (OOM kill, SIGKILL, unhandled
-- async exception, container restart) between the claim COMMIT and the final
-- 'delivered'/'failed' write, the row is stranded in 'processing' forever
-- because nothing else will ever pick it up.
--
-- This migration adds a lease so a stale claim can be recovered:
--   * `claimed_at`        — when the current worker grabbed the row
--   * `lease_expires_at`  — deadline by which the worker must update the row
--                           to 'delivered'/'failed' or the row is considered
--                           abandoned and eligible for re-claim
--
-- The reaper logic lives in ConnectorOutboxDrainScheduler.ts: every drain
-- cycle the SELECT also includes processing rows whose lease_expires_at has
-- passed, and we increment `attempts` on reclaim so a poison-pill row that
-- repeatedly OOM-kills the worker eventually hits max_attempts and dead-letters
-- instead of looping forever.

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMP;

-- Reaper read path: find processing rows whose lease has expired so they can
-- be reclaimed. Partial index keeps it tiny because in steady state very few
-- rows are in 'processing'.
CREATE INDEX IF NOT EXISTS idx_outbox_events_processing_lease
  ON outbox_events(lease_expires_at)
  WHERE status = 'processing' AND archived_at IS NULL;
