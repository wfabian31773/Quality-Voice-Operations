/**
 * Every phrase list the SAY check uses. These are hard output guards on what
 * the agent is about to say, not caller-intent parsing.
 *
 * Write phrases as they'd be spoken. The checker runs both the phrase and the
 * agent's line through normalizeSpeech (lowercase, no diacritics, no
 * apostrophes, punctuation → spaces) and matches whole words, so "You’re
 * booked!" matches "you're booked" and "Está reservada" matches "esta reservada".
 */

/**
 * Success claims. Each group is allowed only when the latest committed result
 * whose action name has one of `actionSegments` (a trailing "@<version>" is
 * dropped, then the name is split on "." and "_") is ok.
 * An empty `actionSegments` matches any commit/write result (not a transfer).
 * That result must also come after every prepare whose token is still
 * outstanding: a second booking that is only prepared can't ride on the first.
 *
 * `labels` are claims only as a label: the whole text before a colon that opens
 * the line or a sentence, as in the app's own post-commit readbacks
 * ("Confirmed: …", "Done: …", "Cancelada: …"). "Just to confirm: …" and "I confirmed
 * your phone number" are not claims.
 */
export interface SuccessClaimGroup {
  readonly effect: string;
  readonly actionSegments: readonly string[];
  readonly phrases: readonly string[];
  readonly labels?: readonly string[];
}

export const SUCCESS_CLAIMS: readonly SuccessClaimGroup[] = [
  {
    effect: 'appointment',
    actionSegments: ['book', 'reschedule'],
    labels: ['Confirmed', 'Confirmado', 'Done', 'Listo'],
    phrases: [
      "you're booked",
      'you are booked',
      "i've booked",
      'i have booked',
      'i booked you',
      'your appointment is confirmed',
      'your appointment is booked',
      "you're rescheduled",
      "i've rescheduled",
      "i've moved your appointment",
      // Anchored to the booking: a bare "ya está reservado" is how a taken slot is described.
      'su cita está reservada',
      'su cita ya está reservada',
      'ya está reservada su cita',
      'quedó reservada',
      'quedó reservado',
      'ya le reservé',
      'ya te reservé',
      'su cita está confirmada',
      'su cita quedó',
    ],
  },
  {
    effect: 'cancellation',
    actionSegments: ['cancel'],
    labels: ['Cancelled', 'Canceled', 'Cancelada'],
    phrases: [
      "i've cancelled",
      "i've canceled",
      'i have cancelled',
      'i have canceled',
      'your appointment is cancelled',
      'your appointment is canceled',
      'quedó cancelada',
      // Anchored to the booking: a bare "está cancelada" also reads out a booking's status.
      'su cita está cancelada',
      'su cita ya está cancelada',
      'ya está cancelada su cita',
      'ya la cancelé',
      'ya le cancelé',
    ],
  },
  {
    effect: 'sent',
    actionSegments: ['sms', 'send', 'email'],
    phrases: [
      "i've sent",
      'i have sent',
      'i just sent',
      'i sent you',
      'le envié',
      'te envié',
      'ya le mandé',
      'ya te mandé',
      'le acabo de enviar',
    ],
  },
  {
    effect: 'relayed',
    actionSegments: ['tickets', 'ticket', 'message', 'callback'],
    phrases: [
      "i've let them know",
      'i have let them know',
      "i've passed your message",
      "i've passed that along",
      "i've left them a message",
      'ya les avisé',
      'ya le avisé',
      'ya les dejé el mensaje',
      'ya pasé su mensaje',
    ],
  },
  {
    effect: 'order',
    actionSegments: ['order', 'ordering'],
    phrases: [
      'your order is in',
      'your order is placed',
      "i've placed your order",
      'su pedido está hecho',
      'su pedido ya está',
      'ya hice su pedido',
    ],
  },
  {
    effect: 'any',
    actionSegments: [],
    phrases: ["you're all set", 'you are all set', 'ya quedó', 'ya está todo listo'],
  },
];

/**
 * A success phrase right after one of these, in the same clause, is a denial,
 * not a claim: "No quedó reservada; voy a intentar de nuevo". Only the
 * occurrence it touches is exempt; "No problem, you're booked" is still a claim.
 */
export const SUCCESS_NEGATORS: readonly string[] = [
  'no',
  'todavía no',
  'aún no',
  'not',
  "wasn't",
  'was not',
  "isn't",
  'is not',
  "haven't",
  'have not',
  "couldn't",
  "didn't",
];

/** Transfer claims: allowed only after an ok transfer result. */
export const TRANSFER_PHRASES: readonly string[] = [
  'connecting you',
  'transferring you',
  'let me transfer',
  "i'll transfer you",
  'i will transfer you',
  "i'm transferring",
  'putting you through',
  "i'll put you through",
  'le comunico',
  'te comunico',
  'lo comunico',
  'la comunico',
  'lo transfiero',
  'la transfiero',
  'le transfiero',
  'te transfiero',
  'le paso con',
  'lo paso con',
  'la paso con',
];

/** Narration words a voice model must never speak (Azul v97: "Filing quietly"). */
export const STAGE_DIRECTION_WORDS: readonly string[] = [
  'quietly',
  'silently',
  'softly',
  'whispering',
  'whispers',
  'under my breath',
  'en silencio',
  'silenciosamente',
  'en voz baja',
  'susurrando',
];

/**
 * Bracketed narration: (pause), [typing], *files*, {beat}. Only brackets with
 * a letter inside, so "(555)" is left to the ref check.
 */
export const STAGE_DIRECTION_PATTERNS: readonly RegExp[] = [
  /\([^()]*\p{L}[^()]*\)/u,
  /\[[^[\]]*\p{L}[^[\]]*\]/u,
  /\{[^{}]*\p{L}[^{}]*\}/u,
  /\*[^*\n]*\p{L}[^*\n]*\*/u,
];

/** Promises of a text message. Allowed with SMS off only alongside a qualifier below. */
export const TEXT_PROMISE_PHRASES: readonly string[] = [
  'a text will follow',
  "i'll text you",
  'i will text you',
  "we'll text you",
  'we will text you',
  "you'll get a text",
  'you will get a text',
  "you'll receive a text",
  'you will receive a text',
  "i'll send you a text",
  "we'll send you a text",
  'le llegará un mensaje',
  'te llegará un mensaje',
  'le llegará un texto',
  'le enviaré un mensaje',
  'le mandaré un mensaje',
  'le enviaremos un mensaje',
  'le mandaremos un mensaje',
  'le enviaré un texto',
  'le mandaré un texto',
  'recibirá un mensaje',
];

/** The only allowed framing of a text promise while SMS is off (D7). */
export const SMS_OFF_QUALIFIERS: readonly string[] = [
  'once texting is enabled',
  'when texting is enabled',
  'una vez que se activen los mensajes de texto',
  'cuando se activen los mensajes de texto',
];

/** Single spoken digits, EN/ES, turned into digits before the ref check. */
export const DIGIT_WORDS: Readonly<Record<string, string>> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  cero: '0',
  uno: '1',
  dos: '2',
  tres: '3',
  cuatro: '4',
  cinco: '5',
  seis: '6',
  siete: '7',
  ocho: '8',
  nueve: '9',
};
