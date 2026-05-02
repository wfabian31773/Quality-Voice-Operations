import pg from 'pg';
import bcrypt from 'bcryptjs';

const ADMIN_TENANT_ID = 'admin-org';
const ADMIN_TENANT_SLUG = 'admin-org';

// Stable id+slug for the fixture tenant that hosts the non-ops fixture
// user used by tests/e2e/opsPagesSmoke.spec.ts to exercise the OpsGuard
// AccessDenied path. Keeping the member on its own tenant (rather than
// piling another role onto admin-org) keeps the admin login response
// deterministic — the /auth/login route picks a single role per user
// from user_roles ORDER BY created_at DESC and a second admin-org role
// would race with the seeded tenant_owner one.
const MEMBER_TENANT_ID = 'member-org';
const MEMBER_TENANT_SLUG = 'member-org';

// Stable id+subject for the fixture ticket used by
// tests/e2e/tenantPagesSmoke.spec.ts (Ticket Detail page check).
// Keep these strings in sync with PAGES in that spec.
const SMOKE_TICKET_ID = 'admin-org-smoke-ticket';
const SMOKE_TICKET_SUBJECT = 'Smoke Test Ticket';

// Stable id+name for the fixture agent used by
// tests/e2e/tenantPagesSmoke.spec.ts (Agent Builder page check).
// /agents/:id/builder needs a real id to load, so we seed one with a
// known id here. Keep these strings in sync with PAGES in that spec.
const SMOKE_AGENT_ID = 'admin-org-smoke-agent';
const SMOKE_AGENT_NAME = 'Smoke Test Agent';

