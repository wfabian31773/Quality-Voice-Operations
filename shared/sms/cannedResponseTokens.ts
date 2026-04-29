/**
 * Single source of truth for the merge tokens that
 * `useTemplate()` (in `client-app/src/pages/SmsInbox.tsx`) is able to
 * substitute when an agent inserts a canned-response template into the
 * SMS reply box.
 *
 * The SMS Inbox canned-response editor uses this list to:
 *   - render the help text (so editors always see the live list of
 *     known tokens, no hand-maintained docs to drift),
 *   - flag unknown `{{...}}` tokens with an inline warning, and
 *   - block the save (server-side too) so a typo like
 *     `{{custmer_name}}` can never escape into a customer-facing SMS.
 *
 * Keep this list in lockstep with the substitution chain in
 * `useTemplate()` — the renderer pulls keys from the same constant
 * to guarantee the editor and the renderer can't drift apart.
 */

export const SMS_CANNED_RESPONSE_TOKENS = [
  'name',
  'phone',
  'contact_name',
  'contact_email',
  'contact_location',
  'agent_name',
] as const;

export type SmsCannedResponseToken = (typeof SMS_CANNED_RESPONSE_TOKENS)[number];

// Case-insensitive lookup so we stay aligned with `useTemplate()` in
// `client-app/src/pages/SmsInbox.tsx`, whose substitution regex uses
// the `gi` flag — i.e. it will substitute `{{Name}}` and `{{NAME}}`
// just as it does `{{name}}`. If validation were case-sensitive while
// the renderer was not, an editor could be told a perfectly-rendered
// token was "unknown" and Save would be blocked.
const KNOWN_TOKEN_SET: ReadonlySet<string> = new Set(
  SMS_CANNED_RESPONSE_TOKENS.map((t) => t.toLowerCase()),
);

export function isKnownSmsCannedResponseToken(name: string): name is SmsCannedResponseToken {
  return KNOWN_TOKEN_SET.has(name.toLowerCase());
}

// Match anything between `{{` and `}}` so we also catch malformed
// names like `{{contact-name}}` or `{{ contact name }}` — the
// renderer's substitute() only swaps tokens whose normalized name is
// in the allowlist, so any other braced sequence would otherwise leak
// through as raw text. Inner whitespace is normalized so
// `{{ contact_name }}` matches the allowlist exactly.
const MERGE_TOKEN_RE = /\{\{([^{}]*?)\}\}/g;

/**
 * Returns the deduped, ordered list of `{{token}}` references in
 * `template` whose names are NOT in {@link SMS_CANNED_RESPONSE_TOKENS}.
 *
 * Catches both unknown identifiers (`{{custmer_name}}`) and
 * malformed token shapes the renderer can't substitute
 * (`{{contact-name}}`, `{{ contact name }}`).
 *
 * Returns `[]` for any non-string input so callers can pass raw form
 * state without a guard.
 */
export function findUnknownSmsCannedResponseTokens(template: unknown): string[] {
  if (typeof template !== 'string' || template.length === 0) return [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const match of template.matchAll(MERGE_TOKEN_RE)) {
    const inner = match[1].trim();
    // Skip empty `{{}}` — there's nothing to flag and no substitution
    // would happen either way.
    if (inner.length === 0) continue;
    // Compare lowercased so `{{Name}}` / `{{NAME}}` are accepted —
    // the renderer's substitution regex (in SmsInbox.tsx useTemplate)
    // uses the `gi` flag, so it would substitute them just fine.
    if (KNOWN_TOKEN_SET.has(inner.toLowerCase())) continue;
    if (seen.has(inner)) continue;
    seen.add(inner);
    unknown.push(inner);
  }
  return unknown;
}
