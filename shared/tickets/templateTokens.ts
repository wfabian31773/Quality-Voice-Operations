/**
 * Single source of truth for the merge tokens that
 * `insertTemplate()` (in `client-app/src/pages/TicketDetail.tsx`) is
 * able to substitute when an agent drops a canned ticket-template
 * reply into the note composer.
 *
 * The Tickets template editor uses this list to:
 *   - render the help text (so editors always see the live list of
 *     known tokens, no hand-maintained docs to drift),
 *   - flag unknown `{{...}}` tokens with an inline warning, and
 *   - block the save (server-side too) so a typo like
 *     `{{custmer_name}}` can never escape into a customer-facing
 *     ticket reply.
 *
 * Keep this list in lockstep with the substitution chain in
 * `insertTemplate()` — the renderer pulls keys from the same constant
 * to guarantee the editor and the renderer can't drift apart.
 */

export const TICKET_TEMPLATE_TOKENS = [
  'ticket_number',
  'subject',
  'status',
  'priority',
  'contact_name',
  'contact_email',
  'contact_phone',
  'department',
  'assignee',
  'created_at',
] as const;

export type TicketTemplateToken = (typeof TICKET_TEMPLATE_TOKENS)[number];

const KNOWN_TOKEN_SET: ReadonlySet<string> = new Set(TICKET_TEMPLATE_TOKENS);

export function isKnownTicketTemplateToken(name: string): name is TicketTemplateToken {
  return KNOWN_TOKEN_SET.has(name);
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
 * `template` whose names are NOT in {@link TICKET_TEMPLATE_TOKENS}.
 *
 * Catches both unknown identifiers (`{{custmer_name}}`) and
 * malformed token shapes the renderer can't substitute
 * (`{{contact-name}}`, `{{ contact name }}`).
 *
 * Returns `[]` for any non-string input so callers can pass raw form
 * state without a guard.
 */
export function findUnknownTicketTemplateTokens(template: unknown): string[] {
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
