import {
  RealtimeAgent,
  RealtimeSession,
  OpenAIRealtimeWebSocket,
  tool,
} from '@openai/agents/realtime';
import type { RealtimeItem, TransportLayerAudio } from '@openai/agents/realtime';
import { createLogger } from '../../../platform/core/logger';
import { redactPHI } from '../../../platform/core/phi/redact';
import type { TenantId } from '../../../platform/core/types';
import type { LoadedAgentConfig, AgentToolDef } from './agentLoader';
import type { CallLifecycleCoordinator } from '../../../platform/runtime/lifecycle/CallLifecycleCoordinator';
import { WorkflowEngine } from '../../../platform/workflow/engine/WorkflowEngine';
import type { WorkflowContext, IntentType, WorkflowState } from '../../../platform/workflow/types';
import { BudgetGuardService } from '../../../platform/billing/budget/BudgetGuardService';
import { CallerMemoryService } from '../../../platform/infra/memory/CallerMemoryService';
import type { OutboxService } from '../../../platform/integrations/outbox/OutboxService';
import { globalToolRegistry } from '../../../platform/tools/registry';
import { hasKnowledgeArticles } from '../../../platform/knowledge/knowledgeContext';
import { isToolDenied, type ToolOverride } from '../../../platform/agent-templates/toolPermissions';
import { handleDemoToolCall } from './demoToolHandler';
import { createServiceTicket } from '../../../platform/agent-templates/answering-service/tools/createServiceTicketTool';
import { createAfterHoursTicket } from '../../../platform/agent-templates/medical-after-hours/tools/createAfterHoursTicketTool';
import { triageEscalate } from '../../../platform/agent-templates/medical-after-hours/tools/triageEscalateTool';
import { DEFAULT_ANSWERING_SERVICE_CONFIG } from '../../../platform/agent-templates/answering-service/config/ticketingConfig';
import type { TriageOutcome } from '../../../platform/agent-templates/medical-after-hours/config/triageOutcomes';
import {
  createCallSession,
  writeCallEvent,
  updateCallState,
  createPlatformPersistenceAdapter,
} from './callPersistence';
import { sessionManager } from './sessionManager';
import { createSessionLogger, type SessionLogContext } from './sessionLogger';

const logger = createLogger('OPENAI_SESSION');

export interface SessionContext {
  tenantId: TenantId;
  agentConfig: LoadedAgentConfig;
  callerNumber: string;
  calledNumber: string;
  callSid: string;
  direction?: 'inbound' | 'outbound';
  templateKey?: string;
  toolOverrides?: ToolOverride[];
  lifecycleCoordinator: CallLifecycleCoordinator;
  workflowEngine?: WorkflowEngine;
  budgetGuard?: BudgetGuardService;
  callerMemory?: CallerMemoryService;
  outboxService?: OutboxService;
  onEscalation?: (callSessionId: string, callSid: string, reason: string) => Promise<void>;
  onToolCall?: (name: string, args: unknown, callSessionId: string) => Promise<string>;
  isTrial?: boolean;
}

interface RealtimeMessageItem {
  type: string;
  role?: string;
  content?: Array<{ type: string; text?: string; transcript?: string }>;
}

