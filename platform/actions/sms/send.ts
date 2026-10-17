import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createLogger } from '../../core/logger';
import { TwilioApiError } from '../../integrations/twilio/sender';
import {
  actionFail,
  actionOk,
  requestHash,
  runActionDefinition,
  type ActionContext,
  type ActionDefinition,
  type ActionResult,
  type ActionRuntime,
  type Actor,
  type TenantTx,
} from '../core';
import { defaultWithTenantTx } from '../core/runtime';
import {
  defaultSmsSendDeps,
  type ClaimedSmsRecord,
  type OutboundSmsPatch,
  type OutboundSmsRecord,
  type SmsRateLimitWindow,
  type SmsSendDeps,
} from './deps';
import { bodyStats, renderSmsTemplate, SMS_MAX_BODY_CHARS, type SmsTemplateKey } from './templates';

const logger = createLogger('SMS_SEND');

export const SMS_SEND_ACTION = 'sms.send';

/** Send-policy error codes returned by `sms.send` (all core `ActionErrorCode`s). */
export const SMS_SEND_ERROR_CODES = [
  'RECIPIENT_OPTED_OUT',
  'MESSAGING_NOT_ENABLED',
  'QUIET_HOURS',
  'INVALID_NUMBER',
  'UPSTREAM_UNAVAILABLE',
] as const;
export type SmsSendErrorCode = (typeof SMS_SEND_ERROR_CODES)[number];

const CANT_TEXT = "I can't text this number; the shop will confirm by email or you can call back.";

const SAFE_MESSAGE: Record<SmsSendErrorCode, string> = {
  RECIPIENT_OPTED_OUT: CANT_TEXT,
  MESSAGING_NOT_ENABLED: CANT_TEXT,
  QUIET_HOURS: "You'll get the text in the morning.",
  INVALID_NUMBER: "That number can't receive texts.",
  UPSTREAM_UNAVAILABLE: "I couldn't send the text right now.",
};

// Twilio REST error codes that mean the destination itself is unusable.
const TWILIO_INVALID_NUMBER_CODES = new Set([21211, 21614]);
// "Attempt to send to unsubscribed recipient" (carrier-level STOP).
const TWILIO_UNSUBSCRIBED_CODE = 21610;

function smsFail(
  code: SmsSendErrorCode,
  message: string,
  opts: { retryable?: boolean; field?: string } = {},
): ActionResult<never> {
  return actionFail(code, message, {
    callerSafeMessage: SAFE_MESSAGE[code],
    retryable: opts.retryable ?? false,
    ...(opts.field ? { field: opts.field } : {}),
  });
}

export function normalizeE164(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/[\s\-().]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(cleaned) ? cleaned : null;
}

const relatedEntitySchema = z
  .object({ type: z.string().min(1).max(64), id: z.string().min(1).max(128) })
  .strict();

export const smsSendInput = z
  .object({
    to: z.string().min(1).max(32),
    from: z.string().min(1).max(32).optional(),
    templateKey: z.string().min(1).max(64).optional(),
    vars: z.record(z.string().max(SMS_MAX_BODY_CHARS)).optional(),
    body: z.string().min(1).max(SMS_MAX_BODY_CHARS).optional(),
    purpose: z.enum(['transactional', 'conversational', 'marketing']),
    relatedEntity: relatedEntitySchema.optional(),
    /**
     * System callers only. Present while a call is live (no `endedAt`) or just
     * after it (`endedAt`); transactional sends within the configured window
     * (default 60 s) skip quiet hours.
     */
    liveCall: z
      .object({ callId: z.string().min(1).max(128), endedAt: z.string().datetime({ offset: true }).optional() })
      .strict()
      .optional(),
  })
  .strict();

export type SmsSendInput = z.infer<typeof smsSendInput>;

export const smsSendOutput = z.object({
  messageId: z.string(),
  status: z.enum(['queued', 'deferred_quiet_hours', 'suppressed']),
  reason: z.literal('QUIET_HOURS').optional(),
  deferredUntil: z.string().optional(),
  twilioSid: z.string().optional(),
  segments: z.number().int(),
  encoding: z.enum(['GSM-7', 'UCS-2']),
});

export type SmsSendOutput = z.infer<typeof smsSendOutput>;

type Resolved = { ok: true; body: string } | { ok: false; result: ActionResult<never> };

