/**
 * Auto-detect when OpenAI ships new (or removes) Realtime voices.
 *
 * The canonical list of voices we expose in the agent builder lives in
 * `client-app/src/lib/agentVoices.ts` (`VOICES`). Today that list is
 * updated by hand from the OpenAI changelog. The CI guard added in task
 * #709 catches *removals* (a voice still recommended for a language but
 * dropped from `VOICES` fails the test), but does NOT notice *additions*
 * — when OpenAI ships a new Realtime voice we want to find out within a
 * day so we can grade it per-language instead of months later.
 *
 * This script is the missing detector. It compares the voices supported
 * by OpenAI's Realtime API right now against `VOICES` and exits non-zero
 * (with a printed diff) when they disagree. Run on a daily schedule
 * from `.github/workflows/check-openai-realtime-voices.yml`, which
 * opens / updates a GitHub issue with the diff so the team is notified.
 *
 * --------------------------------------------------------------------
 * How discovery works
 * --------------------------------------------------------------------
 *   The Realtime API does not expose a "list voices" endpoint, but it
 *   *does* validate the `voice` parameter on session creation and (per
 *   OpenAI's standard validation-error shape) returns the full set of
 *   allowed enum values in the error message:
 *
 *     POST https://api.openai.com/v1/realtime/client_secrets
 *     {
 *       "expires_after": { "anchor": "created_at", "seconds": 60 },
 *       "session": {
 *         "type": "realtime",
 *         "model": "gpt-realtime",
 *         "audio": { "output": { "voice": "__qvo_invalid_probe__" } }
 *       }
 *     }
 *
 *   (The /v1/realtime/sessions endpoint used pre-GA returns 404 today.)
 *
 *     400 {
 *       "error": {
 *         "message": "Invalid value: '__qvo_invalid_probe__'. Supported
 *                     values are: 'alloy', 'ash', 'ballad', 'coral',
 *                     'echo', 'sage', 'shimmer', 'verse', 'marin',
 *                     'cedar'.",
 *         "type": "invalid_request_error",
 *         "param": "voice",
 *         "code": "invalid_value"
 *       }
 *     }
 *
 *   We send one deliberately-invalid probe and parse the allowed-value
 *   list out of `error.message`. Several regex patterns are tried so the
 *   script keeps working if OpenAI tweaks the wording (e.g.
 *   "Allowed values are", "must be one of"). When no pattern matches —
 *   typically because the error format changed in an unexpected way —
 *   the script exits non-zero with a "parser-broken" status so the
 *   workflow opens an issue and a human can update the parser. That is
 *   the desired failure mode: false positive (issue gets opened, human
 *   investigates) is much better than silently missing a new voice.
 *
 * --------------------------------------------------------------------
 * Required env
 * --------------------------------------------------------------------
 *   OPENAI_API_KEY — any project key with access to the Realtime API.
 *                    The probe creates an ephemeral session key (no
 *                    audio is synthesized, no spend) and even that is
 *                    *expected* to fail with 400, so the cost is zero.
 *
 * --------------------------------------------------------------------
 * Exit codes
 * --------------------------------------------------------------------
 *   0  — Discovered voice set matches the canonical `VOICES` list.
 *   1  — Diff detected (additions and/or removals). Body is a JSON
 *        document on stdout describing the diff.
 *   2  — Parser is broken (could not extract a voice list from the
 *        OpenAI response). Body is a JSON document on stdout with the
 *        raw response so the maintainer can update the parser.
 *   3  — Network / auth / unexpected error talking to OpenAI. Body is
 *        a JSON document on stdout with the failure reason.
 *
 * --------------------------------------------------------------------
 * Local usage
 * --------------------------------------------------------------------
 *   OPENAI_API_KEY=sk-... npx tsx scripts/check-openai-realtime-voices.ts
 *
 *   # Print the discovered set without comparing (debugging the parser):
 *   OPENAI_API_KEY=sk-... npx tsx scripts/check-openai-realtime-voices.ts --print-only
 */

import { VOICES } from '../client-app/src/lib/agentVoices';

