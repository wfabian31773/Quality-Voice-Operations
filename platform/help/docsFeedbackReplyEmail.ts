/**
 * Shared HTML/text renderer for outbound docs feedback reply emails.
 *
 * Extracted from the manual reply path in
 * server/admin-api/routes/support.ts so the auto-retry scheduler
 * (DocsFeedbackReplyRetryScheduler) re-sends the exact same email body that
 * the admin UI originally sent — no rendering drift between the two paths,
 * the way SupportReplyRetryScheduler shares renderOutboundTicketReplyEmail()
 * with the manual support-reply retry path.
 */

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface DocsFeedbackReplyEmailInput {
  /** Article slug the reader gave feedback on (e.g. "getting-started"). */
  articleSlug: string;
  /** Optional original feedback comment to quote back to the reader. */
  originalComment: string | null;
  /** Plain-text body the admin entered. */
  body: string;
}

export interface DocsFeedbackReplyEmailOutput {
  html: string;
  text: string;
}

export function renderDocsFeedbackReplyEmail(
  input: DocsFeedbackReplyEmailInput,
): DocsFeedbackReplyEmailOutput {
  const { articleSlug, originalComment, body } = input;
  const escapedBody = escape(body).replace(/\n/g, '<br/>');
  const originalBlock = originalComment
    ? `<hr style="margin:16px 0;border:none;border-top:1px solid #e5e7eb"/>
       <p style="color:#64748b;font-size:12px;margin:0 0 4px">You wrote about <code>${escape(articleSlug)}</code>:</p>
       <blockquote style="margin:0;padding:8px 12px;border-left:3px solid #cbd5e1;color:#475569;background:#f8fafc;font-size:13px;white-space:pre-wrap">${escape(originalComment)}</blockquote>`
    : '';
  const html = `
    <div style="font-family:system-ui,sans-serif;color:#0f172a;max-width:640px">
      <p style="white-space:pre-wrap">${escapedBody}</p>
      ${originalBlock}
      <p style="color:#64748b;font-size:12px;margin-top:16px">— The QVO docs team</p>
    </div>`;
  const textOriginal = originalComment
    ? `\n\n----- Your original feedback (${articleSlug}) -----\n${originalComment}`
    : '';
  const text = `${body}\n${textOriginal}\n\n— The QVO docs team`;
  return { html, text };
}
