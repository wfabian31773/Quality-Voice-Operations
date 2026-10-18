import type { ToolContract } from './types';

/**
 * booking.find@1: find the caller's existing appointment before reading it
 * aloud or changing it. A phone match is only a candidate: the first name on
 * the booking must be confirmed too (identity 'verified'), because household
 * phones are shared. A caller whose caller ID doesn't match must also give
 * the date and time (never offered first).
 *
 * Enforced inside scheduling.find_bookings for the agent: until the name is
 * confirmed the result carries no booking detail and no count, only the next
 * askId in this order. A missing or wrong name is one ask; the second miss on
 * the call exits to a message ticket and the action stops matching names.
 */
export const BOOKING_FIND_V1: ToolContract = {
  id: 'booking.find',
  version: 1,
  intents: ['find'],
  slots: [
    {
      name: 'phone',
      inputPath: 'phone',
      required: true,
      askId: 'ask.bookingPhone',
      defaultAsk: { en: 'What phone number is the appointment under?', es: '¿Con qué número de teléfono está la cita?' },
      heldFrom: 'callerPhone',
    },
    {
      name: 'name',
      inputPath: 'name',
      required: true,
      askId: 'ask.bookingName',
      defaultAsk: { en: 'What name is the appointment under?', es: '¿A nombre de quién está la cita?' },
    },
    {
      name: 'date',
      inputPath: 'date',
      required: false,
      requiredWhen: 'callerIdMismatch',
      askId: 'ask.bookingDate',
      defaultAsk: { en: 'What day is the appointment?', es: '¿Qué día es la cita?' },
      format: 'date',
    },
    {
      name: 'time',
      inputPath: 'time',
      required: false,
      requiredWhen: 'callerIdMismatch',
      askId: 'ask.bookingTime',
      defaultAsk: { en: 'What time is the appointment?', es: '¿A qué hora es la cita?' },
    },
  ],
  action: 'scheduling.find_bookings',
  sideEffect: 'read',
  outbound: 'none',
  identity: 'verified',
  idempotency: 'none',
  // Server-worded lines only: a verified booking's spoken line, or the next ask.
  // Booking ids stay in non-spoken fields for reschedule/cancel.
  sayBack: ['bookings.spoken', 'callerSafeMessage'],
  voiceRefs: false,
  onFailure: {
    SLOT_MISSING: [{ step: 'message_ticket' }],
    default: [{ step: 'message_ticket' }],
  },
  ceilings: { maxAsksPerSlot: 1 },
};
