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
export {
  isLikelySmsOptOut,
  isSmsHelp,
  isSmsOptIn,
  liftSmsOptOutDnc,
} from './consent';
export {
  EMPTY_INBOUND_TWIML,
  defaultSmsInboundDeps,
  handleInboundSms,
  inboundSmsTwiml,
  parseInboundSmsPayload,
  postgresSmsInboundStore,
  type InboundSmsResult,
  type ParsedInboundSms,
  type SmsInboundDeps,
} from './inbound';
export {
  SMS_MAX_BODY_CHARS,
  getSmsTemplate,
  isAgentSmsTemplate,
  isStaffAlertSmsTemplate,
  listSmsTemplates,
  renderSmsTemplate,
  type SmsTemplateKey,
} from './templates';
export { defaultSmsSendDeps, smsStatusCallbackUrl, type SmsSendDeps } from './deps';
