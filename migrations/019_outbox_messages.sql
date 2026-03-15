-- Durable outbox for voice gateway call delivery
-- Separate from outbox_events (generic integration events) —
-- this table is call-scoped with lease-based claiming for at-least-once delivery.

CREATE TABLE IF NOT EXISTS outbox_messages (
  id             VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key VARCHAR(300),
  call_sid        VARCHAR(60),
  call_log_id     VARCHAR REFERENCES call_sessions(id) ON DELETE SET NULL,
  payload         JSONB NOT NULL DEFAULT '{}',
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sending','sent','retry','dead_letter')),
  max_retries     INTEGER NOT NULL DEFAULT 5,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  lease_expires_at TIMESTAMP,
  next_retry_at   TIMESTAMP DEFAULT NOW(),
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_outbox_messages_tenant
  ON outbox_messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_outbox_messages_status_retry
  ON outbox_messages(status, next_retry_at)
  WHERE status IN ('pending','retry');
CREATE INDEX IF NOT EXISTS idx_outbox_messages_call_sid
  ON outbox_messages(call_sid)
  WHERE call_sid IS NOT NULL;

-- RLS
ALTER TABLE outbox_messages ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  DROP POLICY IF EXISTS tenant_isolation_outbox_messages ON outbox_messages;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE POLICY tenant_isolation_outbox_messages ON outbox_messages
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', TRUE))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE));

-- Allow service role to bypass RLS for cross-tenant admin ops
DO $$ BEGIN
  ALTER POLICY tenant_isolation_outbox_messages ON outbox_messages
    USING (
      tenant_id = current_setting('app.tenant_id', TRUE)
      OR current_user IN ('service_role','postgres')
    );
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
