-- RT-03: the voice runtime pins grok-voice-3.0 (xAI deprecated 2.0 on 2026-10-14).
-- Additive: keep the earlier models in the CHECK so historical rows stay valid.
ALTER TABLE healthcare_deployment_approvals
  ALTER COLUMN model SET DEFAULT 'grok-voice-3.0';

ALTER TABLE healthcare_deployment_approvals
  DROP CONSTRAINT IF EXISTS healthcare_deployment_approvals_model_check;

ALTER TABLE healthcare_deployment_approvals
  ADD CONSTRAINT healthcare_deployment_approvals_model_check
  CHECK (model IN ('gpt-realtime-2', 'grok-voice-think-fast-2.0', 'grok-voice-3.0'));

ALTER TABLE healthcare_activation_readiness
  ALTER COLUMN model SET DEFAULT 'grok-voice-3.0';

ALTER TABLE healthcare_activation_readiness
  DROP CONSTRAINT IF EXISTS healthcare_activation_readiness_model_check;

ALTER TABLE healthcare_activation_readiness
  ADD CONSTRAINT healthcare_activation_readiness_model_check
  CHECK (model IN ('gpt-realtime-2', 'grok-voice-think-fast-2.0', 'grok-voice-3.0'));