// `/v1/realtime/sessions` is the deprecated beta endpoint — it now
// returns `HTTP 404 Invalid URL (POST /v1/realtime/sessions)`. The GA
// replacement is `POST /v1/realtime/client_secrets`, which still
// validates the `voice` field and (helpfully for our purposes) still
// emits the "Supported values are: ..." validation error the parser
// below knows how to read. The GA endpoint also no longer wants the
// `OpenAI-Beta: realtime=v1` header — sending it is harmless but the
// docs explicitly call for its removal on GA calls.
const REALTIME_CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const PROBE_MODEL = process.env.QVO_REALTIME_PROBE_MODEL ?? 'gpt-realtime';
const PROBE_VOICE = '__qvo_invalid_voice_probe__';
const REQUEST_TIMEOUT_MS = 15_000;

export interface VoiceDiff {
  added: string[];   // discovered − canonical (new voices OpenAI ships)
  removed: string[]; // canonical − discovered (voices OpenAI dropped)
}

export type CheckOutcome =
  | { status: 'in_sync'; discovered: string[]; canonical: string[] }
  | {
      status: 'drift';
      discovered: string[];
      canonical: string[];
      diff: VoiceDiff;
    }
  | {
      status: 'parser_broken';
      reason: string;
      rawResponse: { httpStatus: number; body: string };
    }
  | { status: 'request_failed'; reason: string };

/**
 * Extract the list of allowed voice ids from an OpenAI validation-error
 * message. Several patterns are tried so the parser keeps working across
 * minor OpenAI wording changes; returns `null` if none match.
 *
 * Exported so the unit test in
 * `tests/scripts/checkOpenaiRealtimeVoices.test.ts` can pin the
 * patterns we have observed in production today and prove the script
 * still catches them all if anyone refactors this function.
 */
export function parseAllowedVoicesFromErrorMessage(message: string): string[] | null {
  if (!message || typeof message !== 'string') return null;

  // Pattern 1 — "Supported values are: 'alloy', 'ash', 'ballad', ..."
  // Pattern 2 — "Allowed values are 'alloy', 'ash', ..."
  // Pattern 3 — "Must be one of: 'alloy', 'ash', ..."
  // Pattern 4 — "is not one of ['alloy', 'ash', ...]"
  // Pattern 5 — "voice must be one of alloy, ash, ballad, ..." (no quotes)
  // \b prefix is critical so "valid" doesn't match the substring inside
  // "Invalid value:" that precedes the actual list in OpenAI's typical
  // wording ("Invalid value: 'X'. Supported values are: 'a', 'b', ...").
  const introPatterns: RegExp[] = [
    /\b(?:supported|allowed|accepted|expected) values?(?:\s+(?:are|include))?\s*[:\s]\s*([^.]+?)(?:\.|$)/i,
    /\bmust be one of[:\s]+([^.]+?)(?:\.|$)/i,
    /\bis not one of\s*\[?\s*([^.\]]+?)\s*\]?(?:\.|$)/i,
    /\bone of the following[:\s]+([^.]+?)(?:\.|$)/i,
  ];

  let listSection: string | null = null;
  for (const re of introPatterns) {
    const m = message.match(re);
    if (m && m[1]) {
      listSection = m[1];
      break;
    }
  }
  if (!listSection) return null;

  // Now extract identifiers from the list section. Voice ids are short
  // lowercase tokens; we accept either quoted or bare comma/whitespace
  // separated values, and also tolerate "or" / "and" between the last
  // two items.
  const tokens = new Set<string>();

  // First pass: prefer single- or double-quoted tokens (most precise).
  const quotedRe = /['"`]([a-z][a-z0-9_-]{1,31})['"`]/gi;
  let m: RegExpExecArray | null;
  while ((m = quotedRe.exec(listSection)) !== null) {
    tokens.add(m[1].toLowerCase());
  }

  // If no quoted tokens, fall back to comma-separated bare identifiers.
  // We deliberately require lowercase ASCII so we don't accidentally
  // capture sentence words like "Are" or "Or" from prose.
  if (tokens.size === 0) {
    const bareRe = /\b([a-z][a-z0-9_-]{1,31})\b/g;
    while ((m = bareRe.exec(listSection)) !== null) {
      const tok = m[1].toLowerCase();
      // Filter out obvious English connector words that are sometimes
      // present even in the list section ("alloy, ash, or verse").
      if (tok === 'and' || tok === 'or') continue;
      tokens.add(tok);
    }
  }

  if (tokens.size === 0) return null;
  return Array.from(tokens).sort();
}

