CREATE TABLE IF NOT EXISTS knowledge_documents (
  id SERIAL PRIMARY KEY,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('pdf', 'url', 'text', 'faq')),
  source_url TEXT,
  raw_content TEXT,
  raw_file BYTEA,
  category VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
  error_message TEXT,
  file_name VARCHAR(500),
  file_size INTEGER,
  chunk_count INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id SERIAL PRIMARY KEY,
  tenant_id VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding JSONB,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_tenant ON knowledge_documents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_status ON knowledge_documents(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_type ON knowledge_documents(tenant_id, source_type);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_tenant ON knowledge_chunks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document ON knowledge_chunks(document_id);

ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_knowledge_documents ON knowledge_documents
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_knowledge_documents_insert ON knowledge_documents
    FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_knowledge_chunks ON knowledge_chunks
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_knowledge_chunks_insert ON knowledge_chunks
    FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
