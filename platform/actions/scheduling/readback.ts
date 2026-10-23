// Spoken readbacks and caller-safe messages for the scheduling write actions,
// in English and Spanish. The locale comes from ActionContext.locale; there
// is no tenant-level locale column yet, so anything else falls back to
// English. Times use PR-08's spokenSlot so reads and writes say them alike.

import { spokenSlot } from './availability';
import type { CatalogService } from './availability';
import { priceText } from './listServices';

export type ReadbackLang = 'en' | 'es';

export function readbackLang(locale: string | undefined): ReadbackLang {
  return locale?.toLowerCase().startsWith('es') ? 'es' : 'en';
}

/**
 * Intl locale for spoken times. A bare 'es' becomes 'es-US' (12-hour clock,
 * "3:30 p. m."), since QVO shops are US businesses; a region the caller
 * already carries ('es-MX') is kept.
 */
export function intlLocale(locale: string | undefined): string {
  const lang = readbackLang(locale);
  if (locale && locale.includes('-') && locale.toLowerCase().startsWith(lang)) return locale;
  return lang === 'es' ? 'es-US' : 'en-US';
}

// ─── phones ───

/** E.164 form of a caller-given number, or null. 10-digit numbers are US (+1). */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) {
    return digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0') ? `+${digits}` : null;
  }
  if (digits.length === 10 && !/^[01]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1') && !/^[01]/.test(digits.slice(1))) return `+${digits}`;
  return null;
}

export function phoneLast4(phone: string): string {
  return phone.replace(/\D/g, '').slice(-4);
}

// ─── pieces ───

function serviceList(names: string[], lang: ReadbackLang): string {
  const and = lang === 'es' ? ' y ' : ' and ';
  if (names.length <= 1) return names[0] ?? (lang === 'es' ? 'una cita' : 'an appointment');
  return `${names.slice(0, -1).join(', ')}${and}${names[names.length - 1]}`;
}

/** Combined price text, or null when any service is unpriced ("the shop will confirm"). */
export function bookingPriceText(
  services: Pick<CatalogService, 'priceKind' | 'priceCents' | 'priceMaxCents'>[],
  lang: ReadbackLang,
): string | null {
  const parts = services.map((s) => priceText(s, lang));
  if (parts.length === 0 || parts.some((p) => p === null)) return null;
  return parts.join(lang === 'es' ? ' más ' : ' plus ');
}

export function priceFallback(lang: ReadbackLang): string {
  return lang === 'es' ? 'el negocio le confirmará el precio' : 'the shop will confirm the price';
}

function priceSentence(price: string | null, lang: ReadbackLang): string {
  if (lang === 'es') return price ? `El precio es ${price}.` : 'El negocio le confirmará el precio.';
  return price ? `The price is ${price}.` : 'The shop will confirm the price.';
}

export interface SpokenTime {
  startMs: number;
  nowMs: number;
  timeZone: string;
  locale: string | undefined;
}

export function spokenWhen(t: SpokenTime): string {
  return spokenSlot(t.startMs, t.nowMs, t.timeZone, intlLocale(t.locale));
}

export interface BookingFacts {
  serviceNames: string[];
  staffName: string;
  when: string;
  customerName: string;
  phone: string;
}

// ─── readbacks ───

/** "Men's cut with Marco, today at 3:30 PM, for Luis, phone ending in 0142. The price is from $35." */
export function bookReadback(facts: BookingFacts, price: string | null, lang: ReadbackLang): string {
  const services = serviceList(facts.serviceNames, lang);
  const last4 = phoneLast4(facts.phone);
  if (lang === 'es') {
    return `${services} con ${facts.staffName}, ${facts.when}, para ${facts.customerName}, teléfono que termina en ${last4}. ${priceSentence(price, lang)}`;
  }
  return `${services} with ${facts.staffName}, ${facts.when}, for ${facts.customerName}, phone ending in ${last4}. ${priceSentence(price, lang)}`;
}

/** What the agent may say once the commit returned ok. */
export function confirmedReadback(facts: Omit<BookingFacts, 'phone'>, lang: ReadbackLang): string {
  const services = serviceList(facts.serviceNames, lang);
  if (lang === 'es') return `Confirmado: ${services} con ${facts.staffName}, ${facts.when}, para ${facts.customerName}.`;
  return `Confirmed: ${services} with ${facts.staffName}, ${facts.when}, for ${facts.customerName}.`;
}

export function rescheduleReadback(
  facts: { serviceNames: string[]; customerName: string; fromWhen: string; fromStaff: string; toWhen: string; toStaff: string },
  lang: ReadbackLang,
): string {
  const services = serviceList(facts.serviceNames, lang);
  if (lang === 'es') {
    return `Vamos a mover la cita de ${facts.customerName}, ${services}, de ${facts.fromWhen} con ${facts.fromStaff} a ${facts.toWhen} con ${facts.toStaff}.`;
  }
  return `Moving ${facts.customerName}'s ${services} from ${facts.fromWhen} with ${facts.fromStaff} to ${facts.toWhen} with ${facts.toStaff}.`;
}

export function rescheduledReadback(
  facts: { serviceNames: string[]; customerName: string; toWhen: string; toStaff: string },
  lang: ReadbackLang,
): string {
  const services = serviceList(facts.serviceNames, lang);
  if (lang === 'es') return `Listo: la cita de ${facts.customerName}, ${services}, ahora es ${facts.toWhen} con ${facts.toStaff}.`;
  return `Done: ${facts.customerName}'s ${services} is now ${facts.toWhen} with ${facts.toStaff}.`;
}

