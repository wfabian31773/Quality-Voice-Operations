-- Master Voice Agent 2.0.0 locks xAI grok-voice-think-fast-2.0.
-- Keep the previous OpenAI model in the CHECK so historical approval rows remain valid.

ALTER TABLE healthcare_deployment_approvals
  ALTER COLUMN model SET DEFAULT 'grok-voice-think-fast-2.0';

ALTER TABLE healthcare_deployment_approvals
  DROP CONSTRAINT IF EXISTS healthcare_deployment_approvals_model_check;

ALTER TABLE healthcare_deployment_approvals
  ADD CONSTRAINT healthcare_deployment_approvals_model_check
  CHECK (model IN ('gpt-realtime-2', 'grok-voice-think-fast-2.0'));

ALTER TABLE healthcare_activation_readiness
  ALTER COLUMN model SET DEFAULT 'grok-voice-think-fast-2.0';

ALTER TABLE healthcare_activation_readiness
  DROP CONSTRAINT IF EXISTS healthcare_activation_readiness_model_check;

ALTER TABLE healthcare_activation_readiness
  ADD CONSTRAINT healthcare_activation_readiness_model_check
  CHECK (model IN ('gpt-realtime-2', 'grok-voice-think-fast-2.0'));
