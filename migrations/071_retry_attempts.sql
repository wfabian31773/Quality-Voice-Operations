-- Cluster-wide cooldown store for the docs-feedback and support-reply
-- "Retry send" buttons. Replaces the per-process in-memory `Map`s in
-- platform/help/docsFeedbackRetryLimiter.ts and supportReplyRetryLimiter.ts
-- so the cooldown is enforced across every admin server in a horizontally
-- scaled deployment instead of being bypassed by a load balancer hop.
--
-- The atomic check-and-reserve is performed by an
--   INSERT ... ON CONFLICT (key) DO UPDATE
--     SET last_attempt_at = EXCLUDED.last_attempt_at
--     WHERE retry_attempts.last_attempt_at <= now - cooldown
--   RETURNING last_attempt_at
-- statement issued by the limiter modules. The table itself just persists
-- the most recent attempt per key with a unique constraint on `key`.

CREATE TABLE IF NOT EXISTS retry_attempts (
  key TEXT PRIMARY KEY,
  last_attempt_at TIMESTAMPTZ NOT NULL
);

-- Helps a future cleanup job find expired entries cheaply.
CREATE INDEX IF NOT EXISTS retry_attempts_last_attempt_at_idx
  ON retry_attempts(last_attempt_at);
