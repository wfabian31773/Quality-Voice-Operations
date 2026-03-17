ALTER TABLE execution_traces ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_event_logs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_execution_traces ON execution_traces
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_isolation_integration_event_logs ON integration_event_logs
    USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
