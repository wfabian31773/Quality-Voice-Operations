import { getPlatformPool } from '../platform/db';

interface EnvVar {
  name: string;
  required: 'always' | 'production' | 'development';
  purpose: string;
}

const ENV_VARS: EnvVar[] = [
  { name: 'APP_ENV', required: 'always', purpose: 'Environment selector (development | staging | production)' },
  { name: 'DATABASE_URL', required: 'development', purpose: 'Local PostgreSQL connection string (Replit)' },
  { name: 'PLATFORM_DB_POOL_URL', required: 'production', purpose: 'Supabase transaction pooler URL (port 6543, SSL)' },
  { name: 'OPENAI_API_KEY', required: 'always', purpose: 'OpenAI Realtime API key for voice AI' },
  { name: 'TWILIO_ACCOUNT_SID', required: 'always', purpose: 'Twilio account SID' },
  { name: 'TWILIO_AUTH_TOKEN', required: 'always', purpose: 'Twilio auth token' },
  { name: 'TWILIO_OUTBOUND_NUMBER', required: 'always', purpose: 'Default outbound caller ID (E.164)' },
  { name: 'ADMIN_JWT_SECRET', required: 'production', purpose: 'JWT signing secret for admin API auth' },
  { name: 'CONNECTOR_ENCRYPTION_KEY', required: 'production', purpose: '32-byte hex key for encrypting tenant connector secrets' },
  { name: 'STRIPE_SECRET_KEY', required: 'production', purpose: 'Stripe API secret key' },
  { name: 'STRIPE_WEBHOOK_SECRET', required: 'production', purpose: 'Stripe webhook signing secret (whsec_...)' },
  { name: 'STRIPE_PRICE_STARTER_MONTHLY', required: 'production', purpose: 'Stripe Price ID for Starter monthly plan' },
  { name: 'STRIPE_PRICE_STARTER_ANNUAL', required: 'production', purpose: 'Stripe Price ID for Starter annual plan' },
  { name: 'STRIPE_PRICE_PRO_MONTHLY', required: 'production', purpose: 'Stripe Price ID for Pro monthly plan' },
  { name: 'STRIPE_PRICE_PRO_ANNUAL', required: 'production', purpose: 'Stripe Price ID for Pro annual plan' },
  { name: 'STRIPE_PRICE_ENTERPRISE_MONTHLY', required: 'production', purpose: 'Stripe Price ID for Enterprise monthly plan' },
  { name: 'STRIPE_PRICE_ENTERPRISE_ANNUAL', required: 'production', purpose: 'Stripe Price ID for Enterprise annual plan' },
  { name: 'STRIPE_METER_EVENT_CALLS', required: 'production', purpose: 'Stripe meter event name for call usage' },
  { name: 'STRIPE_METER_EVENT_AI_MINUTES', required: 'production', purpose: 'Stripe meter event name for AI minute usage' },
  { name: 'VOICE_GATEWAY_BASE_URL', required: 'production', purpose: 'Public URL of the voice gateway (for Twilio webhooks)' },
  { name: 'ADMIN_API_BASE_URL', required: 'production', purpose: 'Public URL of the admin API' },
  { name: 'SMTP_HOST', required: 'production', purpose: 'SMTP server hostname for transactional email' },
  { name: 'SMTP_PORT', required: 'production', purpose: 'SMTP server port (e.g. 587 for STARTTLS)' },
  { name: 'SMTP_USER', required: 'production', purpose: 'SMTP authentication username' },
  { name: 'SMTP_PASS', required: 'production', purpose: 'SMTP authentication password' },
  { name: 'EMAIL_FROM', required: 'production', purpose: 'Default sender address for outbound email' },
  { name: 'APP_URL', required: 'production', purpose: 'Public application URL (for invite links, redirects)' },
];

