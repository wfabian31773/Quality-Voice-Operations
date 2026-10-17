import { randomUUID } from 'node:crypto';
import type { ActionContext, ActionResult, TenantTx } from './types';
import type {
  ActionStore,
  AuditRecord,
  BeginIdempotencyResult,
  IdempotencyRecord,
  ProposalRecord,
} from './store';

function idempKey(tenantId: string, action: string, key: string): string {
  return `${tenantId}\0${action}\0${key}`;
}

function cloneResult(result: ActionResult): ActionResult {
  return JSON.parse(JSON.stringify(result)) as ActionResult;
}

export interface MemoryActionStore extends ActionStore {
  audits: AuditRecord[];
  proposals: Map<string, ProposalRecord>;
  idempotency: Map<string, IdempotencyRecord>;
  withTenantTx: <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
}

export function createMemoryStore(): MemoryActionStore {
  const idempotency = new Map<string, IdempotencyRecord>();
  const proposals = new Map<string, ProposalRecord>();
  const audits: AuditRecord[] = [];
  const keyLocks = new Map<string, Promise<unknown>>();
  const tenantLocks = new Map<string, Promise<unknown>>();

  function withLock<T>(locks: Map<string, Promise<unknown>>, lockKey: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(lockKey) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    locks.set(
      lockKey,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  const noopTx: TenantTx = {
    query: async () => ({ rows: [], rowCount: 0 }),
  };

  const store: MemoryActionStore = {
    audits,
    proposals,
    idempotency,
    async withTenantTx<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
      return withLock(tenantLocks, tenantId, () => fn(noopTx));
    },
    async beginIdempotency(tx, input): Promise<BeginIdempotencyResult> {
      const k = idempKey(input.tenantId, input.action, input.key);
      return withLock(keyLocks, k, async () => {
        const existing = idempotency.get(k);
        if (!existing || existing.expiresAt.getTime() <= input.now.getTime()) {
          idempotency.set(k, {
            tenantId: input.tenantId,
            action: input.action,
            key: input.key,
            requestHash: input.requestHash,
            status: 'in_progress',
            response: null,
            expiresAt: input.expiresAt,
          });
          return { kind: 'new' };
        }
        if (existing.requestHash !== input.requestHash) return { kind: 'reused' };
        if (existing.status === 'completed' && existing.response) {
          return { kind: 'replay', response: cloneResult(existing.response) };
        }
        existing.requestHash = input.requestHash;
        existing.status = 'in_progress';
        existing.response = null;
        existing.expiresAt = input.expiresAt;
        return { kind: 'new' };
      });
    },
    async completeIdempotency(_tx, input): Promise<void> {
      const k = idempKey(input.tenantId, input.action, input.key);
      const existing = idempotency.get(k);
      if (!existing) return;
      existing.status = 'completed';
      existing.response = cloneResult(input.response);
    },
    async createProposal(_tx, ctx, input): Promise<ProposalRecord> {
      const record: ProposalRecord = {
        id: randomUUID(),
        tenantId: ctx.tenantId,
        action: input.action,
        callId: input.callId ?? null,
        payloadHash: input.payloadHash,
        payload: input.payload,
        readback: input.readback,
        expiresAt: input.expiresAt,
        consumedAt: null,
      };
      proposals.set(record.id, record);
      return record;
    },
    async consumeProposal(_tx, ctx, input) {
      const lockKey = `proposal:${input.confirmationToken}`;
      return withLock(keyLocks, lockKey, async () => {
        const row = proposals.get(input.confirmationToken);
        if (!row || row.tenantId !== ctx.tenantId) return null;
        if (
          row.consumedAt ||
          row.expiresAt.getTime() <= ctx.now.getTime() ||
          row.action !== input.action ||
          (row.callId ?? undefined) !== (input.callId ?? undefined) ||
          row.payloadHash !== input.payloadHash
        ) {
          return null;
        }
        row.consumedAt = ctx.now;
        return row;
      });
    },
    async inspectProposal(_tx, ctx, id) {
      const row = proposals.get(id);
      if (!row || row.tenantId !== ctx.tenantId) return null;
      return row;
    },
    async insertAudit(_tx, record) {
      audits.push(record);
    },
  };

  return store;
}
