CREATE TABLE IF NOT EXISTS vertical_prompt_library (
  id SERIAL PRIMARY KEY,
  vertical_id VARCHAR(100) NOT NULL,
  category VARCHAR(50) NOT NULL CHECK (category IN ('greeting', 'qualification', 'scheduling', 'troubleshooting', 'escalation')),
  prompt_text TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(vertical_id, category, version)
);

CREATE INDEX idx_vertical_prompt_library_vertical ON vertical_prompt_library(vertical_id);
CREATE INDEX idx_vertical_prompt_library_category ON vertical_prompt_library(category);

CREATE TABLE IF NOT EXISTS vertical_starter_knowledge (
  id SERIAL PRIMARY KEY,
  vertical_id VARCHAR(100) NOT NULL,
  title VARCHAR(500) NOT NULL,
  content TEXT NOT NULL,
  category_type VARCHAR(50) NOT NULL CHECK (category_type IN ('FAQ', 'Services', 'Procedures', 'Troubleshooting')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_vertical_starter_knowledge_vertical ON vertical_starter_knowledge(vertical_id);
CREATE INDEX idx_vertical_starter_knowledge_type ON vertical_starter_knowledge(category_type);

CREATE TABLE IF NOT EXISTS vertical_demo_flows (
  id SERIAL PRIMARY KEY,
  vertical_id VARCHAR(100) NOT NULL,
  scenario_name VARCHAR(255) NOT NULL,
  caller_request TEXT NOT NULL,
  expected_agent_path JSONB NOT NULL DEFAULT '[]',
  expected_tool_calls JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_vertical_demo_flows_vertical ON vertical_demo_flows(vertical_id);