/** Template-only for system (automated / agent-wrapper) sends; free text only for UI and MCP replies. */
function resolveBody(actor: Actor, input: SmsSendInput): Resolved {
  if (input.templateKey && input.body !== undefined) {
    return { ok: false, result: actionFail('VALIDATION_FAILED', 'Send either templateKey or body, not both', { field: 'body' }) };
  }
  if (input.templateKey) {
    const rendered = renderSmsTemplate(input.templateKey, input.vars);
    if (!rendered.ok) {
      return { ok: false, result: actionFail('VALIDATION_FAILED', rendered.message, { field: rendered.field }) };
    }
    if (rendered.body.length > SMS_MAX_BODY_CHARS) {
      return {
        ok: false,
        result: actionFail('VALIDATION_FAILED', `Rendered SMS exceeds ${SMS_MAX_BODY_CHARS} characters`, { field: 'vars' }),
      };
    }
    return { ok: true, body: rendered.body };
  }
  if (input.vars) {
    return { ok: false, result: actionFail('VALIDATION_FAILED', 'vars require a templateKey', { field: 'vars' }) };
  }
  if (input.body === undefined || input.body.trim() === '') {
    return { ok: false, result: actionFail('VALIDATION_FAILED', 'templateKey or body is required', { field: 'templateKey' }) };
  }
  if (actor.type !== 'user' && actor.type !== 'mcp') {
    return {
      ok: false,
      result: actionFail('FORBIDDEN', 'Free-text SMS is only allowed for UI and MCP replies; use a template', {
        field: 'body',
      }),
    };
  }
  return { ok: true, body: input.body };
}

function liveCallExempt(ctx: ActionContext, input: SmsSendInput, windowSeconds: number): boolean {
  if (windowSeconds <= 0 || input.purpose !== 'transactional' || !input.liveCall) return false;
  // Only trusted platform code can claim a live call.
  if (ctx.actor.type !== 'system') return false;
  if (!input.liveCall.endedAt) return true;
  const sinceEnd = ctx.now.getTime() - Date.parse(input.liveCall.endedAt);
  return sinceEnd >= 0 && sinceEnd <= windowSeconds * 1000;
}

type TransmitResult =
  | { ok: true; twilioSid?: string }
  | { ok: false; result: ActionResult<never> };

function classifyTransportError(err: unknown): ActionResult<never> {
  if (err instanceof TwilioApiError) {
    if (err.twilioCode === TWILIO_UNSUBSCRIBED_CODE) {
      return smsFail('RECIPIENT_OPTED_OUT', err.message);
    }
    if (err.twilioCode !== null && TWILIO_INVALID_NUMBER_CODES.has(err.twilioCode)) {
      return smsFail('INVALID_NUMBER', err.message, { field: 'to' });
    }
    const retryable = err.httpStatus >= 500 || err.httpStatus === 429;
    return smsFail('UPSTREAM_UNAVAILABLE', err.message, { retryable });
  }
  // Network failures, timeouts, missing credentials at send time.
  return smsFail('UPSTREAM_UNAVAILABLE', err instanceof Error ? err.message : String(err), { retryable: true });
}

/**
 * Steps 6–7: Twilio send with StatusCallback, then the status update. On a
 * send error the row is marked `failed` unless `markFailed` is false (the
 * release path decides between retry and failure itself).
 */
async function transmit(
  deps: SmsSendDeps,
  msg: Pick<OutboundSmsRecord, 'id' | 'tenantId' | 'from' | 'to' | 'body'>,
  now: Date,
  { markFailed = true }: { markFailed?: boolean } = {},
): Promise<TransmitResult> {
  const statusCallback = deps.config.statusCallbackUrl();
  if (!statusCallback) {
    logger.warn('No public base URL for the SMS StatusCallback; delivery status will not update', {
      tenantId: msg.tenantId,
      messageId: msg.id,
    });
  }
  let sent: { sid?: string };
  try {
    sent = await deps.transport.send({
      tenantId: msg.tenantId,
      from: msg.from,
      to: msg.to,
      body: msg.body,
      statusCallback,
    });
  } catch (err) {
    const result = classifyTransportError(err);
    if (!markFailed) return { ok: false, result };
    const errorMessage = result.ok ? undefined : `${result.error.code}: ${result.error.message}`.slice(0, 500);
    try {
      await deps.store.updateOutbound(msg.tenantId, msg.id, { status: 'failed', errorMessage });
    } catch (updateErr) {
      logger.error('Failed to mark SMS as failed', { tenantId: msg.tenantId, messageId: msg.id, error: String(updateErr) });
    }
    return { ok: false, result };
  }
  try {
    await deps.store.updateOutbound(msg.tenantId, msg.id, { status: 'queued', twilioSid: sent.sid, sentAt: now });
  } catch (err) {
    // Twilio accepted the message; never report a failure that would invite a resend.
    logger.error('Twilio accepted SMS but the status update failed', {
      tenantId: msg.tenantId,
      messageId: msg.id,
      error: String(err),
    });
  }
  return { ok: true, twilioSid: sent.sid };
}

