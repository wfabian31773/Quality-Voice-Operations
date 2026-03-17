import { randomUUID } from 'crypto';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import type { CallPersistenceAdapter } from '../../../platform/runtime/lifecycle/CallLifecycleCoordinator';
import { recordConversionStage } from '../../../platform/analytics/ConversionFunnelService';
import { encryptTranscript, encryptSensitiveField, decryptSensitiveField } from '../../../platform/security/FieldEncryption';

const logger = createLogger('CALL_PERSISTENCE');

type LifecycleState =
  | 'CALL_RECEIVED'
  | 'SESSION_INITIALIZED'
  | 'AGENT_CONNECTED'
  | 'ACTIVE_CONVERSATION'
  | 'WORKFLOW_EXECUTION'
  | 'TOOL_EXECUTION'
  | 'ESCALATION_CHECK'
  | 'ESCALATED'
  | 'CALL_COMPLETED'
  | 'CALL_FAILED'
  | 'WORKFLOW_FAILED'
  | 'ESCALATION_FAILED'
  | 'HANDOFF';

export interface CreateCallSessionParams {
  tenantId: string;
  agentId: string;
  callSid: string;
  direction: 'inbound' | 'outbound';
  callerNumber: string;
  calledNumber: string;
  environment?: string;
}

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

export async function createCallSession(
  params: CreateCallSessionParams,
): Promise<string> {
  const id = randomUUID();
  const sessionId = `session-${id}`;

  const encryptedCallerNumber = params.callerNumber
    ? await encryptSensitiveField(params.tenantId, params.callerNumber)
    : null;

  await withTenant(params.tenantId, async (client) => {
    await client.query(
      `INSERT INTO call_sessions
         (id, tenant_id, agent_id, call_sid, session_id, direction,
          caller_number, called_number, lifecycle_state, start_time, environment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10)`,
      [
        id,
        params.tenantId,
        params.agentId,
        params.callSid,
        sessionId,
        params.direction,
        encryptedCallerNumber,
        params.calledNumber,
        'CALL_RECEIVED' as LifecycleState,
        params.environment ?? process.env.APP_ENV ?? 'development',
      ],
    );
  });

  logger.info('Call session created', {
    callId: id,
    tenantId: params.tenantId,
    agentId: params.agentId,
  });

  recordConversionStage(params.tenantId, id, 'call_received', {
    direction: params.direction,
    agentId: params.agentId,
  }).catch((err) => {
    logger.error('Failed to record call_received conversion stage', { error: String(err) });
  });

  return id;
}

export async function writeCallEvent(
  tenantId: string,
  callSessionId: string,
  eventType: string,
  fromState: LifecycleState | null,
  toState: LifecycleState | null,
  payload?: Record<string, unknown>,
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO call_events (id, tenant_id, call_session_id, event_type, from_state, to_state, payload, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [randomUUID(), tenantId, callSessionId, eventType, fromState, toState, JSON.stringify(payload ?? {})],
    );
  });
}

export async function updateCallState(
  tenantId: string,
  callSessionId: string,
  newState: LifecycleState,
  extra?: Partial<{
    escalationTarget: string;
    escalationReason: string;
    workflowId: string;
    context: Record<string, unknown>;
    agentId: string;
  }>,
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    const sets = ['lifecycle_state = $3', 'updated_at = NOW()'];
    const values: unknown[] = [tenantId, callSessionId, newState];
    let idx = 4;

    if (extra?.escalationTarget) {
      sets.push(`escalation_target = $${idx++}`);
      values.push(extra.escalationTarget);
    }
    if (extra?.escalationReason) {
      sets.push(`escalation_reason = $${idx++}`);
      values.push(extra.escalationReason);
    }
    if (extra?.workflowId) {
      sets.push(`workflow_id = $${idx++}`);
      values.push(extra.workflowId);
    }
    if (extra?.context) {
      sets.push(`context = $${idx++}`);
      values.push(JSON.stringify(extra.context));
    }
    if (extra?.agentId) {
      sets.push(`agent_id = $${idx++}`);
      values.push(extra.agentId);
    }

    await client.query(
      `UPDATE call_sessions SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2`,
      values,
    );

    if (newState === 'ESCALATED') {
      try {
        const { rows: existingTickets } = await client.query(
          `SELECT id FROM tickets WHERE tenant_id = $1 AND call_id = $2 LIMIT 1`,
          [tenantId, callSessionId],
        );
        if (existingTickets.length === 0) {
          const reason = extra?.escalationReason || 'Call escalated';
          await client.query(
            `INSERT INTO tickets (id, tenant_id, call_id, subject, description, status, priority)
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'open', 'high')`,
            [tenantId, callSessionId, `Escalated call: ${reason}`, `Auto-created from escalated call ${callSessionId}. Reason: ${reason}`],
          );
          logger.info('Auto-created ticket for escalated call', { tenantId, callSessionId });
        }
      } catch (ticketErr) {
        logger.error('Failed to auto-create ticket for escalated call', { tenantId, callSessionId, error: String(ticketErr) });
      }
    }
  });
}

