-- Push delivery telemetry — one row per fan-out attempt to Expo.
--
-- Surfaces operator-facing "push delivery health" in the Platform Admin
-- console (PushDispatcher previously swallowed network errors / non-200
-- responses / Expo ticket errors with no operational visibility — a tenant
-- whose techs were not getting pushes had no way to find that out).
--
-- One row is written per call to sendDispatchPush() that actually attempted
-- delivery (devices > 0). Calls with no matching devices are skipped to
-- keep the table from filling up with no-ops.

CREATE TABLE IF NOT EXISTS push_delivery_attempts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id VARCHAR(255) NOT NULL,
  -- Optional lifecycle event name (e.g. 'job_assigned', 'booking_cancelled').
  -- NULL when the caller didn't supply one (non-dispatch caller in future).
  event VARCHAR(64),
  attempted INTEGER NOT NULL DEFAULT 0,
  accepted INTEGER NOT NULL DEFAULT 0,
  retired INTEGER NOT NULL DEFAULT 0,
  dropped INTEGER NOT NULL DEFAULT 0,
  -- Coarse failure category for the panel: 'network_error',
  -- 'http_status_<n>', 'invalid_json', 'ticket_error:<code>'. NULL when
  -- every device in this fan-out succeeded (or was retired cleanly).
  failure_reason VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_delivery_attempts_tenant_created
  ON push_delivery_attempts (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_push_delivery_attempts_created
  ON push_delivery_attempts (created_at DESC);

-- Partial index for the "recent failures" panel — only a tiny subset of
-- rows have failure_reason set, so the partial index stays small and fast.
CREATE INDEX IF NOT EXISTS idx_push_delivery_attempts_failures
  ON push_delivery_attempts (created_at DESC)
  WHERE failure_reason IS NOT NULL OR dropped > 0;
