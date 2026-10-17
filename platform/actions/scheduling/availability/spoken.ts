import { diffDays, localDateOf, localMinuteOf } from './time';

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

/** ICU puts narrow/no-break spaces before AM/PM; TTS and tests want plain ones. */
function plainSpaces(text: string): string {
  return text.replace(/[  ]/g, ' ');
}

function isEnglish(locale: string): boolean {
  return locale.toLowerCase().startsWith('en');
}

/**
 * How the agent says a slot start, relative to `now` in the tenant timezone:
 * "today at 2 PM", "tomorrow at 10 AM", "Tuesday at 3:30 PM", and with the
 * date once it is more than six days out ("Tuesday, October 27 at 3:30 PM").
 */
export function spokenSlot(ms: number, nowMs: number, timeZone: string, locale = 'en-US'): string {
  const days = diffDays(localDateOf(nowMs, timeZone), localDateOf(ms, timeZone));
  const onTheHour = localMinuteOf(ms, timeZone) % 60 === 0;
  const time = plainSpaces(
    formatter(locale, timeZone, onTheHour ? { hour: 'numeric' } : { hour: 'numeric', minute: '2-digit' }).format(ms),
  );

  let day: string;
  if (days === 0 || days === 1) {
    day = isEnglish(locale)
      ? (days === 0 ? 'today' : 'tomorrow')
      : new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(days, 'day');
  } else if (days > 1 && days <= 6) {
    day = formatter(locale, timeZone, { weekday: 'long' }).format(ms);
  } else {
    day = formatter(locale, timeZone, { weekday: 'long', month: 'long', day: 'numeric' }).format(ms);
  }
  return isEnglish(locale) ? `${day} at ${time}` : `${day}, ${time}`;
}
