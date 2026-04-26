import { getPlatformPool, withTenantContext } from '../../db';
import { decryptValue } from './crypto';
import { isEnvelopeEncrypted } from '../../security/EncryptionService';
import type { ConnectorConfig, ConnectorType } from './types';
import type { TenantId } from '../../core/types';
import { createLogger } from '../../core/logger';

const logger = createLogger('CONNECTOR_DB');

interface DbClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

async function withTenant<T>(tenantId: string, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const result = await fn(client as unknown as DbClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getConnectorConfig(
  tenantId: TenantId,
  connectorType: ConnectorType,
  provider?: string,
): Promise<ConnectorConfig | null> {
  return withTenant(tenantId, async (client) => {
    const { rows: integRows } = provider
      ? await client.query(
          `SELECT id, integration_type, provider, is_enabled, config,
                  fallback_connector_type, fallback_provider
           FROM integrations
           WHERE tenant_id = $1 AND integration_type = $2 AND provider = $3 AND is_enabled = TRUE
           LIMIT 1`,
          [tenantId, connectorType, provider],
        )
      : await client.query(
          `SELECT id, integration_type, provider, is_enabled, config,
                  fallback_connector_type, fallback_provider
           FROM integrations
           WHERE tenant_id = $1 AND integration_type = $2 AND is_enabled = TRUE
           ORDER BY updated_at DESC
           LIMIT 1`,
          [tenantId, connectorType],
        );

    if (integRows.length === 0) {
      logger.warn('No enabled integration found', { tenantId, connectorType });
      return null;
    }

    const integration = integRows[0];
    const integrationId = integration.id as string;

    const { rows: configRows } = await client.query(
      `SELECT config_key, encrypted_value
       FROM connector_configs
       WHERE tenant_id = $1 AND integration_id = $2`,
      [tenantId, integrationId],
    );

    const credentials: Record<string, string> = {};
    let envelopeDecrypt: ((ciphertext: string) => Promise<string>) | null = null;
    try {
      const { decryptSensitiveField } = await import('../../security/FieldEncryption');
      envelopeDecrypt = (ciphertext: string) => decryptSensitiveField(tenantId, ciphertext);
    } catch {
      // Envelope decryption not available
    }

    for (const row of configRows) {
      const key = row.config_key as string;
      const val = row.encrypted_value as string | null;
      if (val) {
        try {
          if (isEnvelopeEncrypted(val) && envelopeDecrypt) {
            credentials[key] = await envelopeDecrypt(val);
          } else {
            credentials[key] = decryptValue(val);
          }
        } catch {
          logger.warn('Failed to decrypt connector config value', { tenantId, key });
          credentials[key] = val;
        }
      }
    }

    const staticConfig = typeof integration.config === 'object' && integration.config !== null
      ? (integration.config as Record<string, string>)
      : {};

    return {
      integrationId,
      tenantId,
      connectorType: integration.integration_type as ConnectorType,
      provider: integration.provider as string,
      isEnabled: integration.is_enabled as boolean,
      credentials: { ...staticConfig, ...credentials },
      fallbackConnectorType: (integration.fallback_connector_type as ConnectorType) ?? undefined,
      fallbackProvider: (integration.fallback_provider as string) ?? undefined,
    };
  });
}

export async function getConnectorById(
  tenantId: TenantId,
  integrationId: string,
): Promise<{ integrationId: string; connectorType: ConnectorType; provider: string; isEnabled: boolean; name: string } | null> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, integration_type, provider, is_enabled, name
       FROM integrations
       WHERE tenant_id = $1 AND id = $2
       LIMIT 1`,
      [tenantId, integrationId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      integrationId: r.id as string,
      connectorType: r.integration_type as ConnectorType,
      provider: r.provider as string,
      isEnabled: r.is_enabled as boolean,
      name: (r.name as string) ?? (r.provider as string),
    };
  });
}

export async function listConnectorConfigs(tenantId: TenantId): Promise<Array<{
  integrationId: string;
  connectorType: ConnectorType;
  provider: string;
  name: string;
  isEnabled: boolean;
  configKeys: string[];
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  lastSyncErrorAt: string | null;
  autoDisabledAt: string | null;
}>> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT i.id, i.integration_type, i.provider, i.name, i.is_enabled,
              i.last_sync_at, i.last_sync_status, i.last_sync_error, i.last_sync_error_at,
              i.auto_disabled_at,
              COALESCE(json_agg(cc.config_key) FILTER (WHERE cc.config_key IS NOT NULL), '[]') AS config_keys
       FROM integrations i
       LEFT JOIN connector_configs cc ON cc.integration_id = i.id AND cc.tenant_id = i.tenant_id
       WHERE i.tenant_id = $1
       GROUP BY i.id, i.integration_type, i.provider, i.name, i.is_enabled,
                i.last_sync_at, i.last_sync_status, i.last_sync_error, i.last_sync_error_at,
                i.auto_disabled_at
       ORDER BY i.created_at`,
      [tenantId],
    );

    return rows.map((r) => ({
      integrationId: r.id as string,
      connectorType: r.integration_type as ConnectorType,
      provider: r.provider as string,
      name: (r.name as string) ?? (r.provider as string),
      isEnabled: r.is_enabled as boolean,
      configKeys: r.config_keys as string[],
      lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at as string).toISOString() : null,
      lastSyncStatus: (r.last_sync_status as string) ?? null,
      lastSyncError: (r.last_sync_error as string) ?? null,
      lastSyncErrorAt: r.last_sync_error_at ? new Date(r.last_sync_error_at as string).toISOString() : null,
      autoDisabledAt: r.auto_disabled_at ? new Date(r.auto_disabled_at as string).toISOString() : null,
    }));
  });
}

