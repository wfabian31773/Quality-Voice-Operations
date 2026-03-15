import pg from 'pg';
import bcrypt from 'bcryptjs';

const ADMIN_TENANT_ID = 'admin-org';
const ADMIN_TENANT_SLUG = 'admin-org';

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

    await client.query('COMMIT');
    console.log('[SEED-ADMIN] Admin user seeded successfully.');
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
