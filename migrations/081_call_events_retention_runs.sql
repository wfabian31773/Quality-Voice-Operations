-- 081: Bookkeeping for the daily call_events partition retention worker
-- (CallEventsRetentionScheduler — see migrations/078 + platform/billing).
--
-- The scheduler created in BL-044 silently DROPs monthly partitions on
-- `call_events` once they fall outside the 90-day retention window and
-- pre-creates next month's partition. Until now the only signal that a
-- cycle ran was a log line, so an on-call engineer had no easy way to
-- confirm "the prune actually ran today" or "next month's partition is
-- ready" without shelling into the database.
--
-- This migration adds an append-only history table the scheduler writes
-- into after every cycle. The Platform Admin console reads it to render
-- the retention status tile (last successful run, recently dropped
-- partitions, upcoming-month readiness, staleness alert). One row per
-- cycle and ~1 cycle/day means this table stays tiny indefinitely; we
-- still index on started_at DESC so the "most recent N runs" query never
-- has to seq-scan once we accumulate a few years of history.

CREATE TABLE IF NOT EXISTS call_events_retention_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
  retention_days INTEGER NOT NULL,
  ensured_partitions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  dropped_partitions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_call_events_retention_runs_started_at
  ON call_events_retention_runs (started_at DESC);
