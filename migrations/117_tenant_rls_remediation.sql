-- GTM-014: close the audited tenant-table RLS gaps before healthcare activation.
--
-- These relations were created after the original global RLS migration (or were
-- recreated later), so they never received an active policy. The migration is
-- intentionally data-preserving: it changes authorization metadata only.
-- Missing/empty app.tenant_id settings match no rows, including rows whose
-- tenant_id is nullable. Privileged maintenance remains a separately audited
-- service-role responsibility.

ALTER TABLE activation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE activation_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_activation_events ON activation_events;
CREATE POLICY tenant_isolation_activation_events ON activation_events
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE case_studies ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_studies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_case_studies ON case_studies;
CREATE POLICY tenant_isolation_case_studies ON case_studies
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE connector_alert_mutes ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_alert_mutes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_connector_alert_mutes ON connector_alert_mutes;
CREATE POLICY tenant_isolation_connector_alert_mutes ON connector_alert_mutes
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE connector_alert_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_alert_recipients FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_connector_alert_recipients ON connector_alert_recipients;
CREATE POLICY tenant_isolation_connector_alert_recipients ON connector_alert_recipients
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE connector_alert_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_alert_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_connector_alert_settings ON connector_alert_settings;
CREATE POLICY tenant_isolation_connector_alert_settings ON connector_alert_settings
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE connector_stale_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_stale_alerts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_connector_stale_alerts ON connector_stale_alerts;
CREATE POLICY tenant_isolation_connector_stale_alerts ON connector_stale_alerts
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE crm_stale_cache_scrubs ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_stale_cache_scrubs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_crm_stale_cache_scrubs ON crm_stale_cache_scrubs;
CREATE POLICY tenant_isolation_crm_stale_cache_scrubs ON crm_stale_cache_scrubs
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE distributed_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE distributed_locks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_distributed_locks ON distributed_locks;
CREATE POLICY tenant_isolation_distributed_locks ON distributed_locks
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE evolution_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE evolution_signals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_evolution_signals ON evolution_signals;
CREATE POLICY tenant_isolation_evolution_signals ON evolution_signals
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE gin_policy_acceptance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE gin_policy_acceptance_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_gin_policy_acceptance_records ON gin_policy_acceptance_records;
CREATE POLICY tenant_isolation_gin_policy_acceptance_records ON gin_policy_acceptance_records
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE marketplace_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_purchases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_marketplace_purchases ON marketplace_purchases;
CREATE POLICY tenant_isolation_marketplace_purchases ON marketplace_purchases
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE marketplace_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_reviews FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_marketplace_reviews ON marketplace_reviews;
CREATE POLICY tenant_isolation_marketplace_reviews ON marketplace_reviews
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE milestone_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE milestone_thresholds FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_milestone_thresholds ON milestone_thresholds;
CREATE POLICY tenant_isolation_milestone_thresholds ON milestone_thresholds
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE operations_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_alerts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_operations_alerts ON operations_alerts;
CREATE POLICY tenant_isolation_operations_alerts ON operations_alerts
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE push_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_delivery_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_push_delivery_attempts ON push_delivery_attempts;
CREATE POLICY tenant_isolation_push_delivery_attempts ON push_delivery_attempts
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE support_recipient_bounce_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_recipient_bounce_alerts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_support_recipient_bounce_alerts ON support_recipient_bounce_alerts;
CREATE POLICY tenant_isolation_support_recipient_bounce_alerts ON support_recipient_bounce_alerts
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_support_tickets ON support_tickets;
CREATE POLICY tenant_isolation_support_tickets ON support_tickets
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE tenant_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_deletion_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_tenant_deletion_requests ON tenant_deletion_requests;
CREATE POLICY tenant_isolation_tenant_deletion_requests ON tenant_deletion_requests
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE tenant_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_tenant_notifications ON tenant_notifications;
CREATE POLICY tenant_isolation_tenant_notifications ON tenant_notifications
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_user_devices ON user_devices;
CREATE POLICY tenant_isolation_user_devices ON user_devices
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE verified_caller_alert_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE verified_caller_alert_recipients FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_verified_caller_alert_recipients ON verified_caller_alert_recipients;
CREATE POLICY tenant_isolation_verified_caller_alert_recipients ON verified_caller_alert_recipients
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE widget_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE widget_configs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_widget_configs ON widget_configs;
CREATE POLICY tenant_isolation_widget_configs ON widget_configs
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);

ALTER TABLE widget_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE widget_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_widget_tokens ON widget_tokens;
CREATE POLICY tenant_isolation_widget_tokens ON widget_tokens
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::varchar);
