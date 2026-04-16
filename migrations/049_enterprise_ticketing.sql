-- Enterprise Ticketing System: Extended schema for full ticket lifecycle management

-- Ticket categories for structured intake
CREATE TABLE IF NOT EXISTS ticket_categories (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  parent_id VARCHAR(255) REFERENCES ticket_categories(id) ON DELETE SET NULL,
  sort_order INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_categories_tenant ON ticket_categories(tenant_id);

ALTER TABLE ticket_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ticket_categories ON ticket_categories;
CREATE POLICY tenant_isolation_ticket_categories ON ticket_categories
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

-- Extend tickets table with enterprise fields
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS category_id VARCHAR(255) REFERENCES ticket_categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS department VARCHAR(100) DEFAULT '',
  ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'manual' CHECK (source IN ('manual', 'api', 'ai_agent', 'email', 'phone')),
  ADD COLUMN IF NOT EXISTS ticket_number SERIAL,
  ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reopened_count INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS parent_ticket_id VARCHAR(255) REFERENCES tickets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contact_name VARCHAR(255) DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255) DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(50) DEFAULT '',
  ADD COLUMN IF NOT EXISTS created_by_user_id VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL;

-- Update status check constraint to include new statuses
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_status_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_status_check
  CHECK (status IN ('open', 'in_progress', 'pending', 'escalated', 'resolved', 'closed', 'reopened'));

CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(tenant_id, category_id);
CREATE INDEX IF NOT EXISTS idx_tickets_priority_status ON tickets(tenant_id, priority, status);
CREATE INDEX IF NOT EXISTS idx_tickets_department ON tickets(tenant_id, department);
CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tickets_ticket_number ON tickets(tenant_id, ticket_number);