export function cancelReadback(
  facts: { serviceNames: string[]; customerName: string; when: string; staffName: string },
  lang: ReadbackLang,
): string {
  const services = serviceList(facts.serviceNames, lang);
  if (lang === 'es') return `Vamos a cancelar la cita de ${facts.customerName}, ${services} con ${facts.staffName}, ${facts.when}.`;
  return `Cancelling ${facts.customerName}'s ${services} with ${facts.staffName}, ${facts.when}.`;
}

export function cancelledReadback(
  facts: { serviceNames: string[]; customerName: string; when: string; staffName: string },
  lang: ReadbackLang,
): string {
  const services = serviceList(facts.serviceNames, lang);
  if (lang === 'es') return `Cancelada: la cita de ${facts.customerName}, ${services} con ${facts.staffName}, ${facts.when}.`;
  return `Cancelled: ${facts.customerName}'s ${services} with ${facts.staffName}, ${facts.when}.`;
}

/** One find_bookings result as the agent says it: "Men's cut with Marco, Thursday at 10 AM, for Luis." */
export function foundBookingLine(facts: Omit<BookingFacts, 'phone'>, lang: ReadbackLang): string {
  const services = serviceList(facts.serviceNames, lang);
  if (lang === 'es') return `${services} con ${facts.staffName}, ${facts.when}, para ${facts.customerName}.`;
  return `${services} with ${facts.staffName}, ${facts.when}, for ${facts.customerName}.`;
}

// ─── caller-safe messages ───

const MESSAGES = {
  slotTaken: {
    en: 'That time was just taken. I can offer the closest open times.',
    es: 'Ese horario se acaba de ocupar. Le puedo ofrecer los horarios libres más cercanos.',
  },
  slotUnavailable: {
    en: "That time isn't available. I can offer the closest open times.",
    es: 'Ese horario no está disponible. Le puedo ofrecer los horarios libres más cercanos.',
  },
  holdLost: {
    en: 'That hold ran out and the time is no longer available. I can offer the closest open times.',
    es: 'La reserva temporal venció y ese horario ya no está disponible. Le puedo ofrecer los horarios libres más cercanos.',
  },
  holdReplaced: {
    en: 'That booking was replaced by the newer one. I can read the new one back.',
    es: 'Esa reserva se reemplazó por la más reciente. Le puedo repetir la nueva.',
  },
  offGrid: {
    en: 'Appointments start on the quarter hour.',
    es: 'Las citas empiezan cada cuarto de hora.',
  },
  outsideLead: {
    en: "That time is outside the shop's booking window.",
    es: 'Ese horario está fuera del período de reservas del negocio.',
  },
  unknownService: {
    en: "I couldn't find that service.",
    es: 'No encontré ese servicio.',
  },
  ambiguousService: {
    en: 'We have more than one service by that name. Which one did you mean?',
    es: 'Tenemos más de un servicio con ese nombre. ¿Cuál quería?',
  },
  unknownStaff: {
    en: "I couldn't find that staff member.",
    es: 'No encontré a esa persona.',
  },
  ambiguousStaff: {
    en: 'We have more than one person by that name. Which one did you mean?',
    es: 'Tenemos más de una persona con ese nombre. ¿Con cuál quería?',
  },
  unknownBooking: {
    en: "I couldn't find that appointment.",
    es: 'No encontré esa cita.',
  },
  bookingChanged: {
    en: 'That appointment was just changed by the shop. I can check it again or take a message.',
    es: 'El negocio acaba de cambiar esa cita. Puedo revisarla de nuevo o dejar un mensaje.',
  },
  notChangeable: {
    en: "I can't change that appointment. I can take a message for the shop.",
    es: 'No puedo cambiar esa cita. Puedo dejarle un mensaje al negocio.',
  },
  noStaffForAll: {
    en: 'No one here does all of those services in one visit.',
    es: 'Aquí nadie hace todos esos servicios en una sola visita.',
  },
  noStaffForOne: {
    en: 'No one is set up to do that service right now.',
    es: 'Ahora mismo nadie hace ese servicio.',
  },
} as const satisfies Record<string, Record<ReadbackLang, string>>;

export type MessageKey = keyof typeof MESSAGES;

export function callerMessage(key: MessageKey, lang: ReadbackLang): string {
  return MESSAGES[key][lang];
}

export function staffMismatchMessage(staffName: string, many: boolean, lang: ReadbackLang): string {
  if (lang === 'es') return `${staffName} no hace ${many ? 'todos esos servicios' : 'ese servicio'}.`;
  return `${staffName} doesn't do ${many ? 'all of those services' : 'that service'}.`;
}

/** The cancellation-window policy text the agent states (spec §1.6 #8). */
export function cancellationPolicyText(hours: number, lang: ReadbackLang): string {
  if (lang === 'es') {
    return `La política del negocio pide al menos ${hours} ${hours === 1 ? 'hora' : 'horas'} de aviso para cambiar o cancelar una cita. Puedo dejarle un mensaje al negocio.`;
  }
  return `The shop's policy needs at least ${hours} ${hours === 1 ? "hour's" : "hours'"} notice to change or cancel an appointment. I can take a message for the shop.`;
}

export function pastAppointmentText(lang: ReadbackLang): string {
  if (lang === 'es') return 'Esa cita ya pasó, así que no la puedo cambiar. Puedo dejarle un mensaje al negocio.';
  return "That appointment has already started or passed, so I can't change it. I can take a message for the shop.";
}
