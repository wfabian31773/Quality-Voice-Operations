-- Track when admins were last alerted about an underperforming help article so
-- the daily docs-feedback alert job does not spam the inbox.

CREATE TABLE IF NOT EXISTS docs_feedback_alerts (
  article_slug VARCHAR(128) PRIMARY KEY,
  last_alerted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_total_votes INTEGER NOT NULL DEFAULT 0,
  last_not_helpful_count INTEGER NOT NULL DEFAULT 0,
  last_helpful_ratio INTEGER,
  last_reason VARCHAR(64),
  alert_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS docs_feedback_alerts_last_idx ON docs_feedback_alerts(last_alerted_at DESC);
