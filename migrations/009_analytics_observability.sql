CREATE TABLE IF NOT EXISTS analytics_metrics (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  metric_name VARCHAR(100) NOT NULL,
  metric_value NUMERIC NOT NULL,
  dimensions JSONB DEFAULT '{}',
  recorded_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_metrics_tenant ON analytics_metrics(tenant_id);
CREATE INDEX IF NOT EXISTS idx_analytics_metrics_tenant_name ON analytics_metrics(tenant_id, metric_name);
CREATE INDEX IF NOT EXISTS idx_analytics_metrics_recorded ON analytics_metrics(recorded_at);

CREATE TABLE IF NOT EXISTS system_metrics (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  host VARCHAR(100),
  metric_name VARCHAR(100) NOT NULL,
  metric_value NUMERIC NOT NULL,
  tags JSONB DEFAULT '{}',
  recorded_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_metrics_name ON system_metrics(metric_name);
CREATE INDEX IF NOT EXISTS idx_system_metrics_recorded ON system_metrics(recorded_at);

DO $$ BEGIN
  CREATE TYPE error_severity AS ENUM (
    'debug', 'info', 'warning', 'error', 'critical'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS error_logs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE SET NULL,
  severity error_severity NOT NULL DEFAULT 'error',
  service VARCHAR(100),
  error_code VARCHAR(100),
  message TEXT NOT NULL,
  stack_trace TEXT,
  context JSONB DEFAULT '{}',
  call_session_id VARCHAR REFERENCES call_sessions(id) ON DELETE SET NULL,
  resolved_at TIMESTAMP,
  occurred_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_error_logs_tenant ON error_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_error_logs_severity ON error_logs(severity);
CREATE INDEX IF NOT EXISTS idx_error_logs_occurred ON error_logs(occurred_at);
CREATE INDEX IF NOT EXISTS idx_error_logs_session ON error_logs(call_session_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  actor_role VARCHAR(60),
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(60) NOT NULL,
  resource_id VARCHAR,
  changes JSONB DEFAULT '{}',
  ip_address INET,
  user_agent TEXT,
  occurred_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant ON audit_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_occurred ON audit_logs(tenant_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
