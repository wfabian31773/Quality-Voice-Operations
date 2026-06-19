/**
 * Seed the dedicated `diagnostic` tenant + `diagnostic-probe` agent used by
 * the realtime-stream diagnostic / canary in `full` mode.
 *
 * `full`-mode probes drive the real /twilio/stream path end-to-end (to first
 * audio), which requires the gateway to resolve a real agent for the probe's
 * `start` frame. This seeds a minimal, isolated agent on its own tenant so the
 * canary never touches demo/customer data.
 *
 * Idempotent: ON CONFLICT DO UPDATE keeps re-runs safe. Targets the live DB via
 * PLATFORM_DB_POOL_URL.
 *
 *   PLATFORM_DB_POOL_URL=... npm run seed:diagnostic-agent
 *
 * The probe's default identity (server/voice-gateway/services/streamDiagnostic.ts)
 * is tenantId='diagnostic', agentId='diagnostic-probe' — matching this seed.
 */
import { Pool } from 'pg';

const url = process.env.PLATFORM_DB_POOL_URL;
if (!url) throw new Error('PLATFORM_DB_POOL_URL is required');

const TENANT_ID = 'diagnostic';
const AGENT_ID = 'diagnostic-probe';

const SYSTEM_PROMPT = [
  'You are a synthetic diagnostic agent used only to verify the realtime voice',
  'pipeline is healthy. You are never connected to a real caller.',
  'Immediately greet briefly and then say you are a diagnostic probe.',
  'Keep every response to a single short sentence.',
].join('\n');

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO tenants (id, name, slug, status, plan, settings, feature_flags)
       VALUES ($1, 'Realtime Diagnostics', 'diagnostic', 'active', 'enterprise',
               '{"timezone": "UTC", "diagnostic": true}'::jsonb,
               '{"diagnostic": true}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         status = 'active',
         updated_at = NOW()`,
      [TENANT_ID],
    );

    await client.query(
      `INSERT INTO agents (
         id, tenant_id, name, type, status, system_prompt, voice, model,
         welcome_greeting, language, execution_mode, sync_mode,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'Realtime Diagnostic Probe', 'general', 'active', $3, 'alloy',
         'gpt-realtime-2',
         'Diagnostic probe online.', 'en', 'native', 'event_push',
         NOW(), NOW()
       )
       ON CONFLICT (id) DO UPDATE SET
         system_prompt = EXCLUDED.system_prompt,
         status = 'active',
         updated_at = NOW()`,
      [AGENT_ID, TENANT_ID, SYSTEM_PROMPT],
    );

    await client.query('COMMIT');

    const verify = await client.query(
      `SELECT a.id, a.tenant_id, a.status, a.voice, a.model
         FROM agents a WHERE a.id = $1 AND a.tenant_id = $2`,
      [AGENT_ID, TENANT_ID],
    );
    // eslint-disable-next-line no-console
    console.log('✓ seeded diagnostic agent:', verify.rows[0]);
    // eslint-disable-next-line no-console
    console.log(
      `\nRun a full-mode probe with:\n  npm run diagnose:realtime-stream -- --mode=full\n` +
      `(uses tenantId='${TENANT_ID}', agentId='${AGENT_ID}')\n`,
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Seed failed:', err);
  process.exit(1);
});
