import { createLogger } from '../../../core/logger';
import { getPlatformPool } from '../../../db';
import { getTwilioCredentials, sendTwilioSms } from '../../../integrations/twilio/sender';
import { getOrCreateConversation, saveMessage } from '../../../sms/SmsConversationService';
import type { ToolContext, ToolDefinition } from '../../registry/types';
import { getToolLibraryEntry } from '../catalog';

const logger = createLogger('TOOL_SEND_SMS');

export async function executeSendSms(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<{ success: boolean; message: string; sid?: string }> {
  const toNumber = String(input.toNumber ?? '').trim();
  const body = String(input.body ?? '').trim();
  if (!toNumber || !body) {
    return { success: false, message: 'toNumber and body are required.' };
  }

  const creds = await getTwilioCredentials(context.tenantId);
  if (!creds) {
    return { success: false, message: 'SMS is not configured for this tenant.' };
  }

  const fromNumber = String(input.fromNumber ?? creds.phoneNumber ?? '').trim();
  if (!fromNumber) {
    return { success: false, message: 'No from-number is configured for SMS.' };
  }

  try {
    const result = await sendTwilioSms(context.tenantId, toNumber, fromNumber, body);
    const pool = getPlatformPool();
    const { rows } = await pool.query(
      `SELECT id FROM phone_numbers WHERE tenant_id = $1 AND phone_number IN ($2, $3) LIMIT 1`,
      [context.tenantId, fromNumber, toNumber],
    );
    const phoneNumberId = rows[0]?.id as string | undefined;
    if (phoneNumberId) {
      const conversation = await getOrCreateConversation(context.tenantId, phoneNumberId, toNumber);
      await saveMessage(context.tenantId, conversation.id, {
        direction: 'outbound',
        fromNumber,
        toNumber,
        body,
        status: 'sent',
        twilioSid: result.sid,
      });
    }
    return { success: true, message: 'SMS sent.', sid: result.sid };
  } catch (err) {
    logger.error('send_sms failed', { tenantId: context.tenantId, error: String(err) });
    return { success: false, message: 'Failed to send the SMS. Offer to try again or escalate.' };
  }
}

const entry = getToolLibraryEntry('send_sms')!;

export const sendSmsTool: ToolDefinition = {
  name: entry.name,
  description: entry.description,
  inputSchema: entry.parameters,
  handler: (input, context) => executeSendSms(input as Record<string, unknown>, context),
};
