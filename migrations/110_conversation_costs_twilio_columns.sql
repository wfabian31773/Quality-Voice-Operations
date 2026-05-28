-- Capture the actual Twilio carrier cost on `conversation_costs`.
--
-- BACKGROUND
-- ----------
-- Cost-tracking audit finding #2 (docs/audit/10-cost-tracking-audit.md
-- §2.2): the `/twilio/status` callback handler reads `CallSid` and
-- `CallStatus` from `req.body` and extracts STIR telemetry, but the
-- three fields Twilio sends that describe the carrier cost of the call
-- are silently discarded:
--
--   * `Price`         — the customer-facing per-call charge in dollars,
--                       a signed string (Twilio convention: negative
--                       for "Twilio charged you") with up to 5 decimal
--                       places, e.g. "-0.00850" for a 1-min US local
--                       inbound at the current Twilio retail rate.
--   * `PriceUnit`     — ISO-4217 currency code, almost always "USD".
--   * `CallDuration`  — Twilio's CARRIER-BILLED seconds (may differ
--                       from wall-clock if rounding up to the next
--                       minute / partial-minute rounding rules).
--
-- Without these we fall back to the `TWILIO_COST_PER_MINUTE_CENTS=2`
-- env default × ceil(durationSeconds/60), which is wrong by 10×–100×
-- for any destination outside US local DIDs and silently eats the
-- spread on international or premium-rate calls.
--
-- DESIGN
-- ------
-- Three new nullable columns on `conversation_costs`, populated by a
-- new `recordTwilioCallCost(...)` helper in CostTrackingService when
-- the status callback arrives:
--
--   * twilio_price_cents      NUMERIC(10,4)
--       Stored in cents, but with 4 decimal places of precision so a
--       0.00850 USD charge (= 0.85 cents) survives as 0.8500 cents
--       instead of rounding to 1¢ (a 17% overstatement on cheap
--       calls). The aggregate of many such rows still rounds to whole
--       cents at query time for invoice-matching, but the per-call
--       truth is preserved here.
--
--       This is a deliberate exception to the "currency is stored as
--       integer cents" convention: a NUMERIC column carries no in-code
--       float-math risk (the lint rules are about TypeScript), and
--       sub-cent precision is the entire point of capturing Twilio's
--       raw Price instead of estimating from a per-minute rate.
--
--   * twilio_price_currency   VARCHAR(3)
--       Almost always 'USD'. Captured raw so we can reconcile
--       multi-currency tenants without back-translating.
--
--   * twilio_billed_seconds   INTEGER
--       Twilio's carrier-billed `CallDuration`. May differ from the
--       wall-clock duration we already store in call_sessions (Twilio
--       rounds up to the nearest billing increment for some
--       destinations). Storing both lets us spot tenants whose
--       wall-clock / billed-seconds ratio drifts from 1.0, which is a
--       sign of fraud or stuck calls.
--
-- All three are nullable; legacy rows stay NULL until/unless a sweeper
-- cron backfills them from Twilio's REST API. The
-- `recordTwilioCallCost` helper uses `INSERT ... ON CONFLICT ... DO
-- UPDATE` so the call ordering between stream-finalize and Twilio's
-- status callback doesn't matter (either path may run first; the
-- other path's UPSERT fills in its own columns without clobbering the
-- already-populated ones).

ALTER TABLE conversation_costs
  ADD COLUMN IF NOT EXISTS twilio_price_cents      NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS twilio_price_currency   VARCHAR(3),
  ADD COLUMN IF NOT EXISTS twilio_billed_seconds   INTEGER;

-- Index for the "show me calls whose carrier cost we never captured"
-- analytics query and for the eventual backfill sweeper. Partial index
-- so we only carry rows that actually need looking at.
CREATE INDEX IF NOT EXISTS idx_conversation_costs_missing_twilio_price
  ON conversation_costs(tenant_id, created_at DESC)
  WHERE twilio_price_cents IS NULL;
