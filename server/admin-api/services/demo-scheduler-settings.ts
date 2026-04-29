import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { getPlatformPool } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';

const logger = createLogger('DEMO_SCHEDULER_SETTINGS');

const SETTINGS_KEY = 'demo_scheduler';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEK_SALT = 'demo-scheduler-kek-v1';

export type SchedulerProvider = 'cal.com' | 'calendly';

export interface DemoSchedulerSettings {
  provider: SchedulerProvider;
  embedUrl: string;
  calcomWebhookSecretEncrypted: string | null;
  calendlyWebhookSecretEncrypted: string | null;
}

export interface DemoSchedulerPublicConfig {
  provider: SchedulerProvider;
  embedUrl: string;
}

export const DEFAULT_DEMO_SCHEDULER_SETTINGS: DemoSchedulerSettings = {
  provider: 'cal.com',
  embedUrl: 'https://cal.com/qvo/30min',
  calcomWebhookSecretEncrypted: null,
  calendlyWebhookSecretEncrypted: null,
};

const IS_DEV = ['development', 'dev', 'local', 'test'].includes(
  (process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development').toLowerCase(),
);

/**
 * Derive the platform-wide key-encryption-key used to wrap demo-scheduler
 * webhook secrets stored in platform_settings. We reuse the same master-key
 * env var as the rest of the platform crypto stack so a single rotation lets
 * both move forward together.
 */
function deriveKEK(): Buffer {
  const secret = process.env.ENCRYPTION_MASTER_KEY ?? process.env.CONNECTOR_ENCRYPTION_KEY;
  if (!secret) {
    if (IS_DEV) {
      const devKey = 'qvo-dev-encryption-' + (process.env.REPL_ID ?? 'local');
      logger.warn('ENCRYPTION_MASTER_KEY not set — using auto-generated dev key for demo scheduler secrets');
      return scryptSync(devKey, KEK_SALT, 32) as Buffer;
    }
    throw new Error('ENCRYPTION_MASTER_KEY environment variable is required to encrypt demo scheduler secrets in production.');
  }
  return scryptSync(secret, KEK_SALT, 32) as Buffer;
}

export function encryptSchedulerSecret(plaintext: string): string {
  const key = deriveKEK();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptSchedulerSecret(ciphertext: string): string {
  const key = deriveKEK();
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
}

function isValidProvider(v: unknown): v is SchedulerProvider {
  return v === 'cal.com' || v === 'calendly';
}

function isValidEmbedUrl(v: string): boolean {
  try {
    const url = new URL(v);
    return url.protocol === 'https:' || (IS_DEV && url.protocol === 'http:');
  } catch {
    return false;
  }
}

function coerceSettings(raw: unknown): DemoSchedulerSettings {
  const merged: DemoSchedulerSettings = { ...DEFAULT_DEMO_SCHEDULER_SETTINGS };
  if (!raw || typeof raw !== 'object') return merged;
  const r = raw as Record<string, unknown>;
  if (isValidProvider(r.provider)) merged.provider = r.provider;
  if (typeof r.embedUrl === 'string' && r.embedUrl.trim()) {
    const trimmed = r.embedUrl.trim();
    if (isValidEmbedUrl(trimmed)) merged.embedUrl = trimmed;
  }
  if (typeof r.calcomWebhookSecretEncrypted === 'string' && r.calcomWebhookSecretEncrypted.trim()) {
    merged.calcomWebhookSecretEncrypted = r.calcomWebhookSecretEncrypted.trim();
  } else if (r.calcomWebhookSecretEncrypted === null) {
    merged.calcomWebhookSecretEncrypted = null;
  }
  if (typeof r.calendlyWebhookSecretEncrypted === 'string' && r.calendlyWebhookSecretEncrypted.trim()) {
    merged.calendlyWebhookSecretEncrypted = r.calendlyWebhookSecretEncrypted.trim();
  } else if (r.calendlyWebhookSecretEncrypted === null) {
    merged.calendlyWebhookSecretEncrypted = null;
  }
  return merged;
}

/**
 * Resolve the build-time defaults from VITE_BOOK_DEMO_SCHEDULER_* env vars.
 * Used as the initial seed when the admin has not customised the settings,
 * and as the fallback when the DB lookup fails so the public /book-demo page
 * still renders something usable.
 */
export function resolveEnvFallbackConfig(): DemoSchedulerPublicConfig {
  const envProvider = (process.env.BOOK_DEMO_SCHEDULER_PROVIDER ?? process.env.VITE_BOOK_DEMO_SCHEDULER_PROVIDER ?? '')
    .trim()
    .toLowerCase();
  const provider: SchedulerProvider = envProvider === 'calendly' ? 'calendly' : 'cal.com';
  const envUrl = (process.env.VITE_BOOK_DEMO_SCHEDULER_URL ?? '').trim();
  const embedUrl =
    envUrl && isValidEmbedUrl(envUrl)
      ? envUrl
      : DEFAULT_DEMO_SCHEDULER_SETTINGS.embedUrl;
  return { provider, embedUrl };
}

export async function getDemoSchedulerSettings(): Promise<DemoSchedulerSettings> {
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query<{ value: unknown }>(
      `SELECT value FROM platform_settings WHERE key = $1`,
      [SETTINGS_KEY],
    );
    if (!rows.length) {
      const fallback = resolveEnvFallbackConfig();
      return {
        ...DEFAULT_DEMO_SCHEDULER_SETTINGS,
        provider: fallback.provider,
        embedUrl: fallback.embedUrl,
      };
    }
    return coerceSettings(rows[0].value);
  } catch (err) {
    logger.warn('Failed to load demo scheduler settings; using env fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    const fallback = resolveEnvFallbackConfig();
    return {
      ...DEFAULT_DEMO_SCHEDULER_SETTINGS,
      provider: fallback.provider,
      embedUrl: fallback.embedUrl,
    };
  }
}

/**
 * Public-facing config used by the /book-demo page. NEVER includes any
 * secret material — only the provider and the embed URL the iframe loads.
 */
export async function getPublicDemoSchedulerConfig(): Promise<DemoSchedulerPublicConfig> {
  const settings = await getDemoSchedulerSettings();
  return { provider: settings.provider, embedUrl: settings.embedUrl };
}

/**
 * Return the active Cal.com webhook signing secret. Prefers the env var so
 * existing deployments keep working without a DB migration; falls back to
 * the encrypted DB-stored value when no env var is configured.
 */
export async function getActiveCalcomWebhookSecret(): Promise<string | null> {
  const fromEnv = (process.env.CALCOM_WEBHOOK_SECRET ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const settings = await getDemoSchedulerSettings();
    if (!settings.calcomWebhookSecretEncrypted) return null;
    return decryptSchedulerSecret(settings.calcomWebhookSecretEncrypted);
  } catch (err) {
    logger.warn('Failed to load Cal.com webhook secret from DB', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function getActiveCalendlyWebhookSecret(): Promise<string | null> {
  const fromEnv = (process.env.CALENDLY_WEBHOOK_SECRET ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const settings = await getDemoSchedulerSettings();
    if (!settings.calendlyWebhookSecretEncrypted) return null;
    return decryptSchedulerSecret(settings.calendlyWebhookSecretEncrypted);
  } catch (err) {
    logger.warn('Failed to load Calendly webhook secret from DB', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface DemoSchedulerSettingsPatch {
  provider?: SchedulerProvider;
  embedUrl?: string;
  /** New plaintext secret. Pass `null` to clear, omit to leave unchanged. */
  calcomWebhookSecret?: string | null;
  calendlyWebhookSecret?: string | null;
}

export interface DemoSchedulerSettingsAdminView {
  provider: SchedulerProvider;
  embedUrl: string;
  /** True iff a DB-stored secret is set. The plaintext is never returned. */
  calcomWebhookSecretConfigured: boolean;
  calendlyWebhookSecretConfigured: boolean;
}

export function toAdminView(settings: DemoSchedulerSettings): DemoSchedulerSettingsAdminView {
  return {
    provider: settings.provider,
    embedUrl: settings.embedUrl,
    calcomWebhookSecretConfigured: Boolean(settings.calcomWebhookSecretEncrypted),
    calendlyWebhookSecretConfigured: Boolean(settings.calendlyWebhookSecretEncrypted),
  };
}

export class DemoSchedulerSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoSchedulerSettingsValidationError';
  }
}

export async function setDemoSchedulerSettings(
  patch: DemoSchedulerSettingsPatch,
  updatedBy: string | null,
): Promise<DemoSchedulerSettings> {
  const current = await getDemoSchedulerSettings();
  const next: DemoSchedulerSettings = { ...current };

  if (patch.provider !== undefined) {
    if (!isValidProvider(patch.provider)) {
      throw new DemoSchedulerSettingsValidationError('provider must be "cal.com" or "calendly"');
    }
    next.provider = patch.provider;
  }
  if (patch.embedUrl !== undefined) {
    const trimmed = (patch.embedUrl ?? '').trim();
    if (!trimmed || !isValidEmbedUrl(trimmed)) {
      throw new DemoSchedulerSettingsValidationError('embedUrl must be a valid https URL');
    }
    next.embedUrl = trimmed;
  }
  if (patch.calcomWebhookSecret !== undefined) {
    if (patch.calcomWebhookSecret === null) {
      next.calcomWebhookSecretEncrypted = null;
    } else {
      const trimmed = patch.calcomWebhookSecret.trim();
      if (trimmed.length < 16) {
        throw new DemoSchedulerSettingsValidationError(
          'calcomWebhookSecret must be at least 16 characters',
        );
      }
      next.calcomWebhookSecretEncrypted = encryptSchedulerSecret(trimmed);
    }
  }
  if (patch.calendlyWebhookSecret !== undefined) {
    if (patch.calendlyWebhookSecret === null) {
      next.calendlyWebhookSecretEncrypted = null;
    } else {
      const trimmed = patch.calendlyWebhookSecret.trim();
      if (trimmed.length < 16) {
        throw new DemoSchedulerSettingsValidationError(
          'calendlyWebhookSecret must be at least 16 characters',
        );
      }
      next.calendlyWebhookSecretEncrypted = encryptSchedulerSecret(trimmed);
    }
  }

  const pool = getPlatformPool();
  await pool.query(
    `INSERT INTO platform_settings (key, value, updated_by)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           updated_at = NOW(),
           updated_by = EXCLUDED.updated_by`,
    [SETTINGS_KEY, JSON.stringify(next), updatedBy],
  );
  return next;
}
