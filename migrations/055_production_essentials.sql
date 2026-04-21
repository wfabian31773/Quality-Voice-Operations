-- Production essentials: changelog + platform settings (maintenance mode)

CREATE TABLE IF NOT EXISTS changelog_entries (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  published_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_changelog_published ON changelog_entries(published_at DESC);

CREATE TABLE IF NOT EXISTS changelog_reads (
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id VARCHAR NOT NULL REFERENCES changelog_entries(id) ON DELETE CASCADE,
  read_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, entry_id)
);

CREATE TABLE IF NOT EXISTS platform_settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_by VARCHAR REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO platform_settings (key, value)
VALUES ('maintenance_mode', '{"enabled": false, "message": null, "scheduled_for": null}'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO changelog_entries (title, body, tags, published_at)
VALUES
  ('Production Essentials shipped',
   'Branded error pages, trial countdown banner, in-app notifications center, in-app changelog, and a mobile-responsive sweep across the tenant portal.',
   '["platform","ux"]'::jsonb,
   NOW()),
  ('Enterprise Ticketing & Dispatch',
   'New tenant-facing modules for service tickets, scheduling, SMS inbox, and dispatch — with role-based access and audit logging.',
   '["feature","operations"]'::jsonb,
   NOW() - INTERVAL '7 days'),
  ('Reliability tab inside Operations',
   'Tool execution logs, integration diagnostics, and cost optimization views are consolidated into the Reliability section of the Ops console.',
   '["ops","reliability"]'::jsonb,
   NOW() - INTERVAL '14 days')
ON CONFLICT DO NOTHING;
