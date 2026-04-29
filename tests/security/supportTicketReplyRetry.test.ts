import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const supportFile = readFileSync(
  join(process.cwd(), 'server/admin-api/routes/support.ts'),
  'utf8',
);
const sharedReplyHelperFile = readFileSync(
  join(process.cwd(), 'platform/help/supportReplyEmail.ts'),
  'utf8',
);
const adminUiFile = readFileSync(
  join(process.cwd(), 'client-app/src/pages/PlatformAdmin.tsx'),
  'utf8',
);

describe('support ticket reply retry — server', () => {
  it('exposes a POST /support/tickets/:id/replies/:replyId/retry endpoint behind admin auth', () => {
    expect(supportFile).toMatch(
      /router\.post\(\s*'\/support\/tickets\/:id\/replies\/:replyId\/retry'/,
    );
    // Auth middleware is applied to the retry route (search the surrounding block).
    const retryRouteIdx = supportFile.indexOf("'/support/tickets/:id/replies/:replyId/retry'");
    expect(retryRouteIdx).toBeGreaterThan(-1);
    const retryRouteSlice = supportFile.slice(retryRouteIdx, retryRouteIdx + 400);
    expect(retryRouteSlice).toMatch(/requireAuth/);
    expect(retryRouteSlice).toMatch(/requirePlatformAdmin/);
  });

  it('refuses to retry inbound replies or already-Sent replies', () => {
    expect(supportFile).toMatch(/Only outbound replies can be retried/);
    expect(supportFile).toMatch(/nothing to retry/);
  });

  it('updates the existing reply row in place rather than inserting a new one', () => {
    // The retry path issues an UPDATE against support_ticket_replies that
    // overwrites email_message_id and email_error.
    expect(supportFile).toMatch(
      /UPDATE support_ticket_replies\s+SET email_message_id = \$2, email_error = \$3/,
    );
  });

  it('shares the email-rendering helper with the initial send so retry payloads match', () => {
    // The renderer now lives in platform/help/supportReplyEmail.ts so both the
    // route and the background auto-retry scheduler can reuse it.
    expect(sharedReplyHelperFile).toMatch(/export function renderOutboundTicketReplyEmail/);
    expect(supportFile).toMatch(
      /from '\.\.\/\.\.\/\.\.\/platform\/help\/supportReplyEmail'/,
    );
    // Both the create-reply route and the manual /retry route call the shared helper.
    const usages = supportFile.match(/renderOutboundTicketReplyEmail\(/g) ?? [];
    expect(usages.length).toBeGreaterThanOrEqual(2);
  });

  it('re-sends to the original recipient via the existing SMTP path with the inbound reply-to', () => {
    const retryRouteIdx = supportFile.indexOf("'/support/tickets/:id/replies/:replyId/retry'");
    expect(retryRouteIdx).toBeGreaterThan(-1);
    // Slice from the retry route declaration up to the start of the next
    // `router.` declaration (or end of file) so the assertion keeps locating
    // sendEmail() no matter how much the handler body grows. Earlier versions
    // used a fixed-size window (4000, then 12000 chars) which kept drifting
    // out of date as the handler accreted hard-bounce skip blocks,
    // suppression / unsubscribe pre-checks, alert-escalation logic, and the
    // retry_skipped_reason / cooldown response fields.
    const afterRetryRoute = supportFile.slice(retryRouteIdx + 1);
    const nextRouterRel = afterRetryRoute.search(/\brouter\.[a-z]+\(/);
    const handlerEnd =
      nextRouterRel === -1 ? supportFile.length : retryRouteIdx + 1 + nextRouterRel;
    const retryRouteSlice = supportFile.slice(retryRouteIdx, handlerEnd);
    // sendEmail call uses ticket.user_email and buildReplyToAddress(token).
    expect(retryRouteSlice).toMatch(/sendEmail\(/);
    expect(retryRouteSlice).toMatch(/to:\s*ticket\.user_email/);
    expect(retryRouteSlice).toMatch(/replyTo:\s*buildReplyToAddress\(token\)/);
  });
});

describe('support ticket reply retry — admin UI', () => {
  it('renders a Retry send button next to the Failed badge for failed outbound replies', () => {
    expect(adminUiFile).toMatch(/Retry send/);
    // The button is gated on outbound + email_error + not a permanent SMTP
    // failure + a recipient address. The permanent-failure check mirrors the
    // server-side hard-bounce skip so admins don't burn sender reputation
    // re-sending to a clearly undeliverable address.
    expect(adminUiFile).toMatch(
      /const canRetry =\s*\n?\s*isOutbound && !!r\.email_error && !isPermanentFailure && !!ticket\.user_email/,
    );
  });

  it('calls the retry endpoint with the reply id and refreshes the thread on success', () => {
    expect(adminUiFile).toMatch(
      /\/support\/tickets\/\$\{ticket\.id\}\/replies\/\$\{replyId\}\/retry/,
    );
    expect(adminUiFile).toMatch(
      /queryClient\.invalidateQueries\(\{ queryKey: \['support-ticket-replies', ticket\.id\] \}\)/,
    );
  });

  it('surfaces a per-reply retry error when the new send also fails', () => {
    expect(adminUiFile).toMatch(/setRetryErrors/);
    expect(adminUiFile).toMatch(/Retry failed:/);
  });
});
