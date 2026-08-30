import { createLogger } from '../../../core/logger';
import { sendEmail } from '../../../email/EmailService';
import type { ToolContext, ToolDefinition } from '../../registry/types';
import { getToolLibraryEntry } from '../catalog';

const logger = createLogger('TOOL_SEND_EMAIL');

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function executeSendEmail(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<{ success: boolean; message: string; messageId?: string }> {
  const to = String(input.to ?? '').trim();
  const subject = String(input.subject ?? '').trim();
  const body = String(input.body ?? '').trim();
  const replyTo = input.replyTo ? String(input.replyTo).trim() : undefined;

  if (!to || !subject || !body) {
    return { success: false, message: 'to, subject, and body are required.' };
  }

  try {
    const result = await sendEmail({
      to,
      subject,
      text: body,
      html: `<p>${escapeHtml(body).replace(/\n/g, '<br/>')}</p>`,
      replyTo,
    });
    if (!result.success) {
      return { success: false, message: result.error || 'Email send failed.' };
    }
    return { success: true, message: 'Email sent.', messageId: result.messageId };
  } catch (err) {
    logger.error('send_email failed', { tenantId: context.tenantId, error: String(err) });
    return { success: false, message: 'Failed to send the email. Offer to try again or escalate.' };
  }
}

const entry = getToolLibraryEntry('send_email')!;

export const sendEmailTool: ToolDefinition = {
  name: entry.name,
  description: entry.description,
  inputSchema: entry.parameters,
  handler: (input, context) => executeSendEmail(input as Record<string, unknown>, context),
};
