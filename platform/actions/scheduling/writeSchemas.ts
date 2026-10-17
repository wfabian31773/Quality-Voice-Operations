import { z } from 'zod';
import { toE164 } from './readback';

const id = z.string().min(1).max(255);

/** ISO 8601 instant with an offset or Z ("2026-10-20T15:30:00-04:00"). */
const instant = z.string().datetime({ offset: true, message: 'Use an ISO date-time with offset, e.g. 2026-10-20T15:30:00-04:00' });

/** A phone number, normalized to E.164 (10-digit numbers are US). */
export const phone = z
  .string()
  .min(7)
  .max(32)
  .transform((value, issue) => {
    const e164 = toE164(value);
    if (!e164) {
      issue.addIssue({ code: z.ZodIssueCode.custom, message: 'Use a valid phone number, e.g. +15555550142' });
      return z.NEVER;
    }
    return e164;
  });

const serviceIds = z
  .array(id)
  .min(1)
  .max(3)
  .refine((ids) => new Set(ids).size === ids.length, 'Each service may appear once');

export const confirmationTokenInput = z.object({
  confirmationToken: z.string().uuid(),
});

export const bookPrepareInput = z.object({
  /** 1 to 3 services, done back-to-back by one staff member. */
  serviceIds,
  /** A staff id from list_staff, or 'any'. */
  staffId: id,
  /** A start time returned by check_availability. */
  start: instant,
  customer: z.object({
    name: z.string().trim().min(1).max(80),
    phone,
    email: z.string().email().max(255).optional(),
  }),
  notes: z.string().max(1000).optional(),
});
export type BookPrepareInput = z.infer<typeof bookPrepareInput>;

const slotFields = {
  staffId: z.string(),
  staffName: z.string(),
  start: z.string(),
  end: z.string(),
};

export const bookPrepareOutput = z.object({
  confirmationToken: z.string(),
  holdId: z.string(),
  expiresAt: z.string(),
  readback: z.string(),
  /** Exactly what the agent says, or "the shop will confirm the price". */
  priceText: z.string(),
  ...slotFields,
  /** Earlier holds from this call released by this prepare (a correction). */
  replacedHoldIds: z.array(z.string()),
});

export const bookCommitOutput = z.object({
  bookingId: z.string(),
  status: z.literal('confirmed'),
  readback: z.string(),
  /** SMS/email confirmations arrive with PR-17. */
  confirmationChannel: z.enum(['sms', 'email', 'none']),
  ...slotFields,
});

export const reschedulePrepareInput = z.object({
  bookingId: id,
  newStart: instant,
  /** Defaults to the booking's staff member; 'any' lets the engine pick. */
  staffId: id.optional(),
});

export const reschedulePrepareOutput = z.object({
  confirmationToken: z.string(),
  holdId: z.string(),
  expiresAt: z.string(),
  readback: z.string(),
  ...slotFields,
  replacedHoldIds: z.array(z.string()),
});

export const rescheduleCommitOutput = z.object({
  bookingId: z.string(),
  previousBookingId: z.string(),
  status: z.enum(['confirmed', 'pending']),
  readback: z.string(),
  ...slotFields,
});

export const cancelPrepareInput = z.object({
  bookingId: id,
  reason: z.string().trim().max(500).optional(),
});

export const cancelPrepareOutput = z.object({
  confirmationToken: z.string(),
  expiresAt: z.string(),
  readback: z.string(),
});

export const cancelCommitOutput = z.object({
  bookingId: z.string(),
  status: z.literal('cancelled'),
  readback: z.string(),
});

/** What book.prepare stores on its proposal (action_proposals.payload). */
export const bookProposalPayload = z.object({
  holdId: z.string(),
  serviceIds: z.array(z.string()),
  staffId: z.string(),
  start: z.string(),
  end: z.string(),
  customerName: z.string(),
  locale: z.string().nullable(),
});

export const rescheduleProposalPayload = bookProposalPayload.extend({
  bookingId: z.string(),
  fromStart: z.string(),
  /** Agent proposals only: bookingIdentityKey of the booking verified at prepare. */
  idKey: z.string().optional(),
});

export const cancelProposalPayload = z.object({
  bookingId: z.string(),
  start: z.string(),
  reason: z.string().nullable(),
  locale: z.string().nullable(),
  /** Agent proposals only: bookingIdentityKey of the booking verified at prepare. */
  idKey: z.string().optional(),
});
