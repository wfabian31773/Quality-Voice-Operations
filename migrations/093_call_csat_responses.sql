-- 093_call_csat_responses.sql
--
-- Capture real customer satisfaction (CSAT) survey responses per call so the
-- Global Intelligence Network can report a CSAT benchmark that's actually
-- driven by customers, not by the LLM-judged 0–10 quality score in
-- `call_quality_scores` (task #710).
--
-- A CSAT row represents one *requested* survey for a single call. The row is
-- inserted up front (status='pending') when the survey is dispatched (e.g.
-- post-call SMS or web link), and updated to status='responded' when the
-- customer actually answers. Rows that age past `expires_at` without a reply
-- become status='expired' and are excluded from the GIN aggregation.
--
-- We deliberately keep this in its own table rather than tacking columns
-- onto `call_quality_scores` because:
--   * call_quality_scores is an LLM judgement and may be backfilled in bulk;
--     CSAT is a customer-reported number and must never be conflated.
--   * CSAT is sparse — most calls never get a survey reply — and we don't
--     want to dilute the dense quality_scores table with mostly-NULL rows.
--   * Multi-channel: a single call could in principle get an SMS request and
--     a follow-up web/email response; the table accommodates that without
--     forcing voice-side schema changes.
--
-- The score column is normalized to 0..1 (see `score_normalized`) so the
-- aggregation pipeline can mix tenants that survey on a 1–5 scale with
-- tenants that survey on a 1–10 scale without rescaling at read time. The
-- raw value the customer sent is kept in `score_raw` for audit / debugging.

CREATE TABLE IF NOT EXISTS call_csat_responses (
  id                VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_session_id   VARCHAR NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,

  -- Where the survey was sent / answered. 'sms' = post-call text, 'ivr' =
  -- end-of-call IVR digit, 'web' = follow-up survey link, 'email' = link in
  -- email receipt. We store both the request channel and the response
  -- channel so a tenant who sends via SMS but accepts web replies (the
  -- follow-up link in the SMS body) is correctly attributed.
  request_channel   VARCHAR(16) NOT NULL CHECK (request_channel IN ('sms', 'ivr', 'web', 'email')),
  response_channel  VARCHAR(16) CHECK (response_channel IS NULL OR response_channel IN ('sms', 'ivr', 'web', 'email')),

  status            VARCHAR(16) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'responded', 'expired', 'failed', 'opted_out')),

  -- Survey scale the customer was asked to use (e.g. 5 for "1–5 stars",
  -- 10 for "0–10 NPS"). NULL until the survey is actually scored so a
  -- pending row doesn't lie about the rubric.
  score_scale       INTEGER CHECK (score_scale IS NULL OR score_scale BETWEEN 2 AND 10),
  score_raw         NUMERIC(4,2) CHECK (score_raw IS NULL OR score_raw >= 0),
  -- 0..1 normalization of (score_raw - 1) / (score_scale - 1). Computed by
  -- the service layer at write time so reads stay cheap and we don't need
  -- a generated column (Postgres generated columns can't reference another
  -- column in a CHECK across all supported versions).
  score_normalized  NUMERIC(4,3) CHECK (score_normalized IS NULL OR (score_normalized >= 0 AND score_normalized <= 1)),

  comment           TEXT,
  raw_response      TEXT, -- the literal SMS body / form payload the customer sent

  -- Where we sent the survey to. For SMS this is the customer's phone
  -- number (already encrypted upstream when copied from `call_sessions`);
  -- for web/email it's a hashed token we issue. Keeping it nullable means
  -- IVR-only surveys (no out-of-band dispatch) don't carry a fake address.
  dispatch_to       TEXT,
  dispatch_token    VARCHAR(64),

  requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at      TIMESTAMPTZ,
  -- When this pending request stops accepting replies. Default is 7 days
  -- after request — long enough for typical SMS/email response windows but
  -- short enough that an old, abandoned call doesn't get a stale CSAT
  -- weeks later that the customer barely remembers.
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),

  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tenant + window queries (the aggregation pipeline scans the last 30 days).
CREATE INDEX IF NOT EXISTS idx_call_csat_tenant_responded
  ON call_csat_responses(tenant_id, responded_at DESC)
  WHERE status = 'responded';

-- Per-call lookup (e.g. "did this call already get a survey?").
CREATE INDEX IF NOT EXISTS idx_call_csat_session
  ON call_csat_responses(call_session_id);

-- Expiry sweep: find pending rows past their expires_at to mark expired.
CREATE INDEX IF NOT EXISTS idx_call_csat_pending_expiry
  ON call_csat_responses(expires_at)
  WHERE status = 'pending';

-- Inbound SMS reply matcher: when a customer texts a digit back, the
-- twilio webhook needs to find their most recent pending SMS request
-- keyed on tenant + the (encrypted/normalized) phone number it dispatched
-- to. This index keeps that lookup O(log n) per inbound message.
CREATE INDEX IF NOT EXISTS idx_call_csat_pending_sms_dispatch
  ON call_csat_responses(tenant_id, dispatch_to)
  WHERE status = 'pending' AND request_channel = 'sms';

-- Web/email links carry an opaque single-use token. Indexed for the
-- public form submission lookup.
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_csat_dispatch_token
  ON call_csat_responses(dispatch_token)
  WHERE dispatch_token IS NOT NULL;

-- Only one pending or responded survey per call session — we don't want a
-- runaway loop or a flaky webhook to spam the customer with duplicate
-- "rate this call" texts. Failed/expired/opted_out rows are excluded so a
-- legitimate retry after a delivery failure is still possible.
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_csat_one_active_per_session
  ON call_csat_responses(call_session_id)
  WHERE status IN ('pending', 'responded');

ALTER TABLE call_csat_responses ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_call_csat_responses ON call_csat_responses
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Per-tenant CSAT survey configuration. All columns default to OFF so
-- existing tenants do not start texting their callers without explicit
-- opt-in. Settings live on `tenants` (not a side table) because they're
-- read on every call completion and we already keep similar dispatch
-- toggles there (e.g. dispatch_sms_segment_limit).
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS csat_survey_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS csat_survey_channel VARCHAR(16) NOT NULL DEFAULT 'sms'
  CHECK (csat_survey_channel IN ('sms', 'web', 'email'));
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS csat_survey_scale INTEGER NOT NULL DEFAULT 5
  CHECK (csat_survey_scale BETWEEN 2 AND 10);
-- Minimum call duration before we ask for a CSAT — a 3-second hangup is
-- not worth surveying and would skew the score. 30s default; tunable per
-- tenant from 5..600.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS csat_survey_min_duration_seconds INTEGER NOT NULL DEFAULT 30
  CHECK (csat_survey_min_duration_seconds BETWEEN 5 AND 600);
-- Per-tenant override of the SMS prompt. NULL falls back to the service
-- default ("Thanks for calling! ..."). Capped at 320 chars so it fits in
-- two GSM-7 segments with the rating prompt appended.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS csat_survey_sms_template TEXT
  CHECK (csat_survey_sms_template IS NULL OR length(csat_survey_sms_template) <= 320);
