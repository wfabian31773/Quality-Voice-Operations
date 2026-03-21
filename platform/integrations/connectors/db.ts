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
): Promise<ConnectorConfig | null> {
  return withTenant(tenantId, async (client) => {
    const { rows: integRows } = await client.query(
      `SELECT id, integration_type, provider, is_enabled, config,
              fallback_connector_type, fallback_provider
       FROM integrations
       WHERE tenant_id = $1 AND integration_type = $2 AND is_enabled = TRUE
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
}>> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT i.id, i.integration_type, i.provider, i.name, i.is_enabled,
              i.last_sync_at, i.last_sync_status,
              COALESCE(json_agg(cc.config_key) FILTER (WHERE cc.config_key IS NOT NULL), '[]') AS config_keys
       FROM integrations i
       LEFT JOIN connector_configs cc ON cc.integration_id = i.id AND cc.tenant_id = i.tenant_id
       WHERE i.tenant_id = $1
       GROUP BY i.id, i.integration_type, i.provider, i.name, i.is_enabled, i.last_sync_at, i.last_sync_status
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
    }));
  });
}

export async function updateConnectorSyncStatus(
  tenantId: TenantId,
  connectorType: ConnectorType,
  status: 'success' | 'error',
): Promise<void> {
  try {
    await withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE integrations SET last_sync_at = NOW(), last_sync_status = $3, updated_at = NOW()
         WHERE tenant_id = $1 AND integration_type = $2 AND is_enabled = TRUE`,
        [tenantId, connectorType, status],
      );
    });
  } catch (err) {
    logger.warn('Failed to update sync status', { tenantId, connectorType, error: String(err) });
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
       DO UPDATE SET name = EXCLUDED.name, is_enabled = EXCLUDED.is_enabled, updated_at = NOW()
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
