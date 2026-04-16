DROP POLICY IF EXISTS sms_conversations_tenant_policy ON sms_conversations;
CREATE POLICY sms_conversations_tenant_policy ON sms_conversations
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS sms_messages_tenant_policy ON sms_messages;
CREATE POLICY sms_messages_tenant_policy ON sms_messages
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS sms_internal_notes_tenant_policy ON sms_internal_notes;
CREATE POLICY sms_internal_notes_tenant_policy ON sms_internal_notes
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS sms_canned_responses_tenant_policy ON sms_canned_responses;
CREATE POLICY sms_canned_responses_tenant_policy ON sms_canned_responses
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS sms_auto_reply_rules_tenant_policy ON sms_auto_reply_rules;
CREATE POLICY sms_auto_reply_rules_tenant_policy ON sms_auto_reply_rules
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS sms_assignment_rules_tenant_policy ON sms_assignment_rules;
CREATE POLICY sms_assignment_rules_tenant_policy ON sms_assignment_rules
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS sms_activity_log_tenant_policy ON sms_conversation_activity_log;
CREATE POLICY sms_activity_log_tenant_policy ON sms_conversation_activity_log
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS sms_consent_log_tenant_policy ON sms_consent_log;
CREATE POLICY sms_consent_log_tenant_policy ON sms_consent_log
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
