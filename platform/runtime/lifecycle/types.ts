import type { TenantId, CallState } from '../../core/types';

export type { CallState };

export interface CallRecord {
  callLogId: string;
  tenantId: TenantId;
  twilioCallSid?: string;
  openAiCallId?: string;
  conferenceSid?: string;
  state: CallState;
  startTime: Date;
  lastActivity: Date;
  transcriptLines: string[];
  agentSlug?: string;
  from?: string;
  to?: string;
  transferredToHuman: boolean;
  staleWarningLogged?: boolean;
  firstTranscriptAt?: Date;
  lastTranscriptAt?: Date;
  terminationSignals: {
    twilioStatusCallback?: boolean;
    conferenceEnded?: boolean;
    openAiSessionEnded?: boolean;
    participantLeft?: boolean;
  };
}

export interface BufferedTerminationSignal {
  type: 'twilio_status' | 'conference_end' | 'participant_left' | 'openai_session_end';
  status?: string;
  label?: string;
  receivedAt: Date;
}

export interface RegisterCallParams {
  callLogId: string;
  tenantId: TenantId;
  twilioCallSid?: string;
  openAiCallId?: string;
  conferenceSid?: string;
  agentSlug?: string;
  from?: string;
  to?: string;
  isTrial?: boolean;
}

export type TerminalTwilioStatus = 'completed' | 'busy' | 'failed' | 'no-answer' | 'canceled';

export const TERMINAL_TWILIO_STATUSES: TerminalTwilioStatus[] = [
  'completed',
  'busy',
  'failed',
  'no-answer',
  'canceled',
];

export function isTerminalTwilioStatus(status: string): status is TerminalTwilioStatus {
  return (TERMINAL_TWILIO_STATUSES as readonly string[]).includes(status);
}
