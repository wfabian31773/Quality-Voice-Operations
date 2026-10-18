// Integer money helpers for the cost reconciler.
//
// Internal unit is micro-USD (1 USD = 1_000_000 micros, 1 cent = 10_000
// micros). Twilio prices carry at most 5 decimals of a dollar and the DB
// stores Twilio cents as NUMERIC(10,4), so both parse into micros exactly.
// Nothing here goes through a float; the report converts to cents once,
// at the end, with round-half-up.

export const MICROS_PER_CENT = 10_000;
export const MICROS_PER_USD = 1_000_000;

function assertSafe(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is outside the safe integer range`);
  return value;
}

/**
 * Parse a decimal string into an integer scaled by 10^digits, rounding
 * half away from zero past the last kept digit. `parseScaledDecimal("-0.01700", 6)`
 * is -17000. Rejects anything that is not a plain decimal (no exponents).
 */
export function parseScaledDecimal(raw: string, digits: number): number {
  const text = raw.trim();
  const match = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
    throw new Error('Not a plain decimal amount');
  }
  const negative = match[1] === '-';
  const whole = match[2] || '0';
  const fraction = match[3] ?? '';
  const kept = fraction.slice(0, digits).padEnd(digits, '0');
  const roundUp = fraction.length > digits && Number(fraction[digits]) >= 5;
  const magnitude = assertSafe(Number(whole + kept) + (roundUp ? 1 : 0), 'Amount');
  return negative && magnitude !== 0 ? -magnitude : magnitude;
}

/** Twilio `price` ("-0.01700", USD, negative = charged) → absolute micro-USD. */
export function usdStringToMicros(raw: string): number {
  return Math.abs(parseScaledDecimal(raw, 6));
}

/** A cents amount with up to 4 decimals (NUMERIC(10,4)) → micro-USD. */
export function centsStringToMicros(raw: string): number {
  return Math.abs(parseScaledDecimal(raw, 4));
}

/** Integer division rounded half away from zero. `den` must be > 0. */
export function roundDiv(num: number, den: number): number {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den <= 0) {
    throw new Error('roundDiv needs safe integers and a positive divisor');
  }
  const magnitude = Math.floor((Math.abs(num) * 2 + den) / (den * 2));
  return num < 0 ? -magnitude : magnitude;
}

export function microsToCents(micros: number): number {
  return roundDiv(micros, MICROS_PER_CENT);
}

export function sumMicros(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total = assertSafe(total + value, 'Total');
  return total;
}

/**
 * Cents per minute to two decimals, computed in integers:
 * hundredths = micros * 60 / (seconds * 100). Null when there are no seconds.
 */
export function centsPerMinute(micros: number, seconds: number): number | null {
  if (seconds <= 0) return null;
  return roundDiv(micros * 60, seconds * 100) / 100;
}

/** Seconds as minutes to two decimals (display only, never summed). */
export function secondsToMinutes(seconds: number): number {
  return roundDiv(seconds * 100, 60) / 100;
}

/** `part / whole` as a percent with one decimal. Null when `whole` is 0. */
export function percentOf(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return roundDiv(part * 1000, whole) / 10;
}
