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

export function hasCancelOrRescheduleLanguage(utterance: string): boolean {
  const lower = utterance.toLowerCase();
  return CANCEL_RESCHEDULE_PHRASES.some((phrase) => lower.includes(phrase));
}

export function inferCancelOrRescheduleAction(utterance: string): 'cancel' | 'reschedule' | null {
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
