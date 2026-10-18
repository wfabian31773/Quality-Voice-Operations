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

import { z, type ZodType } from 'zod';
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

/**
 * 13 to 19 digits, grouped by up to 3 spaces, commas, dots, dashes or line breaks: card-number shaped.
 * Two phone numbers in a row match too, so the mask label doesn't say "card".
 */
const CARD_LIKE = /\b\d(?:[\s,.-]{0,3}\d){12,18}\b/g;
export const NUMBER_MASK = '[number removed]';

/**
 * US SSN shape: 3-2-4 split by one dash, space or dot (the same one both times),
 * or 9 digits in a row as ASR often writes it. Word boundaries keep a 10+ digit
 * phone number out of it, so the core redactor still masks that to its last 4.
 */
const SSN_LIKE = /\b\d{3}([-. ])\d{2}\1\d{4}\b|\b\d{9}\b/g;
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
  const masked = text.replace(CARD_LIKE, maskKeepingLines(NUMBER_MASK)).replace(SSN_LIKE, SSN_MASK);
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

export const FLOOR_MAX_CALL_ID_LENGTH = 128;
export const FLOOR_MAX_NAME_LENGTH = 255;

/**
 * The validation-failure audit copy of a raw floor input. runAction audits the
 * raw input when it fails the schema (too many lines, a line too long, a
 * non-string line, an unknown key), and the core redactor masks phones only.
 * So the copy is an allowlist built from the known keys only; anything else is dropped:
 * - callId: a string, sliced to FLOOR_MAX_CALL_ID_LENGTH chars.
 * - callerLines: the string entries of an array (non-strings dropped), or a
 *   single string as one line. Redacted as one text first, then capped to
 *   FLOOR_MAX_LINES lines of FLOOR_MAX_LINE_LENGTH chars, so a cut never leaves
 *   part of a number unmasked. Any other shape is omitted.
 * - callerName: a string, redacted, then sliced to FLOOR_MAX_NAME_LENGTH chars.
 * - language: kept only when it is 'en' or 'es'.
 * A non-object input (string, array, number, null) gives {}.
 */
export function floorAuditRawInput(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  if (typeof input.callId === 'string') copy.callId = input.callId.slice(0, FLOOR_MAX_CALL_ID_LENGTH);
  const lines =
    typeof input.callerLines === 'string'
      ? [input.callerLines]
      : Array.isArray(input.callerLines)
        ? input.callerLines.filter((line): line is string => typeof line === 'string')
        : null;
  if (lines) {
    copy.callerLines = redactCallerLines(lines)
      .slice(0, FLOOR_MAX_LINES)
      .map((line) => line.slice(0, FLOOR_MAX_LINE_LENGTH));
  }
  if (typeof input.callerName === 'string') copy.callerName = redactCallerName(input.callerName);
  if (input.language === 'en' || input.language === 'es') copy.language = input.language;
  return copy;
}

/** Redacted like the caller's lines, then cut back to the column size (a mask can be longer than what it hides). */
function redactCallerName(name: string): string {
  return redactCallerText(name).slice(0, FLOOR_MAX_NAME_LENGTH);
}

function nonBlank(lines: readonly string[]): string[] {
  return lines.map((line) => line.trim()).filter(Boolean);
}

// Strict: the caller phone comes from call_sessions, so an input phone is rejected, not ignored.
// It also rejects a caller-supplied `substantive`: only the transform below sets it.
// The transform judges "substantive" on the raw lines and raw name (a spoken
// callback number counts as content, and the name's own tokens are dropped),
// then replaces callerLines and callerName with their redacted forms. So
// runAction's audit row and request hash (both built from the parsed input)
// and the ticket's contact name never see a card number or a full phone number.
export const fileFloorInput = z
  .object({
    callId: z.string().trim().min(1).max(FLOOR_MAX_CALL_ID_LENGTH),
    callerLines: z.array(z.string().max(FLOOR_MAX_LINE_LENGTH)).max(FLOOR_MAX_LINES),
    callerName: z.string().trim().max(FLOOR_MAX_NAME_LENGTH).optional(),
    language: z.enum(['en', 'es']).optional(),
  })
  .strict()
  .transform((input) => ({
    ...input,
    substantive: saidMoreThanTheirOwnName(nonBlank(input.callerLines), input.callerName),
    callerLines: redactCallerLines(input.callerLines),
    ...(input.callerName === undefined ? {} : { callerName: redactCallerName(input.callerName) }),
  }));
/** What the runtime sends. */
export type FileFloorInput = z.input<typeof fileFloorInput>;
/** The parsed input `run()` sees: redacted lines plus the raw-line `substantive` verdict. */
type FileFloorParsed = z.output<typeof fileFloorInput>;

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

  return defineAction<FileFloorParsed, FileFloorOutput>({
    name: FILE_FLOOR,
    tool: 'tickets',
    kind: 'write',
    // Core types `input` as ZodType<I>, which assumes the parsed shape equals the
    // sent shape. This transform adds `substantive`, so widen it here (core is out of scope).
    input: fileFloorInput as unknown as ZodType<FileFloorParsed>,
    output: fileFloorOutput,
    // No roles, no agent, no MCP scope: only a system actor passes checkPermission.
    permissions: { roles: [], agent: false },
    auditRawInput: floorAuditRawInput,
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

      const lines = nonBlank(input.callerLines);
      if (lines.length === 0) return actionOk({ filed: false, reason: 'never_heard' as const });
      if (!input.substantive) return actionOk({ filed: false, reason: 'nothing_substantive' as const });

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
