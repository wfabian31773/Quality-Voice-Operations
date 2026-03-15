import { createLogger } from '../core/logger';
import type { ContactOutcome } from './types';

const logger = createLogger('OUTCOME_CLASSIFIER');

export interface CallClassificationInput {
  answeredBy?: string;
  callDurationSeconds: number;
  twilioStatus?: string;
  streamEstablished: boolean;
}

export function classifyCallOutcome(input: CallClassificationInput): ContactOutcome {
  if (input.answeredBy && (input.answeredBy.startsWith('machine') || input.answeredBy === 'fax')) {
    logger.debug('Classified as voicemail_left', { answeredBy: input.answeredBy });
    return 'voicemail_left';
  }

  if (input.twilioStatus === 'no-answer') {
    return 'no_answer';
  }

  if (input.twilioStatus === 'busy' || input.twilioStatus === 'failed' || input.twilioStatus === 'canceled') {
    return 'failed';
  }

  if (!input.streamEstablished) {
    return 'failed';
  }

  if (input.callDurationSeconds >= 5) {
    return 'human_answered';
  }

  return 'completed';
}
