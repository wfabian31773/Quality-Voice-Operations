/**
 * Detects a request for another booking/transaction after one already finished.
 * Acknowledgments like "thanks for booking my appointment" must not match.
 * Negated declines ("I don't need another", "no quiero otra cita") must not match.
 */
const BOOKING_OR_SERVICE =
  /(?:book(?:ing)?|appointment|haircut|fade|trim|color|highlight|blowout|manicure|pedicure|nails|beard|shave|stylist|barber|schedule|slot|reservar|reserva|cita|agendar)/;

export function isAdditionalTransactionRequest(utterance: string): boolean {
  const lower = utterance.toLowerCase();
  if (isNegatedAdditionalTransaction(lower)) return false;
  return (
    /\banother\b/.test(lower)
    || /\balso\s+book/.test(lower)
    || /\bone more\b/.test(lower)
    || /\bsecond appointment\b/.test(lower)
    || /\bfor my (?:son|daughter|friend)\b/.test(lower)
    || hasAlsoModifierWithBookingContext(lower)
    || /\botra\b/.test(lower)
    || /\botra cita\b/.test(lower)
    || /\buna m[aá]s\b/.test(lower)
    || /\bpara mi (?:hijo|hija)\b/.test(lower)
  );
}

function hasAlsoModifierWithBookingContext(lower: string): boolean {
  const hasAlso = /\btoo\b/.test(lower) || /\bas well\b/.test(lower) || /\btambi[eé]n\b/.test(lower);
  if (!hasAlso) return false;
  return new RegExp(`\\b${BOOKING_OR_SERVICE.source}\\b`).test(lower);
}

function isNegatedAdditionalTransaction(lower: string): boolean {
  if (/\b(?:do not|don't|dont)\b[\s\S]{0,40}\b(?:another|one more|a second|other)\b/.test(lower)) {
    return true;
  }
  if (/\bno need(?:\s+for)?\b[\s\S]{0,20}\b(?:another|one more|other)\b/.test(lower)) return true;
  if (/\bno other\b/.test(lower) || /\bnot another\b/.test(lower)) return true;
  if (/\bno\s+(?:quiero|necesito)(?:\s+reservar)?\s+(?:otra|otro|una m[aá]s)\b/.test(lower)) return true;
  if (/\bno\s+me\s+reserv[eé]\s+(?:otra|otro)\b/.test(lower)) return true;
  if (/\bno\s+reserv[eé]s?\s+(?:otra|otro)\b/.test(lower)) return true;
  if (/\bno\s+otra\b/.test(lower)) return true;
  return false;
}
