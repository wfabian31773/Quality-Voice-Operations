import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import type { ToolDefinition, ToolContext } from './registry/types';

const logger = createLogger('TOOL_CALL_OUTCOME');

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

export type CallDisposition = 'resolved' | 'follow_up_needed' | 'escalated' | 'voicemail' | 'no_answer' | 'callback_requested';

export interface RecordCallOutcomeInput {
  disposition: CallDisposition;
  notes?: string;
  followUpRequired?: boolean;
  followUpDate?: string;
  summary?: string;
  tags?: string[];
}

async function handler(input: unknown, context: ToolContext): Promise<unknown> {
  const { tenantId, callLogId, callSid } = context;
  const args = input as RecordCallOutcomeInput;

  if (!args.disposition) {
    return { success: false, message: 'disposition is required.' };
  }

  if (!callLogId) {
    return { success: false, message: 'No active call session to record outcome for.' };
  }

  try {
    return await withTenant(tenantId, async (client) => {
      const outcomeData: Record<string, unknown> = {
        disposition: args.disposition,
        notes: args.notes ?? null,
        followUpRequired: args.followUpRequired ?? (args.disposition === 'follow_up_needed' || args.disposition === 'callback_requested'),
        followUpDate: args.followUpDate ?? null,
        summary: args.summary ?? null,
        tags: args.tags ?? [],
        recordedAt: new Date().toISOString(),
      };

      const { rowCount } = await client.query(
        `UPDATE call_sessions
         SET context = COALESCE(context, '{}'::jsonb) || jsonb_build_object('callOutcome', $3::jsonb),
             updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, callLogId, JSON.stringify(outcomeData)],
      );

      if ((rowCount ?? 0) === 0) {
        return { success: false, message: 'Call session not found. Cannot record outcome.' };
      }

      await client.query(
        `INSERT INTO call_events (id, tenant_id, call_session_id, event_type, from_state, to_state, payload, occurred_at)
         VALUES (gen_random_uuid(), $1, $2, 'call_outcome_recorded', NULL, NULL, $3, NOW())`,
        [tenantId, callLogId, JSON.stringify(outcomeData)],
      );

      logger.info('Call outcome recorded', {
        tenantId,
        callLogId,
        callSid,
        disposition: args.disposition,
      });

      return {
        success: true,
        message: `Call outcome recorded as "${args.disposition}".`,
        outcome: outcomeData,
      };
    });
  } catch (err) {
    logger.error('record_call_outcome failed', { tenantId, error: String(err) });
    return { success: false, message: 'Failed to record call outcome. Please try again.' };
  }
}

export const recordCallOutcomeTool: ToolDefinition = {
  name: 'record_call_outcome',
  description: 'Record the structured outcome of a call including disposition, notes, and follow-up requirements.',
  inputSchema: {
    type: 'object',
    properties: {
      disposition: {
        type: 'string',
        enum: ['resolved', 'follow_up_needed', 'escalated', 'voicemail', 'no_answer', 'callback_requested'],
        description: 'The call disposition/outcome category.',
      },
      notes: {
        type: 'string',
        description: 'Free-text notes about the call outcome.',
      },
      followUpRequired: {
        type: 'boolean',
        description: 'Whether a follow-up action is needed.',
      },
      followUpDate: {
        type: 'string',
        description: 'ISO date for when follow-up should occur (e.g. "2025-01-15").',
      },
      summary: {
        type: 'string',
        description: 'Brief summary of what was discussed or resolved on the call.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags to categorize this call outcome.',
      },
    },
    required: ['disposition'],
    additionalProperties: false,
  },
  handler,
};
