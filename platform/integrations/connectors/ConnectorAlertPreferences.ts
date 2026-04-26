import { getPlatformPool } from '../../db';
import { createLogger } from '../../core/logger';

const logger = createLogger('CONNECTOR_ALERT_PREFS');

export type MuteScope = 'provider' | 'integration';

export interface ConnectorAlertSettings {
  digestMode: boolean;
  digestLastSentAt: Date | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export interface ConnectorAlertMute {
  scope: MuteScope;
  target: string;
}

export const DEFAULT_SETTINGS: ConnectorAlertSettings = {
  digestMode: false,
  digestLastSentAt: null,
  updatedAt: null,
  updatedBy: null,
};

export async function getConnectorAlertSettings(
  tenantId: string,
): Promise<ConnectorAlertSettings> {
  if (!tenantId) return { ...DEFAULT_SETTINGS };
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query<{
      digest_mode: boolean;
      digest_last_sent_at: Date | string | null;
      updated_at: Date | string | null;
      updated_by: string | null;
    }>(
      `SELECT digest_mode, digest_last_sent_at, updated_at, updated_by
         FROM connector_alert_settings
        WHERE tenant_id = $1
        LIMIT 1`,
      [tenantId],
    );
    if (rows.length === 0) return { ...DEFAULT_SETTINGS };
    const r = rows[0];
    return {
      digestMode: !!r.digest_mode,
      digestLastSentAt: r.digest_last_sent_at ? new Date(r.digest_last_sent_at) : null,
      updatedAt: r.updated_at ? new Date(r.updated_at) : null,
      updatedBy: r.updated_by ?? null,
    };
  } catch (err) {
    logger.warn('Failed to load connector alert settings; using defaults', {
      tenantId,
      error: String(err),
    });
    return { ...DEFAULT_SETTINGS };
  }
}

export async function setConnectorAlertSettings(
  tenantId: string,
  patch: { digestMode?: boolean },
  userId?: string | null,
): Promise<ConnectorAlertSettings> {
  if (!tenantId) throw new Error('tenantId is required');
  const pool = getPlatformPool();
  await pool.query(
    `INSERT INTO connector_alert_settings (tenant_id, digest_mode, updated_at, updated_by)
     VALUES ($1, COALESCE($2, FALSE), NOW(), $3)
     ON CONFLICT (tenant_id)
     DO UPDATE SET
       digest_mode = COALESCE($2, connector_alert_settings.digest_mode),
       updated_at  = NOW(),
       updated_by  = COALESCE($3, connector_alert_settings.updated_by)`,
    [tenantId, typeof patch.digestMode === 'boolean' ? patch.digestMode : null, userId ?? null],
  );
  return getConnectorAlertSettings(tenantId);
}

export async function recordDigestSent(tenantId: string): Promise<void> {
  if (!tenantId) return;
  try {
    const pool = getPlatformPool();
    await pool.query(
      `INSERT INTO connector_alert_settings (tenant_id, digest_mode, digest_last_sent_at, updated_at)
       VALUES ($1, TRUE, NOW(), NOW())
       ON CONFLICT (tenant_id)
       DO UPDATE SET digest_last_sent_at = NOW(), updated_at = NOW()`,
      [tenantId],
    );
  } catch (err) {
    logger.warn('Failed to record digest sent timestamp', {
      tenantId,
      error: String(err),
    });
  }
}

export async function getConnectorAlertMutes(
  tenantId: string,
): Promise<ConnectorAlertMute[]> {
  if (!tenantId) return [];
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query<{ scope: MuteScope; target: string }>(
      `SELECT scope, target FROM connector_alert_mutes
        WHERE tenant_id = $1
        ORDER BY scope, target`,
      [tenantId],
    );
    return rows.map((r) => ({ scope: r.scope, target: r.target }));
  } catch (err) {
    logger.warn('Failed to load connector alert mutes', {
      tenantId,
      error: String(err),
    });
    return [];
  }
}

/**
 * Replace the tenant's mute list with the supplied set. Idempotent and
 * transactional so a partial failure can't leave a mixed-state list.
 */
export async function replaceConnectorAlertMutes(
  tenantId: string,
  mutes: ConnectorAlertMute[],
  userId?: string | null,
): Promise<ConnectorAlertMute[]> {
  if (!tenantId) throw new Error('tenantId is required');
  const sanitized = sanitizeMutes(mutes);
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM connector_alert_mutes WHERE tenant_id = $1`,
      [tenantId],
    );
    for (const m of sanitized) {
      await client.query(
        `INSERT INTO connector_alert_mutes (tenant_id, scope, target, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, scope, target) DO NOTHING`,
        [tenantId, m.scope, m.target, userId ?? null],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return getConnectorAlertMutes(tenantId);
}

function sanitizeMutes(mutes: ConnectorAlertMute[]): ConnectorAlertMute[] {
  const seen = new Set<string>();
  const out: ConnectorAlertMute[] = [];
  for (const m of mutes ?? []) {
    if (!m) continue;
    const scope = m.scope === 'provider' || m.scope === 'integration' ? m.scope : null;
    const target = typeof m.target === 'string' ? m.target.trim() : '';
    if (!scope || !target) continue;
    const key = `${scope}:${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ scope, target });
  }
  return out;
}

/**
 * Returns true if either the connector's provider or its specific
 * integration id is muted for the given tenant. Falls open on DB
 * errors so a misbehaving prefs table never silences alerts.
 */
export async function isConnectorMuted(
  tenantId: string,
  provider: string | null | undefined,
  integrationId: string | null | undefined,
): Promise<boolean> {
  if (!tenantId) return false;
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query<{ scope: MuteScope; target: string }>(
      `SELECT scope, target FROM connector_alert_mutes
        WHERE tenant_id = $1
          AND (
            (scope = 'provider'    AND LOWER(target) = LOWER($2))
            OR (scope = 'integration' AND target = $3)
          )
        LIMIT 1`,
      [tenantId, provider ?? '', integrationId ?? ''],
    );
    return rows.length > 0;
  } catch (err) {
    logger.warn('Failed to check connector alert mute; treating as unmuted', {
      tenantId,
      provider,
      integrationId,
      error: String(err),
    });
    return false;
  }
}

/**
 * Bulk variant used by the auth-alert scheduler so it can answer mute
 * questions for many tenants without N+1 queries.
 */
export async function loadMuteSetsForTenants(
  tenantIds: string[],
): Promise<Map<string, { providers: Set<string>; integrations: Set<string> }>> {
  const result = new Map<string, { providers: Set<string>; integrations: Set<string> }>();
  const unique = Array.from(new Set(tenantIds.filter(Boolean)));
  if (unique.length === 0) return result;
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query<{ tenant_id: string; scope: MuteScope; target: string }>(
      `SELECT tenant_id, scope, target FROM connector_alert_mutes
        WHERE tenant_id = ANY($1::varchar[])`,
      [unique],
    );
    for (const row of rows) {
      let entry = result.get(row.tenant_id);
      if (!entry) {
        entry = { providers: new Set<string>(), integrations: new Set<string>() };
        result.set(row.tenant_id, entry);
      }
      if (row.scope === 'provider') entry.providers.add(row.target.toLowerCase());
      else if (row.scope === 'integration') entry.integrations.add(row.target);
    }
  } catch (err) {
    logger.warn('Failed to bulk-load connector alert mutes; treating all as unmuted', {
      error: String(err),
    });
  }
  return result;
}
