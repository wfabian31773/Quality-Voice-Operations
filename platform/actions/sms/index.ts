import type { AnyActionDefinition } from '../core';
import { smsSendAction } from './send';

export const smsActions: AnyActionDefinition[] = [smsSendAction];

export {
  SMS_SEND_ACTION,
  SMS_SEND_ERROR_CODES,
  automatedSmsIdempotencyKey,
  createSmsSendAction,
  normalizeE164,
  releaseDueDeferredSms,
  sendSystemSms,
  sendSystemSmsOrThrow,
  smsSendAction,
  type SmsSendErrorCode,
  type SmsSendInput,
  type SmsSendOutput,
  type SystemSmsRequest,
} from './send';
export { applySmsStatusCallback, type SmsStatusCallback } from './statusCallback';
export {
  SMS_MAX_BODY_CHARS,
  getSmsTemplate,
  isAgentSmsTemplate,
  listSmsTemplates,
  renderSmsTemplate,
  type SmsTemplateKey,
} from './templates';
export { defaultSmsSendDeps, smsStatusCallbackUrl, type SmsSendDeps } from './deps';