function rateLimitWindow(deps: SmsSendDeps, now: Date): SmsRateLimitWindow | null {
  const { max, windowMs } = deps.config.rateLimit();
  return max > 0 ? { max, since: new Date(now.getTime() - windowMs) } : null;
}

export function createSmsSendAction(deps: SmsSendDeps = defaultSmsSendDeps): ActionDefinition<SmsSendInput, SmsSendOutput> {
  const newId = deps.newId ?? randomUUID;
  return {
    name: SMS_SEND_ACTION,
    tool: 'sms',
    kind: 'write',
    input: smsSendInput,
    output: smsSendOutput,
    // System, UI and MCP. The agent reaches it only through the send_sms wrapper.
    // It texts real people, so MCP keys need qvo:admin (a qvo:read key never sees it).
    permissions: {
      roles: ['tenant_owner', 'operations_manager', 'owner', 'manager'],
      agent: false,
      mcpScope: 'qvo:admin',
    },
    async run(ctx, input, tx: TenantTx) {
      const to = normalizeE164(input.to);
      if (!to) return smsFail('INVALID_NUMBER', 'Recipient is not a valid E.164 number', { field: 'to' });
      if (input.purpose === 'marketing') {
        return actionFail('OUTSIDE_POLICY', 'Marketing SMS is not supported', { field: 'purpose' });
      }
      const resolved = resolveBody(ctx.actor, input);
      if (!resolved.ok) return resolved.result;
      const body = resolved.body;
      const stats = bodyStats(body);

      // 1. Tenant messaging enabled: platform switch and per-tenant flag (both default off).
      if (!deps.config.smsEnabled()) {
        return smsFail('MESSAGING_NOT_ENABLED', 'SMS_ENABLED is off');
      }
      if (!(await deps.store.isTenantMessagingEnabled(tx, ctx.tenantId))) {
        return smsFail('MESSAGING_NOT_ENABLED', 'Messaging is not enabled for this tenant');
      }
      const defaultFrom = await deps.transport.defaultFromNumber(ctx.tenantId);
      let from = defaultFrom ? normalizeE164(defaultFrom) : null;
      if (input.from) {
        const requested = normalizeE164(input.from);
        if (!requested) return actionFail('VALIDATION_FAILED', 'from is not a valid E.164 number', { field: 'from' });
        if (requested !== from && !(await deps.store.isTenantSender(tx, ctx.tenantId, requested))) {
          return actionFail('VALIDATION_FAILED', 'from is not a sender number for this tenant', { field: 'from' });
        }
        from = requested;
      }
      if (!from) return smsFail('MESSAGING_NOT_ENABLED', 'No SMS sender number is configured');

      // 2. Latest consent event must not be an opt-out.
      if ((await deps.store.latestConsentAction(tx, ctx.tenantId, to)) === 'opt_out') {
        return smsFail('RECIPIENT_OPTED_OUT', 'Recipient has opted out of SMS');
      }

      const metadata: Record<string, unknown> = {
        source: SMS_SEND_ACTION,
        purpose: input.purpose,
        templateKey: input.templateKey ?? null,
        relatedEntity: input.relatedEntity ?? null,
        actor: { type: ctx.actor.type, id: ctx.actor.id },
        callId: ctx.callId ?? input.liveCall?.callId ?? null,
        idempotencyKey: ctx.idempotencyKey ?? null,
        segments: stats.segments,
        encoding: stats.encoding,
      };
      const id = newId();

      // 3. Quiet hours: defer to the window start, never drop.
      if (!liveCallExempt(ctx, input, deps.config.liveCallExemptSeconds())) {
        const allowed = await deps.quietHours.isAllowed(ctx.tenantId, to, ctx.now);
        if (!allowed) {
          const deferredUntil = await deps.quietHours.nextWindowStart(ctx.tenantId, to, ctx.now);
          await deps.store.insertOutbound({
            id,
            tenantId: ctx.tenantId,
            from,
            to,
            body,
            status: 'deferred_quiet_hours',
            scheduledAt: deferredUntil,
            metadata: { ...metadata, deferredReason: 'QUIET_HOURS' },
          });
          return actionOk({
            messageId: id,
            status: 'deferred_quiet_hours' as const,
            reason: 'QUIET_HOURS' as const,
            deferredUntil: deferredUntil.toISOString(),
            segments: stats.segments,
            encoding: stats.encoding,
          });
        }
      }

      // 4–5. Per-recipient rate limit and persist, atomically (one lock per
      // tenant + recipient), before calling Twilio.
      const reserved = await deps.store.reserveOutbound(
        { id, tenantId: ctx.tenantId, from, to, body, status: 'sending', scheduledAt: null, metadata },
        rateLimitWindow(deps, ctx.now),
      );
      if (!reserved.reserved) {
        return actionFail('RATE_LIMITED', `Recipient already received ${reserved.recent} SMS in the rate-limit window`);
      }

      // 6–7. Twilio send with StatusCallback, then the status update.
      const sent = await transmit(deps, { id, tenantId: ctx.tenantId, from, to, body }, ctx.now);
      if (!sent.ok) return sent.result;
      return actionOk({
        messageId: id,
        status: 'queued' as const,
        ...(sent.twilioSid ? { twilioSid: sent.twilioSid } : {}),
        segments: stats.segments,
        encoding: stats.encoding,
      });
    },
  };
}

