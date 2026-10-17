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

function resultCode(result: ActionResult): string {
  return result.ok ? 'ok' : result.error.code;
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
  await store.insertAudit(tx, {
    tenantId: ctx.tenantId,
    action,
    actor: auditActor(ctx.actor),
    inputRedacted: redactInput(input),
    resultCode: resultCode(result),
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    callId: ctx.callId,
  });
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

async function execute<I, O>(
  def: ActionDefinition<I, O>,
  ctx: ActionContext,
  rawInput: unknown,
  store: ActionStore,
  withTenantTx: <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>,
  startedAt: number,
): Promise<ActionResult<O>> {
  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) {
    const failed = validationError(parsed.error);
    await withTenantTx(ctx.tenantId, (tx) => writeAudit(store, tx, ctx, def.name, rawInput, failed, startedAt));
    return failed;
  }

  const denied = checkPermission(def, ctx.actor);
  if (denied) {
    await withTenantTx(ctx.tenantId, (tx) => writeAudit(store, tx, ctx, def.name, parsed.data, denied, startedAt));
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
    await withTenantTx(ctx.tenantId, (tx) => writeAudit(store, tx, ctx, def.name, parsed.data, failed, startedAt));
    return failed;
  }

  const boundCtx: ActionContext = { ...ctx, idempotencyKey };
  const hash = requestHash(parsed.data);

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

      let result: ActionResult<O>;
      try {
        result = await def.run(boundCtx, parsed.data, tx);
      } catch (err) {
        result = internalError(err) as ActionResult<O>;
      }

      if (result.ok) {
        const out = def.output.safeParse(result.data);
        if (!out.success) {
          result = actionFail(
            'INTERNAL',
            `Action ${def.name} returned data that did not match its output schema`,
            { callerSafeMessage: 'Something went wrong on our side. Please try again.', retryable: true },
          ) as ActionResult<O>;
        } else {
          result = { ...result, data: out.data };
        }
      }

      if (isWriteKind(def.kind) && idempotencyKey) {
        await store.completeIdempotency(tx, {
          tenantId: ctx.tenantId,
          action: def.name,
          key: idempotencyKey,
          response: result,
          now: ctx.now,
        });
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
      withTenantTx(ctx.tenantId, (tx) => writeAudit(store, tx, ctx, name, input, failed, startedAt)),
    );
    return failed;
  }
  return runActionDefinition(def, ctx, input, runtime);
}
