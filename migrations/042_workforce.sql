CREATE TABLE IF NOT EXISTS workforce_teams (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workforce_teams_tenant ON workforce_teams(tenant_id);
CREATE INDEX IF NOT EXISTS idx_workforce_teams_status ON workforce_teams(tenant_id, status);

CREATE TABLE IF NOT EXISTS workforce_members (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id VARCHAR NOT NULL REFERENCES workforce_teams(id) ON DELETE CASCADE,
  agent_id VARCHAR NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL DEFAULT 'specialist',
  is_receptionist BOOLEAN NOT NULL DEFAULT false,
  priority INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(team_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_workforce_members_team ON workforce_members(team_id);
CREATE INDEX IF NOT EXISTS idx_workforce_members_agent ON workforce_members(agent_id);
CREATE INDEX IF NOT EXISTS idx_workforce_members_tenant ON workforce_members(tenant_id);

CREATE TABLE IF NOT EXISTS workforce_routing_rules (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id VARCHAR NOT NULL REFERENCES workforce_teams(id) ON DELETE CASCADE,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  intent VARCHAR(100) NOT NULL,
  target_member_id VARCHAR NOT NULL REFERENCES workforce_members(id) ON DELETE CASCADE,
  fallback_member_id VARCHAR REFERENCES workforce_members(id) ON DELETE SET NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  conditions JSONB DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workforce_routing_rules_team ON workforce_routing_rules(team_id);
CREATE INDEX IF NOT EXISTS idx_workforce_routing_rules_tenant ON workforce_routing_rules(tenant_id);
CREATE INDEX IF NOT EXISTS idx_workforce_routing_rules_intent ON workforce_routing_rules(team_id, intent);

CREATE TABLE IF NOT EXISTS workforce_templates (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  vertical VARCHAR(100),
  is_system BOOLEAN NOT NULL DEFAULT false,
  template_config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workforce_templates_tenant ON workforce_templates(tenant_id);
CREATE INDEX IF NOT EXISTS idx_workforce_templates_vertical ON workforce_templates(vertical);

CREATE TABLE IF NOT EXISTS workforce_routing_history (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id VARCHAR NOT NULL REFERENCES workforce_teams(id) ON DELETE CASCADE,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_session_id VARCHAR NOT NULL,
  from_agent_id VARCHAR NOT NULL,
  to_agent_id VARCHAR NOT NULL,
  intent VARCHAR(100),
  routing_rule_id VARCHAR REFERENCES workforce_routing_rules(id) ON DELETE SET NULL,
  reason TEXT,
  context_summary TEXT,
  duration_ms INTEGER,
  outcome VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workforce_routing_history_team ON workforce_routing_history(team_id);
CREATE INDEX IF NOT EXISTS idx_workforce_routing_history_tenant ON workforce_routing_history(tenant_id);
CREATE INDEX IF NOT EXISTS idx_workforce_routing_history_call ON workforce_routing_history(call_session_id);
CREATE INDEX IF NOT EXISTS idx_workforce_routing_history_created ON workforce_routing_history(tenant_id, created_at DESC);

ALTER TABLE workforce_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE workforce_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workforce_routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE workforce_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE workforce_routing_history ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workforce_teams' AND policyname = 'workforce_teams_tenant_isolation') THEN
    CREATE POLICY workforce_teams_tenant_isolation ON workforce_teams
      USING (tenant_id = current_setting('app.tenant_id', true));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workforce_members' AND policyname = 'workforce_members_tenant_isolation') THEN
    CREATE POLICY workforce_members_tenant_isolation ON workforce_members
      USING (tenant_id = current_setting('app.tenant_id', true));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workforce_routing_rules' AND policyname = 'workforce_routing_rules_tenant_isolation') THEN
    CREATE POLICY workforce_routing_rules_tenant_isolation ON workforce_routing_rules
      USING (tenant_id = current_setting('app.tenant_id', true));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workforce_templates' AND policyname = 'workforce_templates_tenant_isolation') THEN
    CREATE POLICY workforce_templates_tenant_isolation ON workforce_templates
      USING (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workforce_routing_history' AND policyname = 'workforce_routing_history_tenant_isolation') THEN
    CREATE POLICY workforce_routing_history_tenant_isolation ON workforce_routing_history
      USING (tenant_id = current_setting('app.tenant_id', true));
  END IF;
END $$;

INSERT INTO workforce_templates (id, name, description, vertical, is_system, template_config) VALUES
  ('tpl-medical-office', 'Medical Office Team', 'Receptionist + scheduler + after-hours triage for medical practices', 'medical', true, '{
    "roles": [
      {"role": "receptionist", "agentType": "answering-service", "isReceptionist": true, "description": "Greets callers and routes to appropriate specialist"},
      {"role": "scheduler", "agentType": "answering-service", "isReceptionist": false, "description": "Handles appointment scheduling and calendar management"},
      {"role": "triage", "agentType": "medical-after-hours", "isReceptionist": false, "description": "After-hours medical triage and urgent care routing"}
    ],
    "routingRules": [
      {"intent": "schedule_appointment", "targetRole": "scheduler", "fallbackRole": "receptionist"},
      {"intent": "urgent_medical", "targetRole": "triage", "fallbackRole": "receptionist"},
      {"intent": "billing_inquiry", "targetRole": "receptionist"},
      {"intent": "general_inquiry", "targetRole": "receptionist"}
    ]
  }'),
  ('tpl-home-services', 'Home Services Team', 'Receptionist + dispatcher + scheduler for HVAC, plumbing, electrical', 'home-services', true, '{
    "roles": [
      {"role": "receptionist", "agentType": "answering-service", "isReceptionist": true, "description": "Greets callers and identifies service needs"},
      {"role": "dispatcher", "agentType": "home-services", "isReceptionist": false, "description": "Dispatches technicians and manages service scheduling"},
      {"role": "support", "agentType": "customer-support", "isReceptionist": false, "description": "Handles billing questions and customer support"}
    ],
    "routingRules": [
      {"intent": "service_request", "targetRole": "dispatcher", "fallbackRole": "receptionist"},
      {"intent": "schedule_appointment", "targetRole": "dispatcher", "fallbackRole": "receptionist"},
      {"intent": "billing_inquiry", "targetRole": "support", "fallbackRole": "receptionist"},
      {"intent": "general_inquiry", "targetRole": "receptionist"}
    ]
  }'),
  ('tpl-legal-office', 'Legal Office Team', 'Receptionist + intake specialist + scheduler for law firms', 'legal', true, '{
    "roles": [
      {"role": "receptionist", "agentType": "answering-service", "isReceptionist": true, "description": "Greets callers and performs initial screening"},
      {"role": "intake", "agentType": "legal", "isReceptionist": false, "description": "Handles new client intake and case information gathering"},
      {"role": "scheduler", "agentType": "answering-service", "isReceptionist": false, "description": "Manages attorney consultation scheduling"}
    ],
    "routingRules": [
      {"intent": "schedule_consultation", "targetRole": "scheduler", "fallbackRole": "receptionist"},
      {"intent": "general_inquiry", "targetRole": "intake", "fallbackRole": "receptionist"},
      {"intent": "billing_inquiry", "targetRole": "receptionist"}
    ]
  }')
ON CONFLICT (id) DO NOTHING;
