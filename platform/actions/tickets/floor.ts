// tickets.file_floor: the hangup floor (architecture rev 4, F7 / §1.3).
//
// The runtime calls this once at call teardown. If the caller was heard, said
// more than their own name, and nothing was filed on the call, it files one
// message ticket carrying the caller's own lines. It is system-only: the agent,
// users and MCP callers get FORBIDDEN.
//
// Rule order: never_heard → nothing_substantive → already_filed → filed.
// Idempotency: the runtime passes ctx.idempotencyKey = floorIdempotencyKey(callId);
// runAction's idempotency store replays the first result for a retry, and the
// already_filed check stops a second ticket even if the store entry is gone.

import { z } from 'zod';
import { actionFail, actionOk, defineAction, redactInput, type AnyActionDefinition } from '../core';
import { decryptSensitiveField } from '../../security/FieldEncryption';
import { saidMoreThanTheirOwnName } from './floorHeuristics';
import type { TicketsRepoFactory } from './repo';
import { priorityFor, resolveSla } from './sla';

export const FILE_FLOOR = 'tickets.file_floor';

/** One subject for every language; the details hold the caller's own words. */
export const FLOOR_SUBJECT = 'Caller hung up before finishing';

export const FLOOR_MAX_LINES = 50;
export const FLOOR_MAX_LINE_LENGTH = 500;

export function floorIdempotencyKey(callId: string): string {
  return `call-${callId}-floor`;
}

/** 13 to 19 digits, grouped by up to 3 spaces, commas, dots, dashes or line breaks: card-number shaped. */
const CARD_LIKE = /\b\d(?:[\s,.-]{0,3}\d){12,18}\b/g;
export const CARD_MASK = '[card number removed]';

/** US SSN shape (3-2-4 with dashes). */
const SSN_LIKE = /\b\d{3}-\d{2}-\d{4}\b/g;
export const SSN_MASK = '[ssn removed]';

/** The mask keeps any line breaks the match spanned, so the caller's line count is unchanged. */
function maskKeepingLines(mask: string): (match: string) => string {
  return (match) => mask + '\n'.repeat(match.split('\n').length - 1);
}

/**
 * Caller free text: card-like and SSN-like numbers are removed, then the core
 * action redactor masks phone-shaped numbers to their last 4 digits. The core
 * redactor has no card or SSN rule today, so those masks live here (see PR notes).
 * Safe to run twice: the masks hold no card, SSN or phone shapes.
 */
export function redactCallerText(text: string): string {
  const masked = text.replace(CARD_LIKE, maskKeepingLines(CARD_MASK)).replace(SSN_LIKE, SSN_MASK);
  return String(redactInput(masked));
}

/**
 * Redacts the lines as one text, so a card split across two lines is still
 * caught, then splits it back into lines. A line that itself holds a line
 * break comes back as two lines.
 */
export function redactCallerLines(lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : redactCallerText(lines.join('\n')).split('\n');
}

// Strict: the caller phone comes from call_sessions, so an input phone is rejected, not ignored.
// callerLines are redacted while parsing, so runAction's audit row and request
// hash (both built from the parsed input) never see a card number.
export const fileFloorInput = z
  .object({
    callId: z.string().trim().min(1).max(128),
    callerLines: z
      .array(z.string().max(FLOOR_MAX_LINE_LENGTH))
      .max(FLOOR_MAX_LINES)
      .transform(redactCallerLines),
    callerName: z.string().trim().max(255).optional(),
    language: z.enum(['en', 'es']).optional(),
  })
  .strict();
export type FileFloorInput = z.infer<typeof fileFloorInput>;

export const FLOOR_REASONS = ['filed', 'nothing_substantive', 'already_filed', 'never_heard'] as const;

export const fileFloorOutput = z.object({
  filed: z.boolean(),
  reason: z.enum(FLOOR_REASONS),
  ticketId: z.string().optional(),
  ticketNumber: z.number().int().nullable().optional(),
});
export type FileFloorOutput = z.infer<typeof fileFloorOutput>;

/** Decrypts a stored call_sessions.caller_number; null or a throw means "no phone". */
export type CallerNumberDecrypter = (tenantId: string, stored: string) => Promise<string | null>;

/** Legacy plain-text caller_number (same shape scheduling/identity.ts accepts). */
const PLAIN_PHONE = /^\+?[0-9 ().-]{7,24}$/;

function phoneOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '').length;
  return digits >= 7 && digits <= 15 ? value.trim() : null;
}

export interface FloorActionDeps {
  repo: TicketsRepoFactory;
  decryptCallerNumber?: CallerNumberDecrypter;
}

export function createFloorAction(deps: FloorActionDeps): AnyActionDefinition {
  const decrypt: CallerNumberDecrypter = deps.decryptCallerNumber ?? decryptSensitiveField;

  async function callerPhone(stored: string | null, tenantId: string): Promise<string | null> {
    if (!stored) return null;
    if (PLAIN_PHONE.test(stored)) return phoneOrNull(stored);
    try {
      return phoneOrNull(await decrypt(tenantId, stored));
    } catch {
      return null;
    }
  }

  return defineAction({
    name: FILE_FLOOR,
    tool: 'tickets',
    kind: 'write',
    input: fileFloorInput,
    output: fileFloorOutput,
    // No roles, no agent, no MCP scope: only a system actor passes checkPermission.
    permissions: { roles: [], agent: false },
    async run(ctx, input, tx) {
      if (ctx.actor.type !== 'system') return actionFail('FORBIDDEN', 'Only the runtime can file the floor ticket');
      if (ctx.callId && ctx.callId !== input.callId) {
        return actionFail('VALIDATION_FAILED', 'callId does not match the call in context', { field: 'callId' });
      }
      if (ctx.idempotencyKey !== floorIdempotencyKey(input.callId)) {
        return actionFail('VALIDATION_FAILED', `Idempotency key must be ${floorIdempotencyKey('<callId>')}`, {
          field: 'idempotencyKey',
        });
      }

      const lines = input.callerLines.map((line) => line.trim()).filter(Boolean);
      if (lines.length === 0) return actionOk({ filed: false, reason: 'never_heard' as const });
      if (!saidMoreThanTheirOwnName(lines, input.callerName)) {
        return actionOk({ filed: false, reason: 'nothing_substantive' as const });
      }

      const repo = deps.repo(tx, ctx.tenantId);
      if (await repo.hasCallArtifact(input.callId)) return actionOk({ filed: false, reason: 'already_filed' as const });

      const phone = await callerPhone(await repo.callerNumber(input.callId), ctx.tenantId);
      const settings = await repo.getSettings();
      const urgency = 'normal' as const;
      const priority = priorityFor(urgency);
      const { dueAt, instance } = await resolveSla(repo, settings.callbackSlaMinutes, priority, ctx.now);
      const ticket = await repo.insert({
        kind: 'message',
        subject: FLOOR_SUBJECT,
        description: redactCallerText(lines.join('\n')),
        contactName: input.callerName ?? '',
        contactPhone: phone ?? '',
        urgency,
        priority,
        source: 'ai_agent',
        intake: {},
        callbackDueAt: dueAt,
        callRef: input.callId,
        createdByUserId: null,
        now: ctx.now,
      });
      if (instance) await repo.applySlaInstance({ ...instance, ticketId: ticket.id });
      await repo.addActivity({
        ticketId: ticket.id,
        actorUserId: null,
        type: 'created',
        content: `Opened through ${FILE_FLOOR}`,
        metadata: {
          kind: ticket.kind,
          urgency,
          actor: ctx.actor.type,
          floor: true,
          lines: lines.length,
          ...(input.language ? { language: input.language } : {}),
        },
        now: ctx.now,
      });

      // Same ticket_outbox row and effect as tickets.open.commit, so the owner
      // alert path picks the floor ticket up. No SMS is sent from here.
      const event = {
        ticketId: ticket.id,
        ticketNumber: ticket.ticketNumber,
        dueAt: ticket.callbackDueAt?.toISOString() ?? null,
        deduped: false,
        kind: ticket.kind,
        urgency: ticket.urgency,
        priority: ticket.priority,
        callId: input.callId,
        floor: true,
        idempotencyKey: ctx.idempotencyKey,
      };
      const outboxId = await repo.enqueueOutbox({ eventType: 'ticket.opened', payload: event });
      return actionOk(
        { filed: true, reason: 'filed' as const, ticketId: ticket.id, ticketNumber: ticket.ticketNumber },
        { effects: [{ type: 'ticket.opened', payload: { ...event, outboxId } }] },
      );
    },
  });
}
