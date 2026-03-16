import crypto from 'crypto';
import { getPlatformPool } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('WIDGET_TOKEN');

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface WidgetToken {
  id: string;
  tenant_id: string;
  token_hash: string;
  label: string;
  revoked_at: string | null;
  created_at: string;
}

export interface WidgetConfig {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  enabled: boolean;
  greeting: string;
  lead_capture_fields: string[];
  primary_color: string;
  allowed_domains: string[];
  text_chat_enabled: boolean;
  voice_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export async function generateWidgetToken(
  tenantId: string,
  label: string = 'Default',
): Promise<{ token: WidgetToken; plaintextToken: string }> {
  const plaintext = `wt_${crypto.randomBytes(32).toString('hex')}`;
  const hash = hashToken(plaintext);
  const pool = getPlatformPool();

  const { rows } = await pool.query(
    `INSERT INTO widget_tokens (tenant_id, token_hash, label)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [tenantId, hash, label],
  );

  logger.info('Widget token generated', { tenantId, tokenId: rows[0].id });
  return { token: rows[0] as WidgetToken, plaintextToken: plaintext };
}

export async function validateWidgetToken(
  plaintext: string,
): Promise<{ tenantId: string; tokenId: string } | null> {
  const hash = hashToken(plaintext);
  const pool = getPlatformPool();

  const { rows } = await pool.query(
    `SELECT id, tenant_id FROM widget_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hash],
  );

  if (rows.length === 0) return null;
  return { tenantId: rows[0].tenant_id as string, tokenId: rows[0].id as string };
}

export async function listWidgetTokens(tenantId: string): Promise<WidgetToken[]> {
  const pool = getPlatformPool();
  const { rows } = await pool.query(
    `SELECT id, tenant_id, label, revoked_at, created_at
     FROM widget_tokens
     WHERE tenant_id = $1
     ORDER BY created_at DESC`,
    [tenantId],
  );
  return rows as WidgetToken[];
}

export async function revokeWidgetToken(tenantId: string, tokenId: string): Promise<boolean> {
  const pool = getPlatformPool();
  const { rowCount } = await pool.query(
    `UPDATE widget_tokens SET revoked_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
    [tokenId, tenantId],
  );
  if (rowCount && rowCount > 0) {
    logger.info('Widget token revoked', { tenantId, tokenId });
    return true;
  }
  return false;
}

export async function getWidgetConfig(tenantId: string): Promise<WidgetConfig | null> {
  const pool = getPlatformPool();
  const { rows } = await pool.query(
    `SELECT * FROM widget_configs WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows.length > 0 ? (rows[0] as WidgetConfig) : null;
}

export async function upsertWidgetConfig(
  tenantId: string,
  config: Partial<Omit<WidgetConfig, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>>,
): Promise<WidgetConfig> {
  const pool = getPlatformPool();

  const fields: string[] = [];
  const values: unknown[] = [tenantId];
  const updateParts: string[] = ['updated_at = NOW()'];

  if (config.agent_id !== undefined) {
    values.push(config.agent_id);
    fields.push('agent_id');
    updateParts.push(`agent_id = $${values.length}`);
  }
  if (config.enabled !== undefined) {
    values.push(config.enabled);
    fields.push('enabled');
    updateParts.push(`enabled = $${values.length}`);
  }
  if (config.greeting !== undefined) {
    values.push(config.greeting);
    fields.push('greeting');
    updateParts.push(`greeting = $${values.length}`);
  }
  if (config.lead_capture_fields !== undefined) {
    values.push(JSON.stringify(config.lead_capture_fields));
    fields.push('lead_capture_fields');
    updateParts.push(`lead_capture_fields = $${values.length}`);
  }
  if (config.primary_color !== undefined) {
    values.push(config.primary_color);
    fields.push('primary_color');
    updateParts.push(`primary_color = $${values.length}`);
  }
  if (config.allowed_domains !== undefined) {
    values.push(config.allowed_domains);
    fields.push('allowed_domains');
    updateParts.push(`allowed_domains = $${values.length}`);
  }
  if (config.text_chat_enabled !== undefined) {
    values.push(config.text_chat_enabled);
    fields.push('text_chat_enabled');
    updateParts.push(`text_chat_enabled = $${values.length}`);
  }
  if (config.voice_enabled !== undefined) {
    values.push(config.voice_enabled);
    fields.push('voice_enabled');
    updateParts.push(`voice_enabled = $${values.length}`);
  }

  const insertCols = ['tenant_id', ...fields];
  const insertVals = values.map((_, i) => `$${i + 1}`);
  const conflictUpdate = updateParts.join(', ');

  const { rows } = await pool.query(
    `INSERT INTO widget_configs (${insertCols.join(', ')})
     VALUES (${insertVals.join(', ')})
     ON CONFLICT (tenant_id) DO UPDATE SET ${conflictUpdate}
     RETURNING *`,
    values,
  );

  return rows[0] as WidgetConfig;
}

export async function getPublicWidgetConfig(tenantId: string): Promise<{
  enabled: boolean;
  greeting: string;
  leadCaptureFields: string[];
  primaryColor: string;
  textChatEnabled: boolean;
  voiceEnabled: boolean;
  tenantName: string;
  agentId: string | null;
} | null> {
  const pool = getPlatformPool();

  const { rows } = await pool.query(
    `SELECT wc.*, t.name as tenant_name
     FROM widget_configs wc
     JOIN tenants t ON t.id = wc.tenant_id
     WHERE wc.tenant_id = $1 AND wc.enabled = true`,
    [tenantId],
  );

  if (rows.length === 0) return null;

  const row = rows[0] as WidgetConfig & { tenant_name: string };
  return {
    enabled: row.enabled,
    greeting: row.greeting,
    leadCaptureFields: row.lead_capture_fields,
    primaryColor: row.primary_color,
    textChatEnabled: row.text_chat_enabled,
    voiceEnabled: row.voice_enabled,
    tenantName: row.tenant_name,
    agentId: row.agent_id,
  };
}
