CREATE TABLE IF NOT EXISTS users (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE SET NULL,
  email VARCHAR(255) NOT NULL,
  username VARCHAR(100),
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  password_hash VARCHAR(255),
  role VARCHAR(50) NOT NULL DEFAULT 'user',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at TIMESTAMP,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(email)
);

CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS agents (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(60) NOT NULL DEFAULT 'general',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  system_prompt TEXT,
  voice VARCHAR(50) DEFAULT 'alloy',
  model VARCHAR(100) DEFAULT 'gpt-4o-realtime-preview',
  temperature NUMERIC(3,2) DEFAULT 0.8,
  max_response_output_tokens INTEGER,
  tools JSONB DEFAULT '[]',
  knowledge_base JSONB DEFAULT '{}',
  escalation_config JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_tenant ON agents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_agents_type ON agents(type);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

CREATE TABLE IF NOT EXISTS agent_tools (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id VARCHAR NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tool_name VARCHAR(100) NOT NULL,
  tool_config JSONB DEFAULT '{}',
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_tools_agent ON agent_tools(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_tools_tenant ON agent_tools(tenant_id);

CREATE TABLE IF NOT EXISTS phone_endpoints (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  phone_number VARCHAR(20) NOT NULL,
  friendly_name VARCHAR(255),
  provider VARCHAR(50) DEFAULT 'twilio',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_phone_endpoints_tenant ON phone_endpoints(tenant_id);

CREATE TABLE IF NOT EXISTS campaigns (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id VARCHAR REFERENCES agents(id),
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'outbound_call',
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  config JSONB DEFAULT '{}',
  scheduled_at TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns(tenant_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

CREATE TABLE IF NOT EXISTS campaign_contacts (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id VARCHAR NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  phone_number VARCHAR(20) NOT NULL,
  name VARCHAR(255),
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_contacts_tenant ON campaign_contacts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_campaign ON campaign_contacts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_contacts_status ON campaign_contacts(status);

CREATE TABLE IF NOT EXISTS campaign_contact_attempts (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_contact_id VARCHAR NOT NULL REFERENCES campaign_contacts(id) ON DELETE CASCADE,
  call_sid VARCHAR(50),
  status VARCHAR(30),
  duration_seconds INTEGER,
  notes TEXT,
  attempted_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_contact_attempts_contact ON campaign_contact_attempts(campaign_contact_id);

CREATE TABLE IF NOT EXISTS call_logs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id VARCHAR REFERENCES agents(id),
  call_sid VARCHAR(50),
  direction VARCHAR(10) DEFAULT 'inbound',
  caller_number VARCHAR(20),
  called_number VARCHAR(20),
  status VARCHAR(30),
  duration_seconds INTEGER,
  cost_cents INTEGER,
  summary TEXT,
  sentiment VARCHAR(20),
  escalated BOOLEAN DEFAULT FALSE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_logs_tenant ON call_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_tenant_created ON call_logs(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_call_logs_call_sid ON call_logs(call_sid);

CREATE TABLE IF NOT EXISTS sms_logs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  direction VARCHAR(10) NOT NULL DEFAULT 'outbound',
  from_number VARCHAR(20),
  to_number VARCHAR(20),
  body TEXT,
  status VARCHAR(30),
  twilio_sid VARCHAR(50),
  cost_cents INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_logs_tenant ON sms_logs(tenant_id);

CREATE TABLE IF NOT EXISTS callback_queue (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  phone_number VARCHAR(20) NOT NULL,
  agent_id VARCHAR REFERENCES agents(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  priority INTEGER DEFAULT 0,
  notes TEXT,
  scheduled_at TIMESTAMP,
  attempted_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_callback_queue_tenant ON callback_queue(tenant_id);
CREATE INDEX IF NOT EXISTS idx_callback_queue_status ON callback_queue(status);

CREATE TABLE IF NOT EXISTS support_tickets (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  call_log_id VARCHAR REFERENCES call_logs(id),
  subject VARCHAR(255),
  description TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'open',
  priority VARCHAR(20) DEFAULT 'normal',
  assigned_to VARCHAR REFERENCES users(id),
  resolved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_tenant ON support_tickets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);

CREATE TABLE IF NOT EXISTS ticket_outbox (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  event_type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_outbox_tenant ON ticket_outbox(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ticket_outbox_status ON ticket_outbox(status);

CREATE TABLE IF NOT EXISTS handoff_states (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  call_sid VARCHAR(50) NOT NULL,
  agent_id VARCHAR REFERENCES agents(id),
  state VARCHAR(50) NOT NULL,
  context JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(call_sid)
);

CREATE INDEX IF NOT EXISTS idx_handoff_states_tenant ON handoff_states(tenant_id);
CREATE INDEX IF NOT EXISTS idx_handoff_states_call_sid ON handoff_states(call_sid);

CREATE TABLE IF NOT EXISTS active_call_sessions (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  call_sid VARCHAR(50) NOT NULL,
  agent_id VARCHAR REFERENCES agents(id),
  session_data JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(call_sid)
);

CREATE INDEX IF NOT EXISTS idx_active_call_sessions_tenant ON active_call_sessions(tenant_id);

CREATE TABLE IF NOT EXISTS distributed_locks (
  lock_name VARCHAR(255) PRIMARY KEY,
  tenant_id VARCHAR,
  holder_id VARCHAR(100),
  acquired_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_distributed_locks_expires ON distributed_locks(expires_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  source VARCHAR(50),
  event_type VARCHAR(100),
  payload JSONB DEFAULT '{}',
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  processed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_tenant ON webhook_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_processed ON webhook_events(processed);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id VARCHAR REFERENCES agents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  system_prompt TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by VARCHAR REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prompt_versions_agent ON prompt_versions(agent_id);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_tenant ON prompt_versions(tenant_id);

CREATE TABLE IF NOT EXISTS user_invitations (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  role VARCHAR(60),
  token VARCHAR(255) NOT NULL UNIQUE,
  invited_by VARCHAR REFERENCES users(id),
  accepted_at TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_invitations_tenant ON user_invitations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_invitations_token ON user_invitations(token);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) NOT NULL UNIQUE,
  used_at TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON password_reset_tokens(token);

CREATE TABLE IF NOT EXISTS answering_service_logs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  call_log_id VARCHAR REFERENCES call_logs(id),
  caller_name VARCHAR(255),
  caller_number VARCHAR(20),
  message TEXT,
  urgency VARCHAR(20),
  callback_requested BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_answering_service_logs_tenant ON answering_service_logs(tenant_id);

CREATE TABLE IF NOT EXISTS scheduling_workflows (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  workflow_type VARCHAR(60) NOT NULL,
  config JSONB DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduling_workflows_tenant ON scheduling_workflows(tenant_id);

CREATE TABLE IF NOT EXISTS daily_openai_costs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  model VARCHAR(100),
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_cents INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id, date, model)
);

CREATE INDEX IF NOT EXISTS idx_daily_openai_costs_tenant ON daily_openai_costs(tenant_id);

CREATE TABLE IF NOT EXISTS daily_org_usage (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  total_calls INTEGER DEFAULT 0,
  total_sms INTEGER DEFAULT 0,
  total_ai_minutes INTEGER DEFAULT 0,
  total_cost_cents INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_org_usage_tenant ON daily_org_usage(tenant_id);

CREATE TABLE IF NOT EXISTS daily_reconciliation (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  discrepancies JSONB DEFAULT '[]',
  reconciled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_reconciliation_tenant ON daily_reconciliation(tenant_id);

CREATE TABLE IF NOT EXISTS agent_prompts (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id VARCHAR REFERENCES agents(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_prompts_agent ON agent_prompts(agent_id);

CREATE TABLE IF NOT EXISTS agent_prompt_versions (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  agent_prompt_id VARCHAR REFERENCES agent_prompts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_prompt_versions_prompt ON agent_prompt_versions(agent_prompt_id);
