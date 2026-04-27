/**
 * Helpers for parsing the STIR/SHAKEN telemetry that Twilio includes on
 * outbound call status callbacks.
 *
 * Twilio surfaces three relevant fields on a status callback:
 *   - StirStatus   : high-level signing status (`signed`, `not-signed`,
 *                    `failed`, ...).
 *   - StirVerstat  : the SIP `verstat` value the terminating carrier
 *                    reported. Encodes the attestation level we surface
 *                    in the Calls UI. Examples:
 *                      `TN-Validation-Passed-A` → attestation A
 *                      `TN-Validation-Passed-B` → attestation B
 *                      `TN-Validation-Passed-C` → attestation C
 *                      `TN-Validation-Failed-A` → attestation failed (A signer)
 *                      `No-TN-Validation`       → no attestation reported
 *   - StirPassportToken : the JWT we don't currently persist.
 *
 * `extractStirTelemetry` is intentionally tolerant — Twilio occasionally
 * sends mixed casing or new verstat strings, so we accept anything that
 * looks like the documented shape rather than a strict allow-list.
 */

export type AttestationLetter = 'A' | 'B' | 'C';

export interface StirTelemetry {
  /** Raw Twilio `StirStatus` (lower-cased), or null if not provided. */
  status: string | null;
  /** Raw Twilio `StirVerstat`, preserved as-sent (trimmed) for debugging. */
  verstat: string | null;
  /** Derived attestation letter A/B/C, or null when the verstat carries
   *  no usable attestation (failed, no validation, unknown shape). */
  attestation: AttestationLetter | null;
}

function pickString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Parse the attestation letter (A / B / C) out of a Twilio `StirVerstat`.
 *
 * Returns null when the verstat indicates a failed validation, no
 * validation was performed, or the value doesn't look like a documented
 * verstat string at all. Callers that need to render a "failed" badge
 * should look at `StirTelemetry.status` / the raw verstat instead.
 */
export function parseAttestationLetter(verstat: string | null | undefined): AttestationLetter | null {
  const v = pickString(verstat);
  if (!v) return null;
  // Normalise: Twilio docs use Title-Case but some carriers echo
  // lower-case or mixed-case, and we shouldn't drop those on the floor.
  const upper = v.toUpperCase();
  // Only `*-Passed-X` indicates a real attestation level we can show
  // with confidence. `*-Failed-*` and `No-TN-Validation` deliberately
  // return null so the UI shows a warning instead of a misleading
  // "attested A" badge.
  const match = /TN-VALIDATION-PASSED-([ABC])\b/.exec(upper);
  if (!match) return null;
  return match[1] as AttestationLetter;
}

/**
 * Extract STIR telemetry from a Twilio status callback request body.
 *
 * Returns null when the callback contains no STIR fields at all (the
 * common case for inbound calls and demo traffic). When at least one
 * STIR field is present we always return an object so the persistence
 * layer can clear stale values for re-sent callbacks.
 */
export function extractStirTelemetry(body: Record<string, unknown> | null | undefined): StirTelemetry | null {
  if (!body || typeof body !== 'object') return null;
  const status = pickString((body as Record<string, unknown>).StirStatus);
  const verstat = pickString((body as Record<string, unknown>).StirVerstat);
  if (status === null && verstat === null) return null;
  return {
    status: status ? status.toLowerCase() : null,
    verstat,
    attestation: parseAttestationLetter(verstat),
  };
}

/**
 * Should the Calls UI show a warning badge for this telemetry?
 *
 * We warn whenever the carrier downgraded the attestation (B or C),
 * explicitly failed to validate, or signed but reported a non-success
 * status. Calls with a clean A attestation, or no STIR data at all,
 * do not warn.
 */
export function isStirAttestationDegraded(telemetry: StirTelemetry | null | undefined): boolean {
  if (!telemetry) return false;
  if (telemetry.attestation === 'B' || telemetry.attestation === 'C') return true;
  const status = telemetry.status?.toLowerCase() ?? null;
  if (status === 'failed' || status === 'not-signed') return true;
  const verstat = telemetry.verstat?.toUpperCase() ?? null;
  if (verstat && /TN-VALIDATION-FAILED/.test(verstat)) return true;
  return false;
}