/**
 * Compute (added, removed) between the discovered voice set and the
 * canonical `VOICES` list. Both inputs are de-duplicated and sorted in
 * the result so output is stable for diffing in CI.
 */
export function diffVoiceSets(discovered: readonly string[], canonical: readonly string[]): VoiceDiff {
  const d = new Set(discovered.map((v) => v.toLowerCase()));
  const c = new Set(canonical.map((v) => v.toLowerCase()));
  const added: string[] = [];
  const removed: string[] = [];
  for (const v of d) if (!c.has(v)) added.push(v);
  for (const v of c) if (!d.has(v)) removed.push(v);
  added.sort();
  removed.sort();
  return { added, removed };
}

/**
 * Send the probe request and parse the response. Pulled out so the
 * unit test can drive it with a mocked `fetch`.
 */
export async function runVoiceCheck(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  canonical?: readonly string[];
}): Promise<CheckOutcome> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const canonical = options.canonical ?? VOICES;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let httpStatus = 0;
  let bodyText = '';
  try {
    // GA `/v1/realtime/client_secrets` body shape — see OpenAI docs.
    // `voice` now lives at `session.audio.output.voice`; the model is
    // at `session.model`; an `expires_after` is required. We send a
    // 60-second TTL so a leaked client_secret expires fast, in the
    // unlikely event the API DOES accept our deliberately-invalid
    // voice and mints one.
    const requestBody = {
      expires_after: { anchor: 'created_at', seconds: 60 },
      session: {
        type: 'realtime',
        model: PROBE_MODEL,
        audio: {
          output: {
            voice: PROBE_VOICE,
          },
        },
      },
    };
    const res = await fetchImpl(REALTIME_CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        // No `OpenAI-Beta: realtime=v1` header — that was for the
        // deprecated /v1/realtime/sessions beta. The GA docs
        // explicitly call for its removal on /v1/realtime/client_secrets.
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    httpStatus = res.status;
    bodyText = await res.text();
  } catch (err) {
    clearTimeout(timeout);
    return {
      status: 'request_failed',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  clearTimeout(timeout);

  // 401/403 mean the key is wrong, not that the API broke — surface that
  // distinctly so the workflow can flag a credentials problem rather
  // than alleging the parser is broken.
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      status: 'request_failed',
      reason: `OpenAI auth failed (HTTP ${httpStatus}). Check OPENAI_API_KEY.`,
    };
  }

  // 429 (rate limit) and 5xx (OpenAI infrastructure) are transient
  // upstream failures, not parser breakage — classify them as
  // `request_failed` so the workflow's alert wording matches reality
  // and so an opened tracking issue blames OpenAI rather than this
  // script. The script will retry on its next daily tick.
  if (httpStatus === 429 || httpStatus >= 500) {
    return {
      status: 'request_failed',
      reason:
        `OpenAI Realtime client_secrets endpoint returned HTTP ${httpStatus} ` +
        `(transient upstream failure). Body: ${bodyText.slice(0, 500)}`,
    };
  }

  // We *expect* 400 with a validation error. Any 2xx (which would mean
  // OpenAI accepted our nonsense voice id) is itself a signal that the
  // API contract changed — fail closed.
  if (httpStatus >= 200 && httpStatus < 300) {
    return {
      status: 'parser_broken',
      reason:
        `OpenAI accepted invalid voice "${PROBE_VOICE}" (HTTP ${httpStatus}). ` +
        `The Realtime API no longer validates the voice param the way this ` +
        `script assumes. Update scripts/check-openai-realtime-voices.ts.`,
      rawResponse: { httpStatus, body: bodyText.slice(0, 4000) },
    };
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    return {
      status: 'parser_broken',
      reason: `OpenAI returned non-JSON body (HTTP ${httpStatus}).`,
      rawResponse: { httpStatus, body: bodyText.slice(0, 4000) },
    };
  }

  const errorMessage =
    (parsedBody as { error?: { message?: unknown } } | null)?.error?.message;
  if (typeof errorMessage !== 'string') {
    return {
      status: 'parser_broken',
      reason: `OpenAI response had no error.message (HTTP ${httpStatus}).`,
      rawResponse: { httpStatus, body: bodyText.slice(0, 4000) },
    };
  }

  const discovered = parseAllowedVoicesFromErrorMessage(errorMessage);
  if (!discovered || discovered.length === 0) {
    return {
      status: 'parser_broken',
      reason:
        `Could not extract voice list from OpenAI error message. ` +
        `Update parseAllowedVoicesFromErrorMessage in ` +
        `scripts/check-openai-realtime-voices.ts to recognize the new wording.`,
      rawResponse: { httpStatus, body: bodyText.slice(0, 4000) },
    };
  }

  const diff = diffVoiceSets(discovered, canonical);
  const sortedCanonical = Array.from(new Set([...canonical].map((v) => v.toLowerCase()))).sort();
  if (diff.added.length === 0 && diff.removed.length === 0) {
    return { status: 'in_sync', discovered, canonical: sortedCanonical };
  }
  return { status: 'drift', discovered, canonical: sortedCanonical, diff };
}