function buildToolHandler(
  ctx: SessionContext,
  callSessionId: string,
) {
  return async (toolName: string, args: Record<string, unknown>): Promise<string> => {
    const { tenantId, callSid, outboxService, agentConfig, onEscalation } = ctx;

    if (ctx.templateKey && isToolDenied(toolName, ctx.templateKey, ctx.toolOverrides)) {
      logger.warn('Denied tool invocation blocked', { tenantId, callId: callSessionId, tool: toolName });
      return JSON.stringify({ success: false, message: 'This tool is not available for this agent. Please use the tools that are enabled for your current session.' });
    }

    const demoResult = handleDemoToolCall(tenantId, toolName, args);
    if (demoResult !== null) {
      await updateCallState(tenantId, callSessionId, 'TOOL_EXECUTION');
      await writeCallEvent(tenantId, callSessionId, 'tool_start', 'WORKFLOW_EXECUTION', 'TOOL_EXECUTION', {
        tool: toolName,
        demo: true,
      });
      await writeCallEvent(tenantId, callSessionId, 'tool_end', 'TOOL_EXECUTION', 'ACTIVE_CONVERSATION', {
        tool: toolName,
        demo: true,
      });
      await updateCallState(tenantId, callSessionId, 'ACTIVE_CONVERSATION');
      return demoResult;
    }

    if (ctx.workflowEngine) {
      await updateCallState(tenantId, callSessionId, 'WORKFLOW_EXECUTION');
      await writeCallEvent(tenantId, callSessionId, 'workflow_execution_start', 'ACTIVE_CONVERSATION', 'WORKFLOW_EXECUTION', {
        tool: toolName,
      });
    }

    await updateCallState(tenantId, callSessionId, 'TOOL_EXECUTION');
    await writeCallEvent(tenantId, callSessionId, 'tool_start', 'WORKFLOW_EXECUTION', 'TOOL_EXECUTION', {
      tool: toolName,
    });

    let result: string;

    try {
      switch (toolName) {
        case 'createServiceTicket': {
          if (!outboxService) {
            result = JSON.stringify({ success: false, confirmationMessage: 'Outbox service not configured.' });
            break;
          }
          const ticketResult = await createServiceTicket(
            args as unknown as Parameters<typeof createServiceTicket>[0],
            {
              tenantId,
              callSid,
              callLogId: callSessionId,
              outbox: outboxService,
              config: DEFAULT_ANSWERING_SERVICE_CONFIG,
            },
          );
          result = JSON.stringify(ticketResult);
          break;
        }

        case 'createAfterHoursTicket': {
          if (!outboxService) {
            result = JSON.stringify({ success: false, confirmationMessage: 'Outbox service not configured.' });
            break;
          }
          const agentMeta = agentConfig.metadata as Record<string, unknown>;
          const afterHoursResult = await createAfterHoursTicket(
            args as unknown as Parameters<typeof createAfterHoursTicket>[0],
            {
              tenantId,
              callSid,
              callLogId: callSessionId,
              outbox: outboxService,
              afterHoursDepartmentId: (agentMeta.afterHoursDepartmentId as number) ?? 1,
            },
          );
          result = JSON.stringify(afterHoursResult);
          break;
        }

        case 'triageEscalate': {
          const escalateMeta = agentConfig.metadata as Record<string, unknown>;
          const transferNumber = (escalateMeta.onCallTransferNumber as string) ?? '';
          const escalateResult = await triageEscalate(
            args as unknown as Parameters<typeof triageEscalate>[0],
            {
              tenantId,
              callLogId: callSessionId,
              callSid,
              onCallTransferNumber: transferNumber,
              initiateTransfer: async (toNumber: string) => {
                if (onEscalation) {
                  try {
                    await onEscalation(callSessionId, callSid, (args as Record<string, string>).urgentConcern ?? 'urgent');
                    return { success: true };
                  } catch (err) {
                    logger.error('Transfer initiation failed', { tenantId, callId: callSessionId, error: String(err) });
                    return { success: false };
                  }
                }
                return { success: false };
              },
            },
          );

          if (escalateResult.success) {
            await updateCallState(tenantId, callSessionId, 'ESCALATED', {
              escalationTarget: transferNumber,
              escalationReason: (args as Record<string, string>).urgentConcern,
            });
            await writeCallEvent(tenantId, callSessionId, 'escalation_active', 'TOOL_EXECUTION', 'ESCALATED', {
              target: transferNumber,
            });
          }

          result = JSON.stringify(escalateResult);
          break;
        }

        default: {
          const registeredTool = globalToolRegistry.get(toolName);
          if (registeredTool) {
            const toolResult = await registeredTool.handler(args, {
              tenantId,
              callLogId: callSessionId,
              callSid,
              agentSlug: agentConfig.agentId,
            });
            result = JSON.stringify(toolResult);
          } else {
            logger.warn('Unknown tool called', { tenantId, callId: callSessionId, tool: toolName });
            result = JSON.stringify({ success: false, message: `Unknown tool: ${toolName}` });
          }
          break;
        }
      }
    } catch (err) {
      logger.error('Tool execution failed', { tenantId, callId: callSessionId, tool: toolName, error: String(err) });
      result = JSON.stringify({ success: false, message: 'Tool execution failed. Please try again.' });
    }

    await updateCallState(tenantId, callSessionId, 'ACTIVE_CONVERSATION');
    await writeCallEvent(tenantId, callSessionId, 'tool_end', 'TOOL_EXECUTION', 'ACTIVE_CONVERSATION', {
      tool: toolName,
    });

    try {
      const { recordToolExecution } = await import('../../../platform/billing/usage/UsageRecorder');
      await recordToolExecution(tenantId, 1);
    } catch (meterErr) {
      logger.error('Failed to record tool execution', { tenantId, callId: callSessionId, error: String(meterErr) });
    }

    if (ctx.isTrial) {
      try {
        const { checkTrialLimits } = await import('../../../platform/billing/guardrails/TrialGuard');
        const trialCheck = await checkTrialLimits(tenantId);
        if (trialCheck.isTrial && !trialCheck.allowed && trialCheck.usage.toolExecutions >= trialCheck.usage.maxToolExecutions) {
          logger.warn('Trial tool execution limit reached mid-session', { tenantId, callId: callSessionId, toolExecutions: trialCheck.usage.toolExecutions });
        }
      } catch (trialErr) {
        logger.error('Failed to check trial tool limits', { tenantId, error: String(trialErr) });
      }
    }

    return result;
  };
}

