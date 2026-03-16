import type { Server as HTTPServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createLogger } from '../../../platform/core/logger';
import { redactPHI } from '../../../platform/core/phi/redact';
import { loadAgentConfig } from '../services/agentLoader';
import { getAgentConfig, getAgentToolOverrides } from '../services/numberLookup';
import { createRealtimeSession, type RealtimeSessionResult } from '../services/openaiSession';
import { writeCallEvent, updateCallState, finalizeCallSession } from '../services/callPersistence';
import { sessionManager } from '../services/sessionManager';
import { EscalationController } from '../services/escalation';
import { getCoordinator, getTwilioAdapter } from './twilio';
import { WorkflowEngine } from '../../../platform/workflow/engine/WorkflowEngine';
import { BudgetGuardService } from '../../../platform/billing/budget/BudgetGuardService';
import { checkBudget } from '../../../platform/billing/budget/checkBudget';
import { CallerMemoryService } from '../../../platform/infra/memory/CallerMemoryService';
import { OutboxService } from '../../../platform/integrations/outbox/OutboxService';
import { createCallerMemoryStorage, createOutboxAdapters } from '../services/platformAdapters';
import { createSessionLogger, type SessionLogger } from '../services/sessionLogger';
import { updateContactStatus, classifyCallOutcome, addToDnc } from '../../../platform/campaigns';
import { writeCallMetric } from '../../../platform/core/observability';
import { scoreCall } from '../../../platform/analytics/QualityScorerService';
import { recordCallUsage, estimateCallCost } from '../../../platform/billing/usage/UsageRecorder';
import { validateWidgetToken, getWidgetConfig, getPublicWidgetConfig } from '../../../platform/widget/WidgetTokenService';

const logger = createLogger('WS_STREAM');
const widgetLogger = createLogger('WS_WIDGET');

const STREAM_AUTH_TOKEN = process.env.VOICE_GATEWAY_STREAM_TOKEN;

function validateStreamOrigin(request: IncomingMessage): boolean {
  if (!STREAM_AUTH_TOKEN) return true;
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  const token = url.searchParams.get('token');
  return token === STREAM_AUTH_TOKEN;
}

function createBudgetGuard(tenantId: string): BudgetGuardService {
  return new BudgetGuardService(tenantId, {
    getDailySpendCents: async () => 0,
  });
}

function createWorkflowEngine(): WorkflowEngine {
  return new WorkflowEngine({
    workflows: [
      {
        id: 'general_inquiry',
        name: 'General Inquiry',
        requiredSlots: ['patient_name', 'reason_for_call', 'callback_number'],
        confirmationRequired: true,
      },
      {
        id: 'urgent_medical',
        name: 'Urgent Medical',
        requiredSlots: ['patient_name', 'symptom_description'],
        confirmationRequired: false,
      },
    ],
  });
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = Buffer.from(base64, 'base64');
  return binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString('base64');
}

