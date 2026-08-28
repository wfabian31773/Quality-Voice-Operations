import { getPlatformPool } from '../platform/db';
import { validateBillingConfig } from '../platform/billing/stripe/plans';

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
  // Per-tier metered AI-minutes Stripe Price IDs. Originally optional under
  // Task #1269 (the upgrade-preview endpoint fell back to the catalog overage
  // rate when unset) so pre-migration deployments would not break overnight.
  // Promoted to production-required by Task #1321 now that every production
  // deployment has been migrated to per-tier metered AI-minutes pricing in
  // Stripe — a missing price id silently quotes the catalog rate, which is a
  // billing accuracy bug we no longer tolerate. `validateBillingConfig` also
  // surfaces these as hard errors at admin-api boot when
  // `STRIPE_METER_EVENT_AI_MINUTES` is set, providing belt-and-braces
  // coverage in environments (e.g. local dev opting in for testing) where
  // the static `production` gate here does not fire.
  { name: 'STRIPE_PRICE_STARTER_AI_MINUTES', required: 'production', purpose: 'Stripe metered Price ID for Starter per-minute AI overage. Required in production now that the per-tier metered-pricing migration is complete (Task #1321).' },
  { name: 'STRIPE_PRICE_PRO_AI_MINUTES', required: 'production', purpose: 'Stripe metered Price ID for Pro per-minute AI overage. Required in production now that the per-tier metered-pricing migration is complete (Task #1321).' },
  { name: 'STRIPE_PRICE_ENTERPRISE_AI_MINUTES', required: 'production', purpose: 'Stripe metered Price ID for Enterprise per-minute AI overage. Required in production now that the per-tier metered-pricing migration is complete (Task #1321).' },
  { name: 'VOICE_GATEWAY_BASE_URL', required: 'production', purpose: 'Public URL of the voice gateway (for Twilio webhooks)' },
  { name: 'VOICE_GATEWAY_STREAM_TOKEN', required: 'production', purpose: 'Strong bearer token authenticating Twilio and widget WebSocket stream upgrades' },
  { name: 'QVO_PII_LOOKUP_HMAC_KEY', required: 'production', purpose: 'Strong purpose-separated HMAC key for tenant-scoped caller lookup identifiers' },
  { name: 'QVO_PII_LOOKUP_HMAC_KEY_VERSION', required: 'production', purpose: 'Stable lowercase identifier for the active caller-lookup HMAC key' },
  { name: 'ADMIN_API_BASE_URL', required: 'production', purpose: 'Public URL of the admin API' },
  { name: 'SMTP_HOST', required: 'production', purpose: 'SMTP server hostname for transactional email' },
  { name: 'SMTP_PORT', required: 'production', purpose: 'SMTP server port (e.g. 587 for STARTTLS)' },
  { name: 'SMTP_USER', required: 'production', purpose: 'SMTP authentication username' },
  { name: 'SMTP_PASS', required: 'production', purpose: 'SMTP authentication password' },
  { name: 'EMAIL_FROM', required: 'production', purpose: 'Default sender address for outbound email' },
  { name: 'APP_URL', required: 'production', purpose: 'Public application URL (for invite links, redirects)' },
  { name: 'CALCOM_WEBHOOK_SECRET', required: 'production', purpose: 'HMAC-SHA256 secret for verifying Cal.com booking webhooks. Cal.com itself signs only the body (no timestamp), so register the Cal.com webhook against the adapter URL `/book-demo/calcom-native-webhook` — that route authenticates the native body-only signature and re-signs the payload with the envelope `t=<unix>,v1=HMAC(secret,"<t>.<body>")` before handing it to the canonical `/book-demo/calendar-webhook` verifier (5-minute replay window). Production fails closed without this secret. See docs/deployment-checklist.md §5 (Cal.com Webhook).' },
  // CALENDLY_WEBHOOK_SECRET is conditionally required in production — only when
  // VITE_BOOK_DEMO_SCHEDULER_PROVIDER (or BOOK_DEMO_SCHEDULER_PROVIDER) is set
  // to "calendly". The conditional check runs in `validateEnvironment` below
  // rather than this static table so the var stays optional for the default
  // Cal.com configuration.

  { name: 'SALES_NOTIFICATION_EMAIL', required: 'production', purpose: 'Sales inbox that receives demo lead and Cal.com booking lifecycle emails' },
  { name: 'VITE_BOOK_DEMO_SCHEDULER_URL', required: 'production', purpose: 'Embedded scheduler URL inlined into the /book-demo client bundle at vite build time' },
  { name: 'TURNSTILE_SECRET_KEY', required: 'production', purpose: 'Cloudflare Turnstile secret key for verifying sign-up CAPTCHA (production fails closed without it)' },
  { name: 'ALLOWED_ORIGINS', required: 'production', purpose: 'Comma-separated list of CORS origins allowed in production (e.g. https://app.example.com)' },
];