export const smsSendAction = createSmsSendAction();

/**
 * Idempotency key for automated sends: relatedEntity + templateKey + to. The
 * template key carries the reminder kind, so `reminder_24h` and `reminder_2h`
 * for the same booking and number never dedupe against each other.
 */
export function automatedSmsIdempotencyKey(input: {
  relatedEntity: { type: string; id: string };
  templateKey: string;
  to: string;
}): string {
  const to = normalizeE164(input.to) ?? input.to;
  return `sms:auto:${input.relatedEntity.type}:${input.relatedEntity.id}:${input.templateKey}:${to}`;
}

/**
 * Idempotency key for agent sends: the call plus a stable hash of templateKey
 * + canonicalized vars + normalized recipient. An exact repeat dedupes; a
 * corrected retry or a second, different message in the same call does not
 * collide with the first (no IDEMPOTENCY_KEY_REUSED).
 */
export function agentSmsIdempotencyKey(input: {
  callId: string;
  templateKey: string;
  vars: Record<string, string>;
  to: string;
}): string {
  const to = normalizeE164(input.to) ?? input.to;
  const digest = requestHash({ templateKey: input.templateKey, vars: input.vars, to }).slice(0, 32);
  return `sms:agent:${input.callId}:${digest}`;
}

export interface SystemSmsRequest {
  tenantId: string;
  to: string;
  from?: string;
  templateKey: SmsTemplateKey;
  vars: Record<string, string>;
  purpose: 'transactional' | 'conversational';
  relatedEntity?: { type: string; id: string };
  liveCall?: { callId: string; endedAt?: string };
  callId?: string;
  /** Overrides the derived key (relatedEntity + templateKey + to). */
  idempotencyKey?: string;
  actorId?: string;
  tenantTimezone?: string;
  now?: Date;
}

export interface SystemSmsOptions {
  runtime?: ActionRuntime;
  action?: ActionDefinition<SmsSendInput, SmsSendOutput>;
}

/** Entry point for platform code (automations, agent wrapper, alerts). Always template-only. */
export async function sendSystemSms(
  req: SystemSmsRequest,
  opts: SystemSmsOptions = {},
): Promise<ActionResult<SmsSendOutput>> {
  const input: SmsSendInput = {
    to: req.to,
    ...(req.from ? { from: req.from } : {}),
    templateKey: req.templateKey,
    vars: req.vars,
    purpose: req.purpose,
    ...(req.relatedEntity ? { relatedEntity: req.relatedEntity } : {}),
    ...(req.liveCall ? { liveCall: req.liveCall } : {}),
  };
  const idempotencyKey =
    req.idempotencyKey ??
    (req.relatedEntity
      ? automatedSmsIdempotencyKey({ relatedEntity: req.relatedEntity, templateKey: req.templateKey, to: req.to })
      : `sms:system:${randomUUID()}`);
  const ctx: ActionContext = {
    tenantId: req.tenantId,
    actor: { type: 'system', id: req.actorId ?? SMS_SEND_ACTION },
    now: req.now ?? new Date(),
    idempotencyKey,
    callId: req.callId ?? req.liveCall?.callId,
    tenantTimezone: req.tenantTimezone ?? 'UTC',
  };
  return runActionDefinition(opts.action ?? smsSendAction, ctx, input, opts.runtime);
}