export function attachWebSocket(server: HTTPServer): void {
  const wss = new WebSocketServer({ noServer: true });
  const widgetWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    if (url.pathname === '/twilio/stream') {
      if (!validateStreamOrigin(request)) {
        logger.warn('WebSocket connection rejected — invalid stream token', {
          remoteAddress: request.socket?.remoteAddress,
        });
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (url.pathname === '/widget/stream') {
      const widgetToken = url.searchParams.get('token');
      if (!widgetToken) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      widgetWss.handleUpgrade(request, socket, head, (ws) => {
        widgetWss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    let streamSid: string | undefined;
    let callSessionId: string | undefined;
    let tenantId: string | undefined;
    let twilioCallSid: string | undefined;
    let campaignId: string | undefined;
    let campaignContactId: string | undefined;
    let streamAgentId: string | undefined;
    let callDirection: 'inbound' | 'outbound' = 'inbound';
    let sessionResult: RealtimeSessionResult | undefined;
    let sessionClosed = false;
    const streamStartedAt = Date.now();
    let slog: SessionLogger = logger;

    async function finalizeStream(): Promise<void> {
      if (callSessionId && tenantId && !sessionClosed) {
        sessionClosed = true;

        if (sessionResult) {
          try {
            await sessionResult.session.close();
            slog.info('OpenAI realtime session closed');
          } catch (err) {
            slog.error('Error closing OpenAI session', { error: String(err) });
          }
        }

        const durationSeconds = Math.round((Date.now() - streamStartedAt) / 1000);
        const costEstimate = estimateCallCost(durationSeconds);

        try {
          await finalizeCallSession(tenantId, callSessionId, 'completed', durationSeconds, costEstimate.totalCostCents);
          await writeCallEvent(tenantId, callSessionId, 'call_completed', 'ACTIVE_CONVERSATION', 'CALL_COMPLETED', {
            durationSeconds,
            totalCostCents: costEstimate.totalCostCents,
          });
        } catch (err) {
          slog.error('Error finalizing call session', { error: String(err) });
        }

        recordCallUsage(tenantId, callDirection, durationSeconds).catch((err) => {
          slog.error('Failed to record call usage metrics', { error: String(err) });
        });

        const coordinator = getCoordinator(tenantId);

        const callRecord = coordinator.getCallRecord(callSessionId!);
        if (callRecord && callRecord.transcriptLines.length >= 2) {
          const transcript = callRecord.transcriptLines.map((line: string) => {
            const colonIdx = line.indexOf(':');
            if (colonIdx > 0) {
              return { role: line.slice(0, colonIdx).trim(), content: line.slice(colonIdx + 1).trim() };
            }
            return { role: 'unknown', content: line };
          });
          scoreCall(tenantId!, callSessionId!, transcript).catch((err) => {
            slog.error('Quality scoring failed (fire-and-forget)', { error: String(err) });
          });
        }

        const callOutcome = classifyCallOutcome({
          callDurationSeconds: durationSeconds,
          streamEstablished: true,
        });

        writeCallMetric(tenantId, durationSeconds, {
          callSessionId,
          agentId: streamAgentId,
          campaignId,
          outcome: callOutcome,
        }).catch((err) => {
          slog.error('Failed to write call analytics metric', { error: String(err) });
        });

        if (campaignId && campaignContactId && tenantId) {
          const outcome = callOutcome;

          const record = coordinator.getCallRecord(callSessionId!);
          let voiceOptOut = false;
          if (record && record.transcriptLines.length > 0) {
            const { detectOptOutInTranscript } = await import('../../../platform/campaigns/DncService');
            voiceOptOut = detectOptOutInTranscript(record.transcriptLines.join('\n'));
          }

          if (voiceOptOut) {
            addToDnc(tenantId, record!.from!, 'voice', 'Opt-out detected in call transcript').catch((err) => {
              slog.error('Failed to add caller to DNC after voice opt-out', { error: String(err) });
            });
            updateContactStatus(tenantId, campaignContactId, 'opted_out', twilioCallSid, 'Voice opt-out detected in transcript').catch((err) => {
              slog.error('Failed to mark campaign contact as opted_out', { error: String(err) });
            });
          } else {
            updateContactStatus(tenantId, campaignContactId, 'completed', twilioCallSid, undefined, outcome).catch((err) => {
              slog.error('Failed to update campaign contact status', { error: String(err) });
            });
          }
        }

        if (twilioCallSid) {
          coordinator.handleTwilioStatusCallback(twilioCallSid, 'completed');
        }
        sessionManager.unregister(callSessionId);
      }
    }

    ws.on('message', async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.event) {
          case 'start': {
            const params = msg.start?.customParameters ?? {};
            tenantId = params.tenantId;
            const agentId = params.agentId;
            streamAgentId = agentId;
            const agentType = params.agentType ?? 'general';
            callDirection = agentType === 'outbound' || params.direction === 'outbound' ? 'outbound' : 'inbound';
            twilioCallSid = params.callSid;
            campaignId = params.campaignId || undefined;
            campaignContactId = params.contactId || undefined;
            const callerNumber = params.callerNumber;
            const calledNumber = params.calledNumber;
            streamSid = msg.start?.streamSid;

            if (!tenantId || !agentId || !twilioCallSid) {
              logger.error('Missing stream parameters', { tenantId, agentId, callSid: twilioCallSid });
              ws.close();
              return;
            }

            logger.info('Stream started', {
              tenantId,
              agentId,
              agentType,
              callSid: twilioCallSid,
              streamSid,
              callerPhone: redactPHI(callerNumber),
            });

            const budgetResult = await checkBudget(tenantId);
            if (!budgetResult.allowed) {
              logger.warn('Call blocked by subscription budget', {
                tenantId,
                reason: budgetResult.reason,
                plan: budgetResult.plan,
                usage: budgetResult.usage,
              });
              ws.close();
              return;
            }

            const coordinator = getCoordinator(tenantId);
            const dbAgent = await getAgentConfig(tenantId, agentId);
            const toolOverrides = await getAgentToolOverrides(tenantId, agentId);
            const trustedAgentType = dbAgent?.type || agentType || 'general';
            const agentCfg = loadAgentConfig({
              tenantId,
              agentId,
              agentType: trustedAgentType,
              callerPhone: callerNumber,
              toolOverrides,
              dbAgent,
            });

            const workflowEngine = createWorkflowEngine();
            const budgetGuard = createBudgetGuard(tenantId);

            const callerMemory = new CallerMemoryService(createCallerMemoryStorage());

            const { persistence: outboxDb, integration: outboxIntegration } = createOutboxAdapters();
            const outboxService = new OutboxService(outboxDb, outboxIntegration);

            const twilioAdapter = getTwilioAdapter();
            const escalationController = twilioAdapter
              ? new EscalationController(twilioAdapter, outboxService)
              : undefined;

            const onEscalation = async (csId: string, cSid: string, reason: string): Promise<void> => {
              const tid = tenantId!;
              await updateCallState(tid, csId, 'ESCALATION_CHECK', { escalationReason: reason });

              if (!escalationController) {
                slog.warn('Escalation requested but no Twilio adapter configured — marking failed');
                await writeCallEvent(tid, csId, 'escalation_failed', 'ESCALATION_CHECK', 'ESCALATION_FAILED', {
                  reason: 'no_twilio_adapter',
                });
                await updateCallState(tid, csId, 'ACTIVE_CONVERSATION');
                return;
              }
              const agentMeta = agentCfg.metadata as Record<string, unknown>;
              const onCallNumber = (agentMeta.onCallTransferNumber as string) ?? '';
              if (!onCallNumber) {
                slog.warn('Escalation requested but no on-call number configured');
                await writeCallEvent(tid, csId, 'escalation_failed', 'ESCALATION_CHECK', 'ESCALATION_FAILED', {
                  reason: 'no_on_call_number',
                });
                await updateCallState(tid, csId, 'ACTIVE_CONVERSATION');
                return;
              }
              const result = await escalationController.escalateCall({
                tenantId: tid,
                callSessionId: csId,
                callSid: cSid,
                targetNumber: onCallNumber,
                reason,
              });
              if (result.success) {
                await updateCallState(tid, csId, 'ESCALATED', {
                  escalationTarget: onCallNumber,
                  escalationReason: reason,
                });
                await writeCallEvent(tid, csId, 'escalation_success', 'ESCALATION_CHECK', 'ESCALATED');
              } else {
                slog.error('Escalation transfer failed', { message: result.message });
                await writeCallEvent(tid, csId, 'escalation_failed', 'ESCALATION_CHECK', 'ESCALATION_FAILED', {
                  error: result.message,
                });
                await updateCallState(tid, csId, 'ACTIVE_CONVERSATION');
              }
            };

            try {
              sessionResult = await createRealtimeSession({
                tenantId,
                agentConfig: agentCfg,
                callerNumber,
                calledNumber,
                callSid: twilioCallSid,
                direction: callDirection,
                templateKey: trustedAgentType,
                toolOverrides,
                lifecycleCoordinator: coordinator,
                workflowEngine,
                budgetGuard,
                callerMemory,
                outboxService,
                onEscalation,
              });

              callSessionId = sessionResult.callSessionId;
              slog = createSessionLogger('WS_STREAM', {
                tenantId: tenantId!,
                callId: callSessionId,
                callSid: twilioCallSid!,
              });

              sessionResult.onOpenAIAudio((audioEvent) => {
                if (ws.readyState !== WebSocket.OPEN || !streamSid) return;
                if (!audioEvent.data) return;
                const base64Audio = arrayBufferToBase64(audioEvent.data);
                ws.send(JSON.stringify({
                  event: 'media',
                  streamSid,
                  media: {
                    payload: base64Audio,
                  },
                }));
              });

              const apiKey = process.env.OPENAI_API_KEY;
              if (apiKey) {
                sessionResult.triggerGreeting();
                await sessionResult.session.connect({ apiKey });
                slog.info('OpenAI Realtime session connected', { agentId });
              } else {
                slog.error('OPENAI_API_KEY not set — cannot connect realtime session');
              }

              await updateCallState(tenantId, callSessionId, 'ACTIVE_CONVERSATION');
              await writeCallEvent(
                tenantId,
                callSessionId,
                'active_conversation',
                'AGENT_CONNECTED',
                'ACTIVE_CONVERSATION',
              );

              if (campaignId && campaignContactId) {
                updateContactStatus(tenantId!, campaignContactId, 'connected', twilioCallSid).catch((e) => {
                  slog.warn('Failed to set campaign contact connected', { error: String(e) });
                });
              }

              slog.info('Bidirectional media bridge established', {
                agentId,
                streamSid,
              });
            } catch (err) {
              slog.error('Failed to create realtime session', {
                error: String(err),
              });
              ws.close();
            }
            break;
          }

          case 'media': {
            if (!sessionResult || !msg.media?.payload) break;
            const audioBuffer = base64ToArrayBuffer(msg.media.payload);
            sessionResult.sendAudioToOpenAI(audioBuffer);
            break;
          }

          case 'stop': {
            slog.info('Stream stopped', { streamSid });
            await finalizeStream();
            break;
          }

          default:
            break;
        }
      } catch (err) {
        slog.error('Error processing WebSocket message', { error: String(err) });
      }
    });

    ws.on('close', () => {
      finalizeStream().catch((err) => {
        slog.error('Error during WebSocket close finalization', { error: String(err) });
      });
      slog.info('WebSocket closed');
    });

    ws.on('error', (err) => {
      slog.error('WebSocket error', { error: String(err) });
    });
  });

  widgetWss.on('connection', async (ws: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const token = url.searchParams.get('token');
    let tenantId: string | undefined;
    let callSessionId: string | undefined;
    let sessionResult: RealtimeSessionResult | undefined;
    let sessionClosed = false;
    const startedAt = Date.now();
    let slog: SessionLogger = widgetLogger;

    if (!token) {
      ws.close(4001, 'Missing token');
      return;
    }

    let validated: { tenantId: string; tokenId: string } | null = null;
    try {
      validated = await validateWidgetToken(token);
    } catch (err) {
      widgetLogger.error('Widget token validation error', { error: String(err) });
      ws.close(4001, 'Token validation failed');
      return;
    }

    if (!validated) {
      ws.close(4001, 'Invalid token');
      return;
    }

    tenantId = validated.tenantId;

    try {
      const widgetCfg = await getWidgetConfig(tenantId);
      if (widgetCfg && widgetCfg.allowed_domains && widgetCfg.allowed_domains.length > 0) {
        const origin = request.headers.origin || '';
        const originHost = origin ? new URL(origin).hostname : '';
        const domainAllowed = widgetCfg.allowed_domains.some(
          (d: string) => originHost === d || originHost.endsWith('.' + d),
        );
        if (!domainAllowed) {
          widgetLogger.warn('Widget WS from unauthorized domain', { tenantId, origin });
          ws.close(4003, 'Domain not authorized');
          return;
        }
      }
    } catch (err) {
      widgetLogger.error('Widget domain check error', { error: String(err) });
    }

    widgetLogger.info('Widget WebSocket connected', { tenantId });

    async function finalizeWidgetStream(): Promise<void> {
      if (callSessionId && tenantId && !sessionClosed) {
        sessionClosed = true;
        if (sessionResult) {
          try {
            await sessionResult.session.close();
            slog.info('Widget OpenAI session closed');
          } catch (err) {
            slog.error('Error closing widget OpenAI session', { error: String(err) });
          }
        }
        const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
        const costEstimate = estimateCallCost(durationSeconds);
        try {
          await finalizeCallSession(tenantId, callSessionId, 'completed', durationSeconds, costEstimate.totalCostCents);
        } catch (err) {
          slog.error('Error finalizing widget session', { error: String(err) });
        }
        recordCallUsage(tenantId, 'inbound', durationSeconds).catch((err) => {
          slog.error('Failed to record widget usage', { error: String(err) });
        });
        writeCallMetric(tenantId, durationSeconds, {
          callSessionId,
          outcome: 'completed',
        }).catch(() => {});
        sessionManager.unregister(callSessionId);
      }
    }

    ws.on('message', async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case 'start': {
            if (!tenantId) { ws.close(4001, 'Not authenticated'); return; }

            const budgetResult = await checkBudget(tenantId);
            if (!budgetResult.allowed) {
              ws.send(JSON.stringify({ type: 'error', message: 'Service temporarily unavailable' }));
              ws.close(4003, 'Budget exceeded');
              return;
            }

            const widgetConfig = await getWidgetConfig(tenantId);
            if (!widgetConfig || !widgetConfig.enabled || !widgetConfig.agent_id) {
              ws.send(JSON.stringify({ type: 'error', message: 'Widget not configured' }));
              ws.close(4004, 'Widget not configured');
              return;
            }

            const dbAgent = await getAgentConfig(tenantId, widgetConfig.agent_id);
            const agentCfg = loadAgentConfig({
              tenantId,
              agentId: widgetConfig.agent_id,
              agentType: dbAgent?.type || 'general',
              callerPhone: 'widget',
              dbAgent,
            });

            const coordinator = getCoordinator(tenantId);
            const workflowEngine = createWorkflowEngine();
            const budgetGuard = createBudgetGuard(tenantId);
            const callerMemory = new CallerMemoryService(createCallerMemoryStorage());
            const { persistence: outboxDb, integration: outboxIntegration } = createOutboxAdapters();
            const outboxService = new OutboxService(outboxDb, outboxIntegration);

            try {
              sessionResult = await createRealtimeSession({
                tenantId,
                agentConfig: agentCfg,
                callerNumber: 'widget-visitor',
                calledNumber: 'widget',
                callSid: `widget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                direction: 'inbound',
                lifecycleCoordinator: coordinator,
                workflowEngine,
                budgetGuard,
                callerMemory,
                outboxService,
              });

              callSessionId = sessionResult.callSessionId;
              slog = createSessionLogger('WS_WIDGET', {
                tenantId: tenantId!,
                callId: callSessionId,
                callSid: 'widget',
              });

              sessionResult.onOpenAIAudio((audioEvent) => {
                if (ws.readyState !== WebSocket.OPEN) return;
                if (!audioEvent.data) return;
                const base64Audio = arrayBufferToBase64(audioEvent.data);
                ws.send(JSON.stringify({ type: 'audio', data: base64Audio }));
              });

              const apiKey = process.env.OPENAI_API_KEY;
              if (apiKey) {
                sessionResult.triggerGreeting();
                await sessionResult.session.connect({ apiKey });
                slog.info('Widget OpenAI session connected');
              } else {
                slog.error('OPENAI_API_KEY not set');
                ws.close(4005, 'Server configuration error');
                return;
              }

              ws.send(JSON.stringify({ type: 'ready', callSessionId }));
              slog.info('Widget stream established');
            } catch (err) {
              slog.error('Failed to create widget session', { error: String(err) });
              ws.send(JSON.stringify({ type: 'error', message: 'Failed to start session' }));
              ws.close(4005, 'Session creation failed');
            }
            break;
          }

          case 'audio': {
            if (!sessionResult || !msg.data) break;
            const audioBuffer = base64ToArrayBuffer(msg.data);
            sessionResult.sendAudioToOpenAI(audioBuffer);
            break;
          }

          case 'text': {
            if (!sessionResult || !msg.text) break;
            try {
              const transport = (sessionResult.session as unknown as { transport: { sendEvent: (e: unknown) => void } }).transport;
              transport.sendEvent({
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'user',
                  content: [{ type: 'input_text', text: msg.text }],
                },
              });
              transport.sendEvent({ type: 'response.create' });
            } catch (err) {
              slog.error('Failed to send text to OpenAI', { error: String(err) });
            }
            break;
          }

          case 'stop': {
            slog.info('Widget stream stopped');
            await finalizeWidgetStream();
            ws.close(1000, 'Session ended');
            break;
          }

          default:
            break;
        }
      } catch (err) {
        widgetLogger.error('Error processing widget message', { error: String(err) });
      }
    });

    ws.on('close', () => {
      finalizeWidgetStream().catch((err) => {
        widgetLogger.error('Error during widget close', { error: String(err) });
      });
    });

    ws.on('error', (err) => {
      widgetLogger.error('Widget WebSocket error', { error: String(err) });
    });
  });
}
