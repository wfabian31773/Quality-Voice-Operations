// A day's working hours the way the agent says them on a call: 12-hour clock,
// "9 AM to 5 PM" / "9 a. m. a 5 p. m.", noon and midnight by name. Pure (no
// imports), so the quality sim's fake list_staff says hours exactly alike.

export type SpokenHoursLang = 'en' | 'es';

/** 'HH:MM' (00:00–24:00) → spoken 12-hour time, or null when it isn't a clock time. */
function spokenClock(text: string, lang: SpokenHoursLang): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 24 || m > 59 || (h === 24 && m > 0)) return null;
  if (m === 0 && h === 12) return lang === 'es' ? '12 del mediodía' : 'noon';
  if (m === 0 && (h === 0 || h === 24)) return lang === 'es' ? '12 de la noche' : 'midnight';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const pm = h % 24 >= 12;
  const suffix = lang === 'es' ? (pm ? 'p. m.' : 'a. m.') : pm ? 'PM' : 'AM';
  return `${hour12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${suffix}`;
}

/**
 * list_staff's 'HH:MM-HH:MM' day text (split shifts joined with ', ') →
 * "9 AM to noon and 1 PM to 4 PM". Null for a day with no hours.
 */
export function spokenHours(hours: string | undefined, lang: SpokenHoursLang): string | null {
  const ranges: string[] = [];
  for (const block of (hours ?? '').split(',')) {
    if (!block.trim()) continue;
    const [start, end, extra] = block.split('-');
    const from = start === undefined ? null : spokenClock(start, lang);
    const to = end === undefined ? null : spokenClock(end, lang);
    if (!from || !to || extra !== undefined) return null;
    ranges.push(`${from} ${lang === 'es' ? 'a' : 'to'} ${to}`);
  }
  return ranges.length ? ranges.join(lang === 'es' ? ' y ' : ' and ') : null;
}

/** The spoken form of every day in `hours` that has any. */
export function spokenWeek<K extends string>(hours: Partial<Record<K, string>>, lang: SpokenHoursLang): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const [day, text] of Object.entries(hours) as [K, string | undefined][]) {
    const spoken = spokenHours(text, lang);
    if (spoken) out[day] = spoken;
  }
  return out;
}
