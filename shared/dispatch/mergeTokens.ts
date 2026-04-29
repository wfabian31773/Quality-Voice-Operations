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
