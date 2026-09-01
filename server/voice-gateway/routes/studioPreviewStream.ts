import type { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { createLogger } from '../../../platform/core/logger';
import { verifyStudioPreviewToken } from '../../../platform/agent-runtime/studioPreviewToken';
import { loadAgentConfig } from '../services/agentLoader';
import { getAgentConfig } from '../services/numberLookup';
import { createRealtimeSession, type RealtimeSessionResult } from '../services/openaiSession';
import { finalizeCallSession } from '../services/callPersistence';
import { sessionManager } from '../services/sessionManager';
import { getCoordinator } from './twilio';
import { WorkflowEngine } from '../../../platform/workflow/engine/WorkflowEngine';
import { BudgetGuardService } from '../../../platform/billing/budget/BudgetGuardService';
import { checkBudget } from '../../../platform/billing/budget/checkBudget';
import { CallerMemoryService } from '../../../platform/infra/memory/CallerMemoryService';
import { OutboxService } from '../../../platform/integrations/outbox/OutboxService';
import { createCallerMemoryStorage, createOutboxAdapters } from '../services/platformAdapters';
import { createSessionLogger, type SessionLogger } from '../services/sessionLogger';
import { writeCallMetric } from '../../../platform/core/observability';
import { recordCallUsage, estimateCallCostWithLiveRate } from '../../../platform/billing/usage/UsageRecorder';
import { recordConversationCost, logRoutingDecision } from '../../../platform/billing/cost';
import { authorizeHealthcareDeployment } from '../../../platform/compliance/HealthcareDeploymentApprovalService';

const logger = createLogger('WS_STUDIO');

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

export async function handleStudioPreviewConnection(ws: WebSocket, request: IncomingMessage): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  const token = url.searchParams.get('token');
  const claims = token ? verifyStudioPreviewToken(token) : null;
  if (!claims) {
    ws.close(4001, 'Invalid token');
    return;
  }

  const { tenantId, agentId } = claims;
  let callSessionId: string | undefined;
  let sessionResult: RealtimeSessionResult | undefined;
  let sessionClosed = false;
  const startedAt = Date.now();
  let slog: SessionLogger = logger;

  logger.info('Studio preview WebSocket connected', { tenantId, agentId });

  async function finalize(): Promise<void> {
    if (callSessionId && !sessionClosed) {
      sessionClosed = true;
      if (sessionResult) {
        try {
          await sessionResult.session.close();
        } catch (err) {
          slog.error('Error closing studio preview session', { error: String(err) });
        }
      }
      const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
      const costEstimate = await estimateCallCostWithLiveRate(tenantId, durationSeconds);
      try {
        await finalizeCallSession(tenantId, callSessionId, 'completed', durationSeconds, costEstimate.totalCostCents);
      } catch (err) {
        slog.error('Error finalizing studio preview session', { error: String(err) });
      }
      recordCallUsage(tenantId, 'inbound', durationSeconds).catch((err) => {
        slog.error('Failed to record studio preview usage', { error: String(err) });
      });
      if (sessionResult) {
        const ct = sessionResult.costTracker;
        recordConversationCost({
          tenantId,
          callSessionId,
          durationSeconds,
          inputTokens: ct.inputTokens,
          outputTokens: ct.outputTokens,
          cachedInputTokens: ct.cachedInputTokens,
          captureSource: ct.captureSource,
          modelUsed: sessionResult.routedModel,
          modelTier: sessionResult.routedTier as 'economy' | 'standard' | 'premium',
          ttsCharacters: ct.ttsCharacters,
          cacheHits: ct.cacheHits,
          cacheMisses: ct.cacheMisses,
          promptTokensSaved: ct.promptTokensSaved,
        }).catch((err) => {
          slog.error('Failed to record studio preview cost', { error: String(err) });
        });
        for (const decision of ct.routingDecisions) {
          logRoutingDecision(tenantId, callSessionId, decision).catch(() => {});
        }
      }
      writeCallMetric(tenantId, durationSeconds, {
        callSessionId,
        outcome: 'completed',
      }).catch(() => {});
      sessionManager.unregister(callSessionId);
    }
  }

  ws.on('message', async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString()) as { type?: string; data?: string; text?: string };
      switch (msg.type) {
        case 'start': {
          const budgetResult = await checkBudget(tenantId);
          if (!budgetResult.allowed) {
            ws.send(JSON.stringify({ type: 'error', message: 'Service temporarily unavailable' }));
            ws.close(4003, 'Budget exceeded');
            return;
          }

          const dbAgent = await getAgentConfig(tenantId, agentId);
          if (!dbAgent) {
            ws.send(JSON.stringify({ type: 'error', message: 'This agent could not be loaded.' }));
            ws.close(4004, 'Agent not configured');
            return;
          }

          const healthcareApproval = await authorizeHealthcareDeployment({
            tenantId,
            agentId,
            agentType: dbAgent.type || 'general',
            subjectPhone: 'studio-preview',
          });
          if (!healthcareApproval.allowed) {
            ws.send(JSON.stringify({ type: 'error', message: 'This agent is not approved for a live session.' }));
            ws.close(4003, 'Deployment not approved');
            return;
          }

          const agentCfg = loadAgentConfig({
            tenantId,
            agentId,
            agentType: dbAgent.type || 'general',
            callerPhone: 'studio-preview',
            dbAgent,
          });

          const coordinator = getCoordinator(tenantId);
          const workflowEngine = createWorkflowEngine();
          const budgetGuard = createBudgetGuard(tenantId);
          const callerMemory = new CallerMemoryService(createCallerMemoryStorage());
          const { persistence: outboxDb, integration: outboxIntegration } = createOutboxAdapters();
          const outboxService = new OutboxService(outboxDb, outboxIntegration);
          const previewCallSid = `studio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

          sessionResult = await createRealtimeSession({
            tenantId,
            agentConfig: agentCfg,
            callerNumber: 'studio-preview',
            calledNumber: 'studio',
            callSid: previewCallSid,
            direction: 'inbound',
            templateKey: agentCfg.rolePackageId,
            lifecycleCoordinator: coordinator,
            workflowEngine,
            budgetGuard,
            callerMemory,
            outboxService,
          });

          callSessionId = sessionResult.callSessionId;
          workflowEngine.setTraceContext(tenantId, callSessionId);
          slog = createSessionLogger('WS_STUDIO', {
            tenantId,
            callId: callSessionId,
            callSid: 'studio-preview',
          });

          sessionResult.onOpenAIAudio((audioEvent) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (!audioEvent.data) return;
            ws.send(JSON.stringify({ type: 'audio', data: arrayBufferToBase64(audioEvent.data) }));
          });

          const apiKey = process.env.XAI_API_KEY;
          if (!apiKey) {
            slog.error('XAI_API_KEY not set — cannot start studio preview');
            ws.send(JSON.stringify({ type: 'error', message: 'Live preview needs XAI_API_KEY on the voice gateway.' }));
            ws.close(4005, 'Server configuration error');
            return;
          }

          sessionResult.triggerGreeting();
          await sessionResult.session.connect({ apiKey });
          ws.send(JSON.stringify({ type: 'ready', callSessionId }));
          slog.info('Studio preview xAI session connected');
          break;
        }
        case 'audio': {
          if (!sessionResult || !msg.data) break;
          sessionResult.sendAudioToOpenAI(base64ToArrayBuffer(msg.data));
          break;
        }
        case 'text': {
          if (!sessionResult || !msg.text) break;
          const transport = (sessionResult.session as unknown as { transport: { sendEvent: (event: unknown) => void } }).transport;
          transport.sendEvent({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: msg.text }],
            },
          });
          transport.sendEvent({ type: 'response.create' });
          break;
        }
        case 'stop': {
          await finalize();
          ws.close(1000, 'Session ended');
          break;
        }
        default:
          break;
      }
    } catch (err) {
      slog.error('Error processing studio preview message', { error: String(err) });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to start the live preview.' }));
      }
    }
  });

  ws.on('close', () => {
    finalize().catch((err) => {
      logger.error('Error during studio preview close', { error: String(err) });
    });
  });

  ws.on('error', (err) => {
    logger.error('Studio preview WebSocket error', { error: String(err) });
  });
}
