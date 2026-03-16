import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import { normalizePhone } from '../core/types';
import type { ToolDefinition, ToolContext } from './registry/types';

const logger = createLogger('TOOL_UPDATE_CRM');

interface DbClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
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

export interface UpdateCrmRecordInput {
  phoneNumber: string;
  notes?: string;
  tags?: string[];
  name?: string;
  preferredContactMethod?: string;
  customFields?: Record<string, unknown>;
}

async function handler(input: unknown, context: ToolContext): Promise<unknown> {
  const { tenantId, callLogId } = context;
  const args = input as UpdateCrmRecordInput;

  if (!args.phoneNumber) {
    return { success: false, message: 'phoneNumber is required.' };
  }

  const normalized = normalizePhone(args.phoneNumber);

  try {
    return await withTenant(tenantId, async (client) => {
      let updated = false;

      if (args.name) {
        const { rowCount } = await client.query(
          `UPDATE campaign_contacts
           SET name = $3, updated_at = NOW()
           WHERE tenant_id = $1 AND phone_number = $2`,
          [tenantId, normalized, args.name],
        );
        if ((rowCount ?? 0) > 0) updated = true;
      }

      if (args.notes || args.tags || args.preferredContactMethod || args.customFields) {
        const contextUpdate: Record<string, unknown> = {};
        if (args.notes) contextUpdate.agentNotes = args.notes;
        if (args.tags) contextUpdate.tags = args.tags;
        if (args.preferredContactMethod) contextUpdate.preferredContactMethod = args.preferredContactMethod;
        if (args.customFields) contextUpdate.customFields = args.customFields;

        if (callLogId) {
          const { rowCount } = await client.query(
            `UPDATE call_sessions
             SET context = COALESCE(context, '{}'::jsonb) || $3::jsonb,
                 updated_at = NOW()
             WHERE tenant_id = $1 AND id = $2`,
            [tenantId, callLogId, JSON.stringify(contextUpdate)],
          );
          if ((rowCount ?? 0) > 0) updated = true;
        }

        const { rowCount: ccUpdated } = await client.query(
          `UPDATE campaign_contacts
           SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
               updated_at = NOW()
           WHERE tenant_id = $1 AND phone_number = $2`,
          [tenantId, normalized, JSON.stringify(contextUpdate)],
        );
        if ((ccUpdated ?? 0) > 0) updated = true;
      }

      logger.info('CRM record updated', { tenantId, phone: `***${normalized.slice(-4)}`, updated });
      return {
        success: true,
        updated,
        message: updated
          ? 'Customer record has been updated.'
          : 'No existing customer records found for this phone number. The update could not be applied.',
      };
    });
  } catch (err) {
    logger.error('update_crm_record failed', { tenantId, error: String(err) });
    return { success: false, message: 'Failed to update customer record. Please try again.' };
  }
}

export const updateCrmRecordTool: ToolDefinition = {
  name: 'update_crm_record',
  description: 'Update a customer record with new notes, tags, contact preferences, or custom fields after a call.',
  inputSchema: {
    type: 'object',
    properties: {
      phoneNumber: {
        type: 'string',
        description: 'The customer phone number to update records for.',
      },
      notes: {
        type: 'string',
        description: 'Free-text notes to attach to the customer record.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags to add to the customer record (e.g. ["VIP", "follow-up"]).',
      },
      name: {
        type: 'string',
        description: 'Update the customer name on file.',
      },
      preferredContactMethod: {
        type: 'string',
        enum: ['phone', 'email', 'sms', 'mail'],
        description: 'The customer\'s preferred contact method.',
      },
      customFields: {
        type: 'object',
        description: 'Additional custom key-value fields to store.',
      },
    },
    required: ['phoneNumber'],
    additionalProperties: false,
  },
  handler,
};
