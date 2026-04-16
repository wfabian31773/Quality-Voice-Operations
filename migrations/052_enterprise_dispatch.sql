-- Enterprise Dispatch System: Extended schema for full work-order management

-- Skill type definitions
CREATE TABLE IF NOT EXISTS dispatch_skill_types (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  category VARCHAR(100) DEFAULT 'general',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_skill_types_tenant ON dispatch_skill_types(tenant_id);

-- Territory definitions
CREATE TABLE IF NOT EXISTS dispatch_territories (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  region VARCHAR(255) DEFAULT '',
  zip_codes TEXT[] DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_territories_tenant ON dispatch_territories(tenant_id);

-- Resource profiles for field workers / dispatch resources
CREATE TABLE IF NOT EXISTS dispatch_resources (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) DEFAULT '',
  phone VARCHAR(50) DEFAULT '',
  role VARCHAR(50) NOT NULL DEFAULT 'field_worker',
  territory_id VARCHAR(255) REFERENCES dispatch_territories(id) ON DELETE SET NULL,
  shift_start TIME DEFAULT '08:00',
  shift_end TIME DEFAULT '17:00',
  shift_days INTEGER[] DEFAULT '{1,2,3,4,5}',
  max_concurrent_jobs INTEGER DEFAULT 3,
  current_status VARCHAR(30) NOT NULL DEFAULT 'available'
    CHECK (current_status IN ('available', 'busy', 'on_break', 'off_shift', 'unavailable')),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_resources_tenant ON dispatch_resources(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_resources_user ON dispatch_resources(user_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_resources_territory ON dispatch_resources(territory_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_resources_status ON dispatch_resources(tenant_id, current_status);

-- Resource skills (many-to-many)
CREATE TABLE IF NOT EXISTS dispatch_resource_skills (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  resource_id VARCHAR(255) NOT NULL REFERENCES dispatch_resources(id) ON DELETE CASCADE,
  skill_type_id VARCHAR(255) NOT NULL REFERENCES dispatch_skill_types(id) ON DELETE CASCADE,
  proficiency_level INTEGER DEFAULT 1 CHECK (proficiency_level BETWEEN 1 AND 5),
  certified_at TIMESTAMPTZ DEFAULT NULL,
  expires_at TIMESTAMPTZ DEFAULT NULL,
  UNIQUE(resource_id, skill_type_id)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_resource_skills_resource ON dispatch_resource_skills(resource_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_resource_skills_skill ON dispatch_resource_skills(skill_type_id);

-- Extend dispatch_jobs with new columns
ALTER TABLE dispatch_jobs
  ADD COLUMN IF NOT EXISTS territory_id VARCHAR(255) REFERENCES dispatch_territories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resource_id VARCHAR(255) REFERENCES dispatch_resources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS job_type VARCHAR(100) DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS estimated_duration_minutes INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS actual_duration_minutes INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS eta_start TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS eta_end TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS address TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(50) DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255) DEFAULT '',
  ADD COLUMN IF NOT EXISTS parent_job_id VARCHAR(255) REFERENCES dispatch_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_follow_up BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS required_skills TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Update the status check constraint to support full lifecycle
ALTER TABLE dispatch_jobs DROP CONSTRAINT IF EXISTS dispatch_jobs_status_check;
ALTER TABLE dispatch_jobs ADD CONSTRAINT dispatch_jobs_status_check
  CHECK (status IN ('pending', 'assigned', 'scheduled', 'en_route', 'on_site', 'in_progress', 'completed', 'incomplete', 'cancelled', 'done'));

CREATE INDEX IF NOT EXISTS idx_dispatch_jobs_territory ON dispatch_jobs(tenant_id, territory_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_jobs_resource ON dispatch_jobs(tenant_id, resource_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_jobs_parent ON dispatch_jobs(parent_job_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_jobs_scheduled ON dispatch_jobs(tenant_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_dispatch_jobs_priority_status ON dispatch_jobs(tenant_id, priority, status);

-- Job lifecycle events (audit trail)
CREATE TABLE IF NOT EXISTS dispatch_job_events (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  job_id VARCHAR(255) NOT NULL REFERENCES dispatch_jobs(id) ON DELETE CASCADE,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  from_status VARCHAR(30) DEFAULT NULL,
  to_status VARCHAR(30) DEFAULT NULL,
  performed_by VARCHAR(255) DEFAULT NULL,
  notes TEXT DEFAULT '',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_job_events_job ON dispatch_job_events(job_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_job_events_tenant ON dispatch_job_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_job_events_created ON dispatch_job_events(tenant_id, created_at DESC);

-- Job exceptions
CREATE TABLE IF NOT EXISTS dispatch_job_exceptions (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  job_id VARCHAR(255) NOT NULL REFERENCES dispatch_jobs(id) ON DELETE CASCADE,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  exception_type VARCHAR(50) NOT NULL
    CHECK (exception_type IN ('delay', 'no_access', 'cancelled', 'reschedule', 'return_visit', 'reassignment', 'other')),
  reason TEXT NOT NULL DEFAULT '',
  resolution TEXT DEFAULT '',
  resolved_at TIMESTAMPTZ DEFAULT NULL,
  reported_by VARCHAR(255) DEFAULT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_job_exceptions_job ON dispatch_job_exceptions(job_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_job_exceptions_tenant ON dispatch_job_exceptions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_job_exceptions_type ON dispatch_job_exceptions(tenant_id, exception_type);

-- Job attachments (field notes, proof of service)
CREATE TABLE IF NOT EXISTS dispatch_job_attachments (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  job_id VARCHAR(255) NOT NULL REFERENCES dispatch_jobs(id) ON DELETE CASCADE,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  attachment_type VARCHAR(50) NOT NULL DEFAULT 'note'
    CHECK (attachment_type IN ('note', 'photo', 'document', 'signature', 'proof_of_service', 'proof_of_completion')),
  title VARCHAR(255) DEFAULT '',
  content TEXT DEFAULT '',
  file_url VARCHAR(1000) DEFAULT NULL,
  uploaded_by VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_job_attachments_job ON dispatch_job_attachments(job_id);

-- Notification templates
CREATE TABLE IF NOT EXISTS dispatch_notification_templates (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  trigger_event VARCHAR(100) NOT NULL,
  channel VARCHAR(30) NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms', 'email', 'both')),
  subject VARCHAR(500) DEFAULT '',
  body_template TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_notification_templates_tenant ON dispatch_notification_templates(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_notification_templates_event ON dispatch_notification_templates(tenant_id, trigger_event);

-- Notification log
CREATE TABLE IF NOT EXISTS dispatch_notifications_log (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  job_id VARCHAR(255) REFERENCES dispatch_jobs(id) ON DELETE SET NULL,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id VARCHAR(255) REFERENCES dispatch_notification_templates(id) ON DELETE SET NULL,
  channel VARCHAR(30) NOT NULL,
  recipient VARCHAR(255) NOT NULL,
  subject VARCHAR(500) DEFAULT '',
  body TEXT DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'sent',
  error_message TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_notifications_log_job ON dispatch_notifications_log(job_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_notifications_log_tenant ON dispatch_notifications_log(tenant_id);

-- Assignment rules
CREATE TABLE IF NOT EXISTS dispatch_assignment_rules (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  rule_type VARCHAR(50) NOT NULL DEFAULT 'auto_assign'
    CHECK (rule_type IN ('auto_assign', 'round_robin', 'skill_match', 'territory_match', 'capacity_based')),
  priority INTEGER DEFAULT 0,
  conditions JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_assignment_rules_tenant ON dispatch_assignment_rules(tenant_id);

-- RLS policies
ALTER TABLE dispatch_skill_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_territories ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_resource_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_job_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_job_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_job_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_notifications_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_assignment_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_dispatch_skill_types ON dispatch_skill_types;
CREATE POLICY tenant_isolation_dispatch_skill_types ON dispatch_skill_types
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_dispatch_territories ON dispatch_territories;
CREATE POLICY tenant_isolation_dispatch_territories ON dispatch_territories
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_dispatch_resources ON dispatch_resources;
CREATE POLICY tenant_isolation_dispatch_resources ON dispatch_resources
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_dispatch_resource_skills ON dispatch_resource_skills;
CREATE POLICY tenant_isolation_dispatch_resource_skills ON dispatch_resource_skills
  USING (resource_id IN (SELECT id FROM dispatch_resources WHERE tenant_id = current_setting('app.tenant_id', true)::varchar));

DROP POLICY IF EXISTS tenant_isolation_dispatch_job_events ON dispatch_job_events;
CREATE POLICY tenant_isolation_dispatch_job_events ON dispatch_job_events
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_dispatch_job_exceptions ON dispatch_job_exceptions;
CREATE POLICY tenant_isolation_dispatch_job_exceptions ON dispatch_job_exceptions
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_dispatch_job_attachments ON dispatch_job_attachments;
CREATE POLICY tenant_isolation_dispatch_job_attachments ON dispatch_job_attachments
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_dispatch_notification_templates ON dispatch_notification_templates;
CREATE POLICY tenant_isolation_dispatch_notification_templates ON dispatch_notification_templates
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_dispatch_notifications_log ON dispatch_notifications_log;
CREATE POLICY tenant_isolation_dispatch_notifications_log ON dispatch_notifications_log
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_dispatch_assignment_rules ON dispatch_assignment_rules;
CREATE POLICY tenant_isolation_dispatch_assignment_rules ON dispatch_assignment_rules
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);
