CREATE INDEX IF NOT EXISTS idx_audit_logs_action_occurred
  ON audit_logs(tenant_id, action, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_occurred
  ON audit_logs(action, occurred_at DESC);
