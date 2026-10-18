import type { ToolContract } from './types';

/**
 * booking.reschedule@1: move an existing appointment. The booking must be
 * one booking.find@1 verified (caller-ID candidate + first name) in the same
 * call; prepare and commit refuse any other id exactly like an unknown one.
 */
export const BOOKING_RESCHEDULE_V1: ToolContract = {
  id: 'booking.reschedule',
  version: 1,
  intents: ['reschedule'],
  slots: [
    {
      name: 'booking',
      inputPath: 'bookingId',
      required: true,
      askId: 'ask.bookingToChange',
      defaultAsk: { en: 'Which appointment would you like to move?', es: '¿Qué cita le gustaría cambiar?' },
      verifiedBy: 'booking.find',
    },
    {
      name: 'newTime',
      inputPath: 'newStart',
      required: true,
      askId: 'ask.newTime',
      defaultAsk: { en: 'What day and time would you like instead?', es: '¿Qué día y hora le gustaría en su lugar?' },
    },
  ],
  confirm: {
    prepare: 'scheduling.reschedule.prepare',
    commit: 'scheduling.reschedule.commit',
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
    CONFLICT: [{ step: 'offer_alternatives' }, { step: 'ask_again', slot: 'newTime' }, { step: 'message_ticket' }],
    OUTSIDE_POLICY: [{ step: 'message_ticket' }],
    NOT_FOUND: [{ step: 'message_ticket' }],
    default: [{ step: 'message_ticket' }],
  },
  ceilings: { maxAsksPerSlot: 1 },
};