function toJsonObjectSchema(params: Record<string, unknown>): {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: true;
} {
  return {
    type: 'object',
    properties: (params.properties as Record<string, unknown>) ?? {},
    required: (params.required as string[]) ?? [],
    additionalProperties: true,
  };
}

function buildRealtimeTools(
  defs: AgentToolDef[],
  toolHandler: (name: string, args: Record<string, unknown>) => Promise<string>,
) {
  return defs.map((def) => {
    const schema = toJsonObjectSchema(def.parameters);
    return tool({
      name: def.name,
      description: def.description,
      parameters: schema,
      strict: false,
      execute: async (parsedArgs: unknown) => {
        const args = (parsedArgs && typeof parsedArgs === 'object')
          ? parsedArgs as Record<string, unknown>
          : {};
        return toolHandler(def.name, args);
      },
    });
  });
}

export interface RealtimeSessionResult {
  session: RealtimeSession;
  callSessionId: string;
  sendAudioToOpenAI: (audio: ArrayBuffer) => void;
  onOpenAIAudio: (handler: (audioEvent: TransportLayerAudio) => void) => void;
  triggerGreeting: () => void;
  sendSystemMessage: (message: string) => void;
}

export async function createRealtimeSession(
  ctx: SessionContext,
): Promise<RealtimeSessionResult> {
  const { tenantId, agentConfig, callerNumber, calledNumber, callSid, lifecycleCoordinator } = ctx;

  if (ctx.budgetGuard) {
    const status = await ctx.budgetGuard.getStatus();
    if (status.isWarning) {
      logger.warn('Budget warning during call setup', {
        tenantId,
        percentUsed: `${(status.percentUsed * 100).toFixed(1)}%`,
      });
    }
  }

  let callerMemorySummary: string | undefined;
  if (ctx.callerMemory) {
    try {
      const memory = await ctx.callerMemory.getCallerMemory(tenantId, callerNumber);
      if (memory && memory.totalCalls > 0) {
        callerMemorySummary = `Returning caller (${memory.totalCalls} previous calls). Last call: ${memory.lastCallDate ?? 'unknown'}.`;
        if (memory.openTickets && memory.openTickets.length > 0) {
          callerMemorySummary += ` Open tickets: ${memory.openTickets.join(', ')}.`;
        }
      }
    } catch (err) {
      logger.error('Caller memory lookup failed', { tenantId, error: String(err) });
    }
  }

  const callSessionId = await createCallSession({
    tenantId,
    agentId: agentConfig.agentId,
    callSid,
    direction: ctx.direction ?? 'inbound',
    callerNumber,
    calledNumber,
  });

  const slog = createSessionLogger('OPENAI_SESSION', { tenantId, callId: callSessionId, callSid });

  await writeCallEvent(tenantId, callSessionId, 'call_received', null, 'CALL_RECEIVED', {
    callerNumber: redactPHI(callerNumber),
    calledNumber,
    agentId: agentConfig.agentId,
  });

  const toolHandler = buildToolHandler(ctx, callSessionId);
  const agentTools = buildRealtimeTools(agentConfig.tools, toolHandler);

  let knowledgeAvailable = false;
  try {
    knowledgeAvailable = await hasKnowledgeArticles(tenantId);
  } catch (err) {
    logger.error('Failed to check knowledge availability', { tenantId, error: String(err) });
  }

  let systemPromptWithMemory = agentConfig.systemPrompt;
  if (callerMemorySummary) {
    systemPromptWithMemory += `\n\n===== CALLER MEMORY =====\n${callerMemorySummary}`;
  }
  if (knowledgeAvailable) {
    systemPromptWithMemory += `\n\n===== KNOWLEDGE BASE =====\nYou have access to a company knowledge base. When a caller asks about products, services, policies, procedures, or FAQs, use the retrieve_knowledge tool to search for relevant information before answering.`;
  }

  const agent = new RealtimeAgent({
    name: `${agentConfig.agentId}-${tenantId}`,
    instructions: systemPromptWithMemory,
    tools: agentTools,
  });

  const wsTransport = new OpenAIRealtimeWebSocket({ useInsecureApiKey: true });

  const sessionConfig = {
    voice: agentConfig.voice,
    audio: {
      input: {
        format: 'g711_ulaw' as const,
        transcription: { model: 'gpt-4o-mini-transcribe' },
        turnDetection: {
          type: 'semantic_vad' as const,
          eagerness: 'medium' as const,
          createResponse: true,
          interruptResponse: true,
        },
      },
      output: {
        format: 'g711_ulaw' as const,
        voice: agentConfig.voice,
      },
    },
  };

  const session = new RealtimeSession(agent, {
    transport: wsTransport,
    model: agentConfig.model,
    config: sessionConfig,
    tracingDisabled: false,
    tracing: {
      workflowName: `VoiceAI_${agentConfig.agentId}`,
      groupId: callSid,
    },
  } as ConstructorParameters<typeof RealtimeSession>[1]);

  const persistence = createPlatformPersistenceAdapter(tenantId);

  lifecycleCoordinator.registerCall({
    callLogId: callSessionId,
    tenantId,
    twilioCallSid: callSid,
    agentSlug: agentConfig.agentId,
    from: callerNumber,
    to: calledNumber,
    isTrial: ctx.isTrial,
  });

  await updateCallState(tenantId, callSessionId, 'AGENT_CONNECTED');
  await writeCallEvent(tenantId, callSessionId, 'agent_connected', 'CALL_RECEIVED', 'AGENT_CONNECTED', {
    agentId: agentConfig.agentId,
    model: agentConfig.model,
  });

  let workflowContext: WorkflowContext | undefined;
  if (ctx.workflowEngine) {
    workflowContext = {
      tenantId,
      callId: callSessionId,
      agentSlug: agentConfig.agentId,
      intent: 'unknown' as IntentType,
      state: 'greeting' as WorkflowState,
      slots: {},
      turnCount: 0,
      escalationAttempts: 0,
      transcript: [],
    };
  }

  session.on('history_added', (item: RealtimeItem) => {
    const msg = item as RealtimeMessageItem;
    if (msg.type !== 'message') return;

    let line: string | null = null;
    if (msg.role === 'user' && msg.content) {
      for (const c of msg.content) {
        const text = c.text || c.transcript;
        if (text) {
          line = `CALLER: ${text}`;

          if (ctx.workflowEngine && workflowContext) {
            workflowContext.turnCount++;
            workflowContext.transcript.push(text);
            const classification = ctx.workflowEngine.classifyIntent(text);
            if (classification.intent !== 'unknown') {
              workflowContext.intent = classification.intent;
              const prevState = workflowContext.state;
              workflowContext.state = 'intent_classification';
              ctx.workflowEngine.recordTransition(
                prevState,
                'intent_classification',
                `caller_utterance:${classification.intent}`,
                workflowContext.slots,
              );
            }
          }
          break;
        }
      }
    } else if (msg.role === 'assistant' && msg.content) {
      for (const c of msg.content) {
        if (c.text) {
          line = `AGENT: ${c.text}`;
          break;
        }
      }
    }

    if (line) {
      lifecycleCoordinator.appendTranscript(callSessionId, redactPHI(line));
    }
  });

  session.on('error', (event) => {
    const errorEvent = event as { error?: unknown; message?: string; code?: string; type?: string };
    let errorStr: string;
    try {
      errorStr = typeof errorEvent.error === 'object' && errorEvent.error !== null
        ? JSON.stringify(errorEvent.error)
        : String(errorEvent.error ?? errorEvent.message ?? JSON.stringify(event));
    } catch {
      errorStr = String(event);
    }
    slog.error('Realtime session error', {
      error: errorStr,
      code: errorEvent.code,
      type: errorEvent.type,
    });
  });

  session.on('agent_tool_start', (_context, _agent, toolDef) => {
    const toolInfo = toolDef as { name: string };
    slog.info('Tool execution started', { tool: toolInfo.name });
  });

  session.on('agent_tool_end', (_context, _agent, toolDef, result) => {
    const toolInfo = toolDef as { name: string };
    const resultStr = result as string;
    slog.info('Tool execution completed', {
      tool: toolInfo.name,
      resultLength: resultStr?.length,
    });
  });

  sessionManager.register({
    callSessionId,
    tenantId,
    agentId: agentConfig.agentId,
    callSid,
    startedAt: new Date(),
    cleanup: async () => {
      try {
        await session.close();
      } catch {}
      lifecycleCoordinator.handleOpenAiSessionEnd(callSessionId);
    },
  });

  const sessionEmitter = session as unknown as { on(event: string, listener: (...args: unknown[]) => void): void };
  sessionEmitter.on('close', () => {
    slog.info('Realtime session closed');
    updateCallState(tenantId, callSessionId, 'CALL_COMPLETED').catch(() => {});
    writeCallEvent(tenantId, callSessionId, 'session_closed', 'ACTIVE_CONVERSATION', 'CALL_COMPLETED').catch(() => {});
    lifecycleCoordinator.handleOpenAiSessionEnd(callSessionId);
    sessionManager.unregister(callSessionId);
  });

  const sendAudioToOpenAI = (audio: ArrayBuffer): void => {
    try {
      wsTransport.sendAudio(audio);
    } catch (err) {
      slog.error('Failed to send audio to OpenAI', { error: String(err) });
    }
  };

  const onOpenAIAudio = (handler: (audioEvent: TransportLayerAudio) => void): void => {
    wsTransport.on('audio', handler);
  };

  const sendRealtimeEvent = (event: Record<string, unknown>): void => {
    (wsTransport as unknown as { sendEvent(e: Record<string, unknown>): void }).sendEvent(event);
  };

  const injectConversationItem = (text: string): void => {
    sendRealtimeEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
    sendRealtimeEvent({ type: 'response.create' });
  };

  const triggerGreeting = (): void => {
    if (!agentConfig.greeting) return;
    wsTransport.on('session.created', () => {
      try {
        injectConversationItem(
          `[System: The caller just connected. Greet them now. Say exactly: "${agentConfig.greeting}"]`,
        );
        slog.info('Greeting triggered', { greeting: agentConfig.greeting.substring(0, 50) });
      } catch (err) {
        slog.error('Failed to trigger greeting', { error: String(err) });
      }
    });
  };

  const sendSystemMessage = (message: string): void => {
    try {
      injectConversationItem(`[System: Say exactly: "${message}"]`);
      slog.info('System message injected', { message: message.substring(0, 80) });
    } catch (err) {
      slog.error('Failed to inject system message', { error: String(err) });
    }
  };

  return { session, callSessionId, sendAudioToOpenAI, onOpenAIAudio, triggerGreeting, sendSystemMessage };
}
