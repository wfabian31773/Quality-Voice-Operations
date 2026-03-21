import { getPlatformPool, closePlatformPool } from '../platform/db';
import { generateApiKey } from '../platform/rbac/ApiKeyService';
import bcrypt from 'bcryptjs';

const AZUL_VISION_SLUG = 'azul-vision';
const AZUL_VISION_NAME = 'Azul Vision Eye Center';
const ADMIN_EMAIL = 'admin@azulvision.com';
const ADMIN_PASSWORD = process.env.AZUL_ADMIN_PASSWORD || 'AzulVision2026!';

interface FederatedAgent {
  name: string;
  slug: string;
  type: string;
  direction: 'inbound' | 'outbound';
  description: string;
}

const FEDERATED_AGENTS: FederatedAgent[] = [
  {
    name: 'No-IVR Direct Agent',
    slug: 'no-ivr',
    type: 'answering-service',
    direction: 'inbound',
    description: 'Direct answering agent without IVR menu, handles incoming calls immediately.',
  },
  {
    name: 'After-Hours Agent',
    slug: 'after-hours',
    type: 'medical-after-hours',
    direction: 'inbound',
    description: 'Handles patient calls after business hours with triage and scheduling.',
  },
  {
    name: 'Answering Service Agent',
    slug: 'answering-service',
    type: 'answering-service',
    direction: 'inbound',
    description: 'General answering service for incoming calls during business hours.',
  },
  {
    name: 'DRS Scheduler Agent',
    slug: 'drs-scheduler',
    type: 'outbound-scheduling',
    direction: 'outbound',
    description: 'Outbound scheduling agent for doctor appointment bookings.',
  },
  {
    name: 'Appointment Confirmation Agent',
    slug: 'appointment-confirmation',
    type: 'appointment-confirmation',
    direction: 'outbound',
    description: 'Confirms upcoming appointments via outbound calls.',
  },
  {
    name: 'Fantasy Football Agent',
    slug: 'fantasy-football',
    type: 'custom',
    direction: 'outbound',
    description: 'Custom outbound agent for fantasy football league management.',
  },
];