/** Adapter for `send(to, from, body) => { sid }` callbacks. Throws when nothing was queued or deferred. */
export async function sendSystemSmsOrThrow(
  req: SystemSmsRequest,
  opts: SystemSmsOptions = {},
): Promise<{ sid?: string; status: SmsSendOutput['status'] }> {
  const result = await sendSystemSms(req, opts);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return { sid: result.data.twilioSid, status: result.data.status };
}

export interface DeferredReleaseSummary {
  claimed: number;
  /** Claimed rows a previous release left stuck in `sending` without a Twilio SID. */
  reclaimed: number;
  sent: number;
  /** Still in quiet hours: re-deferred to the next window. */
  deferred: number;
  /** Over the per-recipient limit: re-deferred, not dropped. */
  rateLimited: number;
  /** Transient failure: re-deferred with backoff. */
  retried: number;
  suppressed: number;
  failed: number;
}

/** Release attempts (transient failures, stuck reclaims) before a row is marked `failed`. */
export const SMS_RELEASE_MAX_ATTEMPTS = 5;
/** A released row still `sending` with no Twilio SID after this long is reclaimed. */
export const SMS_RELEASE_STUCK_MS = 10 * 60_000;
const RELEASE_BACKOFF_BASE_MS = 60_000;
const RELEASE_BACKOFF_MAX_MS = 30 * 60_000;
const RATE_LIMIT_REDEFER_MIN_MS = 60_000;
const RATE_LIMIT_REDEFER_MAX_MS = 10 * 60_000;

/** 1 min, 2 min, 4 min, … capped at 30 min. */
export function releaseBackoffMs(attempt: number): number {
  return Math.min(RELEASE_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), RELEASE_BACKOFF_MAX_MS);
}