const OPTIONAL_VARS: EnvVar[] = [
  { name: 'TURNSTILE_SITE_KEY', required: 'development', purpose: 'Cloudflare Turnstile site key served to the signup form at runtime via GET /auth/signup-config. Prefer this over VITE_TURNSTILE_SITE_KEY so the widget can render without a frontend rebuild. The form fails closed when captcha is required and no site key is available.' },
  { name: 'VITE_TURNSTILE_SITE_KEY', required: 'development', purpose: 'Build-time fallback Cloudflare Turnstile site key inlined into the signup bundle. Used when TURNSTILE_SITE_KEY is unset.' },
  { name: 'ENCRYPTION_MASTER_KEY', required: 'development', purpose: 'Dedicated 32+ byte master key for platform-admin TOTP secrets and other encrypted application settings; falls back to CONNECTOR_ENCRYPTION_KEY when unset' },
  { name: 'CALL_EVENTS_PARTITION_PRUNING_ENABLED', required: 'development', purpose: 'Explicit destructive-retention opt-in; only set to true after the call-events retention policy is approved' },
  { name: 'ADMIN_API_PORT', required: 'development', purpose: 'Admin API listen port (default: 3002)' },
  { name: 'VOICE_GATEWAY_PORT', required: 'development', purpose: 'Voice gateway listen port (default: 3001)' },
  { name: 'PORT', required: 'development', purpose: 'Generic port fallback (default: 5000 in prod)' },
  { name: 'LOG_LEVEL', required: 'development', purpose: 'Logging level: debug | info | warn | error' },
  { name: 'BUILD_VERSION', required: 'development', purpose: 'Build identifier for observability' },
  { name: 'TWILIO_COST_PER_MINUTE_CENTS', required: 'development', purpose: 'Twilio cost per minute in cents (default: 2)' },
  { name: 'AI_COST_PER_MINUTE_CENTS', required: 'development', purpose: 'AI cost per minute in cents (default: 6)' },
  { name: 'SMS_COST_PER_MESSAGE_CENTS', required: 'development', purpose: 'SMS cost per message in cents (default: 1)' },
  { name: 'CAMPAIGN_TENANT_MAX_CONCURRENT', required: 'development', purpose: 'Max concurrent outbound calls per tenant (default: 5)' },
  { name: 'DISABLE_PHI_LOGGING', required: 'development', purpose: 'Set to "true" to redact PHI from logs' },
  { name: 'ADMIN_EMAIL', required: 'development', purpose: 'Seed admin email (used by seed-admin script)' },
  { name: 'ADMIN_PASSWORD', required: 'development', purpose: 'Seed admin password (used by seed-admin script)' },
  { name: 'ADMIN_INTERNAL_TOKEN', required: 'development', purpose: 'Internal bearer token for inter-service calls' },
  { name: 'OPS_SLACK_WEBHOOK_URL', required: 'development', purpose: 'Incoming-webhook URL for the ops Slack channel (used by docs-feedback alerts; falls back to SLACK_WEBHOOK_URL / SLACK_WEBHOOK)' },
  { name: 'VITE_BOOK_DEMO_SCHEDULER_PROVIDER', required: 'development', purpose: 'Scheduler provider for the /book-demo embed: "cal.com" (default) or "calendly". Inlined into the client bundle at vite build time' },
  { name: 'BOOK_DEMO_SCHEDULER_PROVIDER', required: 'development', purpose: 'Server-readable mirror of VITE_BOOK_DEMO_SCHEDULER_PROVIDER. Set to "calendly" so validate-env can require CALENDLY_WEBHOOK_SECRET in production builds where the VITE_-prefixed value is consumed only at vite build time' },
  { name: 'CALENDLY_WEBHOOK_SECRET', required: 'development', purpose: 'HMAC-SHA256 secret for verifying Calendly webhook requests (handled by both the unified /book-demo/calendar-webhook and the dedicated /book-demo/calendly-webhook routes). Conditionally required in production when VITE_BOOK_DEMO_SCHEDULER_PROVIDER (or BOOK_DEMO_SCHEDULER_PROVIDER) is "calendly"' },
  { name: 'CALENDLY_WEBHOOK_TOLERANCE_SECONDS', required: 'development', purpose: 'Optional override (default 300) for Calendly signature timestamp replay window' },
  { name: 'CALENDLY_WEBHOOK_ALLOW_UNSIGNED', required: 'development', purpose: 'Dev/staging only. Set to "1" to accept unsigned Calendly webhook requests when CALENDLY_WEBHOOK_SECRET is not configured. Production always fails closed' },
  { name: 'QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY', required: 'development', purpose: 'Previous caller-lookup HMAC key retained only during a bounded rotation/backfill window' },
  { name: 'QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION', required: 'development', purpose: 'Version paired with QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY during rotation' },
];