function formatDriftSummary(outcome: Extract<CheckOutcome, { status: 'drift' }>): string {
  const lines: string[] = [];
  lines.push('OpenAI Realtime voice list drift detected.');
  lines.push('');
  if (outcome.diff.added.length > 0) {
    lines.push(`Added (${outcome.diff.added.length}) — present in OpenAI's API but missing from VOICES:`);
    for (const v of outcome.diff.added) lines.push(`  + ${v}`);
    lines.push('');
  }
  if (outcome.diff.removed.length > 0) {
    lines.push(`Removed (${outcome.diff.removed.length}) — in VOICES but no longer in OpenAI's API:`);
    for (const v of outcome.diff.removed) lines.push(`  - ${v}`);
    lines.push('');
  }
  lines.push('Discovered voices: ' + outcome.discovered.join(', '));
  lines.push('Canonical VOICES: ' + outcome.canonical.join(', '));
  lines.push('');
  lines.push('Next steps:');
  lines.push('  1. Update VOICES in client-app/src/lib/agentVoices.ts.');
  lines.push('  2. Grade each new voice per-language using the rubric in that file.');
  lines.push('  3. Update RECOMMENDED_VOICES_BY_LANGUAGE in agentLanguages.ts.');
  lines.push('  4. Update SUPPORTED_VOICES in server/admin-api/routes/voicePreview.ts.');
  lines.push('  5. Run `npm test -- voiceLanguageRecommendations` and confirm green.');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const printOnly = process.argv.includes('--print-only');
  const apiKey = (process.env.OPENAI_API_KEY ?? '').trim();
  if (!apiKey) {
    process.stdout.write(
      JSON.stringify(
        { status: 'request_failed', reason: 'OPENAI_API_KEY is not set' },
        null,
        2,
      ) + '\n',
    );
    process.exit(3);
  }

  const outcome = await runVoiceCheck({ apiKey });

  // Always emit a JSON document to stdout (consumed by the GitHub
  // Action) plus a human-readable summary on stderr.
  process.stdout.write(JSON.stringify(outcome, null, 2) + '\n');

  switch (outcome.status) {
    case 'in_sync':
      process.stderr.write(
        `OpenAI Realtime voices are in sync (${outcome.discovered.length} voices).\n`,
      );
      process.exit(0);
      break;
    case 'drift':
      process.stderr.write(formatDriftSummary(outcome) + '\n');
      process.exit(printOnly ? 0 : 1);
      break;
    case 'parser_broken':
      process.stderr.write(`Parser broken: ${outcome.reason}\n`);
      process.exit(printOnly ? 0 : 2);
      break;
    case 'request_failed':
      process.stderr.write(`Request failed: ${outcome.reason}\n`);
      process.exit(printOnly ? 0 : 3);
      break;
  }
}

// Only run main when invoked as a script (not when imported by tests).
// `import.meta.url` ends with the executed file path under tsx.
const invokedDirectly = (() => {
  try {
    const argv1 = process.argv[1] ?? '';
    return import.meta.url.endsWith(argv1.replace(/\\/g, '/'))
      || argv1.endsWith('check-openai-realtime-voices.ts');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`Unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(3);
  });
}
