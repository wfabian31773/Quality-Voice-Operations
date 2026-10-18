import { ZodError } from 'zod';
import { actionFail, internalError } from './errors';
import { requestHash } from './hash';
import { checkPermission } from './permissions';
import { postgresActionStore } from './postgresStore';
import { auditActor, redactInput } from './redact';
import {
  defaultWithTenantTx,
  resolveRegistry,
  runWithActionStore,
  type ActionRuntime,
} from './runtime';
import type { ActionStore } from './store';
import {
  IDEMPOTENCY_TTL_MS,
  isWriteKind,
  type ActionContext,
  type ActionDefinition,
  type ActionResult,
  type AnyActionDefinition,
  type TenantTx,
} from './types';

export type { ActionRuntime } from './runtime';

export const CALL_ID_MAX_LENGTH = 128;

export function clipCallId(callId: string | undefined): string | undefined {
  if (typeof callId !== 'string') return undefined;
  return callId.length > CALL_ID_MAX_LENGTH ? callId.slice(0, CALL_ID_MAX_LENGTH) : callId;
}

function validationError(err: ZodError): ActionResult<never> {
  const issue = err.issues[0];
  const field = issue?.path?.length ? issue.path.map(String).join('.') : undefined;
  return actionFail('VALIDATION_FAILED', issue?.message ?? 'Invalid input', { field });
}

