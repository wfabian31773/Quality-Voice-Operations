import type { ToolContract } from './types';

/**
 * booking.cancel@1: cancel an existing appointment. The booking must be one
 * booking.find@1 verified (caller-ID candidate + first name) in the same
 * call; prepare and commit refuse any other id exactly like an unknown one.
 */
export const BOOKING_CANCEL_V1: ToolContract = {
  id: 'booking.cancel',
  version: 1,
  intents: ['cancel'],
  slots: [
    {
      name: 'booking',
      inputPath: 'bookingId',
      required: true,
      askId: 'ask.bookingToCancel',
      defaultAsk: { en: 'Which appointment would you like to cancel?', es: '¿Qué cita le gustaría cancelar?' },
      verifiedBy: 'booking.find',
    },
  ],
  confirm: {
    prepare: 'scheduling.cancel.prepare',
    commit: 'scheduling.cancel.commit',
    explicitYes: true,
    maxReadbackCycles: 2,
  },
  sideEffect: 'write',
  outbound: 'none',
  identity: 'verified',
  idempotency: 'proposalToken',
  sayBack: ['readback'],
  voiceRefs: false,
  onFailure: {
    OUTSIDE_POLICY: [{ step: 'message_ticket' }],
    NOT_FOUND: [{ step: 'message_ticket' }],
    // The shop changed the booking since the prepare.
    CONFLICT: [{ step: 'message_ticket' }],
    default: [{ step: 'message_ticket' }],
  },
  ceilings: { maxAsksPerSlot: 1 },
};
