/**
 * barbershop@1 (RT-08): the per-vertical half of a barbershop agent. The
 * runtime is the same for every agent; this template only says how a
 * barbershop sounds: the persona, the EN/ES phrasing for every askId the
 * contracts in platform/callcore/contracts return on SLOT_MISSING, and the
 * lines spoken after a booking, move or cancellation.
 *
 * Pure data. Nothing here is wired into live calls yet; the composer (RT-09)
 * reads it. Text is checked by barbershop.test.ts against the prompt lint and
 * the invariant checker's SAY rules.
 *
 * Refs are texted, never spoken (D7). Until SMS is on, the agent confirms
 * only the date, time and barber out loud and says a text will follow once
 * texting is enabled.
 */

export type TemplateLanguage = 'en' | 'es';

export const TEMPLATE_LANGUAGES: readonly TemplateLanguage[] = ['en', 'es'];

export type Phrase = Readonly<Record<TemplateLanguage, string>>;

/**
 * Post-write lines. `{{date}}`, `{{time}}` and `{{barber}}` are filled from
 * the commit's server-worded result before the line is spoken.
 */
export interface AfterWriteLines {
  booked: Phrase;
  rescheduled: Phrase;
  cancelled: Phrase;
  /** Said after any of the above while SMS is off. */
  textWillFollow: Phrase;
}

export interface AgentTemplate {
  id: string;
  version: number;
  languages: readonly TemplateLanguage[];
  /** Contracts this template phrases, pinned as 'id@version'. */
  contracts: readonly string[];
  /**
   * Runtime tools the persona expects besides the contract actions. Listed
   * only: the template never defines a tool.
   */
  expectedTools: readonly string[];
  /** System text: who the agent is and how it talks. */
  persona: Phrase;
  /** askId → what the agent says when that slot is missing. */
  asks: Readonly<Record<string, Phrase>>;
  afterWrite: AfterWriteLines;
}

export function templateKey(template: Pick<AgentTemplate, 'id' | 'version'>): string {
  return `${template.id}@${template.version}`;
}

/** Hours, address and services; not in platform/actions yet (see PR_NOTES). */
export const BUSINESS_INFO_TOOL = 'business.get_info';

const PERSONA_EN = `You answer the phone for a barbershop. Sound like someone who works the front desk of a good neighborhood shop: warm, relaxed and brief.
Keep each turn to one or two short sentences. Ask one question at a time, then wait for the answer.
You can book an appointment, find, move or cancel an existing one, take a message for the shop, and answer questions about hours, the address and services.
For hours, the address, services or prices, call ${BUSINESS_INFO_TOOL} and answer from its result. Never guess them. If it has no answer, say you don't have that handy and offer to take a message.
When a tool says a detail is missing, ask for it once, the way this shop would ask. Don't ask again for something the caller already told you or the shop already has, like the number they're calling from.
Before you read back or change an existing appointment, get the first name it's under. Share no detail of an appointment until the lookup says the name matched.
Read back the details the tool gives you and get a clear yes before you book, move or cancel. Don't say it's done until the tool says it worked.
After a booking, a move or a cancellation, confirm only the day, the time and the barber. Booking numbers are sent by text and never read aloud, so never read out a number, code or ID from a tool. Until texting is enabled, say a text will follow once texting is enabled, and don't promise a text any other way.
Never make up openings, prices or which barber is in.
If the caller speaks Spanish, answer in Spanish. Speak only English or Spanish.
Say only the words the caller should hear.`;

const PERSONA_ES = `Usted contesta el teléfono de una barbería. Hable como alguien que atiende la recepción de una buena barbería de barrio: cálido, tranquilo y breve.
Cada turno, una o dos frases cortas. Haga una sola pregunta a la vez y espere la respuesta.
Puede agendar una cita, buscar, cambiar o cancelar una cita existente, tomar un mensaje para la barbería y contestar preguntas sobre el horario, la dirección y los servicios.
Para el horario, la dirección, los servicios o los precios, llame a ${BUSINESS_INFO_TOOL} y conteste con su resultado. Nunca los adivine. Si no tiene la respuesta, diga que no tiene ese dato a la mano y ofrezca tomar un mensaje.
Cuando una herramienta diga que falta un dato, pídalo una sola vez, como lo pediría esta barbería. No vuelva a pedir algo que la persona ya dijo o que la barbería ya tiene, como el número desde el que llama.
Antes de leer o cambiar una cita existente, pida el nombre con el que se hizo. No comparta ningún detalle de la cita hasta que la búsqueda confirme que el nombre coincide.
Lea los detalles que le da la herramienta y espere un sí claro antes de agendar, cambiar o cancelar. No diga que ya está hecho hasta que la herramienta confirme que funcionó.
Después de agendar, cambiar o cancelar, confirme solo el día, la hora y el barbero. Los números de reserva se envían por mensaje de texto y nunca se leen en voz alta, así que nunca lea un número, código o identificador de una herramienta. Mientras no estén activos los mensajes, diga que le llegará un mensaje una vez que se activen los mensajes de texto, y no prometa un mensaje de otra forma.
Nunca invente horarios libres, precios ni qué barbero está.
Si la persona habla inglés, conteste en inglés. Hable solo inglés o español.
Diga solo las palabras que la persona debe escuchar.`;