/**
 * Returns the configured /book-demo scheduler provider, normalised to lower
 * case. We check the server-readable BOOK_DEMO_SCHEDULER_PROVIDER first and
 * fall back to the VITE_-prefixed build-time variable so deployments that set
 * either form are covered.
 */
function resolveBookDemoSchedulerProvider(): string {
  const v =
    (process.env.BOOK_DEMO_SCHEDULER_PROVIDER ?? process.env.VITE_BOOK_DEMO_SCHEDULER_PROVIDER ?? '')
      .trim()
      .toLowerCase();
  return v || 'cal.com';
}

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

  // Conditional production requirement: when the /book-demo page is wired to
  // Calendly we must have a webhook secret so the verifier can authenticate
  // Calendly's deliveries (the route fails closed in production without it).
  //
  // NOTE: Admins can also store the secret in the DB-backed Demo Scheduler
  // settings panel (Sales Inbox → Demo scheduler). The verifier prefers the
  // env var when set and only falls back to the DB-stored value when the env
  // var is empty, so this validator's env-only check stays correct: the only
  // configuration that bypasses the env entirely is one where this var is
  // unset *and* the admin panel has saved a value. validate-env.ts
  // intentionally does *not* query the DB — it stays fast and dependency-free
  // at boot — so operators relying on the DB-only path should set
  // CALENDLY_WEBHOOK_SECRET to any non-empty placeholder to silence this
  // check. Setting any non-empty value here also wins over the DB-stored
  // secret; clear the env var first if you want the panel value to take over.
  const provider = resolveBookDemoSchedulerProvider();
  if (isProd && provider === 'calendly') {
    console.log('\nConditional variables:');
    if (!process.env.CALENDLY_WEBHOOK_SECRET) {
      console.log(
        `  FAIL  CALENDLY_WEBHOOK_SECRET — required because BOOK_DEMO_SCHEDULER_PROVIDER (or VITE_BOOK_DEMO_SCHEDULER_PROVIDER) is "calendly". Set the env var, or store a secret via the admin Demo scheduler panel and provide any placeholder value here to silence this check.`,
      );
      missing.push('CALENDLY_WEBHOOK_SECRET');
    } else {
      console.log(`  PASS  CALENDLY_WEBHOOK_SECRET (Calendly provider selected)`);
    }
  }

  // Task #995: connector OAuth state signing accepts EITHER ADMIN_JWT_SECRET
  // or CONNECTOR_ENCRYPTION_KEY (see `getStateSecret()` in
  // server/admin-api/routes/connectorOAuth.ts). Fail boot with a message that
  // names both candidate vars and explicitly mentions OAuth so operators
  // notice during deploy rather than after the first tenant clicks "Connect"
  // and gets a 500. ADMIN_JWT_SECRET is also required on its own (admin auth),
  // so under normal operation this guard piggybacks on that error — but it
  // makes the connector OAuth blast radius unambiguous.
  //
  // We deliberately do NOT push a synthetic name into `missing` here — the
  // failure scenario implies `ADMIN_JWT_SECRET` is already missing (which is
  // a hard production requirement on its own and already in `missing`), so
  // `passed` will be false regardless. Keeping `missing` to real env-var
  // names protects downstream consumers (e.g. log scrapers, runbook tooling)
  // that may treat the array as a list of literal vars to set.
  if (isProd) {
    const oauthSecretConfigured = !!(
      process.env.ADMIN_JWT_SECRET || process.env.CONNECTOR_ENCRYPTION_KEY
    );
    if (!oauthSecretConfigured) {
      console.log('\nConnector OAuth state signing:');
      console.log(
        '  FAIL  ADMIN_JWT_SECRET or CONNECTOR_ENCRYPTION_KEY — neither is set. Connector OAuth flows (/connectors/oauth/<provider>/init) will refuse every tenant request until one of these env vars is configured.',
      );
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

  if (process.env.VOICE_GATEWAY_STREAM_TOKEN && process.env.VOICE_GATEWAY_STREAM_TOKEN.length < 32) {
    warnings.push('VOICE_GATEWAY_STREAM_TOKEN should contain at least 32 characters of cryptographically random data');
    if (isProd && !missing.includes('VOICE_GATEWAY_STREAM_TOKEN')) missing.push('VOICE_GATEWAY_STREAM_TOKEN');
  }

  if (process.env.QVO_PII_LOOKUP_HMAC_KEY && process.env.QVO_PII_LOOKUP_HMAC_KEY.length < 32) {
    warnings.push('QVO_PII_LOOKUP_HMAC_KEY should contain at least 32 characters of cryptographically random data');
    if (isProd && !missing.includes('QVO_PII_LOOKUP_HMAC_KEY')) missing.push('QVO_PII_LOOKUP_HMAC_KEY');
  }

  const lookupVersionPattern = /^[a-z0-9][a-z0-9._-]{0,31}$/;
  const lookupVersion = process.env.QVO_PII_LOOKUP_HMAC_KEY_VERSION;
  if (lookupVersion && !lookupVersionPattern.test(lookupVersion)) {
    warnings.push('QVO_PII_LOOKUP_HMAC_KEY_VERSION must be a lowercase version identifier of at most 32 characters');
    if (isProd && !missing.includes('QVO_PII_LOOKUP_HMAC_KEY_VERSION')) {
      missing.push('QVO_PII_LOOKUP_HMAC_KEY_VERSION');
    }
  }

  const previousLookupKey = process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY;
  const previousLookupVersion = process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION;
  if (!!previousLookupKey !== !!previousLookupVersion) {
    const absent = previousLookupKey
      ? 'QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION'
      : 'QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY';
    warnings.push('QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY and QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION must be configured together');
    if (isProd && !missing.includes(absent)) missing.push(absent);
  } else if (previousLookupKey && previousLookupVersion) {
    if (previousLookupKey.length < 32) {
      warnings.push('QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY should contain at least 32 characters of cryptographically random data');
      if (isProd && !missing.includes('QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY')) {
        missing.push('QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY');
      }
    }
    if (!lookupVersionPattern.test(previousLookupVersion)) {
      warnings.push('QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION must be a lowercase version identifier of at most 32 characters');
      if (isProd && !missing.includes('QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION')) {
        missing.push('QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION');
      }
    }
    if (previousLookupKey === process.env.QVO_PII_LOOKUP_HMAC_KEY) {
      warnings.push('QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY must differ from QVO_PII_LOOKUP_HMAC_KEY');
      if (isProd && !missing.includes('QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY')) {
        missing.push('QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY');
      }
    }
    if (previousLookupVersion === lookupVersion) {
      warnings.push('QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION must differ from QVO_PII_LOOKUP_HMAC_KEY_VERSION');
      if (isProd && !missing.includes('QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION')) {
        missing.push('QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION');
      }
    }
  }

  // Surface the per-tier metered AI-minutes price *errors* from
  // `validateBillingConfig` so operators see the same gap during the env
  // validator pass that the Admin API logs at boot. As of Task #1321 these
  // are hard validation failures: once `STRIPE_METER_EVENT_AI_MINUTES` is
  // configured, every `STRIPE_PRICE_<TIER>_AI_MINUTES` must be set or the
  // upgrade-preview overage quote silently keeps reporting catalog defaults
  // instead of the live Stripe price. The per-tier vars are also listed as
  // production-required in `ENV_VARS` above (so the static check already
  // catches them in production); this block provides belt-and-braces
  // coverage in non-production environments where the static gate does not
  // fire but `STRIPE_METER_EVENT_AI_MINUTES` has been set (e.g. local dev
  // opting in for testing). We filter to the AI-minutes errors here to
  // avoid double-reporting the other billing warnings (STRIPE_SECRET_KEY,
  // STRIPE_WEBHOOK_SECRET, the tier × interval base prices) that are
  // already enforced as production-required entries in the ENV_VARS table.
  if (isProd) {
    const billingCheck = validateBillingConfig();
    const aiMinutesErrors = billingCheck.errors.filter(e => e.includes('_AI_MINUTES'));
    for (const e of aiMinutesErrors) {
      // Extract the env var name (first whitespace-delimited token) so the
      // `missing` array stays a list of literal env-var names that
      // downstream consumers (log scrapers, runbook tooling) can act on.
      const match = e.match(/^(STRIPE_PRICE_[A-Z]+_AI_MINUTES)/);
      const envName = match ? match[1] : null;
      if (envName && !missing.includes(envName)) {
        console.log(`  FAIL  ${envName} — ${e}`);
        missing.push(envName);
      }
    }
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
    // `--skip-db` lets the deploy build hook run env validation without
    // requiring DB connectivity from the build environment. The boot-time
    // path on the Admin API still calls validateDatabaseConnection() at
    // process start, so the migrations check is not skipped at runtime —
    // we just don't insist the build sandbox reach the pooler. See
    // docs/deployment-checklist.md §2 (Pre-deployment Validation).
    const skipDb = process.argv.includes('--skip-db');
    const result = validateEnvironment();
    let dbOk = true;
    if (!skipDb) {
      dbOk = await validateDatabaseConnection();
    } else {
      console.log('  DB connection: SKIPPED (--skip-db)');
    }
    if (!result.passed || !dbOk) {
      process.exit(1);
    }
    process.exit(0);
  })();
}
