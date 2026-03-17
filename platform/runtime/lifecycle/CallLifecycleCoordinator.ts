import { EventEmitter } from 'events';
import { createLogger } from '../../core/logger';
import { getMaxDurationMs, getDemoMaxDurationMs, getDemoWarningMs } from './agentPolicy';
import { detectOptOutInTranscript, addToDnc } from '../../campaigns/DncService';
import { recordTrace } from '../../core/observability/traceLogger';
import type {
  CallRecord,
  RegisterCallParams,
  BufferedTerminationSignal,
} from './types';
import { isTerminalTwilioStatus } from './types';


const logger = createLogger('CALL_COORDINATOR');

const FORCE_CLEANUP_DELAY_MS = 30_000;
const OPENAI_ONLY_CLEANUP_DELAY_MS = 10_000;
const STALE_CALL_THRESHOLD_MS = 120_000;
const PENDING_TRANSCRIPT_TIMEOUT_MS = 60_000;
const BUFFERED_TERMINATION_TIMEOUT_MS = 60_000;

export interface CallPersistenceAdapter {
  updateTranscript(tenantId: string, callLogId: string, transcript: string): Promise<void>;
  finalizeCall(tenantId: string, callLogId: string, status: string, endTime: Date): Promise<boolean>;
  findCallByTwilioSid(tenantId: string, twilioCallSid: string): Promise<{ callLogId: string; conferenceName?: string; state?: string; createdAt?: Date } | null>;
  findCallByConferenceSid(tenantId: string, conferenceSid: string): Promise<{ callLogId: string; conferenceName?: string; state?: string; createdAt?: Date } | null>;
}

/**
 * Per-tenant call lifecycle coordinator.
 *
 * Manages in-memory call state, multi-ID mapping, buffered early signals,
 * stale-call detection, and idempotent DB finalization.
 *
 * One instance is created per tenant by LifecycleCoordinatorRegistry.
 */
export class CallLifecycleCoordinator extends EventEmitter {
  private activeCalls = new Map<string, CallRecord>();
  private callIdMappings = new Map<string, string>();
  private cleanupTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private maxDurationTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private demoWarningTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingMappings = new Map<string, string[]>();
  private pendingTranscripts = new Map<string, string[]>();
  private bufferedTerminations = new Map<string, BufferedTerminationSignal[]>();

  constructor(
    private readonly tenantId: string,
    private readonly persistence: CallPersistenceAdapter,
  ) {
    super();
    this.startStaleCallDetector();
  }

  registerCall(params: RegisterCallParams): CallRecord {
    const record: CallRecord = {
      callLogId: params.callLogId,
      tenantId: params.tenantId,
      twilioCallSid: params.twilioCallSid,
      openAiCallId: params.openAiCallId,
      conferenceSid: params.conferenceSid,
      state: 'in_progress',
      startTime: new Date(),
      lastActivity: new Date(),
      transcriptLines: [],
      agentSlug: params.agentSlug,
      from: params.from,
      to: params.to,
      transferredToHuman: false,
      terminationSignals: {},
    };

    this.activeCalls.set(params.callLogId, record);
    if (params.twilioCallSid) this.callIdMappings.set(params.twilioCallSid, params.callLogId);
    if (params.openAiCallId) this.callIdMappings.set(params.openAiCallId, params.callLogId);
    if (params.conferenceSid) this.callIdMappings.set(params.conferenceSid, params.callLogId);

    logger.callStarted({
      callId: params.callLogId,
      tenantId: this.tenantId,
      agentSlug: params.agentSlug,
      callerPhone: params.from,
    });

    recordTrace({
      tenantId: this.tenantId,
      callSessionId: params.callLogId,
      traceType: 'call_started',
      stepName: 'call_registered',
      inputData: {
        agentSlug: params.agentSlug,
        direction: params.from ? 'inbound' : 'outbound',
      },
    }).catch(() => {});

    this.scheduleMaxDurationTimeout(params.callLogId, params.twilioCallSid, params.agentSlug, params.isTrial);

    if (params.openAiCallId && this.pendingMappings.has(params.openAiCallId)) {
      const pending = this.pendingMappings.get(params.openAiCallId)!;
      for (const externalId of pending) this.addMapping(externalId, params.callLogId);
      this.pendingMappings.delete(params.openAiCallId);
    }

    this.flushPendingTranscripts(params.callLogId, params.openAiCallId, params.twilioCallSid);
    this.processBufferedTerminations(params.callLogId, params.twilioCallSid, params.conferenceSid);

    return record;
  }

