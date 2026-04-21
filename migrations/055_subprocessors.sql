CREATE TABLE IF NOT EXISTS subprocessors (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  data_types TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT 'United States',
  website TEXT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_subprocessors_active ON subprocessors(is_active, display_order);

CREATE TABLE IF NOT EXISTS tenant_deletion_requests (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by VARCHAR NOT NULL REFERENCES users(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scheduled_for TIMESTAMPTZ NOT NULL,
  cancelled_at TIMESTAMPTZ,
  cancelled_by VARCHAR REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'cancelled', 'completed')),
  reason TEXT,
  confirmation_text TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenant_deletion_pending
  ON tenant_deletion_requests(tenant_id, status) WHERE status = 'pending';

INSERT INTO subprocessors (name, purpose, data_types, location, website, display_order)
SELECT * FROM (VALUES
  ('Twilio', 'Voice and SMS infrastructure (call origination, termination, messaging)', 'Phone numbers, call audio, SMS content, call metadata', 'United States', 'https://twilio.com', 10),
  ('OpenAI', 'AI voice generation, transcription, and language understanding', 'Call transcripts, agent prompts, conversation context', 'United States', 'https://openai.com', 20),
  ('Stripe', 'Payment processing and subscription billing', 'Billing contact, payment method (tokenized), invoice history', 'United States', 'https://stripe.com', 30),
  ('Replit', 'Application hosting, compute, and managed PostgreSQL database', 'All tenant data at rest and in transit', 'United States', 'https://replit.com', 40),
  ('Neon', 'Managed PostgreSQL database (when applicable)', 'All tenant data at rest', 'United States', 'https://neon.tech', 50)
) AS v(name, purpose, data_types, location, website, display_order)
WHERE NOT EXISTS (SELECT 1 FROM subprocessors WHERE subprocessors.name = v.name);
