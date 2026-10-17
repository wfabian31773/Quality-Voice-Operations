import { createLogger } from '../../../core/logger';
import {
  agentSmsIdempotencyKey,
  isAgentSmsTemplate,
  normalizeE164,
  sendSystemSms,
  type SmsTemplateKey,
} from '../../../actions/sms';
import type { ToolContext, ToolDefinition } from '../../registry/types';
import { getToolLibraryEntry } from '../catalog';

const logger = createLogger('TOOL_SEND_SMS');

/**
 * Thin wrapper over the `sms.send` chokepoint. Agent sends are template-only
 * (`confirmation`, `directions`, `link`); free-text bodies are refused.
 */
export async function executeSendSms(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<{ success: boolean; message: string; sid?: string; status?: string; code?: string }> {
  const toNumber = String(input.toNumber ?? context.callerNumber ?? '').trim();
  if (!toNumber) {
    return { success: false, message: 'toNumber is required.' };
  }
  const templateKey = typeof input.templateKey === 'string' ? input.templateKey : '';
  if (!templateKey || !isAgentSmsTemplate(templateKey)) {
    return {
      success: false,
      code: 'TEMPLATE_REQUIRED',
      message: "I can't send a custom text. I can take a message so the shop follows up.",
    };
  }
  const vars =
    input.vars && typeof input.vars === 'object' && !Array.isArray(input.vars)
      ? Object.fromEntries(Object.entries(input.vars as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')]))
      : {};
  const callId = context.callSid ?? context.callLogId;
  // Normalized so "+1 312…" and "+1312…" are the same send (same key, same input).
  const to = normalizeE164(toNumber) ?? toNumber;
  // The live-call quiet-hours exemption covers only the person on the call.
  const callerNumber = normalizeE164(context.callerNumber);
  const toCaller = callerNumber !== null && callerNumber === to;

  try {
    const result = await sendSystemSms({
      tenantId: context.tenantId,
      to,
      templateKey: templateKey as SmsTemplateKey,
      vars,
      purpose: 'transactional',
      actorId: `agent:${context.agentSlug ?? 'voice'}`,
      ...(callId
        ? {
            callId,
            ...(toCaller ? { liveCall: { callId } } : {}),
            idempotencyKey: agentSmsIdempotencyKey({ callId, templateKey, vars, to }),
          }
        : {}),
    });
    if (!result.ok) {
      return { success: false, code: result.error.code, message: result.error.callerSafeMessage };
    }
    if (result.data.status === 'deferred_quiet_hours') {
      return { success: true, status: result.data.status, message: "You'll get the text in the morning." };
    }
    return { success: true, status: result.data.status, sid: result.data.twilioSid, message: 'SMS queued.' };
  } catch (err) {
    logger.error('send_sms failed', { tenantId: context.tenantId, error: String(err) });
    return { success: false, message: "I couldn't send the text right now." };
  }
}

const entry = getToolLibraryEntry('send_sms')!;

export const sendSmsTool: ToolDefinition = {
  name: entry.name,
  description: entry.description,
  inputSchema: entry.parameters,
  handler: (input, context) => executeSendSms(input as Record<string, unknown>, context),
};
