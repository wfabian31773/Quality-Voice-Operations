import type { AnyActionDefinition } from '../core';
import { smsSendAction } from './send';

export const smsActions: AnyActionDefinition[] = [smsSendAction];

export {
  SMS_SEND_ACTION,
  SMS_SEND_ERROR_CODES,
  SMS_SEND_OUTCOME_UNKNOWN,
  agentSmsIdempotencyKey,
  automatedSmsIdempotencyKey,
  createSmsSendAction,
  normalizeE164,
  releaseDueDeferredSms,
  sendStoredSms,
  sendSystemSms,
  sendSystemSmsOrThrow,
  sendUserSms,
  smsSendAction,
  type SmsSendErrorCode,
  type SmsSendInput,
  type SmsSendOutput,
  type StoredSmsRequest,
  type SystemSmsOptions,
  type SystemSmsRequest,
  type UserSmsRequest,
} from './send';
export { applySmsStatusCallback, type SmsStatusCallback } from './statusCallback';
export { isSmsOptIn, liftSmsOptOutDnc } from './consent';
export {
  SMS_MAX_BODY_CHARS,
  getSmsTemplate,
  isAgentSmsTemplate,
  listSmsTemplates,
  renderSmsTemplate,
  type SmsTemplateKey,
} from './templates';
export { defaultSmsSendDeps, smsStatusCallbackUrl, type SmsSendDeps } from './deps';