  addMapping(externalId: string, callLogId: string): void {
    this.callIdMappings.set(externalId, callLogId);
    const record = this.activeCalls.get(callLogId);
    if (record) {
      if (externalId.startsWith('rtc_')) record.openAiCallId = externalId;
      else if (externalId.startsWith('CA')) record.twilioCallSid = externalId;
      else if (externalId.startsWith('CF')) record.conferenceSid = externalId;
    }
  }

  queuePendingMapping(openAiCallId: string, externalId: string): void {
    if (!this.pendingMappings.has(openAiCallId)) {
      this.pendingMappings.set(openAiCallId, []);
    }
    this.pendingMappings.get(openAiCallId)!.push(externalId);
  }

  getCallRecord(callLogId: string): CallRecord | undefined {
    return this.activeCalls.get(callLogId);
  }

  getCallByAnyId(id: string): CallRecord | undefined {
    const callLogId = this.callIdMappings.get(id) ?? id;
    return this.activeCalls.get(callLogId);
  }

  async appendTranscript(idOrExternalId: string, line: string): Promise<void> {
    const callLogId = this.callIdMappings.get(idOrExternalId) ?? idOrExternalId;
    const record = this.activeCalls.get(callLogId);

    if (!record) {
      if (!this.pendingTranscripts.has(idOrExternalId)) {
        this.pendingTranscripts.set(idOrExternalId, []);
        setTimeout(() => {
          this.pendingTranscripts.delete(idOrExternalId);
        }, PENDING_TRANSCRIPT_TIMEOUT_MS);
      }
      this.pendingTranscripts.get(idOrExternalId)!.push(line);
      return;
    }

    record.transcriptLines.push(line);
    const now = new Date();
    if (!record.firstTranscriptAt) record.firstTranscriptAt = now;
    record.lastTranscriptAt = now;
    record.lastActivity = now;

    try {
      await this.persistence.updateTranscript(
        this.tenantId,
        callLogId,
        record.transcriptLines.join('\n'),
      );
    } catch (err) {
      logger.error('Failed to persist transcript', {
        callId: callLogId,
        tenantId: this.tenantId,
        error: String(err),
      });
    }
  }

  handleTwilioStatusCallback(callSid: string, status: string): void {
    const callLogId = this.callIdMappings.get(callSid);
    if (!callLogId) {
      if (isTerminalTwilioStatus(status)) {
        this.bufferTerminationSignal(callSid, {
          type: 'twilio_status',
          status,
          receivedAt: new Date(),
        });
        this.fallbackCleanupByTwilioSid(callSid, status).catch(() => {});
      }
      return;
    }
    this.processTerminationForCall(callLogId, callSid, status);
  }

  handleConferenceEnd(conferenceSid: string): void {
    const callLogId = this.callIdMappings.get(conferenceSid);
    if (!callLogId) {
      this.bufferTerminationSignal(conferenceSid, {
        type: 'conference_end',
        receivedAt: new Date(),
      });
      return;
    }
    const record = this.activeCalls.get(callLogId);
    if (!record) return;
    record.terminationSignals.conferenceEnded = true;
    this.checkTermination(callLogId);
  }

  handleOpenAiSessionEnd(openAiCallId: string): void {
    const callLogId = this.callIdMappings.get(openAiCallId) ?? openAiCallId;
    const record = this.activeCalls.get(callLogId);
    if (!record) return;
    record.terminationSignals.openAiSessionEnded = true;
    this.scheduleOpenAiOnlyCleanup(callLogId);
  }

  markTransferredToHuman(callLogIdOrExternalId: string): void {
    const callLogId = this.callIdMappings.get(callLogIdOrExternalId) ?? callLogIdOrExternalId;
    const record = this.activeCalls.get(callLogId);
    if (record) record.transferredToHuman = true;
  }

  getActiveCallCount(): number {
    return this.activeCalls.size;
  }

  getActiveCalls(): CallRecord[] {
    return Array.from(this.activeCalls.values());
  }

