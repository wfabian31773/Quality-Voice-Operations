-- Durable replay-protection store for Twilio inbound webhooks (task #942).
--
-- Twilio's X-Twilio-Signature is HMAC-SHA1 over (URL + sorted form params)
-- with NO embedded timestamp, so a captured (URL, params, signature) tuple
-- verifies forever. We defend against verbatim replay by treating each
-- provider-issued unique ID (MessageSid, CallSid, MessageSid+MessageStatus,
-- CallSid+SequenceNumber) as a one-shot nonce inside a 5-minute window.
--
-- The voice-gateway middleware
-- (server/voice-gateway/middleware/twilioReplayCache.ts) keeps a fast
-- per-process in-memory cache and writes through to this table. A row in
-- this table proves the nonce was already seen — so a replay arriving on a
-- different gateway instance, or after the originating instance restarted,
-- still gets rejected. Without this table the in-memory cache would be
-- best-effort only; with it, replay defense is durable across process
-- lifetime and instance boundaries.
--
-- Cleanup: stale rows are functionally harmless. The cache's claim
-- statement is `INSERT ... ON CONFLICT (nonce) DO UPDATE ... WHERE
-- expires_at <= NOW() RETURNING (xmax = 0) AS inserted`, so an existing
-- row whose `expires_at` has already passed is *reclaimed* on the next
-- arrival of the same nonce — a captured payload re-fired more than 5
-- minutes later is allowed exactly once (and immediately re-claimed). To
-- keep the table from growing unboundedly with dormant nonces no future
-- webhook will ever revisit, the cache module also runs an opportunistic
-- `DELETE ... WHERE expires_at <= NOW()` on roughly 1 in 200 successful
-- claims (probabilistic, async, never blocks the response). Ops can also
-- run a scheduled prune of the same shape; the index below keeps either
-- variant O(log n) regardless of stale-row count.

CREATE TABLE IF NOT EXISTS twilio_webhook_replay_nonces (
    nonce       TEXT        PRIMARY KEY,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookups are always by `nonce` (covered by the PK) plus a freshness check
-- on `expires_at`. The expiry index speeds up the periodic prune.
CREATE INDEX IF NOT EXISTS idx_twilio_webhook_replay_nonces_expires_at
    ON twilio_webhook_replay_nonces (expires_at);