async function main() {
  const env = process.env.APP_ENV ?? 'development';

  if (env !== 'development') {
    throw new Error(
      '[SEED-ADMIN] This script can only run in development (APP_ENV=development). ' +
      'Production admin accounts must be created through the application.'
    );
  }

  const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@voiceaihub.dev';
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    throw new Error(
      '[SEED-ADMIN] ADMIN_PASSWORD environment variable is required. ' +
      'Usage: ADMIN_PASSWORD=YourPassword npx tsx scripts/seed-admin.ts'
    );
  }

  // Non-ops fixture user for the OpsGuard deny-path coverage in
  // tests/e2e/opsPagesSmoke.spec.ts. Defaults match the spec's defaults
  // so a clean checkout works out of the box. Password reuses
  // ADMIN_PASSWORD by default — override with MEMBER_PASSWORD if you
  // want them split.
  const memberEmail = process.env.MEMBER_EMAIL ?? 'member@voiceaihub.dev';
  const memberPassword = process.env.MEMBER_PASSWORD ?? adminPassword;

  const url = process.env.DATABASE_URL ?? '';
  if (!url) {
    throw new Error('[SEED-ADMIN] DATABASE_URL is not set for development.');
  }

  console.log(`[SEED-ADMIN] Environment: ${env}`);
  console.log(`[SEED-ADMIN] Admin email: ${adminEmail}`);

  const pool = new pg.Pool({
    connectionString: url,
    max: 3,
  });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    console.log('[SEED-ADMIN] Upserting admin tenant...');
    await client.query(
      `INSERT INTO tenants (id, name, slug, status, plan, settings, feature_flags)
       VALUES ($1, 'Platform Admin Organization', $2, 'active', 'enterprise',
               '{"timezone": "America/New_York"}'::jsonb,
               '{"platform_admin": true}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         status = 'active',
         updated_at = NOW()`,
      [ADMIN_TENANT_ID, ADMIN_TENANT_SLUG],
    );

    console.log('[SEED-ADMIN] Upserting admin subscription...');
    await client.query(
      `INSERT INTO subscriptions (tenant_id, plan, status, billing_interval,
         monthly_call_limit, monthly_sms_limit, monthly_ai_minute_limit, overage_enabled)
       VALUES ($1, 'enterprise', 'active', 'monthly', 999999, 999999, 999999, false)
       ON CONFLICT (tenant_id) DO UPDATE SET
         plan = EXCLUDED.plan,
         status = 'active',
         updated_at = NOW()`,
      [ADMIN_TENANT_ID],
    );

    const passwordHash = await bcrypt.hash(adminPassword, 12);

    console.log('[SEED-ADMIN] Upserting admin user...');
    const userResult = await client.query(
      `INSERT INTO users (email, password_hash, role, is_platform_admin, is_active)
       VALUES ($1, $2, 'admin', true, true)
       ON CONFLICT (email) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         is_platform_admin = true,
         is_active = true,
         updated_at = NOW()
       RETURNING id`,
      [adminEmail, passwordHash],
    );
    const userId = userResult.rows[0]?.id;

    if (userId) {
      console.log('[SEED-ADMIN] Upserting user_roles...');
      await client.query(
        `INSERT INTO user_roles (user_id, tenant_id, role)
         VALUES ($1, $2, 'tenant_owner')
         ON CONFLICT (user_id, tenant_id, role) DO NOTHING`,
        [userId, ADMIN_TENANT_ID],
      );
    }

    // Seed a fixture ticket for tenantPagesSmoke.spec.ts to hit
    // /tickets/:id with a stable, known id+subject. Without this row
    // the smoke spec would have to scrape the list page for any id,
    // which makes it brittle against ordering or list-fetch changes.
    // The tickets table has tenant RLS, so we set the GUC for this
    // transaction in case the seed user is not bypassing RLS.
    console.log('[SEED-ADMIN] Upserting smoke-test fixture ticket...');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ADMIN_TENANT_ID]);
    await client.query(
      `INSERT INTO tickets (id, tenant_id, subject, description, status, priority, source)
       VALUES ($1, $2, $3, $4, 'open', 'medium', 'manual')
       ON CONFLICT (id) DO UPDATE SET
         subject = EXCLUDED.subject,
         description = EXCLUDED.description,
         status = 'open',
         updated_at = NOW()`,
      [
        SMOKE_TICKET_ID,
        ADMIN_TENANT_ID,
        SMOKE_TICKET_SUBJECT,
        'Auto-created by seed-admin for tenantPagesSmoke.spec.ts. Safe to delete in production.',
      ],
    );

    // Seed a fixture agent for tenantPagesSmoke.spec.ts to hit
    // /agents/:id/builder with a stable, known id+name. Like the smoke
    // ticket above, this avoids the need to scrape the Agents list for
    // a usable id (brittle against ordering / list-fetch changes). The
    // builder fetches /api/agents/:id on mount, so the row must exist
    // on the admin-org tenant.
    console.log('[SEED-ADMIN] Upserting smoke-test fixture agent...');
    await client.query(
      `INSERT INTO agents (id, tenant_id, name, type, status)
       VALUES ($1, $2, $3, 'general', 'active')
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         status = 'active',
         updated_at = NOW()`,
      [SMOKE_AGENT_ID, ADMIN_TENANT_ID, SMOKE_AGENT_NAME],
    );

    // Seed the non-ops fixture tenant + user that
    // tests/e2e/opsPagesSmoke.spec.ts logs in as to exercise the
    // OpsGuard AccessDenied path. The role 'support_reviewer' is
    // intentionally NOT in OpsGuard's allow-set (tenant_owner,
    // operations_manager, platform_admin) — so any /ops/* URL renders
    // OpsAccessDenied for this user.
    console.log('[SEED-ADMIN] Upserting non-ops fixture tenant...');
    await client.query(
      `INSERT INTO tenants (id, name, slug, status, plan, settings, feature_flags)
       VALUES ($1, 'Member Fixture Organization', $2, 'active', 'starter',
               '{"timezone": "America/New_York"}'::jsonb,
               '{}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         status = 'active',
         updated_at = NOW()`,
      [MEMBER_TENANT_ID, MEMBER_TENANT_SLUG],
    );

    console.log('[SEED-ADMIN] Upserting non-ops fixture subscription...');
    await client.query(
      `INSERT INTO subscriptions (tenant_id, plan, status, billing_interval,
         monthly_call_limit, monthly_sms_limit, monthly_ai_minute_limit, overage_enabled)
       VALUES ($1, 'starter', 'active', 'monthly', 1000, 1000, 1000, false)
       ON CONFLICT (tenant_id) DO UPDATE SET
         plan = EXCLUDED.plan,
         status = 'active',
         updated_at = NOW()`,
      [MEMBER_TENANT_ID],
    );

    const memberPasswordHash = await bcrypt.hash(memberPassword, 12);

    console.log('[SEED-ADMIN] Upserting non-ops fixture user...');
    const memberResult = await client.query(
      `INSERT INTO users (email, password_hash, role, is_platform_admin, is_active, email_verified)
       VALUES ($1, $2, 'support_reviewer', false, true, true)
       ON CONFLICT (email) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         is_platform_admin = false,
         is_active = true,
         email_verified = true,
         updated_at = NOW()
       RETURNING id`,
      [memberEmail, memberPasswordHash],
    );
    const memberId = memberResult.rows[0]?.id;

    if (memberId) {
      console.log('[SEED-ADMIN] Upserting non-ops fixture user_roles...');
      await client.query(
        `INSERT INTO user_roles (user_id, tenant_id, role)
         VALUES ($1, $2, 'support_reviewer')
         ON CONFLICT (user_id, tenant_id, role) DO NOTHING`,
        [memberId, MEMBER_TENANT_ID],
      );
    }

    await client.query('COMMIT');
    console.log('[SEED-ADMIN] Admin user seeded successfully.');
    console.log(`[SEED-ADMIN] Non-ops fixture user: ${memberEmail} (tenant=${MEMBER_TENANT_ID}, role=support_reviewer)`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[SEED-ADMIN] Failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