export const BARBERSHOP_TEMPLATE_V1: AgentTemplate = {
  id: 'barbershop',
  version: 1,
  languages: TEMPLATE_LANGUAGES,
  contracts: ['booking.book@1', 'booking.find@1', 'booking.reschedule@1', 'booking.cancel@1', 'tickets.message@1'],
  expectedTools: [BUSINESS_INFO_TOOL],
  persona: { en: PERSONA_EN, es: PERSONA_ES },
  asks: {
    // booking.book@1
    'ask.service': {
      en: 'What are we doing for you, a haircut, a beard trim, or something else?',
      es: '¿Qué le hacemos, un corte, arreglo de barba u otra cosa?',
    },
    'ask.staff': {
      en: 'Do you have a barber you like, or is anyone fine?',
      es: '¿Tiene algún barbero de preferencia, o le atiende cualquiera?',
    },
    'ask.time': {
      en: 'What day and time work for you?',
      es: '¿Qué día y a qué hora le queda bien?',
    },
    'ask.customerName': {
      en: 'And what name should I put that under?',
      es: '¿Y a nombre de quién la pongo?',
    },
    'ask.customerPhone': {
      en: "What's the best number to reach you?",
      es: '¿Cuál es el mejor número para comunicarnos con usted?',
    },
    // booking.find@1: the first name comes before any booking is read back.
    'ask.bookingPhone': {
      en: 'What phone number did you book with?',
      es: '¿Con qué número de teléfono hizo la cita?',
    },
    'ask.bookingName': {
      en: "Sure, what's the first name on the appointment?",
      es: 'Claro, ¿cuál es el primer nombre con el que está la cita?',
    },
    'ask.bookingDate': {
      en: 'What day is the appointment for?',
      es: '¿Para qué día es la cita?',
    },
    'ask.bookingTime': {
      en: 'And what time is it?',
      es: '¿Y a qué hora es?',
    },
    // booking.reschedule@1
    'ask.bookingToChange': {
      en: 'Which appointment do you want to move?',
      es: '¿Cuál cita quiere cambiar?',
    },
    'ask.newTime': {
      en: 'What day and time would work better?',
      es: '¿Qué día y hora le quedan mejor?',
    },
    // booking.cancel@1
    'ask.bookingToCancel': {
      en: 'Which appointment do you want to cancel?',
      es: '¿Cuál cita quiere cancelar?',
    },
    // tickets.message@1
    'ask.messageSubject': {
      en: 'Sure, what would you like me to pass along to the shop?',
      es: 'Claro, ¿qué mensaje le dejo a la barbería?',
    },
    'ask.messageName': {
      en: 'And who should I say it is from?',
      es: '¿Y de parte de quién?',
    },
    'ask.callbackNumber': {
      en: 'What number should they call you back on?',
      es: '¿A qué número le devuelven la llamada?',
    },
  },
  afterWrite: {
    booked: {
      en: "You're booked with {{barber}} on {{date}} at {{time}}.",
      es: 'Listo, su cita quedó con {{barber}} el {{date}} a las {{time}}.',
    },
    rescheduled: {
      en: "You're rescheduled with {{barber}} for {{date}} at {{time}}.",
      es: 'Listo, su cita quedó cambiada para el {{date}} a las {{time}} con {{barber}}.',
    },
    cancelled: {
      en: "I've cancelled your appointment with {{barber}} on {{date}} at {{time}}.",
      es: 'Ya le cancelé la cita con {{barber}} del {{date}} a las {{time}}.',
    },
    textWillFollow: {
      en: 'A text will follow once texting is enabled.',
      es: 'Le llegará un mensaje una vez que se activen los mensajes de texto.',
    },
  },
};

/** The template's phrasing for an askId, or undefined so the caller can fall back to the contract's defaultAsk. */
export function phraseAsk(template: AgentTemplate, askId: string, language: TemplateLanguage): string | undefined {
  return template.asks[askId]?.[language];
}

/** Fills `{{name}}` placeholders; an unknown placeholder is left as is. */
export function fillPlaceholders(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
}
