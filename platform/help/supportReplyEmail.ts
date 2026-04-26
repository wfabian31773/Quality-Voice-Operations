/**
 * Pure helpers for rendering and addressing outbound admin replies on support
 * tickets. Extracted from server/admin-api/routes/support.ts so both the
 * Express route and the background SupportReplyRetryScheduler emit
 * byte-identical messages without pulling express into the platform layer.
 */

const INBOUND_DOMAIN = process.env.SUPPORT_INBOUND_DOMAIN ?? 'reply.qvo.ai';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function generateInboundToken(): string {
  // 24 hex chars (~96 bits) — collision risk is negligible.
  return Array.from({ length: 24 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join('');
}

export function buildReplyToAddress(token: string): string {
  return `support+${token}@${INBOUND_DOMAIN}`;
}

export function renderOutboundTicketReplyEmail(input: {
  ticketId: string;
  topic: string;
  body: string;
}): { subject: string; html: string; text: string } {
  const { ticketId, topic, body } = input;
  const subject = `Re: [QVO Support] ${topic.toUpperCase()} (${ticketId})`;
  const escaped = escapeHtml(body).replace(/\n/g, '<br/>');
  const html = `<div style="font-family:system-ui,sans-serif;color:#0f172a;max-width:640px">
    <div>${escaped}</div>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/>
    <p style="color:#64748b;font-size:12px">Ticket reference: <strong>${escapeHtml(ticketId)}</strong> — please keep this in the subject when replying.</p>
  </div>`;
  const text = `${body}\n\n---\nTicket reference: ${ticketId} — please keep this in the subject when replying.`;
  return { subject, html, text };
}
