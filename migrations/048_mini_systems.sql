-- Mini Systems: Tickets, Dispatch Jobs, and Bookings tables

-- Tickets table for the Ticketing mini-app
CREATE TABLE IF NOT EXISTS tickets (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id VARCHAR(255) REFERENCES call_sessions(id) ON DELETE SET NULL,
  subject VARCHAR(500) NOT NULL,
  description TEXT DEFAULT '',
  status VARCHAR(30) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  priority VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  assignee_user_id VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tickets_tenant ON tickets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(tenant_id, assignee_user_id);

-- Dispatch Jobs table for the Dispatch mini-app
CREATE TABLE IF NOT EXISTS dispatch_jobs (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT DEFAULT '',
  status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'in_progress', 'done', 'cancelled')),
  priority VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  assignee_user_id VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  contact_id VARCHAR(255) DEFAULT NULL,
  contact_name VARCHAR(255) DEFAULT '',
  scheduled_at TIMESTAMPTZ DEFAULT NULL,
  completed_at TIMESTAMPTZ DEFAULT NULL,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_jobs_tenant ON dispatch_jobs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_jobs_status ON dispatch_jobs(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_dispatch_jobs_assignee ON dispatch_jobs(tenant_id, assignee_user_id);

-- Scheduling bookings table for the Scheduling mini-app
CREATE TABLE IF NOT EXISTS bookings (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT DEFAULT '',
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'no_show')),
  contact_name VARCHAR(255) DEFAULT '',
  contact_phone VARCHAR(50) DEFAULT '',
  contact_email VARCHAR(255) DEFAULT '',
  agent_id VARCHAR(255) REFERENCES agents(id) ON DELETE SET NULL,
  created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bookings_tenant ON bookings(tenant_id);
CREATE INDEX IF NOT EXISTS idx_bookings_time ON bookings(tenant_id, start_time);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(tenant_id, status);

-- Enable RLS on all mini-system tables
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_tickets ON tickets;
CREATE POLICY tenant_isolation_tickets ON tickets
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_dispatch_jobs ON dispatch_jobs;
CREATE POLICY tenant_isolation_dispatch_jobs ON dispatch_jobs
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_bookings ON bookings;
CREATE POLICY tenant_isolation_bookings ON bookings
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);
