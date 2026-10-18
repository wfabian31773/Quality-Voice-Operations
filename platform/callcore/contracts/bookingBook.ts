import type { ToolContract } from './types';

/**
 * booking.book@1: book a new appointment. Generic across appointment
 * businesses; templates phrase each askId for their vertical (a barbershop
 * template, for instance, says "cut" where this says "service").
 *
 * Enforced inside scheduling.book.prepare: a missing slot comes back as
 * SLOT_MISSING with the next askId in this order, one ask per slot, then an
 * exit to a message ticket.
 */
export const BOOKING_BOOK_V1: ToolContract = {
  id: 'booking.book',
  version: 1,
  intents: ['book'],
  slots: [
    {
      name: 'service',
      inputPath: 'serviceIds',
      required: true,
      askId: 'ask.service',
      defaultAsk: { en: 'What service would you like?', es: '¿Qué servicio le gustaría?' },
    },
    {
      // 'any' is a valid answer ("anyone is fine").
      name: 'staff',
      inputPath: 'staffId',
      required: true,
      askId: 'ask.staff',
      defaultAsk: {
        en: 'Is there someone you would like to see, or is anyone fine?',
        es: '¿Tiene a alguien de preferencia, o le atiende cualquiera?',
      },
    },
    {
      name: 'time',
      inputPath: 'start',
      required: true,
      askId: 'ask.time',
      defaultAsk: { en: 'What day and time works for you?', es: '¿Qué día y hora le queda bien?' },
    },
    {
      name: 'customerName',
      inputPath: 'customer.name',
      required: true,
      askId: 'ask.customerName',
      defaultAsk: { en: 'What name should I put the appointment under?', es: '¿A nombre de quién hago la cita?' },
      heldFrom: 'verifiedName',
    },
    {
      name: 'customerPhone',
      inputPath: 'customer.phone',
      required: true,
      askId: 'ask.customerPhone',
      defaultAsk: { en: 'What is the best number to reach you?', es: '¿Cuál es el mejor número para contactarle?' },
      heldFrom: 'callerPhone',
    },
  ],
  confirm: {
    prepare: 'scheduling.book.prepare',
    commit: 'scheduling.book.commit',
    explicitYes: true,
    maxReadbackCycles: 2,
  },
  sideEffect: 'write',
  // The confirmation SMS is its own contract.
  outbound: 'none',
  identity: 'none',
  idempotency: 'proposalToken',
  sayBack: ['readback', 'staffName'],
  // Booking refs are texted, never spoken (spoken refs are where invented numbers come from).
  voiceRefs: false,
  onFailure: {
    CONFLICT: [{ step: 'offer_alternatives' }, { step: 'ask_again', slot: 'time' }, { step: 'message_ticket' }],
    OUTSIDE_POLICY: [{ step: 'message_ticket' }],
    SLOT_MISSING: [{ step: 'message_ticket' }],
    default: [{ step: 'message_ticket' }],
  },
  ceilings: { maxAsksPerSlot: 1 },
};
