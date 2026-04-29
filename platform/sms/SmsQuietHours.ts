import { evaluateQuietHours, type QuietHoursDecision, type QuietHoursConfig } from '../campaigns/QuietHours';

/**
 * TCPA-aligned quiet hours for outbound SMS.
 *
 * The TCPA's 8:00am–9:00pm "called party local time" window applies to texts
 * just like voice calls. Unlike voice campaigns — where each tenant can
 * tighten the window via the campaign config — SMS is enforced platform-wide
 * with the federal default so a single misconfigured tenant cannot send
 * after-hours blasts to consumers in other timezones.
 *
 * The recipient's timezone is always inferred from their NANP area code via
 * the same map used by `CampaignScheduler` so voice and SMS stay consistent.
 */
export const SMS_QUIET_HOURS_WINDOW_START = '08:00';
export const SMS_QUIET_HOURS_WINDOW_END = '21:00';

const SMS_QUIET_HOURS_CONFIG: QuietHoursConfig = {
  callWindowStart: SMS_QUIET_HOURS_WINDOW_START,
  callWindowEnd: SMS_QUIET_HOURS_WINDOW_END,
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  respectContactTimezone: true,
};

/**
 * Evaluate whether an outbound SMS to `toNumber` is currently allowed under
 * the TCPA quiet-hours rules. Wraps the same `evaluateQuietHours` helper the
 * voice path uses so behavior stays consistent across channels.
 */
export function evaluateSmsQuietHours(
  toNumber: string,
  now: Date = new Date(),
): QuietHoursDecision {
  return evaluateQuietHours(toNumber, SMS_QUIET_HOURS_CONFIG, now);
}

/**
 * Compute the next UTC instant at which the SMS quiet-hours window opens for
 * `toNumber`'s local timezone. Used by the scheduled-message dispatcher to
 * defer messages that come due outside the window instead of dropping them.
 *
 * Returns `now` unchanged when the recipient is already inside the window.
 */
export function nextSmsWindowStart(toNumber: string, now: Date = new Date()): Date {
  const decision = evaluateSmsQuietHours(toNumber, now);
  if (decision.allowed) return now;
  const timezone = decision.timezone;

  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;
  const localHour = parseInt(lookup.hour ?? '0', 10);
  const localMin = parseInt(lookup.minute ?? '0', 10);
  const localSec = parseInt(lookup.second ?? '0', 10);

  const minutesSinceMidnight = localHour * 60 + localMin;
  const startMin = parseHHMM(SMS_QUIET_HOURS_WINDOW_START);
  const endMin = parseHHMM(SMS_QUIET_HOURS_WINDOW_END);

  let minutesUntilWindow: number;
  if (minutesSinceMidnight < startMin) {
    minutesUntilWindow = startMin - minutesSinceMidnight;
  } else if (minutesSinceMidnight >= endMin) {
    minutesUntilWindow = (24 * 60 - minutesSinceMidnight) + startMin;
  } else {
    return now;
  }

  const millisUntilWindow = minutesUntilWindow * 60_000 - localSec * 1_000;
  return new Date(now.getTime() + Math.max(60_000, millisUntilWindow));
}

function parseHHMM(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}