export async function finalizeCallSession(
  tenantId: string,
  callSessionId: string,
  status: string,
  durationSeconds?: number,
  totalCostCents?: number,
): Promise<void> {
  const finalState: LifecycleState = status === 'failed' ? 'CALL_FAILED' : 'CALL_COMPLETED';

  await withTenant(tenantId, async (client) => {
    await client.query(
      `UPDATE call_sessions SET
         lifecycle_state = $3,
         end_time = NOW(),
         duration_seconds = $4,
         total_cost_cents = $5,
         updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, callSessionId, finalState, durationSeconds ?? null, totalCostCents ?? null],
    );
  });
}

export function createPlatformPersistenceAdapter(tenantId: string): CallPersistenceAdapter {
  return {
    async updateTranscript(_tid: string, callLogId: string, transcript: string): Promise<void> {
      const encryptedTranscript = await encryptTranscript(tenantId, transcript);
      await withTenant(tenantId, async (client) => {
        await client.query(
          `UPDATE call_sessions SET context = jsonb_set(COALESCE(context, '{}'), '{transcript}', to_jsonb($3::text)), updated_at = NOW()
           WHERE tenant_id = $1 AND id = $2`,
          [tenantId, callLogId, encryptedTranscript],
        );
      });
    },

    async finalizeCall(_tid: string, callLogId: string, status: string, endTime: Date): Promise<boolean> {
      await withTenant(tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT start_time FROM call_sessions WHERE tenant_id = $1 AND id = $2`,
          [tenantId, callLogId],
        );
        const rawStartTime = rows[0]?.start_time;
        const startTime = rawStartTime ? new Date(rawStartTime as string) : null;
        const durationSecs = startTime ? Math.round((endTime.getTime() - startTime.getTime()) / 1000) : undefined;
        const finalState: LifecycleState = status === 'failed' ? 'CALL_FAILED' : 'CALL_COMPLETED';
        await client.query(
          `UPDATE call_sessions SET
             lifecycle_state = $3,
             end_time = $4,
             duration_seconds = $5,
             updated_at = NOW()
           WHERE tenant_id = $1 AND id = $2`,
          [tenantId, callLogId, finalState, endTime, durationSecs ?? null],
        );
      });
      return true;
    },

    async findCallByTwilioSid(_tid: string, twilioCallSid: string) {
      return withTenant(tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT id AS "callLogId", lifecycle_state AS state, created_at AS "createdAt"
           FROM call_sessions WHERE tenant_id = $1 AND call_sid = $2 LIMIT 1`,
          [tenantId, twilioCallSid],
        );
        if (!rows[0]) return null;
        return rows[0] as unknown as { callLogId: string; state?: string; createdAt?: Date };
      });
    },

    async findCallByConferenceSid(_tid: string, conferenceSid: string) {
      return withTenant(tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT id AS "callLogId", lifecycle_state AS state, created_at AS "createdAt"
           FROM call_sessions WHERE tenant_id = $1 AND context->>'conferenceSid' = $2 LIMIT 1`,
          [tenantId, conferenceSid],
        );
        if (!rows[0]) return null;
        return rows[0] as unknown as { callLogId: string; state?: string; createdAt?: Date };
      });
    },
  };
}
