/**
 * Single source of truth for the merge tokens that
 * `fireNotifications` (in `server/admin-api/routes/dispatch.ts`) is
 * able to substitute when it renders a dispatch notification template.
 *
 * The dispatch SMS/email template editor uses this list to:
 *   - render the help text (so dispatchers always see the live list of
 *     known tokens, no hand-maintained docs to drift),
 *   - flag unknown `{{...}}` tokens with an inline warning, and
 *   - block the save (server-side too) so a typo like
 *     `{{tracking_link}}` can never escape into a customer-facing SMS.
 *
 * Keep this list in lockstep with the substitution chain in
 * `fireNotifications` — the renderer pulls keys from the same constant
 * to guarantee the editor and the renderer can't drift apart.
 */

export const DISPATCH_MERGE_TOKENS = [
  'job_title',
  'contact_name',
  'eta',
  'eta_drive_minutes',
  'eta_arrival_time',
  'resource_name',
  'status',
  'address',
  'tracking_url',
] as const;

export type DispatchMergeToken = (typeof DISPATCH_MERGE_TOKENS)[number];

const KNOWN_TOKEN_SET: ReadonlySet<string> = new Set(DISPATCH_MERGE_TOKENS);

export function isKnownDispatchMergeToken(name: string): name is DispatchMergeToken {
  return KNOWN_TOKEN_SET.has(name);
}

// Match anything between `{{` and `}}` so we also catch malformed
// names like `{{tracking-url}}` or `{{ tracking link }}` — the
// renderer's substitute() only swaps tokens whose normalized name is
// in the allowlist, so any other braced sequence would otherwise leak
// through as raw text. Inner whitespace is normalized so
// `{{ contact_name }}` matches the allowlist exactly.
const MERGE_TOKEN_RE = /\{\{([^{}]*?)\}\}/g;

/**
 * Returns the deduped, ordered list of `{{token}}` references in
 * `template` whose names are NOT in {@link DISPATCH_MERGE_TOKENS}.
 *
 * Catches both unknown identifiers (`{{tracking_link}}`) and
 * malformed token shapes the renderer can't substitute
 * (`{{tracking-url}}`, `{{ tracking link }}`).
 *
 * Returns `[]` for any non-string input so callers can pass raw form
 * state without a guard.
 */
export function findUnknownDispatchMergeTokens(template: unknown): string[] {
  if (typeof template !== 'string' || template.length === 0) return [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const match of template.matchAll(MERGE_TOKEN_RE)) {
    const inner = match[1].trim();
    // Skip empty `{{}}` — there's nothing to flag and no substitution
    // would happen either way.
    if (inner.length === 0) continue;
    if (KNOWN_TOKEN_SET.has(inner)) continue;
    if (seen.has(inner)) continue;
    seen.add(inner);
    unknown.push(inner);
  }
  return unknown;
}

/**
 * Obvious-fake sample values used by the template editor's live
 * preview. They're deliberately recognizable as placeholders ("Jane
 * Doe", "Today 3:45 PM") so a dispatcher reviewing the preview can't
 * mistake it for a real customer message.
 *
 * Keep one entry per {@link DISPATCH_MERGE_TOKENS} key — the typed
 * Record makes it a compile error to add a new merge token without
 * giving the preview something to substitute.
 */
export const DISPATCH_MERGE_TOKEN_SAMPLES: Record<DispatchMergeToken, string> = {
  job_title: 'Kitchen sink leak repair',
  contact_name: 'Jane Doe',
  eta: 'Today 3:45 PM',
  eta_drive_minutes: '12',
  eta_arrival_time: 'Today 3:45 PM',
  resource_name: 'Alex Rivera',
  status: 'en route',
  address: '123 Main St, Springfield',
  tracking_url: 'https://example.com/track/abc123',
};

/**
 * Substitute `{{token}}` references in `template` using the supplied
 * value map. Mirrors the server-side `substitute()` helper in
 * `fireNotifications` so the editor's preview can't drift from what
 * customers actually receive: same tolerant whitespace handling
 * (`{{ contact_name }}`), same allowlist-only substitution (unknown
 * tokens are left as raw text so they show up in the preview the same
 * way they would in production).
 */
export function renderDispatchTemplate(
  template: string,
  values: Record<DispatchMergeToken, string> = DISPATCH_MERGE_TOKEN_SAMPLES,
): string {
  if (typeof template !== 'string' || template.length === 0) return '';
  let out = template;
  for (const token of DISPATCH_MERGE_TOKENS) {
    const re = new RegExp(`\\{\\{\\s*${token}\\s*\\}\\}`, 'g');
    out = out.replace(re, values[token]);
  }
  return out;
}

// SMS segment counting moved to `shared/sms/segments.ts` (task #845)
// so the dispatch template editor and the admin SMS-inbox composer
// can share one source of truth without one importing from the
// other's domain folder. Re-exported here for backward compatibility
// with callers that already import from this module (e.g. the
// existing dispatch merge-token tests).
export {
  countSmsSegments,
  type SmsEncoding,
  type SmsSegmentInfo,
} from '../sms/segments';