  private processTerminationForCall(callLogId: string, callSid: string, status: string): void {
    const record = this.activeCalls.get(callLogId);
    if (!record) return;

    logger.callStateTransition(callLogId, record.state, status, {
      twilioCallSid: callSid,
      tenantId: this.tenantId,
      event: 'twilio_status',
    });

    if (isTerminalTwilioStatus(status)) {
      this.cancelMaxDurationTimeout(callLogId);
      record.terminationSignals.twilioStatusCallback = true;
      this.checkTermination(callLogId);
    }
  }

  private checkTermination(callLogId: string): void {
    const record = this.activeCalls.get(callLogId);
    if (!record) return;

    const signals = record.terminationSignals;
    const twilioConfirmed = signals.twilioStatusCallback;
    const conferenceEnded = signals.conferenceEnded || signals.participantLeft;

    if (twilioConfirmed && conferenceEnded) {
      this.finalizeCall(callLogId, 'completed');
      return;
    }

    if (twilioConfirmed || conferenceEnded) {
      if (!this.cleanupTimeouts.has(callLogId)) {
        const timeout = setTimeout(() => {
          this.finalizeCall(callLogId, 'completed');
        }, FORCE_CLEANUP_DELAY_MS);
        this.cleanupTimeouts.set(callLogId, timeout);
      }
    }
  }

  private scheduleOpenAiOnlyCleanup(callLogId: string): void {
    if (!this.cleanupTimeouts.has(callLogId)) {
      const timeout = setTimeout(() => {
        const record = this.activeCalls.get(callLogId);
        if (record && !record.terminationSignals.twilioStatusCallback) {
          this.finalizeCall(callLogId, 'completed');
        }
      }, OPENAI_ONLY_CLEANUP_DELAY_MS);
      this.cleanupTimeouts.set(callLogId, timeout);
    }
  }

  private async finalizeCall(callLogId: string, status: string): Promise<void> {
    const record = this.activeCalls.get(callLogId);
    if (!record) return;

    record.state = 'completed';

    const cleanupTimeout = this.cleanupTimeouts.get(callLogId);
    if (cleanupTimeout) {
      clearTimeout(cleanupTimeout);
      this.cleanupTimeouts.delete(callLogId);
    }

    try {
      await this.persistence.finalizeCall(this.tenantId, callLogId, status, new Date());
    } catch (err) {
      logger.error('Failed to finalize call', {
        callId: callLogId,
        tenantId: this.tenantId,
        error: String(err),
      });
    }

    const duration = Date.now() - record.startTime.getTime();
    logger.callEnded({
      callId: callLogId,
      tenantId: this.tenantId,
      duration: Math.round(duration / 1000),
      endReason: status,
    });

    recordTrace({
      tenantId: this.tenantId,
      callSessionId: callLogId,
      traceType: 'call_ended',
      stepName: 'call_finalized',
      durationMs: duration,
      inputData: { status },
      outputData: {
        durationSeconds: Math.round(duration / 1000),
        transcriptLines: record.transcriptLines.length,
        transferredToHuman: record.transferredToHuman,
      },
    }).catch(() => {});

    let voiceOptOut = false;
    if (record.transcriptLines.length > 0 && record.from) {
      const fullTranscript = record.transcriptLines.join('\n');
      if (detectOptOutInTranscript(fullTranscript)) {
        voiceOptOut = true;
        addToDnc(this.tenantId, record.from, 'voice', 'Opt-out detected in call transcript').catch((err) => {
          logger.warn('Failed to add caller to DNC after transcript opt-out', {
            callId: callLogId,
            tenantId: this.tenantId,
            error: String(err),
          });
        });
      }
    }

    this.activeCalls.delete(callLogId);
    this.emit('call-ended', { callLogId, tenantId: this.tenantId, status, voiceOptOut });
  }