export async function updateConnectorCredentials(
  tenantId: TenantId,
  integrationId: string,
  credentials: Record<string, string>,
): Promise<void> {
  if (Object.keys(credentials).length === 0) return;
  const { encryptValue } = await import('./crypto');
  let envelopeEncrypt: ((value: string) => Promise<string>) | null = null;
  try {
    const { encryptSensitiveField } = await import('../../security/FieldEncryption');
    envelopeEncrypt = (value: string) => encryptSensitiveField(tenantId, value);
  } catch {
    // fall back to connector crypto
  }

  await withTenant(tenantId, async (client) => {
    for (const [key, value] of Object.entries(credentials)) {
      let encrypted: string;
      if (envelopeEncrypt) {
        try {
          encrypted = await envelopeEncrypt(value);
        } catch {
          encrypted = encryptValue(value);
        }
      } else {
        encrypted = encryptValue(value);
      }
      await client.query(
        `INSERT INTO connector_configs (tenant_id, integration_id, config_key, encrypted_value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (integration_id, config_key)
         DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, updated_at = NOW()`,
        [tenantId, integrationId, key, encrypted],
      );
    }
  });
}

export interface MarkReconnectNeededOptions {
  /** Underlying error message that triggered the reconnect requirement. Surfaced in alerts. */
  errorMessage?: string | null;
  /** Provider id for the integration (e.g. 'hubspot'). Avoids an extra DB lookup in the alerter. */
  provider?: string;
  /** integration_type / connector type for the integration. Avoids an extra DB lookup in the alerter. */
  connectorType?: string;
  /**
   * When true (default), proactively dispatch an alert to tenant admins via
   * the in-app + email pipeline. Set false in tests / batch tools that just
   * want to flip the status flag.
   */
  notify?: boolean;
}

