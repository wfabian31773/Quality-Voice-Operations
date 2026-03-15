CREATE TABLE IF NOT EXISTS phone_numbers (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_number VARCHAR(20) NOT NULL,
  friendly_name VARCHAR(255),
  twilio_sid VARCHAR(50),
  capabilities JSONB DEFAULT '{"voice": true, "sms": true}',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  provisioned_at TIMESTAMP,
  released_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id, phone_number)
);

CREATE INDEX IF NOT EXISTS idx_phone_numbers_tenant ON phone_numbers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_phone_numbers_number ON phone_numbers(phone_number);
CREATE INDEX IF NOT EXISTS idx_phone_numbers_status ON phone_numbers(status);

CREATE TABLE IF NOT EXISTS number_routing (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_number_id VARCHAR NOT NULL REFERENCES phone_numbers(id) ON DELETE CASCADE,
  agent_id VARCHAR NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 0,
  conditions JSONB DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(phone_number_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_number_routing_tenant ON number_routing(tenant_id);
CREATE INDEX IF NOT EXISTS idx_number_routing_phone ON number_routing(phone_number_id);
CREATE INDEX IF NOT EXISTS idx_number_routing_agent ON number_routing(agent_id);
