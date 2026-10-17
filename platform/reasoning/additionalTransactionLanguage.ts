/**
 * Detects a request for another booking/transaction after one already finished.
 * Acknowledgments like "thanks for booking my appointment" must not match.
 */
export function isAdditionalTransactionRequest(utterance: string): boolean {
  const lower = utterance.toLowerCase();
  return (
    /\banother\b/.test(lower)
    || /\balso\s+book/.test(lower)
    || /\bone more\b/.test(lower)
    || /\bsecond appointment\b/.test(lower)
    || /\bfor my (?:son|daughter|friend)\b/.test(lower)
    || /\botra cita\b/.test(lower)
    || /\btambi[eé]n\b/.test(lower)
    || /\buna m[aá]s\b/.test(lower)
    || /\bpara mi (?:hijo|hija)\b/.test(lower)
  );
}
