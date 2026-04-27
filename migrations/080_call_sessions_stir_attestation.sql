-- 080: STIR/SHAKEN attestation columns on call_sessions
--
-- Twilio status callbacks include STIR/SHAKEN telemetry that the carrier
-- reported back for an outbound call:
--   * StirStatus   — high-level signing status (e.g. `signed`, `not-signed`,
--                    `failed`).
--   * StirVerstat  — the SIP "verstat" header value reported by the
--                    terminating carrier. Encodes the attestation level we
--                    actually care about (`TN-Validation-Passed-A`,
--                    `TN-Validation-Passed-B`, `TN-Validation-Passed-C`,
--                    `TN-Validation-Failed`, `No-TN-Validation`, ...).
--
-- We persist the raw values we received so we can debug carrier weirdness
-- later, and a denormalized one-character `stir_attestation` (A / B / C)
-- so the Calls UI can quickly badge calls where the carrier downgraded the
-- attestation. Calls that never had STIR data (e.g. inbound, demo,
-- pre-deploy, or carriers that never sent a status callback) leave all
-- three columns NULL.

ALTER TABLE call_sessions
  ADD COLUMN IF NOT EXISTS stir_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS stir_verstat VARCHAR(64),
  ADD COLUMN IF NOT EXISTS stir_attestation CHAR(1);

-- Sanity-check the derived attestation column. We deliberately do not
-- constrain stir_status / stir_verstat because Twilio occasionally adds
-- new values and we want to keep accepting them rather than dropping them
-- on the floor.
DO $$ BEGIN
  ALTER TABLE call_sessions
    ADD CONSTRAINT call_sessions_stir_attestation_chk
    CHECK (stir_attestation IS NULL OR stir_attestation IN ('A', 'B', 'C'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
