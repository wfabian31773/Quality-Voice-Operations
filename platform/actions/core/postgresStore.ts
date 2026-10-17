import { randomUUID } from 'node:crypto';
import type { ActionContext, ActionResult, TenantTx } from './types';
import type {
  ActionStore,
  AuditRecord,
  BeginIdempotencyResult,
  ConsumeProposalInput,
  CreateProposalInput,
  ProposalRecord,
} from './store';

function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  return new Date(String(value));
}

function mapProposal(row: Record<string, unknown>): ProposalRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    action: String(row.action),
    callId: (row.call_id as string | null) ?? null,
    payloadHash: String(row.payload_hash),
    payload: row.payload,
    readback: String(row.readback),
    expiresAt: asDate(row.expires_at),
    consumedAt: row.consumed_at ? asDate(row.consumed_at) : null,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export const postgresActionStore: ActionStore = {
  async beginIdempotency(tx, input): Promise<BeginIdempotencyResult> {
    const insertSql = `
      INSERT INTO action_idempotency
        (tenant_id, action, key, request_hash, status, expires_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'in_progress', $5, $6, $6)
      ON CONFLICT (tenant_id, action, key) DO NOTHING
      RETURNING tenant_id
    `;
    const insertValues = [
      input.tenantId,
      input.action,
      input.key,
      input.requestHash,
      input.expiresAt.toISOString(),
      input.now.toISOString(),
    ];

    try {
      const inserted = await tx.query(insertSql, insertValues);
      if ((inserted.rowCount ?? inserted.rows.length) > 0) return { kind: 'new' };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }

    const locked = await tx.query(
      `SELECT request_hash, status, response, expires_at
         FROM action_idempotency
        WHERE tenant_id = $1 AND action = $2 AND key = $3
        FOR UPDATE`,
      [input.tenantId, input.action, input.key],
    );
    const row = locked.rows[0];
    if (!row) {
      await tx.query(insertSql, insertValues);
      return { kind: 'new' };
    }

    const expiresAt = asDate(row.expires_at);
    if (expiresAt.getTime() <= input.now.getTime()) {
      await tx.query(
        `UPDATE action_idempotency
            SET request_hash = $4,
                status = 'in_progress',
                response = NULL,
                expires_at = $5,
                updated_at = $6
          WHERE tenant_id = $1 AND action = $2 AND key = $3`,
        [
          input.tenantId,
          input.action,
          input.key,
          input.requestHash,
          input.expiresAt.toISOString(),
          input.now.toISOString(),
        ],
      );
      return { kind: 'new' };
    }

    if (String(row.request_hash) !== input.requestHash) return { kind: 'reused' };

    if (row.status === 'completed' && row.response) {
      return { kind: 'replay', response: row.response as ActionResult };
    }

    await tx.query(
      `UPDATE action_idempotency
          SET request_hash = $4,
              status = 'in_progress',
              response = NULL,
              expires_at = $5,
              updated_at = $6
        WHERE tenant_id = $1 AND action = $2 AND key = $3`,
      [
        input.tenantId,
        input.action,
        input.key,
        input.requestHash,
        input.expiresAt.toISOString(),
        input.now.toISOString(),
      ],
    );
    return { kind: 'new' };
  },

  async completeIdempotency(tx, input): Promise<void> {
    await tx.query(
      `UPDATE action_idempotency
          SET status = 'completed',
              response = $4::jsonb,
              updated_at = $5
        WHERE tenant_id = $1 AND action = $2 AND key = $3`,
      [
        input.tenantId,
        input.action,
        input.key,
        JSON.stringify(input.response),
        input.now.toISOString(),
      ],
    );
  },

  async createProposal(tx, ctx, input): Promise<ProposalRecord> {
    const id = randomUUID();
    const result = await tx.query(
      `INSERT INTO action_proposals
         (id, tenant_id, action, call_id, payload_hash, payload, readback, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING id, tenant_id, action, call_id, payload_hash, payload, readback, expires_at, consumed_at`,
      [
        id,
        ctx.tenantId,
        input.action,
        input.callId ?? null,
        input.payloadHash,
        JSON.stringify(input.payload),
        input.readback,
        input.expiresAt.toISOString(),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('action_proposals insert returned no row');
    return mapProposal(row);
  },

  async consumeProposal(tx, ctx, input) {
    const updated = await tx.query(
      `UPDATE action_proposals
          SET consumed_at = $6
        WHERE id = $1
          AND tenant_id = $2
          AND action = $3
          AND call_id IS NOT DISTINCT FROM $4
          AND payload_hash = $5
          AND consumed_at IS NULL
          AND expires_at > $6
        RETURNING id, tenant_id, action, call_id, payload_hash, payload, readback, expires_at, consumed_at`,
      [
        input.confirmationToken,
        ctx.tenantId,
        input.action,
        input.callId ?? null,
        input.payloadHash,
        ctx.now.toISOString(),
      ],
    );
    const consumed = updated.rows[0];
    if (consumed) return mapProposal(consumed);
    return null;
  },

  async inspectProposal(tx, ctx, id) {
    const result = await tx.query(
      `SELECT id, tenant_id, action, call_id, payload_hash, payload, readback, expires_at, consumed_at
         FROM action_proposals
        WHERE id = $1 AND tenant_id = $2`,
      [id, ctx.tenantId],
    );
    const row = result.rows[0];
    return row ? mapProposal(row) : null;
  },

  async insertAudit(tx, record: AuditRecord): Promise<void> {
    await tx.query(
      `INSERT INTO action_audit_log
         (tenant_id, action, actor, input_redacted, result_code, latency_ms, call_id, created_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, NOW())`,
      [
        record.tenantId,
        record.action,
        JSON.stringify(record.actor),
        JSON.stringify(record.inputRedacted),
        record.resultCode,
        record.latencyMs,
        record.callId ?? null,
      ],
    );
  },
};