function priorReleaseAttempts(msg: OutboundSmsRecord): number {
  const n = Number(msg.metadata.releaseAttempts);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

type ReleaseOutcome =
  | { kind: 'sent' }
  | { kind: 'suppressed'; reason: 'MESSAGING_NOT_ENABLED' | 'RECIPIENT_OPTED_OUT' }
  | { kind: 'quiet_hours'; next: Date }
  | { kind: 'rate_limited'; next: Date }
  | { kind: 'transient'; error: string }
  | { kind: 'permanent'; error: string };

type WithTenantTx = <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;

async function releaseOne(
  deps: SmsSendDeps,
  withTenantTx: WithTenantTx,
  msg: ClaimedSmsRecord,
  now: Date,
): Promise<ReleaseOutcome> {
  try {
    const gate = await withTenantTx(msg.tenantId, async (tx) => {
      if (!deps.config.smsEnabled() || !(await deps.store.isTenantMessagingEnabled(tx, msg.tenantId))) {
        return 'MESSAGING_NOT_ENABLED' as const;
      }
      if ((await deps.store.latestConsentAction(tx, msg.tenantId, msg.to)) === 'opt_out') {
        return 'RECIPIENT_OPTED_OUT' as const;
      }
      return null;
    });
    if (gate) return { kind: 'suppressed', reason: gate };
    if (!(await deps.quietHours.isAllowed(msg.tenantId, msg.to, now))) {
      return { kind: 'quiet_hours', next: await deps.quietHours.nextWindowStart(msg.tenantId, msg.to, now) };
    }
    // Same per-recipient limit as live sends, atomically reserved.
    const reserved = await deps.store.reserveDeferredSend(msg, rateLimitWindow(deps, now), now);
    if (!reserved.reserved) {
      const { windowMs } = deps.config.rateLimit();
      const delay = Math.min(Math.max(windowMs, RATE_LIMIT_REDEFER_MIN_MS), RATE_LIMIT_REDEFER_MAX_MS);
      return { kind: 'rate_limited', next: new Date(now.getTime() + delay) };
    }
  } catch (err) {
    // DB or quiet-hours lookup error during the gate checks: retry later.
    return { kind: 'transient', error: String(err) };
  }
  const sent = await transmit(deps, msg, now, { markFailed: false });
  if (sent.ok) return { kind: 'sent' };
  const { error } = sent.result as Extract<ActionResult<never>, { ok: false }>;
  const message = `${error.code}: ${error.message}`;
  return error.retryable ? { kind: 'transient', error: message } : { kind: 'permanent', error: message };
}

/**
 * Sends deferred (quiet-hours) messages whose window has opened. Gates 1–4
 * are re-checked at release, so an opt-out or a disabled tenant after the
 * deferral still wins, and the per-recipient limit still applies (over it,
 * the row is re-deferred). Transient Twilio/DB errors re-defer with backoff
 * up to SMS_RELEASE_MAX_ATTEMPTS; non-retryable errors fail at once. Runs on
 * the `sms-deferred-release` scheduler.
 */
export async function releaseDueDeferredSms(
  opts: {
    deps?: SmsSendDeps;
    now?: Date;
    limit?: number;
    withTenantTx?: WithTenantTx;
  } = {},
): Promise<DeferredReleaseSummary> {
  const deps = opts.deps ?? defaultSmsSendDeps;
  const withTenantTx = opts.withTenantTx ?? defaultWithTenantTx;
  const now = opts.now ?? new Date();
  const summary: DeferredReleaseSummary = {
    claimed: 0,
    reclaimed: 0,
    sent: 0,
    deferred: 0,
    rateLimited: 0,
    retried: 0,
    suppressed: 0,
    failed: 0,
  };
  const stuckBefore = new Date(now.getTime() - SMS_RELEASE_STUCK_MS);
  const due = await deps.store.claimDueDeferred(now, opts.limit ?? 100, stuckBefore);
  summary.claimed = due.length;

  for (const msg of due) {
    let attempts = priorReleaseAttempts(msg);
    let patch: OutboundSmsPatch | null;
    if (msg.reclaimed) {
      // A previous release died mid-send before Twilio returned a SID.
      summary.reclaimed += 1;
      attempts += 1;
    }
    if (msg.reclaimed && attempts >= SMS_RELEASE_MAX_ATTEMPTS) {
      summary.failed += 1;
      patch = { status: 'failed', errorMessage: 'STUCK_SENDING', metadata: { releaseAttempts: attempts } };
    } else {
      const outcome = await releaseOne(deps, withTenantTx, msg, now);
      patch = applyOutcome(outcome, attempts, now, summary);
      if (outcome.kind === 'transient' || outcome.kind === 'permanent') {
        logger.warn('Deferred SMS release attempt failed', {
          tenantId: msg.tenantId,
          messageId: msg.id,
          attempt: attempts + 1,
          retrying: patch?.status === 'deferred_quiet_hours',
          error: outcome.error,
        });
      }
    }
    if (!patch) continue;
    try {
      await deps.store.updateOutbound(msg.tenantId, msg.id, patch);
    } catch (err) {
      // Row stays `sending` without a SID; the next run reclaims it after SMS_RELEASE_STUCK_MS.
      logger.error('Deferred SMS release status update failed', {
        tenantId: msg.tenantId,
        messageId: msg.id,
        error: String(err),
      });
    }
  }
  return summary;
}

/** Maps a release outcome to the row update (null when `transmit` already wrote it). */
function applyOutcome(
  outcome: ReleaseOutcome,
  attempts: number,
  now: Date,
  summary: DeferredReleaseSummary,
): OutboundSmsPatch | null {
  switch (outcome.kind) {
    case 'sent':
      summary.sent += 1;
      return null;
    case 'suppressed':
      summary.suppressed += 1;
      return { status: 'suppressed', errorMessage: outcome.reason, metadata: { releaseAttempts: attempts } };
    case 'quiet_hours':
      summary.deferred += 1;
      return {
        status: 'deferred_quiet_hours',
        scheduledAt: outcome.next,
        metadata: { deferredReason: 'QUIET_HOURS', releaseAttempts: attempts },
      };
    case 'rate_limited':
      summary.rateLimited += 1;
      return {
        status: 'deferred_quiet_hours',
        scheduledAt: outcome.next,
        metadata: { deferredReason: 'RATE_LIMITED', releaseAttempts: attempts },
      };
    case 'transient': {
      const next = attempts + 1;
      const error = outcome.error.slice(0, 500);
      if (next >= SMS_RELEASE_MAX_ATTEMPTS) {
        summary.failed += 1;
        return { status: 'failed', errorMessage: error, metadata: { releaseAttempts: next } };
      }
      summary.retried += 1;
      return {
        status: 'deferred_quiet_hours',
        scheduledAt: new Date(now.getTime() + releaseBackoffMs(next)),
        metadata: { deferredReason: 'RETRY', releaseAttempts: next, lastReleaseError: error },
      };
    }
    case 'permanent':
      summary.failed += 1;
      return { status: 'failed', errorMessage: outcome.error.slice(0, 500), metadata: { releaseAttempts: attempts + 1 } };
  }
}
