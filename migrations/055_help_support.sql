-- Help center & support tables: ticket inbox, configurable plan-tier routing, and docs feedback.

CREATE TABLE IF NOT EXISTS support_tickets (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id UUID,
  user_id UUID,
  user_email VARCHAR(255),
  plan VARCHAR(50),
  topic VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  recent_errors TEXT,
  context JSONB DEFAULT '{}'::jsonb,
  routed_to VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  email_message_id VARCHAR(255),
  email_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS support_tickets_created_idx ON support_tickets(created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_tenant_idx ON support_tickets(tenant_id);
CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets(status);

-- Admin-configurable support routing. One row per (plan, topic) pair.
-- topic = '*' means "default for the plan"; plan = '*' means "all plans, topic override".
CREATE TABLE IF NOT EXISTS support_routing (
  id SERIAL PRIMARY KEY,
  plan VARCHAR(50) NOT NULL,
  topic VARCHAR(50) NOT NULL,
  destination VARCHAR(255) NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(plan, topic)
);

INSERT INTO support_routing (plan, topic, destination, priority, notes) VALUES
  ('*',          'billing',     'billing@qvo.ai',              100, 'All billing questions go to billing.'),
  ('*',          'bug',         'engineering@qvo.ai',          100, 'All bug reports go to engineering.'),
  ('enterprise', '*',           'enterprise-support@qvo.ai',    50, 'Enterprise tier dedicated queue.'),
  ('growth',     '*',           'priority-support@qvo.ai',      50, 'Growth tier priority queue.'),
  ('starter',    '*',           'support@qvo.ai',                0, 'Default support queue.'),
  ('trial',      '*',           'support@qvo.ai',                0, 'Trial support queue.'),
  ('free',       '*',           'support@qvo.ai',                0, 'Free tier support queue.')
ON CONFLICT (plan, topic) DO NOTHING;

CREATE TABLE IF NOT EXISTS docs_feedback (
  id SERIAL PRIMARY KEY,
  article_slug VARCHAR(128) NOT NULL,
  vote VARCHAR(16) NOT NULL,
  comment TEXT,
  page_path TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS docs_feedback_slug_idx ON docs_feedback(article_slug);
CREATE INDEX IF NOT EXISTS docs_feedback_created_idx ON docs_feedback(created_at DESC);
