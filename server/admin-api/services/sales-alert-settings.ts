import { getPlatformPool } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';

const logger = createLogger('SALES_ALERT_SETTINGS');

const SETTINGS_KEY = 'sales_alert_settings';

export interface SalesAlertSettings {
  channels: { email: boolean; slack: boolean };
  emailRecipients: string[];
  slackWebhookUrl: string | null;
  notifyOnNewLead: boolean;
  notifyOnBookingCreated: boolean;
  notifyOnBookingRescheduled: boolean;
  notifyOnBookingCancelled: boolean;
}

export const DEFAULT_SALES_ALERT_SETTINGS: SalesAlertSettings = {
  channels: { email: true, slack: true },
  emailRecipients: [],
  slackWebhookUrl: null,
  notifyOnNewLead: true,
  notifyOnBookingCreated: true,
  notifyOnBookingRescheduled: true,
  notifyOnBookingCancelled: true,
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function coerceSettings(raw: unknown): SalesAlertSettings {
  const merged: SalesAlertSettings = { ...DEFAULT_SALES_ALERT_SETTINGS };
  if (!raw || typeof raw !== 'object') return merged;
  const r = raw as Record<string, unknown>;

  if (r.channels && typeof r.channels === 'object') {
    const ch = r.channels as Record<string, unknown>;
    if (typeof ch.email === 'boolean') merged.channels.email = ch.email;
    if (typeof ch.slack === 'boolean') merged.channels.slack = ch.slack;
  }
  if (Array.isArray(r.emailRecipients)) {
    merged.emailRecipients = r.emailRecipients
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter((v) => EMAIL_REGEX.test(v));
  }
  if (typeof r.slackWebhookUrl === 'string') {
    const trimmed = r.slackWebhookUrl.trim();
    merged.slackWebhookUrl = trimmed.startsWith('https://') ? trimmed : null;
  } else if (r.slackWebhookUrl === null) {
    merged.slackWebhookUrl = null;
  }
  for (const key of [
    'notifyOnNewLead',
    'notifyOnBookingCreated',
    'notifyOnBookingRescheduled',
    'notifyOnBookingCancelled',
  ] as const) {
    if (typeof r[key] === 'boolean') merged[key] = r[key] as boolean;
  }
  return merged;
}

export async function getSalesAlertSettings(): Promise<SalesAlertSettings> {
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query<{ value: unknown }>(
      `SELECT value FROM platform_settings WHERE key = $1`,
      [SETTINGS_KEY],
    );
    if (!rows.length) return { ...DEFAULT_SALES_ALERT_SETTINGS };
    return coerceSettings(rows[0].value);
  } catch (err) {
    logger.warn('Failed to load sales alert settings; using defaults', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...DEFAULT_SALES_ALERT_SETTINGS };
  }
}

export interface SalesAlertSettingsPatch {
  channels?: Partial<{ email: boolean; slack: boolean }>;
  emailRecipients?: string[];
  slackWebhookUrl?: string | null;
  notifyOnNewLead?: boolean;
  notifyOnBookingCreated?: boolean;
  notifyOnBookingRescheduled?: boolean;
  notifyOnBookingCancelled?: boolean;
}

export async function setSalesAlertSettings(
  patch: SalesAlertSettingsPatch,
  updatedBy: string | null,
): Promise<SalesAlertSettings> {
  const current = await getSalesAlertSettings();
  const next: SalesAlertSettings = {
    ...current,
    channels: { ...current.channels, ...(patch.channels ?? {}) },
  };
  if (patch.emailRecipients !== undefined) {
    next.emailRecipients = patch.emailRecipients
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter((v) => EMAIL_REGEX.test(v));
  }
  if (patch.slackWebhookUrl !== undefined) {
    const trimmed = (patch.slackWebhookUrl ?? '').trim();
    next.slackWebhookUrl = trimmed && trimmed.startsWith('https://') ? trimmed : null;
  }
  for (const key of [
    'notifyOnNewLead',
    'notifyOnBookingCreated',
    'notifyOnBookingRescheduled',
    'notifyOnBookingCancelled',
  ] as const) {
    if (typeof patch[key] === 'boolean') next[key] = patch[key] as boolean;
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

/**
 * Resolve the public deep-link base for the Sales Inbox. Prefers an explicit
 * platform-admin URL env var, then falls back to ADMIN_API_BASE_URL (which is
 * already set in production), then to a relative path so emails still render
 * something useful even when no env var is configured.
 */
export function getAdminBaseUrl(): string {
  const candidates = [
    process.env.PLATFORM_ADMIN_BASE_URL,
    process.env.ADMIN_PUBLIC_URL,
    process.env.APP_PUBLIC_URL,
    process.env.ADMIN_API_BASE_URL,
  ];
  for (const c of candidates) {
    const v = (c ?? '').trim();
    if (v) return v.replace(/\/+$/, '');
  }
  return '';
}

export function getSalesInboxDeepLink(leadId: number | null | undefined): string {
  const base = getAdminBaseUrl();
  const path = '/admin/sales-inbox';
  const url = base ? `${base}${path}` : path;
  return leadId ? `${url}#lead-${leadId}` : url;
}