-- Ticket activity log for timeline events
CREATE TABLE IF NOT EXISTS ticket_activity_log (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id VARCHAR(255) NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  activity_type VARCHAR(50) NOT NULL CHECK (activity_type IN (
    'created', 'status_change', 'priority_change', 'assigned', 'unassigned',
    'note', 'internal_note', 'field_change', 'escalated', 'reopened',
    'sla_breach', 'sla_breached', 'sla_warning', 'watcher_added', 'watcher_removed',
    'linked', 'unlinked', 'category_change', 'department_change',
    'macro_applied', 'auto_closed', 'merged', 'template_response',
    'attachment_added', 'attachment_removed'
  )),
  content TEXT DEFAULT '',
  old_value TEXT DEFAULT '',
  new_value TEXT DEFAULT '',
  field_name VARCHAR(100) DEFAULT '',
  metadata JSONB DEFAULT '{}',
  is_internal BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_activity_ticket ON ticket_activity_log(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ticket_activity_tenant ON ticket_activity_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ticket_activity_type ON ticket_activity_log(tenant_id, activity_type);

ALTER TABLE ticket_activity_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ticket_activity_log ON ticket_activity_log;
CREATE POLICY tenant_isolation_ticket_activity_log ON ticket_activity_log
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

-- Ticket watchers
CREATE TABLE IF NOT EXISTS ticket_watchers (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id VARCHAR(255) NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(ticket_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ticket_watchers_ticket ON ticket_watchers(ticket_id);

ALTER TABLE ticket_watchers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ticket_watchers ON ticket_watchers;
CREATE POLICY tenant_isolation_ticket_watchers ON ticket_watchers
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

-- Ticket attachments metadata
CREATE TABLE IF NOT EXISTS ticket_attachments (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id VARCHAR(255) NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  file_name VARCHAR(500) NOT NULL,
  file_size INT DEFAULT 0,
  file_type VARCHAR(100) DEFAULT 'application/octet-stream',
  file_url VARCHAR(2000) DEFAULT '',
  uploaded_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_attachments_ticket ON ticket_attachments(ticket_id);

ALTER TABLE ticket_attachments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ticket_attachments ON ticket_attachments;
CREATE POLICY tenant_isolation_ticket_attachments ON ticket_attachments
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

-- Linked/related tickets
CREATE TABLE IF NOT EXISTS ticket_links (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_ticket_id VARCHAR(255) NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  target_ticket_id VARCHAR(255) NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  link_type VARCHAR(30) DEFAULT 'related' CHECK (link_type IN ('related', 'blocks', 'blocked_by', 'duplicate', 'parent', 'child')),
  created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_ticket_id, target_ticket_id)
);

CREATE INDEX IF NOT EXISTS idx_ticket_links_source ON ticket_links(source_ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_links_target ON ticket_links(target_ticket_id);

ALTER TABLE ticket_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ticket_links ON ticket_links;
CREATE POLICY tenant_isolation_ticket_links ON ticket_links
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

-- SLA policies
CREATE TABLE IF NOT EXISTS ticket_sla_policies (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  priority VARCHAR(20) NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  category_id VARCHAR(255) REFERENCES ticket_categories(id) ON DELETE SET NULL,
  first_response_minutes INT NOT NULL DEFAULT 480,
  resolution_minutes INT NOT NULL DEFAULT 2880,
  escalation_minutes INT DEFAULT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_sla_policies_tenant ON ticket_sla_policies(tenant_id);

ALTER TABLE ticket_sla_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ticket_sla_policies ON ticket_sla_policies;
CREATE POLICY tenant_isolation_ticket_sla_policies ON ticket_sla_policies
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

-- SLA instances (per-ticket timers)
CREATE TABLE IF NOT EXISTS ticket_sla_instances (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id VARCHAR(255) NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  policy_id VARCHAR(255) NOT NULL REFERENCES ticket_sla_policies(id) ON DELETE CASCADE,
  response_due_at TIMESTAMPTZ,
  resolution_due_at TIMESTAMPTZ,
  response_met BOOLEAN DEFAULT NULL,
  resolution_met BOOLEAN DEFAULT NULL,
  response_breached_at TIMESTAMPTZ,
  resolution_breached_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  total_paused_minutes INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_sla_instances_ticket ON ticket_sla_instances(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_sla_instances_due ON ticket_sla_instances(tenant_id, resolution_due_at);

ALTER TABLE ticket_sla_instances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ticket_sla_instances ON ticket_sla_instances;
CREATE POLICY tenant_isolation_ticket_sla_instances ON ticket_sla_instances
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

-- Ticket macros (quick actions)
CREATE TABLE IF NOT EXISTS ticket_macros (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  actions JSONB NOT NULL DEFAULT '[]',
  is_active BOOLEAN DEFAULT true,
  created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_macros_tenant ON ticket_macros(tenant_id);

ALTER TABLE ticket_macros ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ticket_macros ON ticket_macros;
CREATE POLICY tenant_isolation_ticket_macros ON ticket_macros
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

-- Saved view definitions
CREATE TABLE IF NOT EXISTS ticket_saved_views (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  filters JSONB NOT NULL DEFAULT '{}',
  sort_by VARCHAR(100) DEFAULT 'created_at',
  sort_order VARCHAR(4) DEFAULT 'desc',
  is_shared BOOLEAN DEFAULT false,
  created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_saved_views_tenant ON ticket_saved_views(tenant_id);

ALTER TABLE ticket_saved_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ticket_saved_views ON ticket_saved_views;
CREATE POLICY tenant_isolation_ticket_saved_views ON ticket_saved_views
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

-- Template responses
CREATE TABLE IF NOT EXISTS ticket_templates (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  subject VARCHAR(500) DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  category_id VARCHAR(255) REFERENCES ticket_categories(id) ON DELETE SET NULL,
  variables JSONB DEFAULT '[]',
  is_active BOOLEAN DEFAULT true,
  created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_templates_tenant ON ticket_templates(tenant_id);

ALTER TABLE ticket_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ticket_templates ON ticket_templates;
CREATE POLICY tenant_isolation_ticket_templates ON ticket_templates
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

-- Custom field definitions
CREATE TABLE IF NOT EXISTS ticket_custom_fields (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  field_key VARCHAR(100) NOT NULL,
  field_type VARCHAR(30) NOT NULL CHECK (field_type IN ('text', 'number', 'select', 'multi_select', 'date', 'boolean', 'url')),
  options JSONB DEFAULT '[]',
  is_required BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_ticket_custom_fields_tenant ON ticket_custom_fields(tenant_id);

ALTER TABLE ticket_custom_fields ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ticket_custom_fields ON ticket_custom_fields;
CREATE POLICY tenant_isolation_ticket_custom_fields ON ticket_custom_fields
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

-- Custom field values per ticket
CREATE TABLE IF NOT EXISTS ticket_custom_field_values (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id VARCHAR(255) NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  field_id VARCHAR(255) NOT NULL REFERENCES ticket_custom_fields(id) ON DELETE CASCADE,
  value TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(ticket_id, field_id)
);

CREATE INDEX IF NOT EXISTS idx_ticket_custom_field_values_ticket ON ticket_custom_field_values(ticket_id);

ALTER TABLE ticket_custom_field_values ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ticket_custom_field_values ON ticket_custom_field_values;
CREATE POLICY tenant_isolation_ticket_custom_field_values ON ticket_custom_field_values
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

-- Workflow rules for automation
CREATE TABLE IF NOT EXISTS ticket_workflow_rules (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  trigger_event VARCHAR(50) NOT NULL CHECK (trigger_event IN ('ticket_created', 'status_change', 'status_changed', 'priority_change', 'priority_changed', 'assigned', 'sla_breach', 'time_based')),
  conditions JSONB NOT NULL DEFAULT '{}',
  actions JSONB NOT NULL DEFAULT '[]',
  is_active BOOLEAN DEFAULT true,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_workflow_rules_tenant ON ticket_workflow_rules(tenant_id);

ALTER TABLE ticket_workflow_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ticket_workflow_rules ON ticket_workflow_rules;
CREATE POLICY tenant_isolation_ticket_workflow_rules ON ticket_workflow_rules
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

-- Queue configuration for assignment routing
CREATE TABLE IF NOT EXISTS ticket_queue_configs (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  assignment_strategy VARCHAR(50) NOT NULL DEFAULT 'manual' CHECK (assignment_strategy IN ('manual', 'round_robin', 'least_loaded')),
  eligible_user_ids TEXT[] DEFAULT '{}',
  filter_priority TEXT[] DEFAULT '{}',
  filter_category_id VARCHAR(255) REFERENCES ticket_categories(id) ON DELETE SET NULL,
  filter_department VARCHAR(100) DEFAULT '',
  max_tickets_per_agent INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  sort_order INT DEFAULT 0,
  last_assigned_user_index INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_queue_configs_tenant ON ticket_queue_configs(tenant_id);

ALTER TABLE ticket_queue_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ticket_queue_configs ON ticket_queue_configs;
CREATE POLICY tenant_isolation_ticket_queue_configs ON ticket_queue_configs
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

-- Retention / archival policies
CREATE TABLE IF NOT EXISTS ticket_retention_policies (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  target_status VARCHAR(50) NOT NULL DEFAULT 'closed',
  days_after_close INT NOT NULL DEFAULT 90,
  action VARCHAR(50) NOT NULL DEFAULT 'archive' CHECK (action IN ('archive', 'delete', 'anonymize')),
  is_active BOOLEAN DEFAULT true,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_retention_policies_tenant ON ticket_retention_policies(tenant_id);

ALTER TABLE ticket_retention_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ticket_retention_policies ON ticket_retention_policies;
CREATE POLICY tenant_isolation_ticket_retention_policies ON ticket_retention_policies
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

-- Ticket notifications table for tracking dispatched notifications
CREATE TABLE IF NOT EXISTS ticket_notifications (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id VARCHAR(255) NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type VARCHAR(50) NOT NULL CHECK (notification_type IN ('assignment', 'escalation', 'sla_breach', 'mention', 'status_change', 'comment')),
  channel VARCHAR(20) NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app', 'email', 'sms')),
  subject TEXT DEFAULT '',
  body TEXT DEFAULT '',
  is_read BOOLEAN DEFAULT false,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_notifications_user ON ticket_notifications(tenant_id, user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_ticket_notifications_ticket ON ticket_notifications(ticket_id);

ALTER TABLE ticket_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ticket_notifications ON ticket_notifications;
CREATE POLICY tenant_isolation_ticket_notifications ON ticket_notifications
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

-- Add archived_at column to tickets for retention
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
