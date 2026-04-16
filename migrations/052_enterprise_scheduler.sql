-- Enterprise Scheduler: providers, schedules, appointment types, resources, rules, waitlist, reminders, audit, recurring

-- Providers table
CREATE TABLE IF NOT EXISTS scheduling_providers (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  specialty VARCHAR(255) DEFAULT '',
  email VARCHAR(255) DEFAULT '',
  phone VARCHAR(50) DEFAULT '',
  location VARCHAR(255) DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sched_providers_tenant ON scheduling_providers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sched_providers_active ON scheduling_providers(tenant_id, is_active);

-- Provider schedules (recurring weekly availability blocks)
CREATE TABLE IF NOT EXISTS scheduling_provider_schedules (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_id VARCHAR(255) NOT NULL REFERENCES scheduling_providers(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  location VARCHAR(255) DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sched_prov_sched_provider ON scheduling_provider_schedules(provider_id);
CREATE INDEX IF NOT EXISTS idx_sched_prov_sched_tenant ON scheduling_provider_schedules(tenant_id);

-- Schedule overrides (blackout dates, special hours)
CREATE TABLE IF NOT EXISTS scheduling_overrides (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_id VARCHAR(255) REFERENCES scheduling_providers(id) ON DELETE CASCADE,
  override_date DATE NOT NULL,
  start_time TIME DEFAULT NULL,
  end_time TIME DEFAULT NULL,
  is_available BOOLEAN NOT NULL DEFAULT false,
  reason VARCHAR(500) DEFAULT '',
  created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sched_overrides_provider ON scheduling_overrides(provider_id, override_date);
CREATE INDEX IF NOT EXISTS idx_sched_overrides_tenant ON scheduling_overrides(tenant_id, override_date);

-- Appointment types
CREATE TABLE IF NOT EXISTS scheduling_appointment_types (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  buffer_minutes INTEGER NOT NULL DEFAULT 0,
  capacity INTEGER NOT NULL DEFAULT 1,
  color VARCHAR(20) DEFAULT '#3b82f6',
  required_resources JSONB DEFAULT '[]',
  intake_fields JSONB DEFAULT '[]',
  is_active BOOLEAN NOT NULL DEFAULT true,
  allow_self_scheduling BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sched_appt_types_tenant ON scheduling_appointment_types(tenant_id);

-- Resources (rooms, equipment)
CREATE TABLE IF NOT EXISTS scheduling_resources (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'room' CHECK (type IN ('room', 'equipment', 'other')),
  location VARCHAR(255) DEFAULT '',
  capacity INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sched_resources_tenant ON scheduling_resources(tenant_id);

-- Booking rules
CREATE TABLE IF NOT EXISTS scheduling_booking_rules (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  appointment_type_id VARCHAR(255) REFERENCES scheduling_appointment_types(id) ON DELETE CASCADE,
  min_lead_time_hours INTEGER NOT NULL DEFAULT 0,
  max_lead_time_days INTEGER NOT NULL DEFAULT 90,
  allow_same_day BOOLEAN NOT NULL DEFAULT true,
  allow_double_book BOOLEAN NOT NULL DEFAULT false,
  max_daily_bookings INTEGER DEFAULT NULL,
  max_per_slot INTEGER NOT NULL DEFAULT 1,
  cancellation_window_hours INTEGER NOT NULL DEFAULT 24,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sched_rules_tenant ON scheduling_booking_rules(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sched_rules_type ON scheduling_booking_rules(appointment_type_id);

-- Add new columns to bookings table
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS provider_id VARCHAR(255) REFERENCES scheduling_providers(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS appointment_type_id VARCHAR(255) REFERENCES scheduling_appointment_types(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS resource_id VARCHAR(255) REFERENCES scheduling_resources(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS recurring_series_id VARCHAR(255) DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancellation_reason TEXT DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS intake_data JSONB DEFAULT '{}';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'America/New_York';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS location VARCHAR(255) DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_source VARCHAR(30) DEFAULT 'manual' CHECK (booking_source IN ('manual', 'self_schedule', 'ai_agent', 'phone', 'api'));

-- Update status check to include new statuses
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'no_show', 'checked_in', 'rescheduled'));

CREATE INDEX IF NOT EXISTS idx_bookings_provider ON bookings(provider_id);
CREATE INDEX IF NOT EXISTS idx_bookings_type ON bookings(appointment_type_id);
CREATE INDEX IF NOT EXISTS idx_bookings_resource ON bookings(resource_id);
CREATE INDEX IF NOT EXISTS idx_bookings_series ON bookings(recurring_series_id);

-- Recurring appointment series
CREATE TABLE IF NOT EXISTS scheduling_recurring_series (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  provider_id VARCHAR(255) REFERENCES scheduling_providers(id) ON DELETE SET NULL,
  appointment_type_id VARCHAR(255) REFERENCES scheduling_appointment_types(id) ON DELETE SET NULL,
  resource_id VARCHAR(255) REFERENCES scheduling_resources(id) ON DELETE SET NULL,
  recurrence_pattern VARCHAR(30) NOT NULL DEFAULT 'weekly' CHECK (recurrence_pattern IN ('daily', 'weekly', 'biweekly', 'monthly')),
  recurrence_day_of_week INTEGER CHECK (recurrence_day_of_week >= 0 AND recurrence_day_of_week <= 6),
  recurrence_time TIME NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  series_start DATE NOT NULL,
  series_end DATE DEFAULT NULL,
  contact_name VARCHAR(255) DEFAULT '',
  contact_phone VARCHAR(50) DEFAULT '',
  contact_email VARCHAR(255) DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sched_recurring_tenant ON scheduling_recurring_series(tenant_id);

-- Waitlist
CREATE TABLE IF NOT EXISTS scheduling_waitlist (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_name VARCHAR(255) NOT NULL,
  contact_phone VARCHAR(50) DEFAULT '',
  contact_email VARCHAR(255) DEFAULT '',
  appointment_type_id VARCHAR(255) REFERENCES scheduling_appointment_types(id) ON DELETE SET NULL,
  provider_id VARCHAR(255) REFERENCES scheduling_providers(id) ON DELETE SET NULL,
  preferred_date_start DATE DEFAULT NULL,
  preferred_date_end DATE DEFAULT NULL,
  preferred_time_start TIME DEFAULT NULL,
  preferred_time_end TIME DEFAULT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'offered', 'booked', 'expired', 'cancelled')),
  notes TEXT DEFAULT '',
  notified_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sched_waitlist_tenant ON scheduling_waitlist(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sched_waitlist_status ON scheduling_waitlist(tenant_id, status);

-- Reminder configurations
CREATE TABLE IF NOT EXISTS scheduling_reminder_configs (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  appointment_type_id VARCHAR(255) REFERENCES scheduling_appointment_types(id) ON DELETE CASCADE,
  reminder_type VARCHAR(30) NOT NULL DEFAULT 'reminder' CHECK (reminder_type IN ('confirmation', 'reminder', 'cancellation_followup', 'reschedule_prompt')),
  channel VARCHAR(20) NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms', 'email', 'both')),
  timing_minutes INTEGER NOT NULL DEFAULT 1440,
  template TEXT DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sched_reminders_tenant ON scheduling_reminder_configs(tenant_id);

-- Reminder delivery log
CREATE TABLE IF NOT EXISTS scheduling_reminder_log (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id VARCHAR(255) NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  reminder_config_id VARCHAR(255) REFERENCES scheduling_reminder_configs(id) ON DELETE SET NULL,
  channel VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'failed')),
  sent_at TIMESTAMPTZ DEFAULT NULL,
  error_message TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sched_reminder_log_booking ON scheduling_reminder_log(booking_id);
CREATE INDEX IF NOT EXISTS idx_sched_reminder_log_tenant ON scheduling_reminder_log(tenant_id);

-- Scheduling audit log
CREATE TABLE IF NOT EXISTS scheduling_audit_log (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id VARCHAR(255) REFERENCES bookings(id) ON DELETE SET NULL,
  action VARCHAR(50) NOT NULL,
  previous_status VARCHAR(30) DEFAULT NULL,
  new_status VARCHAR(30) DEFAULT NULL,
  changed_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  details JSONB DEFAULT '{}',
  override_reason TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sched_audit_tenant ON scheduling_audit_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sched_audit_booking ON scheduling_audit_log(booking_id);
CREATE INDEX IF NOT EXISTS idx_sched_audit_time ON scheduling_audit_log(tenant_id, created_at);

-- RLS policies for new tables
ALTER TABLE scheduling_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling_provider_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling_appointment_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling_booking_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling_recurring_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling_waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling_reminder_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling_reminder_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_sched_providers ON scheduling_providers;
CREATE POLICY tenant_isolation_sched_providers ON scheduling_providers
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_sched_prov_sched ON scheduling_provider_schedules;
CREATE POLICY tenant_isolation_sched_prov_sched ON scheduling_provider_schedules
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_sched_overrides ON scheduling_overrides;
CREATE POLICY tenant_isolation_sched_overrides ON scheduling_overrides
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_sched_appt_types ON scheduling_appointment_types;
CREATE POLICY tenant_isolation_sched_appt_types ON scheduling_appointment_types
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_sched_resources ON scheduling_resources;
CREATE POLICY tenant_isolation_sched_resources ON scheduling_resources
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_sched_rules ON scheduling_booking_rules;
CREATE POLICY tenant_isolation_sched_rules ON scheduling_booking_rules
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_sched_recurring ON scheduling_recurring_series;
CREATE POLICY tenant_isolation_sched_recurring ON scheduling_recurring_series
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_sched_waitlist ON scheduling_waitlist;
CREATE POLICY tenant_isolation_sched_waitlist ON scheduling_waitlist
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_sched_reminder_configs ON scheduling_reminder_configs;
CREATE POLICY tenant_isolation_sched_reminder_configs ON scheduling_reminder_configs
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_sched_reminder_log ON scheduling_reminder_log;
CREATE POLICY tenant_isolation_sched_reminder_log ON scheduling_reminder_log
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_sched_audit ON scheduling_audit_log;
CREATE POLICY tenant_isolation_sched_audit ON scheduling_audit_log
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);
