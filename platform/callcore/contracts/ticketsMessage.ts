import type { ToolContract } from './types';

/**
 * tickets.message@1: leave a message or ask for a callback. Generic across
 * businesses; templates phrase each askId for their vertical.
 *
 * Enforced inside tickets.open.prepare for the agent when the ticket kind is
 * 'message' or 'callback': a missing slot comes back as SLOT_MISSING with the
 * next askId in this order, one ask per slot. A message is never lost for
 * want of a number: the callback number is held from caller ID, and after
 * one ask without it the ticket is prepared anyway, marked "no callback
 * number given". The caller's name is never required.
 */
export const TICKETS_MESSAGE_V1: ToolContract = {
  id: 'tickets.message',
  version: 1,
  intents: ['message', 'callback'],
  slots: [
    {
      name: 'subject',
      inputPath: 'subject',
      required: true,
      askId: 'ask.messageSubject',
      defaultAsk: { en: 'What would you like me to pass along?', es: '¿Qué mensaje le gustaría dejar?' },
    },
    {
      // Optional: asked only if the model chooses to; never blocks the ticket.
      name: 'customerName',
      inputPath: 'customer.name',
      required: false,
      askId: 'ask.messageName',
      defaultAsk: { en: 'Who should I say the message is from?', es: '¿De parte de quién es el mensaje?' },
    },
    {
      name: 'callbackNumber',
      inputPath: 'customer.phone',
      required: true,
      askId: 'ask.callbackNumber',
      defaultAsk: { en: 'What number should they call you back on?', es: '¿A qué número le pueden devolver la llamada?' },
      heldFrom: 'callerPhone',
      afterAsk: 'proceed',
    },
  ],
  confirm: {
    prepare: 'tickets.open.prepare',
    commit: 'tickets.open.commit',
    explicitYes: true,
    maxReadbackCycles: 2,
  },
  sideEffect: 'write',
  // The owner alert goes through the ticket outbox, not to the caller.
  outbound: 'none',
  identity: 'none',
  idempotency: 'proposalToken',
  // The server-worded readback only. A callback number read back in it is a
  // speakable number; ticket numbers are never spoken.
  sayBack: ['readback'],
  voiceRefs: false,
  onFailure: {
    // The second miss of the subject: no second ask. Nothing is filed by the
    // tool, so the floor files the caller's own lines at teardown.
    SLOT_MISSING: [{ step: 'message_ticket' }],
    default: [{ step: 'message_ticket' }],
  },
  ceilings: { maxAsksPerSlot: 1 },
};