function confirmationTokenFrom(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const token = (input as { confirmationToken?: unknown }).confirmationToken;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

function auditableRawInput(def: AnyActionDefinition, rawInput: unknown): unknown {
  if (!def.auditRawInput) return rawInput;
  try {
    return def.auditRawInput(rawInput);
  } catch {
    // Never fall back to the raw input: it is what the hook exists to keep out of the audit row.
    return {};
  }
}

function resultCode(result: ActionResult): string {
  return result.ok ? 'ok' : result.error.code;
}

function shouldFinalizeIdempotency(result: ActionResult): boolean {
  if (result.ok) return true;
  if (result.error.retryable) return false;
  if (result.error.code === 'CONFIRMATION_INVALID') return false;
  return true;
}

async function openSavepoint(tx: TenantTx, name: string): Promise<boolean> {
  try {
    await tx.query(`SAVEPOINT ${name}`);
    return true;
  } catch {
    return false;
  }
}

async function rollbackSavepoint(tx: TenantTx, opened: boolean, name: string): Promise<void> {
  if (!opened) return;
  try {
    await tx.query(`ROLLBACK TO SAVEPOINT ${name}`);
  } catch {
    // Best-effort: the caller still owns the action result or error.
  }
}

async function releaseSavepoint(tx: TenantTx, opened: boolean, name: string): Promise<void> {
  if (!opened) return;
  try {
    await tx.query(`RELEASE SAVEPOINT ${name}`);
  } catch {
    // Ignore fake/memory clients.
  }
}

async function withAuditSavepoint(tx: TenantTx, fn: () => Promise<void>): Promise<void> {
  let opened = false;
  try {
    await tx.query('SAVEPOINT action_audit');
    opened = true;
  } catch {
    // Memory/fake clients have no savepoints; insertAudit still runs.
  }
  try {
    await fn();
    if (opened) await tx.query('RELEASE SAVEPOINT action_audit');
  } catch (err) {
    if (opened) {
      try {
        await tx.query('ROLLBACK TO SAVEPOINT action_audit');
      } catch {
        // The original insert error is the one callers should see.
      }
    }
    throw err;
  }
}

async function writeAudit(
  store: ActionStore,
  tx: TenantTx,
  ctx: ActionContext,
  action: string,
  input: unknown,
  result: ActionResult,
  startedAt: number,
): Promise<void> {
  try {
    await withAuditSavepoint(tx, () =>
      store.insertAudit(tx, {
        tenantId: ctx.tenantId,
        action,
        actor: auditActor(ctx.actor),
        inputRedacted: redactInput(input) ?? {},
        resultCode: resultCode(result),
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        callId: clipCallId(ctx.callId),
      }),
    );
  } catch {
    // Audit is best-effort. A failed insert must not replace the action result
    // or abort the tenant transaction (savepoint rolls the insert back).
  }
}

export async function runActionDefinition<I, O>(
  def: ActionDefinition<I, O>,
  ctx: ActionContext,
  rawInput: unknown,
  runtime: ActionRuntime = {},
): Promise<ActionResult<O>> {
  const store = runtime.store ?? postgresActionStore;
  const withTenantTx = runtime.withTenantTx ?? defaultWithTenantTx;
  const startedAt = performance.now();

  return runWithActionStore(store, () =>
    execute(def, ctx, rawInput, store, withTenantTx, startedAt),
  );
}

async function auditBestEffort(
  withTenantTx: <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>,
  store: ActionStore,
  ctx: ActionContext,
  action: string,
  input: unknown,
  result: ActionResult,
  startedAt: number,
): Promise<void> {
  try {
    await withTenantTx(ctx.tenantId, (tx) => writeAudit(store, tx, ctx, action, input, result, startedAt));
  } catch {
    // Validation/permission responses must not depend on audit being available.
  }
}

async function execute<I, O>(
  def: ActionDefinition<I, O>,
  ctx: ActionContext,
  rawInput: unknown,
  store: ActionStore,
  withTenantTx: <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>,
  startedAt: number,
): Promise<ActionResult<O>> {
  ctx = { ...ctx, callId: clipCallId(ctx.callId) };
  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) {
    const failed = validationError(parsed.error);
    await auditBestEffort(withTenantTx, store, ctx, def.name, auditableRawInput(def, rawInput), failed, startedAt);
    return failed;
  }

  const denied = checkPermission(def, ctx.actor);
  if (denied) {
    await auditBestEffort(withTenantTx, store, ctx, def.name, parsed.data, denied, startedAt);
    return denied;
  }

  let idempotencyKey = ctx.idempotencyKey;
  if (!idempotencyKey && def.kind === 'commit') {
    idempotencyKey = confirmationTokenFrom(parsed.data);
  }

  if (isWriteKind(def.kind) && !idempotencyKey) {
    const failed = actionFail('VALIDATION_FAILED', 'Idempotency key is required for writes', {
      field: 'idempotencyKey',
    });
    await auditBestEffort(withTenantTx, store, ctx, def.name, parsed.data, failed, startedAt);
    return failed;
  }

  const boundCtx: ActionContext = { ...ctx, idempotencyKey };
  const hash = requestHash({ input: parsed.data, callId: ctx.callId ?? null });

  try {
    return await withTenantTx(ctx.tenantId, async (tx) => {
      if (isWriteKind(def.kind) && idempotencyKey) {
        const claim = await store.beginIdempotency(tx, {
          tenantId: ctx.tenantId,
          action: def.name,
          key: idempotencyKey,
          requestHash: hash,
          now: ctx.now,
          expiresAt: new Date(ctx.now.getTime() + IDEMPOTENCY_TTL_MS),
        });
        if (claim.kind === 'reused') {
          const failed = actionFail(
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency key was reused with a different payload',
          );
          await writeAudit(store, tx, boundCtx, def.name, parsed.data, failed, startedAt);
          return failed;
        }
        if (claim.kind === 'replay') {
          const replayed = claim.response as ActionResult<O>;
          await writeAudit(store, tx, boundCtx, def.name, parsed.data, replayed, startedAt);
          return replayed;
        }
      }

      const runSavepoint = await openSavepoint(tx, 'action_run');
      let result: ActionResult<O>;
      try {
        result = await def.run(boundCtx, parsed.data, tx);
        if (result.ok) {
          const out = def.output.safeParse(result.data);
          if (!out.success) {
            throw new Error(`Action ${def.name} returned data that did not match its output schema`);
          }
          result = { ...result, data: out.data };
        }
        if (!result.ok) {
          await rollbackSavepoint(tx, runSavepoint, 'action_run');
        } else {
          await releaseSavepoint(tx, runSavepoint, 'action_run');
        }
      } catch (err) {
        await rollbackSavepoint(tx, runSavepoint, 'action_run');
        throw err;
      }

      if (isWriteKind(def.kind) && idempotencyKey) {
        if (shouldFinalizeIdempotency(result)) {
          await store.completeIdempotency(tx, {
            tenantId: ctx.tenantId,
            action: def.name,
            key: idempotencyKey,
            response: result,
            now: ctx.now,
          });
        } else {
          await store.releaseIdempotency(tx, {
            tenantId: ctx.tenantId,
            action: def.name,
            key: idempotencyKey,
          });
        }
      }
      await writeAudit(store, tx, boundCtx, def.name, parsed.data, result, startedAt);
      return result;
    });
  } catch (err) {
    const failed = internalError(err) as ActionResult<O>;
    try {
      await withTenantTx(ctx.tenantId, (tx) => writeAudit(store, tx, boundCtx, def.name, parsed.data, failed, startedAt));
    } catch {
      // Audit best-effort if the original transaction already failed.
    }
    return failed;
  }
}

export async function runAction(
  name: string,
  ctx: ActionContext,
  input: unknown,
  runtime: ActionRuntime = {},
): Promise<ActionResult> {
  const registry = resolveRegistry(runtime.registry);
  const def = registry.get(name) as AnyActionDefinition | undefined;
  if (!def) {
    const failed = actionFail('NOT_FOUND', `Unknown action: ${name}`);
    const store = runtime.store ?? postgresActionStore;
    const withTenantTx = runtime.withTenantTx ?? defaultWithTenantTx;
    const startedAt = performance.now();
    await runWithActionStore(store, () =>
      auditBestEffort(withTenantTx, store, ctx, name, input, failed, startedAt),
    );
    return failed;
  }
  return runActionDefinition(def, ctx, input, runtime);
}
