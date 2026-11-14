import { intlLocale, phoneLast4, readbackLang, type ReadbackLang } from '../scheduling/readback';
import { formatAddress } from './address';
import type { CreateJobPrepareInput, DispatchWindow } from './schemas';

export { readbackLang } from '../scheduling/readback';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${JSON.stringify(options)}`;
  let dtf = formatters.get(key);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat(locale, { timeZone, ...options });
    formatters.set(key, dtf);
  }
  return dtf;
}

function plainSpaces(text: string): string {
  return text.replace(/[\u00a0\u202f]/g, ' ');
}

function localDateOf(ms: number, timeZone: string): string {
  const parts = formatter('en-US', timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

function diffDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

function clockParts(ms: number, timeZone: string, locale: string): { time: string; dayPeriod: string | undefined } {
  const onTheHour =
    Number(
      formatter('en-US', timeZone, { hour: 'numeric', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(ms)
        .find((p) => p.type === 'minute')?.value ?? '0',
    ) === 0;
  const parts = formatter(locale, timeZone, {
    hour: 'numeric',
    ...(onTheHour ? {} : { minute: '2-digit' }),
  }).formatToParts(ms);
  const dayPeriod = parts.find((p) => p.type === 'dayPeriod')?.value;
  const time = plainSpaces(
    parts
      .filter((p) => p.type !== 'dayPeriod')
      .map((p) => p.value)
      .join('')
      .trim(),
  );
  const period = dayPeriod ? plainSpaces(dayPeriod) : undefined;
  return { time, dayPeriod: period };
}

function spokenDay(ms: number, nowMs: number, timeZone: string, locale: string, lang: ReadbackLang): string {
  const days = diffDays(localDateOf(nowMs, timeZone), localDateOf(ms, timeZone));
  if (days === 0) return lang === 'es' ? 'hoy' : 'today';
  if (days === 1) return lang === 'es' ? 'mañana' : 'tomorrow';
  if (days > 1 && days <= 6) return formatter(locale, timeZone, { weekday: 'long' }).format(ms);
  return formatter(locale, timeZone, { weekday: 'long', month: 'long', day: 'numeric' }).format(ms);
}

function formatClock(ms: number, timeZone: string, locale: string, withPeriod: boolean): string {
  const { time, dayPeriod } = clockParts(ms, timeZone, locale);
  if (!withPeriod || !dayPeriod) return time;
  return `${time} ${dayPeriod}`;
}

/**
 * Arrival window as spoken language: a range, never an exact appointment time.
 * "tomorrow between 1 PM and 5 PM", not "tomorrow at 1:00".
 */
export function spokenWindow(
  window: DispatchWindow,
  nowMs: number,
  timeZone: string,
  locale: string | undefined,
): string {
  const lang = readbackLang(locale);
  const intl = intlLocale(locale);
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  const startDay = spokenDay(startMs, nowMs, timeZone, intl, lang);
  const sameDay = localDateOf(startMs, timeZone) === localDateOf(endMs, timeZone);
  const startClock = clockParts(startMs, timeZone, intl);
  const endClock = clockParts(endMs, timeZone, intl);
  const samePeriod = startClock.dayPeriod !== undefined && startClock.dayPeriod === endClock.dayPeriod;
  const startTime = formatClock(startMs, timeZone, intl, !sameDay || !samePeriod);
  const endTime = formatClock(endMs, timeZone, intl, true);

  if (!sameDay) {
    const endDay = spokenDay(endMs, nowMs, timeZone, intl, lang);
    if (lang === 'es') return `${startDay}, ${startTime}, hasta ${endDay}, ${endTime}`;
    return `${startDay} ${startTime} through ${endDay} ${endTime}`;
  }
  if (lang === 'es') return `${startDay} entre ${startTime} y ${endTime}`;
  return `${startDay} between ${startTime} and ${endTime}`;
}

export function createJobReadback(
  input: CreateJobPrepareInput,
  nowMs: number,
  timeZone: string,
  locale: string | undefined,
): string {
  const lang = readbackLang(locale);
  const address = formatAddress(input.address);
  const window = spokenWindow(input.window, nowMs, timeZone, locale);
  const last4 = phoneLast4(input.contact.phone);
  const urgent = input.urgency === 'urgent';
  if (lang === 'es') {
    const kind = urgent ? 'un trabajo urgente' : 'un trabajo';
    return `${kind} de ${input.jobType} en ${address}, ${window}, para ${input.contact.name}, teléfono que termina en ${last4}.`;
  }
  const kind = urgent ? 'an urgent' : 'a';
  return `${kind} ${input.jobType} job at ${address}, ${window}, for ${input.contact.name}, phone ending in ${last4}.`;
}