async function seedAzulVision(): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL row_security = off');

    const { rows: existingTenants } = await client.query(
      `SELECT id FROM tenants WHERE slug = $1`,
      [AZUL_VISION_SLUG],
    );

    let tenantId: string;

    if (existingTenants.length > 0) {
      tenantId = existingTenants[0].id as string;
      console.log(`[SEED] Existing tenant found: ${tenantId}`);
    } else {
      const { rows: tenantRows } = await client.query(
        `INSERT INTO tenants (name, slug, status, plan, settings, feature_flags, metadata)
         VALUES ($1, $2, 'active', 'enterprise', $3, $4, $5)
         RETURNING id`,
        [
          AZUL_VISION_NAME,
          AZUL_VISION_SLUG,
          JSON.stringify({
            maxAgents: 20,
            maxPhoneNumbers: 10,
            maxConcurrentCalls: 10,
          }),
          JSON.stringify({
            advancedAnalytics: true,
            qualityScoring: true,
            customWorkflows: true,
            apiAccess: true,
            federatedIngest: true,
          }),
          JSON.stringify({
            type: 'internal',
            description: 'First production tenant — federated from Remix voice agents',
            industry: 'healthcare',
            specialization: 'ophthalmology',
          }),
        ],
      );
      tenantId = tenantRows[0].id as string;
      console.log(`[SEED] Created tenant: ${tenantId}`);
    }

    const { rows: existingUsers } = await client.query(
      `SELECT id FROM users WHERE email = $1`,
      [ADMIN_EMAIL],
    );

    let userId: string;
    if (existingUsers.length > 0) {
      userId = existingUsers[0].id as string;
      console.log(`[SEED] Existing admin user found: ${userId}`);
      const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
      await client.query(
        `UPDATE users SET password_hash = $1 WHERE id = $2`,
        [passwordHash, userId],
      );
      console.log(`[SEED] Updated admin password hash to bcrypt`);
    } else {
      const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
      const { rows: userRows } = await client.query(
        `INSERT INTO users (tenant_id, email, first_name, last_name, password_hash, role, is_active, email_verified)
         VALUES ($1, $2, 'Azul', 'Admin', $3, 'tenant_owner', true, true)
         RETURNING id`,
        [tenantId, ADMIN_EMAIL, passwordHash],
      );
      userId = userRows[0].id as string;
      console.log(`[SEED] Created admin user: ${userId} (${ADMIN_EMAIL})`);
    }

    const { rows: existingRoles } = await client.query(
      `SELECT id FROM user_roles WHERE user_id = $1 AND tenant_id = $2`,
      [userId, tenantId],
    );
    if (existingRoles.length === 0) {
      await client.query(
        `INSERT INTO user_roles (user_id, tenant_id, role) VALUES ($1, $2, 'tenant_owner')
         ON CONFLICT DO NOTHING`,
        [userId, tenantId],
      );
      console.log(`[SEED] Assigned owner role to user`);
    }

    const { rows: existingSubs } = await client.query(
      `SELECT id FROM subscriptions WHERE tenant_id = $1`,
      [tenantId],
    );

    if (existingSubs.length === 0) {
      await client.query(
        `INSERT INTO subscriptions (
          tenant_id, plan, status, billing_interval,
          monthly_call_limit, monthly_sms_limit, monthly_ai_minute_limit,
          overage_enabled, current_period_start, current_period_end
        ) VALUES ($1, 'enterprise', 'active', 'annual', 100000, 50000, 50000, false, NOW(), NOW() + INTERVAL '1 year')`,
        [tenantId],
      );
      console.log(`[SEED] Created enterprise subscription (internal, no Stripe)`);
    } else {
      console.log(`[SEED] Subscription already exists`);
    }

    for (const agent of FEDERATED_AGENTS) {
      const { rows: existingAgents } = await client.query(
        `SELECT id FROM agents WHERE tenant_id = $1 AND remote_agent_id = $2 AND execution_mode = 'federated'`,
        [tenantId, agent.slug],
      );

      if (existingAgents.length > 0) {
        console.log(`[SEED] Agent "${agent.name}" already exists, skipping`);
        continue;
      }

      const { rows: agentRows } = await client.query(
        `INSERT INTO agents (
          tenant_id, name, type, status, voice, model,
          execution_mode, remote_system, remote_agent_id, sync_mode,
          system_prompt, metadata
        ) VALUES ($1, $2, $3, 'active', 'alloy', 'gpt-4o-realtime-preview',
                  'federated', 'remix', $4, 'event_push',
                  $5, $6)
        RETURNING id`,
        [
          tenantId,
          agent.name,
          agent.type,
          agent.slug,
          `Federated agent managed by Remix. Direction: ${agent.direction}`,
          JSON.stringify({
            direction: agent.direction,
            description: agent.description,
            remoteSystem: 'remix',
            federatedAt: new Date().toISOString(),
          }),
        ],
      );

      console.log(`[SEED] Created federated agent: ${agent.name} (${agentRows[0].id})`);
    }

    await client.query('COMMIT');

    const { key, plaintextKey } = await generateApiKey(
      tenantId,
      'Remix Ingest Key',
      ['write'],
      null,
    );

    console.log('\n========================================');
    console.log('  Azul Vision Tenant Seeded Successfully');
    console.log('========================================');
    console.log(`  Tenant ID:    ${tenantId}`);
    console.log(`  Tenant Slug:  ${AZUL_VISION_SLUG}`);
    console.log(`  Admin Email:  ${ADMIN_EMAIL}`);
    console.log(`  API Key ID:   ${key.id}`);
    console.log(`  API Key:      ${plaintextKey.slice(0, 12)}...${plaintextKey.slice(-4)} (store securely)`);
    console.log('');
    console.log('  Set these in Remix .env:');
    console.log(`    QVO_TENANT_ID=${tenantId}`);
    console.log(`    QVO_API_KEY=<full key shown once above — copy from API key management>`);
    console.log(`    QVO_INGEST_URL=<your-qvo-base-url>`);
    console.log('');
    console.log(`  Federated Agents: ${FEDERATED_AGENTS.length}`);
    for (const a of FEDERATED_AGENTS) {
      console.log(`    - ${a.slug} (${a.direction})`);
    }
    console.log('========================================\n');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[SEED] Failed:', err);
    process.exit(1);
  } finally {
    client.release();
  }
}

seedAzulVision()
  .then(() => closePlatformPool())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[SEED] Unhandled error:', err);
    process.exit(1);
  });
