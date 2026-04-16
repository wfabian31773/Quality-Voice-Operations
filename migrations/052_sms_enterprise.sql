CREATE TABLE IF NOT EXISTS sms_conversations (
  id VARCHAR PRIMARY KEY,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id),
  phone_number_id VARCHAR NOT NULL,
  remote_number VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  assignee_user_id VARCHAR,
  assignee_team VARCHAR(100),
  priority VARCHAR(10) NOT NULL DEFAULT 'normal',
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  unread_count INTEGER NOT NULL DEFAULT 0,
  follow_up BOOLEAN NOT NULL DEFAULT FALSE,
  follow_up_at TIMESTAMP,
  last_message_at TIMESTAMP,
  last_message_preview TEXT,
  closed_at TIMESTAMP,
  escalated_at TIMESTAMP,
  contact_name VARCHAR(255),
  contact_email VARCHAR(255),
  contact_location VARCHAR(255),
  tags TEXT[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_conv_tenant ON sms_conversations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sms_conv_tenant_status ON sms_conversations(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_sms_conv_tenant_assignee ON sms_conversations(tenant_id, assignee_user_id);
CREATE INDEX IF NOT EXISTS idx_sms_conv_tenant_last_msg ON sms_conversations(tenant_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_conv_remote ON sms_conversations(tenant_id, phone_number_id, remote_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_conv_unique_thread ON sms_conversations(tenant_id, phone_number_id, remote_number);

ALTER TABLE sms_conversations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_conversations_tenant_policy ON sms_conversations;
CREATE POLICY sms_conversations_tenant_policy ON sms_conversations
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE IF NOT EXISTS sms_messages (
  id VARCHAR PRIMARY KEY,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id),
  conversation_id VARCHAR NOT NULL REFERENCES sms_conversations(id) ON DELETE CASCADE,
  direction VARCHAR(10) NOT NULL,
  from_number VARCHAR(20) NOT NULL,
  to_number VARCHAR(20) NOT NULL,
  body TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'queued',
  twilio_sid VARCHAR(50),
  scheduled_at TIMESTAMP,
  sent_at TIMESTAMP,
  delivered_at TIMESTAMP,
  error_message TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_msg_tenant ON sms_messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sms_msg_conv ON sms_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sms_msg_twilio ON sms_messages(twilio_sid);
CREATE INDEX IF NOT EXISTS idx_sms_msg_scheduled ON sms_messages(tenant_id, scheduled_at) WHERE scheduled_at IS NOT NULL AND status = 'scheduled';

ALTER TABLE sms_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_messages_tenant_policy ON sms_messages;
CREATE POLICY sms_messages_tenant_policy ON sms_messages
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE IF NOT EXISTS sms_internal_notes (
  id VARCHAR PRIMARY KEY,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id),
  conversation_id VARCHAR NOT NULL REFERENCES sms_conversations(id) ON DELETE CASCADE,
  user_id VARCHAR NOT NULL,
  user_name VARCHAR(255),
  body TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_notes_conv ON sms_internal_notes(conversation_id, created_at);

ALTER TABLE sms_internal_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_internal_notes_tenant_policy ON sms_internal_notes;
CREATE POLICY sms_internal_notes_tenant_policy ON sms_internal_notes
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE IF NOT EXISTS sms_canned_responses (
  id VARCHAR PRIMARY KEY,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id),
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  category VARCHAR(100),
  variables TEXT[] DEFAULT '{}',
  shortcut VARCHAR(50),
  created_by VARCHAR,
  is_global BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_canned_tenant ON sms_canned_responses(tenant_id);

ALTER TABLE sms_canned_responses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_canned_responses_tenant_policy ON sms_canned_responses;
CREATE POLICY sms_canned_responses_tenant_policy ON sms_canned_responses
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE IF NOT EXISTS sms_auto_reply_rules (
  id VARCHAR PRIMARY KEY,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id),
  name VARCHAR(255) NOT NULL,
  rule_type VARCHAR(30) NOT NULL DEFAULT 'keyword',
  keyword VARCHAR(255),
  match_type VARCHAR(20) DEFAULT 'exact',
  reply_body TEXT NOT NULL,
  is_business_hours BOOLEAN DEFAULT NULL,
  business_hours_start VARCHAR(5),
  business_hours_end VARCHAR(5),
  business_days INTEGER[] DEFAULT '{1,2,3,4,5}',
  timezone VARCHAR(100) DEFAULT 'America/Chicago',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 0,
  phone_number_id VARCHAR,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_auto_reply_tenant ON sms_auto_reply_rules(tenant_id, enabled);

ALTER TABLE sms_auto_reply_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_auto_reply_rules_tenant_policy ON sms_auto_reply_rules;
CREATE POLICY sms_auto_reply_rules_tenant_policy ON sms_auto_reply_rules
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE IF NOT EXISTS sms_assignment_rules (
  id VARCHAR PRIMARY KEY,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id),
  name VARCHAR(255) NOT NULL,
  rule_type VARCHAR(30) NOT NULL,
  match_field VARCHAR(50) NOT NULL,
  match_value VARCHAR(255) NOT NULL,
  assign_to_user_id VARCHAR,
  assign_to_team VARCHAR(100),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_assign_rules_tenant ON sms_assignment_rules(tenant_id, enabled);

ALTER TABLE sms_assignment_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_assignment_rules_tenant_policy ON sms_assignment_rules;
CREATE POLICY sms_assignment_rules_tenant_policy ON sms_assignment_rules
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE IF NOT EXISTS sms_conversation_activity_log (
  id VARCHAR PRIMARY KEY,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id),
  conversation_id VARCHAR NOT NULL REFERENCES sms_conversations(id) ON DELETE CASCADE,
  action VARCHAR(50) NOT NULL,
  actor_user_id VARCHAR,
  actor_name VARCHAR(255),
  details JSONB DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_activity_conv ON sms_conversation_activity_log(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_activity_tenant ON sms_conversation_activity_log(tenant_id, created_at DESC);

ALTER TABLE sms_conversation_activity_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_activity_tenant_policy ON sms_conversation_activity_log;
CREATE POLICY sms_activity_tenant_policy ON sms_conversation_activity_log
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE IF NOT EXISTS sms_consent_log (
  id VARCHAR PRIMARY KEY,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id),
  phone_number VARCHAR(20) NOT NULL,
  action VARCHAR(20) NOT NULL,
  keyword VARCHAR(50),
  source VARCHAR(30) NOT NULL,
  twilio_sid VARCHAR(50),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_consent_tenant_phone ON sms_consent_log(tenant_id, phone_number, created_at DESC);

ALTER TABLE sms_consent_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_consent_log_tenant_policy ON sms_consent_log;
CREATE POLICY sms_consent_log_tenant_policy ON sms_consent_log
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
