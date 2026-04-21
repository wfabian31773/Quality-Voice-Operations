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
}>> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT i.id, i.integration_type, i.provider, i.name, i.is_enabled,
              i.last_sync_at, i.last_sync_status, i.last_sync_error, i.last_sync_error_at,
              COALESCE(json_agg(cc.config_key) FILTER (WHERE cc.config_key IS NOT NULL), '[]') AS config_keys
       FROM integrations i
       LEFT JOIN connector_configs cc ON cc.integration_id = i.id AND cc.tenant_id = i.tenant_id
       WHERE i.tenant_id = $1
       GROUP BY i.id, i.integration_type, i.provider, i.name, i.is_enabled,
                i.last_sync_at, i.last_sync_status, i.last_sync_error, i.last_sync_error_at
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

export async function markConnectorReconnectNeeded(
  tenantId: TenantId,
  integrationId: string,
): Promise<void> {
  try {
    await withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE integrations
            SET last_sync_status = 'needs_reconnect',
                last_sync_at = NOW(),
                updated_at = NOW()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, integrationId],
      );
    });
  } catch (err) {
    logger.warn('Failed to mark connector needs_reconnect', { tenantId, integrationId, error: String(err) });
  }
}

export interface SyncStatusUpdateResult {
  integrationId: string;
  provider: string;
  previousStatus: string | null;
  transitionedToError: boolean;
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
            `SELECT id, provider, last_sync_status
             FROM integrations
             WHERE tenant_id = $1 AND integration_type = $2 AND provider = $3 AND is_enabled = TRUE`,
            [tenantId, connectorType, provider],
          )
        : await client.query(
            `SELECT id, provider, last_sync_status
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
                 updated_at = NOW()
             WHERE tenant_id = $1 AND integration_type = $2 AND provider = $4 AND is_enabled = TRUE`,
            [tenantId, connectorType, status, provider],
          );
        } else {
          await client.query(
            `UPDATE integrations
             SET last_sync_at = NOW(), last_sync_status = $3,
                 last_sync_error = NULL, last_sync_error_at = NULL,
                 updated_at = NOW()
             WHERE tenant_id = $1 AND integration_type = $2 AND is_enabled = TRUE`,
            [tenantId, connectorType, status],
          );
        }
      } else {
        if (provider) {
          await client.query(
            `UPDATE integrations
             SET last_sync_at = NOW(), last_sync_status = $3,
                 last_sync_error = $5, last_sync_error_at = NOW(),
                 updated_at = NOW()
             WHERE tenant_id = $1 AND integration_type = $2 AND provider = $4 AND is_enabled = TRUE`,
            [tenantId, connectorType, status, provider, truncatedError],
          );
        } else {
          await client.query(
            `UPDATE integrations
             SET last_sync_at = NOW(), last_sync_status = $3,
                 last_sync_error = $4, last_sync_error_at = NOW(),
                 updated_at = NOW()
             WHERE tenant_id = $1 AND integration_type = $2 AND is_enabled = TRUE`,
            [tenantId, connectorType, status, truncatedError],
          );
        }
      }

      return priorRows.map((row) => {
        const previousStatus = (row.last_sync_status as string | null) ?? null;
        return {
          integrationId: row.id as string,
          provider: row.provider as string,
          previousStatus,
          transitionedToError: status === 'error' && previousStatus === 'success',
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

export async function deleteConnector(tenantId: TenantId, integrationId: string): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(
      `DELETE FROM integrations WHERE tenant_id = $1 AND id = $2`,
      [tenantId, integrationId],
    );
  });
}