  private scheduleMaxDurationTimeout(
    callLogId: string,
    twilioCallSid?: string,
    agentSlug?: string,
    isTrial?: boolean,
  ): void {
    const isDemo = this.tenantId === 'demo';
    const maxMs = isDemo ? getDemoMaxDurationMs() : getMaxDurationMs(agentSlug, undefined, isTrial);
    const timeout = setTimeout(() => {
      logger.warn('Max call duration reached — forcing termination', {
        callId: callLogId,
        tenantId: this.tenantId,
        agentSlug,
        maxMs,
      });
      if (isDemo) {
        const record = this.activeCalls.get(callLogId);
        this.emit('demo-force-terminate', {
          callLogId,
          tenantId: this.tenantId,
          twilioCallSid: record?.twilioCallSid,
        });
      }
      this.finalizeCall(callLogId, 'completed');
    }, maxMs);
    this.maxDurationTimeouts.set(callLogId, timeout);

    if (isDemo) {
      const warningMs = getDemoWarningMs();
      const warningTimeout = setTimeout(() => {
        logger.info('Demo call warning — 30 seconds remaining', {
          callId: callLogId,
          tenantId: this.tenantId,
        });
        this.emit('demo-warning', {
          callLogId,
          tenantId: this.tenantId,
          message: 'This demo call will end in 30 seconds.',
        });
      }, warningMs);
      this.demoWarningTimeouts.set(callLogId, warningTimeout);
    }
  }

  private cancelMaxDurationTimeout(callLogId: string): void {
    const timeout = this.maxDurationTimeouts.get(callLogId);
    if (timeout) {
      clearTimeout(timeout);
      this.maxDurationTimeouts.delete(callLogId);
    }
    const warningTimeout = this.demoWarningTimeouts.get(callLogId);
    if (warningTimeout) {
      clearTimeout(warningTimeout);
      this.demoWarningTimeouts.delete(callLogId);
    }
  }

  private bufferTerminationSignal(externalId: string, signal: BufferedTerminationSignal): void {
    if (!this.bufferedTerminations.has(externalId)) {
      this.bufferedTerminations.set(externalId, []);
      setTimeout(() => {
        this.bufferedTerminations.delete(externalId);
      }, BUFFERED_TERMINATION_TIMEOUT_MS);
    }
    this.bufferedTerminations.get(externalId)!.push(signal);
  }

  private processBufferedTerminations(
    callLogId: string,
    twilioCallSid?: string,
    conferenceSid?: string,
  ): void {
    const ids = [twilioCallSid, conferenceSid].filter(Boolean) as string[];
    for (const externalId of ids) {
      const signals = this.bufferedTerminations.get(externalId);
      if (!signals) continue;

      const record = this.activeCalls.get(callLogId);
      if (record) {
        for (const signal of signals) {
          if (signal.type === 'twilio_status') record.terminationSignals.twilioStatusCallback = true;
          if (signal.type === 'conference_end') record.terminationSignals.conferenceEnded = true;
          if (signal.type === 'participant_left') record.terminationSignals.participantLeft = true;
          if (signal.type === 'openai_session_end') record.terminationSignals.openAiSessionEnded = true;
        }
        this.checkTermination(callLogId);
      }

      this.bufferedTerminations.delete(externalId);
    }
  }

  private async flushPendingTranscripts(
    callLogId: string,
    openAiCallId?: string,
    twilioCallSid?: string,
  ): Promise<void> {
    const record = this.activeCalls.get(callLogId);
    if (!record) return;

    const ids = [callLogId, openAiCallId, twilioCallSid].filter(Boolean) as string[];
    for (const id of ids) {
      const buffered = this.pendingTranscripts.get(id);
      if (!buffered || buffered.length === 0) continue;
      record.transcriptLines.push(...buffered);
      try {
        await this.persistence.updateTranscript(
          this.tenantId,
          callLogId,
          record.transcriptLines.join('\n'),
        );
      } catch {}
      this.pendingTranscripts.delete(id);
    }
  }

  private async fallbackCleanupByTwilioSid(callSid: string, status: string): Promise<void> {
    try {
      const session = await this.persistence.findCallByTwilioSid(this.tenantId, callSid);
      if (!session?.callLogId) return;
      this.callIdMappings.set(callSid, session.callLogId);
      this.processTerminationForCall(session.callLogId, callSid, status);
    } catch {}
  }

  private startStaleCallDetector(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [callLogId, record] of this.activeCalls) {
        const idleMs = now - record.lastActivity.getTime();
        if (idleMs > STALE_CALL_THRESHOLD_MS) {
          if (!record.staleWarningLogged) {
            record.staleWarningLogged = true;
            logger.warn('Stale call detected', {
              callId: callLogId,
              tenantId: this.tenantId,
              idleMs,
            });
          }
        }
      }
    }, 60_000);
  }
}
