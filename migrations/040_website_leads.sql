CREATE TABLE IF NOT EXISTS website_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  email TEXT,
  phone TEXT,
  company TEXT,
  industry TEXT,
  business_size TEXT,
  recommended_plan TEXT,
  source_page TEXT,
  conversation_id TEXT,
  qualification_score INT DEFAULT 0,
  status TEXT DEFAULT 'new',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS website_agent_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT UNIQUE NOT NULL,
  source_page TEXT,
  messages JSONB DEFAULT '[]',
  lead_id UUID REFERENCES website_leads(id),
  demos_launched TEXT[] DEFAULT '{}',
  pages_navigated TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS website_agent_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  conversation_id TEXT,
  source_page TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_website_leads_conversation_id ON website_leads(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_website_leads_email ON website_leads(email);
CREATE INDEX IF NOT EXISTS idx_website_leads_status ON website_leads(status);
CREATE INDEX IF NOT EXISTS idx_website_leads_created ON website_leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_website_agent_conversations_cid ON website_agent_conversations(conversation_id);
CREATE INDEX IF NOT EXISTS idx_website_agent_analytics_type ON website_agent_analytics(event_type, created_at DESC);
