ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMP;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_expires_at TIMESTAMP;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspension_reason TEXT;

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token VARCHAR(128);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_sent_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verification_code VARCHAR(10);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verification_sent_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_users_email_verification_token ON users(email_verification_token);

DO $$ BEGIN
  ALTER TYPE usage_metric_type ADD VALUE IF NOT EXISTS 'tool_executions';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE usage_metric_type ADD VALUE IF NOT EXISTS 'api_requests';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE billing_event_type ADD VALUE IF NOT EXISTS 'usage_warning';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE billing_event_type ADD VALUE IF NOT EXISTS 'account_suspended';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS tenant_notifications (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_notifications_tenant ON tenant_notifications(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_notifications_unread ON tenant_notifications(tenant_id, read) WHERE read = FALSE;
