export interface SecretCheck {
  name: string;
  present: boolean;
}

export function validateEnv(requiredKeys: string[]): void {
  const checks: SecretCheck[] = requiredKeys.map((name) => ({
    name,
    present: !!process.env[name],
  }));

  const missing = checks.filter((c) => !c.present);
  const isProd = process.env.APP_ENV === 'production';

  console.log('\n[ENV VALIDATION]');
  checks.forEach((c) => {
    console.log(`  ${c.present ? 'PASS' : 'FAIL'}: ${c.name}`);
  });

  if (missing.length > 0 && isProd) {
    throw new Error(
      `[ENV VALIDATION] CRITICAL: Missing required secrets in production: ${missing.map((s) => s.name).join(', ')}`,
    );
  } else if (missing.length > 0) {
    console.warn(
      `[ENV VALIDATION] WARNING: Missing in development (may be expected): ${missing.map((s) => s.name).join(', ')}`,
    );
  } else {
    console.log('[ENV VALIDATION] All required secrets present');
  }
}

export function getRequiredSecrets(): string[] {
  const env = process.env.APP_ENV ?? 'development';
  const base = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'OPENAI_API_KEY',
  ];

  if (env === 'development') {
    base.push('DATABASE_URL');
  } else {
    base.push('PLATFORM_DB_POOL_URL');
  }

  return base;
}

export const PLATFORM_REQUIRED_SECRETS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'OPENAI_API_KEY',
] as const;

export const TENANT_SECRET_KEYS = [
  'TWILIO_SUB_ACCOUNT_SID',
  'TWILIO_SUB_AUTH_TOKEN',
] as const;
