const CANCEL_RESCHEDULE_PHRASES = [
  'cancel',
  'cancellation',
  'cancelar',
  'cancelación',
  'cancelacion',
  'reschedule',
  'reprogramar',
  'move my',
  'mover la cita',
  'mover mi cita',
  'change my appointment',
  'change my cita',
  'cambiar la cita',
  'cambiar mi cita',
  'cambiar cita',
];

function isPolicyOrNegatedCancel(utterance: string): boolean {
  const lower = utterance.toLowerCase();
  if (/\b(?:cancellation|cancel|cancelaci[oó]n)\s+polic(?:y|ies)\b/.test(lower)) return true;
  if (/\bpol[ií]tica de cancelaci[oó]n\b/.test(lower)) return true;
  if (/\b(?:do not|don't|dont)\s+(?:cancel|reschedule|cancelar)\b/.test(lower)) return true;
  if (/\bno\s+cancel[eé]s?(?:\s+mi\s+cita)?\b/.test(lower)) return true;
  if (/\bno\s+cancelar\b/.test(lower)) return true;
  return false;
}

export function hasCancelOrRescheduleLanguage(utterance: string): boolean {
  if (isPolicyOrNegatedCancel(utterance)) return false;
  const lower = utterance.toLowerCase();
  return CANCEL_RESCHEDULE_PHRASES.some((phrase) => lower.includes(phrase));
}

export function inferCancelOrRescheduleAction(utterance: string): 'cancel' | 'reschedule' | null {
  if (isPolicyOrNegatedCancel(utterance)) return null;
  const lower = utterance.toLowerCase();
  if (/\bcancel(?:ar|aci[oó]n|lation)?\b/.test(lower)) return 'cancel';
  if (
    /\b(?:reschedule|reprogramar)\b/.test(lower)
    || /mover (?:la |mi )?cita/.test(lower)
    || /cambiar (?:la |mi )?cita/.test(lower)
    || /\bmove my\b/.test(lower)
    || /\bchange my (?:appointment|cita)\b/.test(lower)
  ) {
    return 'reschedule';
  }
  return hasCancelOrRescheduleLanguage(utterance) ? 'reschedule' : null;
}
