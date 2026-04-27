-- 077: Verified caller IDs (Twilio Trusted Caller / STIR-SHAKEN)
--
-- Stores per-tenant outbound caller identifiers that have either been
-- verified through Twilio's OutgoingCallerIds verification flow (entry-level
-- attestation) or registered against a Trust Hub Customer Profile + Trust
-- Product so carriers attest with A-level under STIR/SHAKEN.
--
-- Outbound campaigns that target a specific verified caller ID will dial
-- with that number as the `From` parameter; campaigns may not be moved to
-- `running`/`scheduled` unless their referenced caller ID is `verified`.
--
-- Status lifecycle:
--   pending  -> verification code issued, waiting for the user to either
--               complete the Twilio call-back or for our poller to confirm.
--   verified -> Twilio OutgoingCallerIds row exists or Trust Hub product is
--               approved. Number is safe to use as the From of outbound
--               campaign calls.
--   failed   -> verification expired or was rejected.
--   rotated  -> superseded by a newer verified caller ID. Kept for audit.
--
-- Attestation level mirrors STIR/SHAKEN A/B/C and is `null` until Twilio
-- reports the carrier attestation. Trust Hub SIDs are optional and let
-- operators record the SIDs of the Customer Profile / Trust Product / Brand
-- that back this caller ID once they complete the regulatory paperwork.

CREATE TABLE IF NOT EXISTS verified_caller_ids (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_number VARCHAR(32) NOT NULL,
  friendly_name VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attestation_level VARCHAR(1),
  twilio_validation_sid VARCHAR(64),
  twilio_caller_sid VARCHAR(64),
  trust_hub_profile_sid VARCHAR(64),
  trust_product_sid VARCHAR(64),
  brand_sid VARCHAR(64),
  verification_code VARCHAR(16),
  verification_expires_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  rotated_at TIMESTAMPTZ,
  rotated_to_id VARCHAR REFERENCES verified_caller_ids(id) ON DELETE SET NULL,
  registered_by_user_id VARCHAR,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, phone_number)
);

CREATE INDEX IF NOT EXISTS idx_verified_caller_ids_tenant
  ON verified_caller_ids(tenant_id);
CREATE INDEX IF NOT EXISTS idx_verified_caller_ids_tenant_status
  ON verified_caller_ids(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_verified_caller_ids_tenant_active
  ON verified_caller_ids(tenant_id) WHERE status = 'verified';

ALTER TABLE verified_caller_ids ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_verified_caller_ids ON verified_caller_ids;
CREATE POLICY tenant_isolation_verified_caller_ids ON verified_caller_ids
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);