const OPTIONAL_VARS: EnvVar[] = [
  { name: 'ADMIN_API_PORT', required: 'development', purpose: 'Admin API listen port (default: 3002)' },
  { name: 'VOICE_GATEWAY_PORT', required: 'development', purpose: 'Voice gateway listen port (default: 3001)' },
  { name: 'PORT', required: 'development', purpose: 'Generic port fallback (default: 5000 in prod)' },
  { name: 'LOG_LEVEL', required: 'development', purpose: 'Logging level: debug | info | warn | error' },
  { name: 'BUILD_VERSION', required: 'development', purpose: 'Build identifier for observability' },
  { name: 'TWILIO_COST_PER_MINUTE_CENTS', required: 'development', purpose: 'Twilio cost per minute in cents (default: 2)' },
  { name: 'AI_COST_PER_MINUTE_CENTS', required: 'development', purpose: 'AI cost per minute in cents (default: 6)' },
  { name: 'SMS_COST_PER_MESSAGE_CENTS', required: 'development', purpose: 'SMS cost per message in cents (default: 1)' },
  { name: 'VOICE_GATEWAY_STREAM_TOKEN', required: 'development', purpose: 'Optional bearer token for WebSocket stream auth' },
  { name: 'CAMPAIGN_TENANT_MAX_CONCURRENT', required: 'development', purpose: 'Max concurrent outbound calls per tenant (default: 5)' },
  { name: 'DISABLE_PHI_LOGGING', required: 'development', purpose: 'Set to "true" to redact PHI from logs' },
  { name: 'ADMIN_EMAIL', required: 'development', purpose: 'Seed admin email (used by seed-admin script)' },
  { name: 'ADMIN_PASSWORD', required: 'development', purpose: 'Seed admin password (used by seed-admin script)' },
  { name: 'ADMIN_INTERNAL_TOKEN', required: 'development', purpose: 'Internal bearer token for inter-service calls' },
];

export function validateEnvironment(options?: { exitOnFailure?: boolean }): {
  passed: boolean;
  missing: string[];
  warnings: string[];
} {
  const appEnv = process.env.APP_ENV ?? 'development';
  const isProd = appEnv === 'production' || appEnv === 'staging';

  console.log(`\n========================================`);
  console.log(`  Environment Validation — ${appEnv}`);
  console.log(`========================================\n`);

  const missing: string[] = [];
  const warnings: string[] = [];

  console.log('Required variables:');
  for (const v of ENV_VARS) {
    const present = !!process.env[v.name];
    const isRequired =
      v.required === 'always' ||
      (v.required === 'production' && isProd) ||
      (v.required === 'development' && !isProd);

    if (!present && isRequired) {
      console.log(`  FAIL  ${v.name} — ${v.purpose}`);
      missing.push(v.name);
    } else if (!present && !isRequired) {
      console.log(`  SKIP  ${v.name} — not required in ${appEnv}`);
    } else {
      console.log(`  PASS  ${v.name}`);
    }
  }

  console.log('\nOptional variables:');
  for (const v of OPTIONAL_VARS) {
    const present = !!process.env[v.name];
    if (present) {
      console.log(`  SET   ${v.name}`);
    } else {
      console.log(`  —     ${v.name} (using default)`);
    }
  }

  if (isProd && process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) {
    warnings.push('STRIPE_SECRET_KEY appears to be a test key in production');
  }

  if (isProd && process.env.ADMIN_JWT_SECRET?.startsWith('qvo-dev-')) {
    warnings.push('ADMIN_JWT_SECRET appears to be an auto-generated dev secret — use a strong random secret in production');
  }

  if (isProd && process.env.PLATFORM_DB_POOL_URL && !process.env.PLATFORM_DB_POOL_URL.includes('6543')) {
    warnings.push('PLATFORM_DB_POOL_URL may not be using transaction pooler port 6543');
  }

  if (process.env.CONNECTOR_ENCRYPTION_KEY && process.env.CONNECTOR_ENCRYPTION_KEY.length < 64) {
    warnings.push('CONNECTOR_ENCRYPTION_KEY should be 32 bytes (64 hex chars)');
  }

  if (warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of warnings) {
      console.log(`  WARN  ${w}`);
    }
  }

  const passed = missing.length === 0;
  console.log(`\n${passed ? 'PASS' : 'FAIL'}: ${missing.length} missing, ${warnings.length} warnings\n`);

  if (!passed && options?.exitOnFailure) {
    process.exit(1);
  }

  return { passed, missing, warnings };
}

export async function validateDatabaseConnection(): Promise<boolean> {
  try {
    const pool = getPlatformPool();
    const client = await pool.connect();
    const { rows } = await client.query('SELECT COUNT(*) AS cnt FROM schema_migrations');
    const migrationCount = parseInt(rows[0]?.cnt as string, 10);
    console.log(`  DB connection: OK (${migrationCount} migrations applied)`);
    client.release();
    return true;
  } catch (err) {
    console.log(`  DB connection: FAIL — ${(err as Error).message}`);
    return false;
  }
}

if (require.main === module) {
  (async () => {
    const result = validateEnvironment();
    const dbOk = await validateDatabaseConnection();
    if (!result.passed || !dbOk) {
      process.exit(1);
    }
    process.exit(0);
  })();
}
