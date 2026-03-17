import { getPlatformPool } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('RELIABILITY_TABLES');

let initialized = false;

export async function ensureReliabilityTables(): Promise<void> {
  if (initialized) return;
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS escalation_tasks (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        call_session_id TEXT NOT NULL,
        agent_slug TEXT,
        caller_phone TEXT,
        reason TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'medium',
        status TEXT NOT NULL DEFAULT 'pending',
        assigned_to TEXT,
        notes TEXT,
        tool_name TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_escalation_tasks_tenant ON escalation_tasks(tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_escalation_tasks_status ON escalation_tasks(tenant_id, status)`);
    await client.query(`ALTER TABLE escalation_tasks ENABLE ROW LEVEL SECURITY`);
    await client.query(`DROP POLICY IF EXISTS rls_escalation_tasks ON escalation_tasks`);
    await client.query(`
      CREATE POLICY rls_escalation_tasks ON escalation_tasks
        USING (tenant_id = current_setting('app.tenant_id', true))
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tool_failure_events (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        call_session_id TEXT NOT NULL,
        agent_slug TEXT,
        error TEXT,
        retry_count INT DEFAULT 0,
        max_retries INT DEFAULT 0,
        final_failure BOOLEAN DEFAULT false,
        fallback_attempted BOOLEAN DEFAULT false,
        fallback_success BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tool_failure_events_tenant ON tool_failure_events(tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tool_failure_events_tool ON tool_failure_events(tenant_id, tool_name)`);
    await client.query(`ALTER TABLE tool_failure_events ENABLE ROW LEVEL SECURITY`);
    await client.query(`DROP POLICY IF EXISTS rls_tool_failure_events ON tool_failure_events`);
    await client.query(`
      CREATE POLICY rls_tool_failure_events ON tool_failure_events
        USING (tenant_id = current_setting('app.tenant_id', true))
    `);

    await client.query(`ALTER TABLE integrations ADD COLUMN IF NOT EXISTS fallback_connector_type TEXT`);
    await client.query(`ALTER TABLE integrations ADD COLUMN IF NOT EXISTS fallback_provider TEXT`);

    initialized = true;
    logger.info('Reliability tables ensured');
  } catch (err) {
    logger.error('Failed to ensure reliability tables', { error: String(err) });
  } finally {
    client.release();
  }
}
