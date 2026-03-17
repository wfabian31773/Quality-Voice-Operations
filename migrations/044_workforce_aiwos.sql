CREATE TABLE IF NOT EXISTS workforce_optimization_insights (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  team_id VARCHAR NOT NULL REFERENCES workforce_teams(id) ON DELETE CASCADE,
  category VARCHAR(60) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  impact_estimate TEXT,
  difficulty VARCHAR(20) DEFAULT 'medium',
  estimated_revenue_impact_cents INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'new',
  action_type VARCHAR(60),
  action_payload JSONB DEFAULT '{}',
  source_data JSONB DEFAULT '{}',
  analysis_period_start TIMESTAMPTZ,
  analysis_period_end TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by VARCHAR(64),
  dismissed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wf_opt_insights_tenant ON workforce_optimization_insights(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wf_opt_insights_team ON workforce_optimization_insights(team_id, status);
CREATE INDEX IF NOT EXISTS idx_wf_opt_insights_status ON workforce_optimization_insights(tenant_id, status);

CREATE TABLE IF NOT EXISTS workforce_revenue_metrics (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  team_id VARCHAR NOT NULL REFERENCES workforce_teams(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  calls_handled INTEGER NOT NULL DEFAULT 0,
  bookings_generated INTEGER NOT NULL DEFAULT 0,
  missed_calls_recovered INTEGER NOT NULL DEFAULT 0,
  estimated_revenue_cents INTEGER NOT NULL DEFAULT 0,
  missed_revenue_cents INTEGER NOT NULL DEFAULT 0,
  avg_ticket_value_cents INTEGER NOT NULL DEFAULT 15000,
  agent_breakdown JSONB DEFAULT '[]',
  daily_breakdown JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wf_revenue_tenant ON workforce_revenue_metrics(tenant_id, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_wf_revenue_team ON workforce_revenue_metrics(team_id, period_start DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wf_revenue_unique ON workforce_revenue_metrics(team_id, period_start, period_end);

CREATE TABLE IF NOT EXISTS workforce_outbound_tasks (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  team_id VARCHAR NOT NULL REFERENCES workforce_teams(id) ON DELETE CASCADE,
  campaign_type VARCHAR(60) NOT NULL,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  config JSONB DEFAULT '{}',
  campaign_id VARCHAR(64),
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  total_contacts INTEGER NOT NULL DEFAULT 0,
  contacts_reached INTEGER NOT NULL DEFAULT 0,
  created_by VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wf_outbound_tenant ON workforce_outbound_tasks(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wf_outbound_team ON workforce_outbound_tasks(team_id, status);

ALTER TABLE workforce_optimization_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE workforce_revenue_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE workforce_outbound_tasks ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workforce_optimization_insights' AND policyname = 'wf_opt_insights_tenant_isolation') THEN
    CREATE POLICY wf_opt_insights_tenant_isolation ON workforce_optimization_insights
      USING (tenant_id = current_setting('app.tenant_id', true));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workforce_revenue_metrics' AND policyname = 'wf_revenue_metrics_tenant_isolation') THEN
    CREATE POLICY wf_revenue_metrics_tenant_isolation ON workforce_revenue_metrics
      USING (tenant_id = current_setting('app.tenant_id', true));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workforce_outbound_tasks' AND policyname = 'wf_outbound_tasks_tenant_isolation') THEN
    CREATE POLICY wf_outbound_tasks_tenant_isolation ON workforce_outbound_tasks
      USING (tenant_id = current_setting('app.tenant_id', true));
  END IF;
END $$;

INSERT INTO workforce_templates (id, name, description, vertical, is_system, template_config) VALUES
  ('tpl-hvac', 'HVAC Service Team', 'Receptionist + dispatcher + scheduler for HVAC companies with emergency dispatch and maintenance reminders', 'hvac', true, '{
    "roles": [
      {"role": "receptionist", "agentType": "answering-service", "isReceptionist": true, "description": "Greets callers, identifies emergency vs routine service needs"},
      {"role": "dispatcher", "agentType": "home-services", "isReceptionist": false, "description": "Dispatches technicians for service calls and emergency repairs"},
      {"role": "scheduler", "agentType": "answering-service", "isReceptionist": false, "description": "Handles maintenance appointment scheduling and seasonal tune-ups"}
    ],
    "routingRules": [
      {"intent": "emergency_dispatch", "targetRole": "dispatcher", "fallbackRole": "receptionist"},
      {"intent": "service_request", "targetRole": "dispatcher", "fallbackRole": "receptionist"},
      {"intent": "schedule_appointment", "targetRole": "scheduler", "fallbackRole": "receptionist"},
      {"intent": "maintenance_request", "targetRole": "scheduler", "fallbackRole": "dispatcher"},
      {"intent": "billing_inquiry", "targetRole": "receptionist"},
      {"intent": "general_inquiry", "targetRole": "receptionist"}
    ],
    "outboundAutomations": [
      {"type": "maintenance_reminder", "description": "Seasonal HVAC maintenance reminders"},
      {"type": "follow_up", "description": "Post-service follow-up calls"},
      {"type": "reactivation", "description": "Re-engage customers who haven''t scheduled in 12+ months"}
    ]
  }'),
  ('tpl-dental', 'Dental Practice Team', 'Receptionist + scheduler + billing for dental offices with appointment reminders and recall campaigns', 'dental', true, '{
    "roles": [
      {"role": "receptionist", "agentType": "answering-service", "isReceptionist": true, "description": "Greets patients, handles general questions and new patient intake"},
      {"role": "scheduler", "agentType": "answering-service", "isReceptionist": false, "description": "Manages appointment booking, rescheduling, and cancellations"},
      {"role": "billing", "agentType": "answering-service", "isReceptionist": false, "description": "Handles insurance verification and billing questions"}
    ],
    "routingRules": [
      {"intent": "schedule_appointment", "targetRole": "scheduler", "fallbackRole": "receptionist"},
      {"intent": "cancel", "targetRole": "scheduler", "fallbackRole": "receptionist"},
      {"intent": "billing_inquiry", "targetRole": "billing", "fallbackRole": "receptionist"},
      {"intent": "new_patient", "targetRole": "receptionist"},
      {"intent": "urgent_medical", "targetRole": "receptionist"},
      {"intent": "general_inquiry", "targetRole": "receptionist"}
    ],
    "outboundAutomations": [
      {"type": "appointment_reminder", "description": "Upcoming appointment reminders (24h and 48h)"},
      {"type": "recall", "description": "6-month cleaning recall campaigns"},
      {"type": "follow_up", "description": "Post-procedure follow-up wellness checks"}
    ]
  }'),
  ('tpl-medical-expanded', 'Medical Practice Team', 'Full medical office team with receptionist, scheduler, triage, billing, and intake specialists', 'medical', true, '{
    "roles": [
      {"role": "receptionist", "agentType": "answering-service", "isReceptionist": true, "description": "Front desk: greets patients, routes to appropriate department"},
      {"role": "scheduler", "agentType": "answering-service", "isReceptionist": false, "description": "Appointment scheduling, rescheduling, and waitlist management"},
      {"role": "triage", "agentType": "medical-after-hours", "isReceptionist": false, "description": "After-hours medical triage and urgent care guidance"},
      {"role": "billing", "agentType": "answering-service", "isReceptionist": false, "description": "Insurance questions, billing inquiries, payment processing"},
      {"role": "intake", "agentType": "answering-service", "isReceptionist": false, "description": "New patient registration and pre-visit information gathering"}
    ],
    "routingRules": [
      {"intent": "schedule_appointment", "targetRole": "scheduler", "fallbackRole": "receptionist"},
      {"intent": "urgent_medical", "targetRole": "triage", "fallbackRole": "receptionist"},
      {"intent": "billing_inquiry", "targetRole": "billing", "fallbackRole": "receptionist"},
      {"intent": "new_patient", "targetRole": "intake", "fallbackRole": "receptionist"},
      {"intent": "cancel", "targetRole": "scheduler", "fallbackRole": "receptionist"},
      {"intent": "general_inquiry", "targetRole": "receptionist"}
    ],
    "outboundAutomations": [
      {"type": "appointment_reminder", "description": "Upcoming appointment reminders"},
      {"type": "follow_up", "description": "Post-visit follow-up and wellness checks"},
      {"type": "recall", "description": "Annual checkup and preventive care reminders"},
      {"type": "review_request", "description": "Patient satisfaction and review requests"}
    ]
  }'),
  ('tpl-property-management', 'Property Management Team', 'Receptionist + maintenance dispatcher + leasing specialist for property management companies', 'property-management', true, '{
    "roles": [
      {"role": "receptionist", "agentType": "answering-service", "isReceptionist": true, "description": "Handles tenant calls, screens prospective renters, routes inquiries"},
      {"role": "dispatcher", "agentType": "home-services", "isReceptionist": false, "description": "Manages maintenance requests and emergency repair dispatch"},
      {"role": "leasing", "agentType": "answering-service", "isReceptionist": false, "description": "Handles leasing inquiries, tour scheduling, and application questions"}
    ],
    "routingRules": [
      {"intent": "maintenance_request", "targetRole": "dispatcher", "fallbackRole": "receptionist"},
      {"intent": "emergency_dispatch", "targetRole": "dispatcher", "fallbackRole": "receptionist"},
      {"intent": "schedule_appointment", "targetRole": "leasing", "fallbackRole": "receptionist"},
      {"intent": "general_inquiry", "targetRole": "leasing", "fallbackRole": "receptionist"},
      {"intent": "billing_inquiry", "targetRole": "receptionist"},
      {"intent": "complaint", "targetRole": "receptionist"}
    ],
    "outboundAutomations": [
      {"type": "maintenance_reminder", "description": "Scheduled maintenance notifications"},
      {"type": "lease_renewal", "description": "Upcoming lease renewal reminders"},
      {"type": "follow_up", "description": "Move-in follow-up and satisfaction checks"},
      {"type": "reactivation", "description": "Re-engage past prospective tenants"}
    ]
  }'),
  ('tpl-home-services-expanded', 'Home Services Team', 'Full home services team with receptionist, dispatcher, scheduler, and support for plumbing, electrical, and general contracting', 'home-services', true, '{
    "roles": [
      {"role": "receptionist", "agentType": "answering-service", "isReceptionist": true, "description": "First point of contact: identifies service type and urgency"},
      {"role": "dispatcher", "agentType": "home-services", "isReceptionist": false, "description": "Dispatches technicians, manages emergency and same-day service"},
      {"role": "scheduler", "agentType": "answering-service", "isReceptionist": false, "description": "Books routine appointments and estimates"},
      {"role": "support", "agentType": "customer-support", "isReceptionist": false, "description": "Handles billing, warranty claims, and customer satisfaction"}
    ],
    "routingRules": [
      {"intent": "emergency_dispatch", "targetRole": "dispatcher", "fallbackRole": "receptionist"},
      {"intent": "service_request", "targetRole": "dispatcher", "fallbackRole": "scheduler"},
      {"intent": "schedule_appointment", "targetRole": "scheduler", "fallbackRole": "receptionist"},
      {"intent": "billing_inquiry", "targetRole": "support", "fallbackRole": "receptionist"},
      {"intent": "complaint", "targetRole": "support", "fallbackRole": "receptionist"},
      {"intent": "general_inquiry", "targetRole": "receptionist"}
    ],
    "outboundAutomations": [
      {"type": "appointment_reminder", "description": "Upcoming service appointment reminders"},
      {"type": "follow_up", "description": "Post-service quality follow-up calls"},
      {"type": "review_request", "description": "Request reviews after completed jobs"},
      {"type": "maintenance_reminder", "description": "Seasonal maintenance and inspection reminders"},
      {"type": "reactivation", "description": "Re-engage past customers for repeat services"}
    ]
  }')
ON CONFLICT (id) DO NOTHING;
