import pg from 'pg';

const DEMO_TENANT_ID = 'demo';
const DEMO_TENANT_SLUG = 'demo';
const DEMO_PHONE_1 = '+15550000001';
const DEMO_PHONE_2 = '+15550000002';

async function main() {
  const env = process.env.APP_ENV ?? 'development';
  let url: string;

  if (env === 'development') {
    url = process.env.DATABASE_URL ?? '';
    if (!url) {
      throw new Error('[SEED] DATABASE_URL is not set for development.');
    }
  } else {
    url = process.env.PLATFORM_DB_POOL_URL ?? '';
    if (!url) {
      throw new Error('[SEED] PLATFORM_DB_POOL_URL is not set for production/staging.');
    }
  }

  console.log(`[SEED] Environment: ${env}`);

  const pool = new pg.Pool({
    connectionString: url,
    max: 3,
    ...(env !== 'development' ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    console.log('[SEED] Upserting demo tenant...');
    await client.query(
      `INSERT INTO tenants (id, name, slug, status, plan, is_demo, demo_call_count, settings, feature_flags)
       VALUES ($1, 'Demo Organization', $2, 'active', 'enterprise', true, 0,
               '{"timezone": "America/New_York", "demo": true}'::jsonb,
               '{"demo_mode": true, "outbound_dialer": true, "analytics": true}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         is_demo = true,
         updated_at = NOW()`,
      [DEMO_TENANT_ID, DEMO_TENANT_SLUG],
    );

    console.log('[SEED] Upserting demo subscription...');
    await client.query(
      `INSERT INTO subscriptions (tenant_id, plan, status, billing_interval,
         monthly_call_limit, monthly_sms_limit, monthly_ai_minute_limit, overage_enabled)
       VALUES ($1, 'enterprise', 'active', 'monthly', 10000, 50000, 2000, true)
       ON CONFLICT (tenant_id) DO UPDATE SET
         plan = EXCLUDED.plan,
         updated_at = NOW()`,
      [DEMO_TENANT_ID],
    );

    const answeringPrompt = `You are Aria, the Voice AI demo assistant for an answering service.
You are demonstrating the capabilities of the Voice AI Operations Hub platform.
Greet the caller warmly, introduce yourself as Aria, and let them know this is a live demo.
You can take messages, answer general questions about the platform, and demonstrate
professional call handling. Be concise, friendly, and professional.
Do not share any real patient data, financial information, or sensitive details.
If asked about pricing or sales, let them know a team member will follow up.
Always maintain a helpful and professional tone.`;

    const medicalPrompt = `You are Aria, the Voice AI demo assistant for a medical after-hours service.
You are demonstrating the capabilities of the Voice AI Operations Hub platform
in a medical after-hours answering scenario. Greet the caller warmly and introduce
yourself as Aria, the demo medical after-hours assistant.
For this demo, you should:
- Collect the caller's name (use a fictional name if they prefer)
- Ask about the nature of their call (urgent vs routine)
- Collect a callback number (remind them this is a demo)
- Provide reassurance that a provider would be notified in a real scenario
Do NOT provide actual medical advice. Do NOT collect real patient health information.
Always remind callers this is a demonstration. Be calm, professional, and empathetic.`;

    console.log('[SEED] Upserting answering-service demo agent...');
    const asAgent = await client.query(
      `INSERT INTO agents (tenant_id, name, type, status, system_prompt, voice, model, temperature)
       VALUES ($1, 'Answering Service Demo', 'answering-service', 'active',
               $2, 'sage', 'gpt-4o-realtime-preview', 0.8)
       ON CONFLICT (tenant_id, name) DO UPDATE SET
         status = EXCLUDED.status,
         system_prompt = EXCLUDED.system_prompt,
         updated_at = NOW()
       RETURNING id`,
      [DEMO_TENANT_ID, answeringPrompt],
    );
    const asAgentId = asAgent.rows[0]?.id;

    console.log('[SEED] Upserting medical-after-hours demo agent...');
    const mahAgent = await client.query(
      `INSERT INTO agents (tenant_id, name, type, status, system_prompt, voice, model, temperature)
       VALUES ($1, 'Medical After Hours Demo', 'medical-after-hours', 'active',
               $2, 'shimmer', 'gpt-4o-realtime-preview', 0.7)
       ON CONFLICT (tenant_id, name) DO UPDATE SET
         status = EXCLUDED.status,
         system_prompt = EXCLUDED.system_prompt,
         updated_at = NOW()
       RETURNING id`,
      [DEMO_TENANT_ID, medicalPrompt],
    );
    const mahAgentId = mahAgent.rows[0]?.id;

    console.log('[SEED] Upserting demo phone number 1 (answering service)...');
    const phone1 = await client.query(
      `INSERT INTO phone_numbers (tenant_id, phone_number, friendly_name, status, is_demo, capabilities, provisioned_at)
       VALUES ($1, $2, 'Demo Line - Answering Service', 'active', true,
               '{"voice": true, "sms": false}'::jsonb, NOW())
       ON CONFLICT (tenant_id, phone_number) DO UPDATE SET
         friendly_name = EXCLUDED.friendly_name,
         is_demo = true,
         updated_at = NOW()
       RETURNING id`,
      [DEMO_TENANT_ID, DEMO_PHONE_1],
    );
    const phone1Id = phone1.rows[0]?.id;

    console.log('[SEED] Upserting demo phone number 2 (medical after-hours)...');
    const phone2 = await client.query(
      `INSERT INTO phone_numbers (tenant_id, phone_number, friendly_name, status, is_demo, capabilities, provisioned_at)
       VALUES ($1, $2, 'Demo Line - Medical After Hours', 'active', true,
               '{"voice": true, "sms": false}'::jsonb, NOW())
       ON CONFLICT (tenant_id, phone_number) DO UPDATE SET
         friendly_name = EXCLUDED.friendly_name,
         is_demo = true,
         updated_at = NOW()
       RETURNING id`,
      [DEMO_TENANT_ID, DEMO_PHONE_2],
    );
    const phone2Id = phone2.rows[0]?.id;

    if (phone1Id && asAgentId) {
      console.log('[SEED] Wiring answering-service agent to demo phone 1...');
      await client.query(
        `INSERT INTO number_routing (tenant_id, phone_number_id, agent_id, priority, is_active)
         VALUES ($1, $2, $3, 10, true)
         ON CONFLICT (phone_number_id, agent_id) DO UPDATE SET
           priority = EXCLUDED.priority,
           is_active = EXCLUDED.is_active`,
        [DEMO_TENANT_ID, phone1Id, asAgentId],
      );
    }

    if (phone2Id && mahAgentId) {
      console.log('[SEED] Wiring medical-after-hours agent to demo phone 2...');
      await client.query(
        `INSERT INTO number_routing (tenant_id, phone_number_id, agent_id, priority, is_active)
         VALUES ($1, $2, $3, 10, true)
         ON CONFLICT (phone_number_id, agent_id) DO UPDATE SET
           priority = EXCLUDED.priority,
           is_active = EXCLUDED.is_active`,
        [DEMO_TENANT_ID, phone2Id, mahAgentId],
      );
    }

    console.log('[SEED] Upserting demo_agents entries...');
    await client.query(
      `INSERT INTO demo_agents (tenant_id, name, description, agent_template, voice_id, is_active)
       VALUES ($1, 'Answering Service', 'Professional answering service for general business use', 'answering-service', 'sage', true)
       ON CONFLICT DO NOTHING`,
      [DEMO_TENANT_ID],
    );

    await client.query(
      `INSERT INTO demo_agents (tenant_id, name, description, agent_template, voice_id, is_active)
       VALUES ($1, 'Medical After Hours', 'HIPAA-aware medical after-hours answering service', 'medical-after-hours', 'shimmer', true)
       ON CONFLICT DO NOTHING`,
      [DEMO_TENANT_ID],
    );

    await client.query('COMMIT');
    console.log('[SEED] Demo data seeded successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[SEED] Failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