export async function markConnectorReconnectNeeded(
  tenantId: TenantId,
  integrationId: string,
  options: MarkReconnectNeededOptions = {},
): Promise<void> {
  let rowsAffected = 0;
  try {
    await withTenant(tenantId, async (client) => {
      // Stamp `last_sync_error_at` (COALESCE preserves earlier failure
      // timestamp) so the auto-disable scheduler can age this connector out.
      const result = await client.query(
        `UPDATE integrations
            SET last_sync_status = 'needs_reconnect',
                last_sync_at = NOW(),
                last_sync_error_at = COALESCE(last_sync_error_at, NOW()),
                last_sync_error = COALESCE($3, last_sync_error, 'Reconnect required: stored credentials are no longer valid'),
                updated_at = NOW()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, integrationId, options.errorMessage ?? null],
      );
      rowsAffected = (result as { rowCount?: number }).rowCount ?? 0;
    });
  } catch (err) {
    logger.warn('Failed to mark connector needs_reconnect', { tenantId, integrationId, error: String(err) });
    return;
  }

  if (rowsAffected === 0 || options.notify === false) return;

  // Fire-and-forget; dynamic import keeps notification deps out of db.ts.
  void (async () => {
    try {
      const { dispatchConnectorAuthAlert } = await import('./ConnectorAuthAlertScheduler');
      let provider = options.provider;
      let connectorType = options.connectorType;
      if (!provider || !connectorType) {
        const meta = await getConnectorById(tenantId, integrationId);
        if (meta) {
          provider = provider ?? meta.provider;
          connectorType = connectorType ?? meta.connectorType;
        }
      }
      if (!provider) return; // can't sensibly notify without a provider label
      await dispatchConnectorAuthAlert({
        tenantId,
        integrationId,
        provider,
        connectorType: connectorType ?? 'unknown',
        errorMessage: options.errorMessage ?? null,
        reason: 'needs_reconnect',
      });
    } catch (err) {
      logger.warn('Immediate reconnect alert dispatch failed', {
        tenantId,
        integrationId,
        error: String(err),
      });
    }
  })();
}

export interface SyncStatusUpdateResult {
  integrationId: string;
  provider: string;
  previousStatus: string | null;
  transitionedToError: boolean;
  /**
   * True when the integration just flipped from an error state (`error` or
   * `needs_reconnect`) back to `success`. Callers can use this to dispatch
   * an "all clear" recovery notification.
   */
  transitionedToRecovery: boolean;
  /**
   * Timestamp the integration first started failing (i.e. when it last
   * transitioned from a non-error state into the error state). Preserved
   * across consecutive failures so callers can compute outage duration.
   * Null when the integration is currently healthy.
   */
  firstFailedAt: string | null;
  /**
   * Duration of the outage that just ended, in milliseconds. Populated only
   * when `transitionedToRecovery` is true and the prior failure timestamp
   * was known.
   */
  outageDurationMs: number | null;
}

export async function updateConnectorSyncStatus(
  tenantId: TenantId,
  connectorType: ConnectorType,
  status: 'success' | 'error',
  provider?: string,
  errorMessage?: string | null,
): Promise<SyncStatusUpdateResult[]> {
  const truncatedError = errorMessage ? errorMessage.slice(0, 1000) : null;
  try {
    return await withTenant(tenantId, async (client) => {
      const { rows: priorRows } = provider
        ? await client.query(
            `SELECT id, provider, last_sync_status, last_sync_error_at
             FROM integrations
             WHERE tenant_id = $1 AND integration_type = $2 AND provider = $3 AND is_enabled = TRUE`,
            [tenantId, connectorType, provider],
          )
        : await client.query(
            `SELECT id, provider, last_sync_status, last_sync_error_at
             FROM integrations
             WHERE tenant_id = $1 AND integration_type = $2 AND is_enabled = TRUE`,
            [tenantId, connectorType],
          );

      if (status === 'success') {
        if (provider) {
          await client.query(
            `UPDATE integrations
             SET last_sync_at = NOW(), last_sync_status = $3,
                 last_sync_error = NULL, last_sync_error_at = NULL,
                 auth_alert_sent_at = NULL,
                 auto_disabled_at = NULL,
                 updated_at = NOW()
             WHERE tenant_id = $1 AND integration_type = $2 AND provider = $4 AND is_enabled = TRUE`,
            [tenantId, connectorType, status, provider],
          );
        } else {
          await client.query(
            `UPDATE integrations
             SET last_sync_at = NOW(), last_sync_status = $3,
                 last_sync_error = NULL, last_sync_error_at = NULL,
                 auth_alert_sent_at = NULL,
                 auto_disabled_at = NULL,
                 updated_at = NOW()
             WHERE tenant_id = $1 AND integration_type = $2 AND is_enabled = TRUE`,
            [tenantId, connectorType, status],
          );
        }
      } else {
        // Preserve the original failure timestamp across consecutive errors so
        // callers can compute outage duration. Only stamp NOW() on the first
        // transition into the error state.
        if (provider) {
          await client.query(
            `UPDATE integrations
             SET last_sync_at = NOW(), last_sync_status = $3,
                 last_sync_error = $5,
                 last_sync_error_at = CASE
                   WHEN last_sync_status = 'error' AND last_sync_error_at IS NOT NULL
                     THEN last_sync_error_at
                   ELSE NOW()
                 END,
                 updated_at = NOW()
             WHERE tenant_id = $1 AND integration_type = $2 AND provider = $4 AND is_enabled = TRUE`,
            [tenantId, connectorType, status, provider, truncatedError],
          );
        } else {
          await client.query(
            `UPDATE integrations
             SET last_sync_at = NOW(), last_sync_status = $3,
                 last_sync_error = $4,
                 last_sync_error_at = CASE
                   WHEN last_sync_status = 'error' AND last_sync_error_at IS NOT NULL
                     THEN last_sync_error_at
                   ELSE NOW()
                 END,
                 updated_at = NOW()
             WHERE tenant_id = $1 AND integration_type = $2 AND is_enabled = TRUE`,
            [tenantId, connectorType, status, truncatedError],
          );
        }
      }

      return priorRows.map((row) => {
        const previousStatus = (row.last_sync_status as string | null) ?? null;
        const priorFailedAt = row.last_sync_error_at
          ? new Date(row.last_sync_error_at as string).toISOString()
          : null;
        let firstFailedAt: string | null = null;
        if (status === 'error') {
          firstFailedAt = previousStatus === 'error' && priorFailedAt
            ? priorFailedAt
            : new Date().toISOString();
        }
        const wasErrored = previousStatus === 'error' || previousStatus === 'needs_reconnect';
        const transitionedToRecovery = status === 'success' && wasErrored;
        let outageDurationMs: number | null = null;
        if (transitionedToRecovery && priorFailedAt) {
          const ms = Date.now() - Date.parse(priorFailedAt);
          outageDurationMs = Number.isFinite(ms) && ms >= 0 ? ms : null;
        }
        return {
          integrationId: row.id as string,
          provider: row.provider as string,
          previousStatus,
          transitionedToError: status === 'error' && previousStatus !== 'error',
          transitionedToRecovery,
          firstFailedAt,
          outageDurationMs,
        };
      });
    });
  } catch (err) {
    logger.warn('Failed to update sync status', { tenantId, connectorType, error: String(err) });
    return [];
  }
}

export async function upsertConnector(
  tenantId: TenantId,
  params: {
    connectorType: ConnectorType;
    provider: string;
    name: string;
    credentials: Record<string, string>;
    credentialsToDelete?: string[];
    isEnabled?: boolean;
  },
): Promise<string> {
  const { encryptValue } = await import('./crypto');
  let envelopeEncrypt: ((value: string) => Promise<string>) | null = null;
  try {
    const { encryptSensitiveField } = await import('../../security/FieldEncryption');
    envelopeEncrypt = (value: string) => encryptSensitiveField(tenantId, value);
  } catch {
    // Envelope encryption not available, fall back to connector crypto
  }

  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO integrations (tenant_id, name, integration_type, provider, is_enabled)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, provider)
       DO UPDATE SET name = EXCLUDED.name, is_enabled = EXCLUDED.is_enabled,
                     last_sync_error = NULL, last_sync_error_at = NULL,
                     auth_alert_sent_at = NULL,
                     auto_disabled_at = NULL,
                     updated_at = NOW()
       RETURNING id`,
      [tenantId, params.name, params.connectorType, params.provider, params.isEnabled ?? true],
    );

    const integrationId = rows[0].id as string;

    for (const [key, value] of Object.entries(params.credentials)) {
      let encrypted: string;
      if (envelopeEncrypt) {
        try {
          encrypted = await envelopeEncrypt(value);
        } catch {
          encrypted = encryptValue(value);
        }
      } else {
        encrypted = encryptValue(value);
      }
      await client.query(
        `INSERT INTO connector_configs (tenant_id, integration_id, config_key, encrypted_value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (integration_id, config_key)
         DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, updated_at = NOW()`,
        [tenantId, integrationId, key, encrypted],
      );
    }

    if (params.credentialsToDelete && params.credentialsToDelete.length > 0) {
      const keysToDelete = params.credentialsToDelete.filter(
        (k) => typeof k === 'string' && k.length > 0 && !(k in params.credentials),
      );
      if (keysToDelete.length > 0) {
        await client.query(
          `DELETE FROM connector_configs
           WHERE tenant_id = $1 AND integration_id = $2 AND config_key = ANY($3::text[])`,
          [tenantId, integrationId, keysToDelete],
        );
      }
    }

    return integrationId;
  });
}

export async function listEnabledConnectorConfigs(
  tenantId: TenantId,
  connectorTypes?: ConnectorType[],
): Promise<ConnectorConfig[]> {
  return withTenant(tenantId, async (client) => {
    const { rows: integRows } = connectorTypes && connectorTypes.length > 0
      ? await client.query(
          `SELECT id, integration_type, provider, is_enabled, config,
                  fallback_connector_type, fallback_provider
           FROM integrations
           WHERE tenant_id = $1 AND is_enabled = TRUE AND integration_type = ANY($2::text[])`,
          [tenantId, connectorTypes],
        )
      : await client.query(
          `SELECT id, integration_type, provider, is_enabled, config,
                  fallback_connector_type, fallback_provider
           FROM integrations
           WHERE tenant_id = $1 AND is_enabled = TRUE`,
          [tenantId],
        );

    if (integRows.length === 0) return [];

    let envelopeDecrypt: ((ciphertext: string) => Promise<string>) | null = null;
    try {
      const { decryptSensitiveField } = await import('../../security/FieldEncryption');
      envelopeDecrypt = (ciphertext: string) => decryptSensitiveField(tenantId, ciphertext);
    } catch {
      // Envelope decryption not available
    }

    const integrationIds = integRows.map((r) => r.id as string);
    const { rows: configRows } = await client.query(
      `SELECT integration_id, config_key, encrypted_value
       FROM connector_configs
       WHERE tenant_id = $1 AND integration_id = ANY($2::uuid[])`,
      [tenantId, integrationIds],
    );

    const credentialsByIntegration = new Map<string, Record<string, string>>();
    for (const row of configRows) {
      const integrationId = row.integration_id as string;
      const key = row.config_key as string;
      const val = row.encrypted_value as string | null;
      if (!val) continue;
      let decrypted: string;
      try {
        if (isEnvelopeEncrypted(val) && envelopeDecrypt) {
          decrypted = await envelopeDecrypt(val);
        } else {
          decrypted = decryptValue(val);
        }
      } catch {
        logger.warn('Failed to decrypt connector config value', { tenantId, key });
        decrypted = val;
      }
      const existing = credentialsByIntegration.get(integrationId) ?? {};
      existing[key] = decrypted;
      credentialsByIntegration.set(integrationId, existing);
    }

    return integRows.map((integration) => {
      const integrationId = integration.id as string;
      const credentials = credentialsByIntegration.get(integrationId) ?? {};
      const staticConfig = typeof integration.config === 'object' && integration.config !== null
        ? (integration.config as Record<string, string>)
        : {};
      return {
        integrationId,
        tenantId,
        connectorType: integration.integration_type as ConnectorType,
        provider: integration.provider as string,
        isEnabled: integration.is_enabled as boolean,
        credentials: { ...staticConfig, ...credentials },
        fallbackConnectorType: (integration.fallback_connector_type as ConnectorType) ?? undefined,
        fallbackProvider: (integration.fallback_provider as string) ?? undefined,
      };
    });
  });
}

export async function listActiveConnectorsByType(tenantId: TenantId): Promise<Array<{
  integrationId: string;
  connectorType: ConnectorType;
  provider: string;
  isEnabled: boolean;
}>> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, integration_type, provider, is_enabled
       FROM integrations
       WHERE tenant_id = $1 AND is_enabled = TRUE
       ORDER BY created_at`,
      [tenantId],
    );

    return rows.map((r) => ({
      integrationId: r.id as string,
      connectorType: r.integration_type as ConnectorType,
      provider: r.provider as string,
      isEnabled: r.is_enabled as boolean,
    }));
  });
}

/**
 * List all enabled connector configs (across tenants) whose provider is in
 * the given set and which are not currently flagged as `needs_reconnect`.
 * Used by the proactive OAuth token refresh scheduler.
 *
 * NOTE: We cannot filter by `token_expires_at` in SQL because credentials are
 * stored encrypted in `connector_configs`. The caller is expected to inspect
 * the decrypted `token_expires_at` and decide whether to refresh.
 */
export async function listRefreshableConnectorConfigs(
  providers: string[],
): Promise<ConnectorConfig[]> {
  if (providers.length === 0) return [];

  const pool = getPlatformPool();
  const { rows: integRows } = await pool.query(
    `SELECT tenant_id, id, integration_type, provider, is_enabled, config,
            fallback_connector_type, fallback_provider
       FROM integrations
      WHERE is_enabled = TRUE
        AND provider = ANY($1::text[])
        AND COALESCE(last_sync_status, '') <> 'needs_reconnect'`,
    [providers],
  );

  if (integRows.length === 0) return [];

  const byTenant = new Map<string, Record<string, unknown>[]>();
  for (const row of integRows) {
    const tid = row.tenant_id as string;
    const arr = byTenant.get(tid) ?? [];
    arr.push(row);
    byTenant.set(tid, arr);
  }

  const results: ConnectorConfig[] = [];
  for (const [tenantId, integrations] of byTenant) {
    try {
      const tenantConfigs = await withTenant(tenantId, async (client) => {
        let envelopeDecrypt: ((ciphertext: string) => Promise<string>) | null = null;
        try {
          const { decryptSensitiveField } = await import('../../security/FieldEncryption');
          envelopeDecrypt = (ciphertext: string) => decryptSensitiveField(tenantId, ciphertext);
        } catch {
          // Envelope decryption not available
        }

        const integrationIds = integrations.map((i) => i.id as string);
        const { rows: configRows } = await client.query(
          `SELECT integration_id, config_key, encrypted_value
             FROM connector_configs
            WHERE tenant_id = $1 AND integration_id = ANY($2::uuid[])`,
          [tenantId, integrationIds],
        );

        const credsByIntegration = new Map<string, Record<string, string>>();
        for (const row of configRows) {
          const integrationId = row.integration_id as string;
          const key = row.config_key as string;
          const val = row.encrypted_value as string | null;
          if (!val) continue;
          let decrypted: string;
          try {
            if (isEnvelopeEncrypted(val) && envelopeDecrypt) {
              decrypted = await envelopeDecrypt(val);
            } else {
              decrypted = decryptValue(val);
            }
          } catch {
            logger.warn('Failed to decrypt connector config value', { tenantId, key });
            decrypted = val;
          }
          const existing = credsByIntegration.get(integrationId) ?? {};
          existing[key] = decrypted;
          credsByIntegration.set(integrationId, existing);
        }

        return integrations.map((integration) => {
          const integrationId = integration.id as string;
          const credentials = credsByIntegration.get(integrationId) ?? {};
          const staticConfig = typeof integration.config === 'object' && integration.config !== null
            ? (integration.config as Record<string, string>)
            : {};
          return {
            integrationId,
            tenantId: tenantId as TenantId,
            connectorType: integration.integration_type as ConnectorType,
            provider: integration.provider as string,
            isEnabled: integration.is_enabled as boolean,
            credentials: { ...staticConfig, ...credentials },
            fallbackConnectorType:
              (integration.fallback_connector_type as ConnectorType) ?? undefined,
            fallbackProvider: (integration.fallback_provider as string) ?? undefined,
          };
        });
      });
      results.push(...tenantConfigs);
    } catch (err) {
      logger.warn('Failed to load refreshable connector configs for tenant', {
        tenantId,
        error: String(err),
      });
    }
  }

  return results;
}

/**
 * Resolve the scheduling provider chosen for a particular agent or phone
 * number. Phone-number selection wins over agent selection when both are
 * present, so a single inbound number can override the agent default. Returns
 * null when neither target carries an explicit preference (the legacy
 * "broadcast to every enabled scheduling integration" behaviour).
 */
export async function getPreferredSchedulingProvider(
  tenantId: TenantId,
  context: { agentId?: string | null; phoneNumberId?: string | null },
): Promise<string | null> {
  const agentId = context.agentId ?? null;
  const phoneNumberId = context.phoneNumberId ?? null;
  if (!agentId && !phoneNumberId) return null;

  try {
    return await withTenant(tenantId, async (client) => {
      if (phoneNumberId) {
        const { rows } = await client.query(
          `SELECT scheduling_provider FROM phone_numbers
           WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
          [tenantId, phoneNumberId],
        );
        const value = rows[0]?.scheduling_provider as string | null | undefined;
        if (value) return value;
      }
      if (agentId) {
        const { rows } = await client.query(
          `SELECT scheduling_provider FROM agents
           WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
          [tenantId, agentId],
        );
        const value = rows[0]?.scheduling_provider as string | null | undefined;
        if (value) return value;
      }
      return null;
    });
  } catch (err) {
    logger.warn('Failed to resolve preferred scheduling provider', {
      tenantId,
      agentId,
      phoneNumberId,
      error: String(err),
    });
    return null;
  }
}

export async function deleteConnector(tenantId: TenantId, integrationId: string): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(
      `DELETE FROM integrations WHERE tenant_id = $1 AND id = $2`,
      [tenantId, integrationId],
    );
  });
}
