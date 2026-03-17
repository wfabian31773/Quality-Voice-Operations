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
import { unifiedToolRegistry } from '../../../platform/tools/ToolRegistry';
import { createToolExecution, completeToolExecution } from '../../../platform/tools/ToolExecutionService';
import { executeWithRetry, getToolRetryConfig } from '../../../platform/tools/RetryOrchestrator';
import { buildFallbackResponse } from '../../../platform/tools/ConversationFallbackService';
import { createEscalationTask } from '../../../platform/tools/HumanEscalationService';
import { handleDemoToolCall } from './demoToolHandler';
import { WorkforceRoutingService } from '../../../platform/workforce/WorkforceRoutingService';
import { ReasoningEngine, type ReasoningEngineConfig } from '../../../platform/reasoning';
import { compressConversation, shouldCompress, type ConversationMessage } from '../../../platform/billing/cost/TokenCompressor';
import { routeQuery, checkConversationBudget, getConversationCostRunningTotal, recordConversationCost, logRoutingDecision, getSessionCacheCounters, clearSessionCacheCounters, type RoutingDecision } from '../../../platform/billing/cost';
import { TIER_MODEL_MAP, type ModelTier, getModelRate, TTS_COST_PER_1K_CHARS_CENTS } from '../../../platform/billing/cost/providerRates';
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
  onHandoff?: (callSessionId: string, intent: string, conversationContext: string) => Promise<{ success: boolean; message: string; targetAgentConfig?: import('./agentLoader').LoadedAgentConfig; routingInfo?: import('../../../platform/workforce/types').HandoffRoutingInfo }>;
  onSessionSwapRequired?: (targetAgentConfig: import('./agentLoader').LoadedAgentConfig, handoffGreeting: string) => Promise<void>;
  onToolCall?: (name: string, args: unknown, callSessionId: string) => Promise<string>;
  isTrial?: boolean;
  reasoningEngine?: ReasoningEngine;
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
    const startTime = Date.now();

    const INTERNAL_ORCHESTRATION_TOOLS = ['transfer_to_agent'];
    if (ctx.templateKey && !INTERNAL_ORCHESTRATION_TOOLS.includes(toolName) && isToolDenied(toolName, ctx.templateKey, ctx.toolOverrides)) {
      logger.warn('Denied tool invocation blocked', { tenantId, callId: callSessionId, tool: toolName });
      const deniedId = await createToolExecution({ tenantId, callSessionId, agentId: agentConfig.agentId, agentSlug: agentConfig.agentId, toolName, parameters: args });
      await completeToolExecution({ tenantId, executionId: deniedId, result: { success: false, reason: 'denied' }, status: 'failed', errorMessage: 'Tool denied by template permissions', durationMs: Date.now() - startTime });
      return JSON.stringify({ success: false, message: 'This tool is not available for this agent. Please use the tools that are enabled for your current session.' });
    }

    const validation = unifiedToolRegistry.validateToolInput(toolName, args);
    if (!validation.valid) {
      logger.warn('Tool input validation failed', { tenantId, callId: callSessionId, tool: toolName, errors: validation.errors });
      const valId = await createToolExecution({ tenantId, callSessionId, agentId: agentConfig.agentId, agentSlug: agentConfig.agentId, toolName, parameters: args });
      await completeToolExecution({ tenantId, executionId: valId, result: { success: false, reason: 'validation_failed' }, status: 'failed', errorMessage: `Validation failed: ${validation.errors.join(', ')}`, durationMs: Date.now() - startTime });
      return JSON.stringify({ success: false, message: `Invalid input: ${validation.errors.join(', ')}` });
    }

    if (!unifiedToolRegistry.checkRateLimit(tenantId, toolName)) {
      logger.warn('Tool rate limit exceeded', { tenantId, callId: callSessionId, tool: toolName });
      const rlId = await createToolExecution({ tenantId, callSessionId, agentId: agentConfig.agentId, agentSlug: agentConfig.agentId, toolName, parameters: args });
      await completeToolExecution({ tenantId, executionId: rlId, result: { success: false, reason: 'rate_limited' }, status: 'failed', errorMessage: 'Rate limit exceeded', durationMs: Date.now() - startTime });
      return JSON.stringify({ success: false, message: 'Rate limit exceeded for this tool. Please wait a moment before trying again.' });
    }

    if (ctx.reasoningEngine) {
      try {
        for (const [key, value] of Object.entries(args)) {
          if (typeof value === 'string' && value.length > 0) {
            ctx.reasoningEngine.fillSlot(key, value, 'tool_args');
          }
        }
      } catch (slotErr) {
        logger.warn('Failed to fill slots from tool args (pre-safety)', { tenantId, callId: callSessionId, tool: toolName, error: String(slotErr) });
      }

      try {
        let latestDecision = ctx.reasoningEngine.getLatestDecision();

        if (latestDecision && latestDecision.action !== 'execute_tool') {
          latestDecision = ctx.reasoningEngine.reEvaluateDecision();
          logger.debug('Re-evaluated reasoning decision after slot fill', {
            tenantId, callId: callSessionId, tool: toolName,
            newAction: latestDecision.action,
          });
        }

        if (latestDecision) {
          const isExactToolMatch = latestDecision.action === 'execute_tool' && latestDecision.toolToExecute === toolName;
          const isWorkflowToolMatch = latestDecision.action === 'continue_workflow' && latestDecision.toolToExecute === toolName;
          const isExecuteAnyTool = latestDecision.action === 'execute_tool' && !latestDecision.toolToExecute;
          const workflowStepTool = ctx.reasoningEngine.getCurrentWorkflowStepTool();
          const isWorkflowStepToolMatch = workflowStepTool === toolName;
          const isToolAllowed = isExactToolMatch || isWorkflowToolMatch || isExecuteAnyTool || isWorkflowStepToolMatch;
          if (!isToolAllowed) {
            logger.warn('Reasoning engine blocks tool execution: decision requires different action', {
              tenantId, callId: callSessionId, tool: toolName,
              requiredAction: latestDecision.action,
              reason: latestDecision.reasoning,
            });
            const rdId = await createToolExecution({ tenantId, callSessionId, agentId: agentConfig.agentId, agentSlug: agentConfig.agentId, toolName, parameters: args });
            await completeToolExecution({ tenantId, executionId: rdId, result: { success: false, reason: 'reasoning_blocked', requiredAction: latestDecision.action }, status: 'failed', errorMessage: `Reasoning engine requires ${latestDecision.action}: ${latestDecision.reasoning}`, durationMs: Date.now() - startTime });
            await writeCallEvent(tenantId, callSessionId, 'reasoning_tool_blocked', 'TOOL_EXECUTION', 'ACTIVE_CONVERSATION', { tool: toolName, requiredAction: latestDecision.action, reason: latestDecision.reasoning });
            const blockMessage = latestDecision.action === 'escalate_to_human'
              ? 'This action cannot be performed. The call needs to be transferred to a human agent.'
              : latestDecision.action === 'complete_interaction'
              ? 'The interaction is being wrapped up. No further tool actions are needed.'
              : `Before performing this action, I need to collect more information from the caller: ${latestDecision.reasoning}`;
            return JSON.stringify({ success: false, message: blockMessage });
          }
        }
      } catch (decisionErr) {
        logger.error('Reasoning decision gate check failed, blocking tool (fail-closed)', { tenantId, callId: callSessionId, tool: toolName, error: String(decisionErr) });
        const fgId = await createToolExecution({ tenantId, callSessionId, agentId: agentConfig.agentId, agentSlug: agentConfig.agentId, toolName, parameters: args });
        await completeToolExecution({ tenantId, executionId: fgId, result: { success: false, reason: 'reasoning_gate_error' }, status: 'failed', errorMessage: `Reasoning gate error: ${String(decisionErr)}`, durationMs: Date.now() - startTime });
        return JSON.stringify({ success: false, message: 'Unable to verify reasoning state. Please try again.' });
      }

      try {
        const safetyResult = ctx.reasoningEngine.checkToolSafety(toolName, args);
        if (!safetyResult.allowed) {
          const criticalViolations = safetyResult.violations.filter((v) => v.severity === 'critical');
          logger.warn('Reasoning safety gate blocked tool', { tenantId, callId: callSessionId, tool: toolName, violations: criticalViolations.map((v) => v.type) });
          const sgId = await createToolExecution({ tenantId, callSessionId, agentId: agentConfig.agentId, agentSlug: agentConfig.agentId, toolName, parameters: args });
          await completeToolExecution({ tenantId, executionId: sgId, result: { success: false, reason: 'safety_blocked', violations: criticalViolations.map((v) => v.description) }, status: 'failed', errorMessage: `Safety gate: ${criticalViolations.map((v) => v.description).join('; ')}`, durationMs: Date.now() - startTime });
          await writeCallEvent(tenantId, callSessionId, 'safety_gate_blocked', 'TOOL_EXECUTION', 'ACTIVE_CONVERSATION', { tool: toolName, violations: criticalViolations.map((v) => ({ type: v.type, description: v.description })) });
          return JSON.stringify({ success: false, message: `This action was blocked by safety policy: ${criticalViolations.map((v) => v.description).join('. ')}` });
        }
      } catch (safetyErr) {
        logger.error('Safety gate check failed, blocking tool execution (fail-closed)', { tenantId, callId: callSessionId, tool: toolName, error: String(safetyErr) });
        const fgId = await createToolExecution({ tenantId, callSessionId, agentId: agentConfig.agentId, agentSlug: agentConfig.agentId, toolName, parameters: args });
        await completeToolExecution({ tenantId, executionId: fgId, result: { success: false, reason: 'safety_gate_error' }, status: 'failed', errorMessage: `Safety gate error: ${String(safetyErr)}`, durationMs: Date.now() - startTime });
        return JSON.stringify({ success: false, message: 'Unable to verify safety policy. Please try again.' });
      }
    }

    if (toolName === 'transfer_to_agent' && ctx.onHandoff) {
      const intent = (args.intent as string) ?? 'general';
      const context = (args.conversation_summary as string) ?? '';
      logger.info('Workforce handoff tool invoked', { tenantId, callId: callSessionId, intent });
      const execId = await createToolExecution({ tenantId, callSessionId, agentId: agentConfig.agentId, agentSlug: agentConfig.agentId, toolName, parameters: args });
      await updateCallState(tenantId, callSessionId, 'HANDOFF');
      await writeCallEvent(tenantId, callSessionId, 'handoff_start', 'ACTIVE_CONVERSATION', 'HANDOFF', { intent, fromAgent: agentConfig.agentId });
      try {
        const handoffResult = await ctx.onHandoff(callSessionId, intent, context);
        const workforceRouter = new WorkforceRoutingService();
        if (handoffResult.success && handoffResult.targetAgentConfig && ctx.onSessionSwapRequired) {
          try {
            await ctx.onSessionSwapRequired(handoffResult.targetAgentConfig, handoffResult.message);
            if (handoffResult.routingInfo) {
              await workforceRouter.recordHandoff(tenantId, { ...handoffResult.routingInfo, reason: `Routed by intent: ${intent}`, duration_ms: Date.now() - startTime, outcome: 'success' });
              await updateCallState(tenantId, callSessionId, 'ACTIVE_CONVERSATION', { agentId: handoffResult.routingInfo.to_agent_id });
            } else {
              await updateCallState(tenantId, callSessionId, 'ACTIVE_CONVERSATION');
            }
            await completeToolExecution({ tenantId, executionId: execId, result: { success: true, message: handoffResult.message }, status: 'success', durationMs: Date.now() - startTime });
            await writeCallEvent(tenantId, callSessionId, 'handoff_success', 'HANDOFF', 'ACTIVE_CONVERSATION', { intent });
            return JSON.stringify({ success: true, message: handoffResult.message });
          } catch (swapErr) {
            logger.error('Session swap failed after handoff routing', { tenantId, callId: callSessionId, error: String(swapErr) });
            if (handoffResult.routingInfo) {
              await workforceRouter.recordHandoff(tenantId, { ...handoffResult.routingInfo, reason: `Session swap failed: ${String(swapErr)}`, duration_ms: Date.now() - startTime, outcome: 'failed' }).catch(() => {});
            }
            await completeToolExecution({ tenantId, executionId: execId, result: { success: false }, status: 'failed', errorMessage: `Session swap failed: ${String(swapErr)}`, durationMs: Date.now() - startTime });
            await writeCallEvent(tenantId, callSessionId, 'handoff_failed', 'HANDOFF', 'ACTIVE_CONVERSATION', { intent, error: String(swapErr) });
            await updateCallState(tenantId, callSessionId, 'ACTIVE_CONVERSATION');
            return JSON.stringify({ success: false, message: 'Transfer failed. Continuing with current agent.' });
          }
        } else if (handoffResult.success) {
          await completeToolExecution({ tenantId, executionId: execId, result: { success: true, message: handoffResult.message }, status: 'success', durationMs: Date.now() - startTime });
          await writeCallEvent(tenantId, callSessionId, 'handoff_success', 'HANDOFF', 'ACTIVE_CONVERSATION', { intent });
          return JSON.stringify({ success: true, message: handoffResult.message });
        } else {
          await completeToolExecution({ tenantId, executionId: execId, result: { success: false, message: handoffResult.message }, status: 'failed', durationMs: Date.now() - startTime });
          await writeCallEvent(tenantId, callSessionId, 'handoff_failed', 'HANDOFF', 'ACTIVE_CONVERSATION', { intent, reason: handoffResult.message });
          await updateCallState(tenantId, callSessionId, 'ACTIVE_CONVERSATION');
          return JSON.stringify({ success: false, message: handoffResult.message });
        }
      } catch (handoffErr) {
        await completeToolExecution({ tenantId, executionId: execId, result: { success: false }, status: 'failed', errorMessage: String(handoffErr), durationMs: Date.now() - startTime });
        await writeCallEvent(tenantId, callSessionId, 'handoff_failed', 'HANDOFF', 'ACTIVE_CONVERSATION', { intent, error: String(handoffErr) });
        await updateCallState(tenantId, callSessionId, 'ACTIVE_CONVERSATION');
        return JSON.stringify({ success: false, message: 'Handoff failed. Continuing with current agent.' });
      }
    }

    const demoResult = handleDemoToolCall(tenantId, toolName, args);
    if (demoResult !== null) {
      const demoStartTime = Date.now();
      const demoExecId = await createToolExecution({
        tenantId,
        callSessionId,
        agentId: agentConfig.agentId,
        agentSlug: agentConfig.agentId,
        toolName,
        parameters: args,
      });
      await updateCallState(tenantId, callSessionId, 'TOOL_EXECUTION');
      await writeCallEvent(tenantId, callSessionId, 'tool_start', 'WORKFLOW_EXECUTION', 'TOOL_EXECUTION', {
        tool: toolName,
        demo: true,
        executionId: demoExecId,
      });
      await completeToolExecution({
        tenantId,
        executionId: demoExecId,
        result: (() => { try { return JSON.parse(demoResult); } catch { return { raw: demoResult }; } })(),
        status: 'success',
        durationMs: Date.now() - demoStartTime,
      });
      if (ctx.reasoningEngine) {
        const stepTool = ctx.reasoningEngine.getCurrentWorkflowStepTool();
        if (stepTool === toolName) {
          ctx.reasoningEngine.advanceWorkflowStep();
          logger.debug('Advanced workflow step after tool execution', { tenantId, callId: callSessionId, tool: toolName });
        }
      }
      await writeCallEvent(tenantId, callSessionId, 'tool_end', 'TOOL_EXECUTION', 'ACTIVE_CONVERSATION', {
        tool: toolName,
        demo: true,
        executionId: demoExecId,
      });
      await updateCallState(tenantId, callSessionId, 'ACTIVE_CONVERSATION');
      return demoResult;
    }

    const executionId = await createToolExecution({
      tenantId,
      callSessionId,
      agentId: agentConfig.agentId,
      agentSlug: agentConfig.agentId,
      toolName,
      parameters: args,
    });

    if (ctx.workflowEngine) {
      await updateCallState(tenantId, callSessionId, 'WORKFLOW_EXECUTION');
      await writeCallEvent(tenantId, callSessionId, 'workflow_execution_start', 'ACTIVE_CONVERSATION', 'WORKFLOW_EXECUTION', {
        tool: toolName,
      });
    }

    await updateCallState(tenantId, callSessionId, 'TOOL_EXECUTION');
    await writeCallEvent(tenantId, callSessionId, 'tool_start', 'WORKFLOW_EXECUTION', 'TOOL_EXECUTION', {
      tool: toolName,
      executionId,
    });

    let result: string;
    let executionStatus: 'success' | 'failed' = 'success';
    let executionError: string | undefined;

    const NON_RETRYABLE_TOOLS = ['triageEscalate'];

    const assertToolSuccess = (jsonResult: string, tool: string): string => {
      if (NON_RETRYABLE_TOOLS.includes(tool)) return jsonResult;
      try {
        const parsed = JSON.parse(jsonResult);
        if (parsed && typeof parsed === 'object' && parsed.success === false) {
          const msg = parsed.message || parsed.confirmationMessage || parsed.error || 'Tool returned success: false';
          throw new Error(`ToolExecutionFailed: ${msg}`);
        }
      } catch (parseErr) {
        if (parseErr instanceof Error && parseErr.message.startsWith('ToolExecutionFailed:')) throw parseErr;
      }
      return jsonResult;
    };

    const dispatchToolExecution = async (): Promise<string> => {
      let rawResult: string;
      switch (toolName) {
        case 'createServiceTicket': {
          if (!outboxService) {
            throw new Error('ToolExecutionFailed: Outbox service not configured');
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
          rawResult = JSON.stringify(ticketResult);
          return assertToolSuccess(rawResult, toolName);
        }

        case 'createAfterHoursTicket': {
          if (!outboxService) {
            throw new Error('ToolExecutionFailed: Outbox service not configured');
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
          rawResult = JSON.stringify(afterHoursResult);
          return assertToolSuccess(rawResult, toolName);
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
                  } catch (transferErr) {
                    logger.error('Transfer initiation failed', { tenantId, callId: callSessionId, error: String(transferErr) });
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

          return JSON.stringify(escalateResult);
        }

        case 'escalate_to_human': {
          const reason = (args.reason as string) ?? 'Agent requested human escalation';
          const priority = (args.priority as string) ?? 'high';
          const task = await createEscalationTask({
            tenantId,
            callSessionId,
            agentSlug: agentConfig.agentId,
            callerPhone: (args.caller_phone as string) ?? undefined,
            reason,
            priority: priority as 'low' | 'medium' | 'high' | 'critical',
            metadata: { source: 'agent_tool', args },
          });

          if (onEscalation) {
            const transferTarget = (args.transfer_number as string) ?? '';
            if (transferTarget) {
              try {
                await onEscalation(callSessionId, callSid, reason);
                return JSON.stringify({
                  success: true,
                  message: "I'm connecting you with our team now. Please hold.",
                  escalationTaskId: task.id,
                  transferred: true,
                });
              } catch {
                return JSON.stringify({
                  success: true,
                  message: "I've created a follow-up task for our team. Someone will reach out to you shortly.",
                  escalationTaskId: task.id,
                  transferred: false,
                });
              }
            }
          }

          return JSON.stringify({
            success: true,
            message: "I've noted your concern and created a follow-up task. A team member will contact you shortly.",
            escalationTaskId: task.id,
            transferred: false,
          });
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
            rawResult = JSON.stringify(toolResult);
            return assertToolSuccess(rawResult, toolName);
          } else {
            logger.warn('Unknown tool called', { tenantId, callId: callSessionId, tool: toolName });
            return JSON.stringify({ success: false, message: `Unknown tool: ${toolName}` });
          }
        }
      }
    };

    const retryConfig = getToolRetryConfig(toolName);
    const retryResult = await executeWithRetry<string>(
      dispatchToolExecution,
      {
        tenantId,
        toolName,
        callSessionId,
        agentSlug: agentConfig.agentId,
        retryConfig,
      },
    );

    if (retryResult.success && retryResult.result !== undefined) {
      result = retryResult.result;
    } else {
      executionStatus = 'failed';
      executionError = retryResult.error ?? 'Unknown tool failure';
      const fallback = buildFallbackResponse(tenantId, toolName, callSessionId, executionError);
      logger.error('Tool execution failed after retries', {
        tenantId, callId: callSessionId, tool: toolName,
        error: executionError, attempts: retryResult.attempts,
        usedFallback: retryResult.usedFallback,
      });

      result = JSON.stringify({
        success: false,
        message: fallback.message,
        recovery: unifiedToolRegistry.getRecoveryInstructions(toolName),
        flaggedForFollowUp: true,
      });

      createEscalationTask({
        tenantId,
        callSessionId,
        agentSlug: agentConfig.agentId,
        reason: `Tool "${toolName}" failed after ${retryResult.attempts} attempt(s): ${executionError.substring(0, 200)}`,
        priority: 'high',
        toolName,
        metadata: { error: executionError, attempts: retryResult.attempts },
      }).catch((escErr) => {
        logger.warn('Failed to create escalation task for tool failure', { error: String(escErr) });
      });

      if (ctx.reasoningEngine) {
        try {
          ctx.reasoningEngine.handleToolFailure();
        } catch (failErr) {
          logger.warn('Reasoning handleToolFailure error', { tenantId, callId: callSessionId, error: String(failErr) });
        }
      }
    }

    const durationMs = Date.now() - startTime;

    let parsedResult: unknown;
    try { parsedResult = JSON.parse(result); } catch { parsedResult = { raw: result }; }

    if (executionStatus === 'success' && parsedResult && typeof parsedResult === 'object') {
      const r = parsedResult as Record<string, unknown>;
      if (r.success === false) {
        executionStatus = 'failed';
        executionError = executionError ?? (typeof r.message === 'string' ? r.message : 'Tool returned success: false');
      }
    }

    await completeToolExecution({
      tenantId,
      executionId,
      result: parsedResult,
      status: executionStatus,
      errorMessage: executionError,
      recoveryAction: executionStatus === 'failed' ? unifiedToolRegistry.getRecoveryInstructions(toolName) : undefined,
      durationMs,
    });

    if (ctx.reasoningEngine) {
      try {
        if (executionStatus === 'success') {
          ctx.reasoningEngine.handleToolSuccess(toolName);
          const stepTool = ctx.reasoningEngine.getCurrentWorkflowStepTool();
          if (stepTool === toolName) {
            ctx.reasoningEngine.advanceWorkflowStep();
            logger.debug('Advanced workflow step after tool execution', { tenantId, callId: callSessionId, tool: toolName });
          }
        }
      } catch (successErr) {
        logger.warn('Reasoning handleToolSuccess error', { tenantId, callId: callSessionId, error: String(successErr) });
      }
    }

    if (executionStatus === 'failed') {
      try {
        const { logError } = await import('../../../platform/core/observability');
        logError(tenantId, 'error', `Tool "${toolName}" failed: ${executionError ?? 'unknown error'}`, {
          service: 'tool_execution',
          errorCode: 'TOOL_EXEC_FAILURE',
          callSessionId: callSessionId,
        });
      } catch (obsErr) {
        logger.warn('Failed to log tool error to observability', { error: String(obsErr) });
      }
    }

    await updateCallState(tenantId, callSessionId, 'ACTIVE_CONVERSATION');
    await writeCallEvent(tenantId, callSessionId, 'tool_end', 'TOOL_EXECUTION', 'ACTIVE_CONVERSATION', {
      tool: toolName,
      executionId,
      durationMs,
      status: executionStatus,
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

function classifyAgentComplexity(
  templateKey: string,
  systemPrompt: string,
  tools: { name: string }[],
): { sampleQuery: string } {
  const COMPLEX_TEMPLATES = ['medical-after-hours', 'medical', 'legal', 'financial', 'insurance'];
  const SIMPLE_TEMPLATES = ['faq', 'receptionist', 'answering-service'];

  if (COMPLEX_TEMPLATES.some(t => templateKey.includes(t))) {
    return { sampleQuery: 'I need help understanding my complex medical situation with multiple concerns' };
  }
  if (SIMPLE_TEMPLATES.some(t => templateKey.includes(t))) {
    return { sampleQuery: 'What are your business hours?' };
  }

  const toolCount = tools.length;
  const promptLength = systemPrompt.length;

  if (toolCount > 5 || promptLength > 3000) {
    return { sampleQuery: 'Can you help me figure out which option would be best for my situation?' };
  }
  if (toolCount <= 2 && promptLength < 1000) {
    return { sampleQuery: 'I would like to schedule an appointment' };
  }

  return { sampleQuery: 'I have a question about your services and pricing' };
}

export interface RealtimeSessionResult {
  session: RealtimeSession;
  callSessionId: string;
  sendAudioToOpenAI: (audio: ArrayBuffer) => void;
  onOpenAIAudio: (handler: (audioEvent: TransportLayerAudio) => void) => void;
  triggerGreeting: () => void;
  sendSystemMessage: (message: string) => void;
  rebuildForHandoff: (newAgentConfig: import('./agentLoader').LoadedAgentConfig, handoffGreeting: string) => Promise<void>;
  costTracker: {
    inputTokens: number;
    outputTokens: number;
    ttsCharacters: number;
    cacheHits: number;
    cacheMisses: number;
    promptTokensSaved: number;
    routingDecisions: RoutingDecision[];
  };
  routedModel: string;
  routedTier: string;
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

  let reasoningEngine: ReasoningEngine | undefined;
  try {
    const reasoningConfig: ReasoningEngineConfig = {
      tenantId,
      callSessionId: '', // will be set after callSession creation
      callSid,
      agentSlug: agentConfig.agentId,
      vertical: ctx.templateKey ?? 'general',
      callerNumber,
      toolsAvailable: agentConfig.tools.map((t) => t.name),
      memoryStorage: ctx.callerMemory ?? null,
    };
    reasoningEngine = new ReasoningEngine(reasoningConfig);
    const callerContext = await reasoningEngine.initialize();
    if (callerContext.isReturningCaller) {
      const reasoningMemoryPrompt = reasoningEngine.getCallerContextPrompt();
      if (reasoningMemoryPrompt) {
        callerMemorySummary = callerMemorySummary
          ? `${callerMemorySummary}\n${reasoningMemoryPrompt}`
          : reasoningMemoryPrompt;
      }
    }
  } catch (err) {
    logger.error('Reasoning engine initialization failed, continuing without it', {
      tenantId,
      error: String(err),
    });
    reasoningEngine = undefined;
  }

  const callSessionId = await createCallSession({
    tenantId,
    agentId: agentConfig.agentId,
    callSid,
    direction: ctx.direction ?? 'inbound',
    callerNumber,
    calledNumber,
  });

  if (reasoningEngine) {
    reasoningEngine.setCallSessionId(callSessionId);
  }

  const slog = createSessionLogger('OPENAI_SESSION', { tenantId, callId: callSessionId, callSid });

  await writeCallEvent(tenantId, callSessionId, 'call_received', null, 'CALL_RECEIVED', {
    callerNumber: redactPHI(callerNumber),
    calledNumber,
    agentId: agentConfig.agentId,
  });

  ctx.reasoningEngine = reasoningEngine;

  const toolHandler = buildToolHandler(ctx, callSessionId);
  const agentTools = buildRealtimeTools(agentConfig.tools, toolHandler);

  let knowledgeAvailable = false;
  try {
    knowledgeAvailable = await hasKnowledgeArticles(tenantId);
  } catch (err) {
    logger.error('Failed to check knowledge availability', { tenantId, error: String(err) });
  }

  let systemPromptWithMemory = agentConfig.systemPrompt;
  if (reasoningEngine) {
    const safetyPolicy = reasoningEngine.getSafetyPolicyPrompt();
    if (safetyPolicy) {
      systemPromptWithMemory += `\n\n${safetyPolicy}`;
    }
  }
  if (callerMemorySummary) {
    systemPromptWithMemory += `\n\n===== CALLER MEMORY =====\n${callerMemorySummary}`;
  }
  if (knowledgeAvailable) {
    systemPromptWithMemory += `\n\n===== KNOWLEDGE BASE =====\nYou have access to a company knowledge base. When a caller asks about products, services, policies, procedures, or FAQs, use the retrieve_knowledge tool to search for relevant information before answering.`;
  }

  const systemMessages: ConversationMessage[] = [{ role: 'system', content: systemPromptWithMemory }];
  if (shouldCompress(systemMessages, 8192)) {
    const compressed = compressConversation(systemMessages, 8192);
    systemPromptWithMemory = compressed.messages.map(m => m.content).join('\n\n');
    slog.info('System prompt compressed', { tokensSaved: compressed.tokensSaved });
  }

  const agentTypeHint = ctx.templateKey ?? 'general';
  const systemPromptComplexity = classifyAgentComplexity(agentTypeHint, systemPromptWithMemory, agentConfig.tools);
  const initialRouting = routeQuery(systemPromptComplexity.sampleQuery);
  let activeModelTier: ModelTier = initialRouting.tier;
  let activeModel = TIER_MODEL_MAP[activeModelTier];

  slog.info('Model routing decision', { agentType: agentTypeHint, tier: activeModelTier, model: activeModel, reason: initialRouting.reason });

  const conversationHistory: ConversationMessage[] = [];
  const COMPRESSION_TURN_THRESHOLD = 20;
  let pendingCompressionSummary: string | null = null;

  const costTracker = {
    inputTokens: 0,
    outputTokens: 0,
    ttsCharacters: 0,
    cacheHits: 0,
    cacheMisses: 0,
    promptTokensSaved: 0,
    routingDecisions: [] as RoutingDecision[],
    get activeModel() { return activeModel; },
    get activeModelTier() { return activeModelTier; },
    addUtterance(role: 'user' | 'assistant', text: string): void {
      const tokenEstimate = Math.ceil(text.length / 4);
      if (role === 'user') {
        this.inputTokens += tokenEstimate;
      } else {
        this.outputTokens += tokenEstimate;
        this.ttsCharacters += text.length;
      }
      conversationHistory.push({ role, content: text });

      if (conversationHistory.length >= COMPRESSION_TURN_THRESHOLD && conversationHistory.length % 10 === 0) {
        if (shouldCompress(conversationHistory, 4096)) {
          const result = compressConversation(conversationHistory, 4096);
          if (result.wasTruncated && result.tokensSaved > 0) {
            this.promptTokensSaved += result.tokensSaved;
            const summaryMsg = result.messages.find(m => m.role === 'system' && m.content.startsWith('[Conversation summary]'));
            if (summaryMsg) {
              pendingCompressionSummary = summaryMsg.content;
              slog.info('Conversation compression generated summary', { tokensSaved: result.tokensSaved, turnCount: conversationHistory.length });
            }
          }
        }
      }
    },
  };

  costTracker.inputTokens += Math.ceil(systemPromptWithMemory.length / 4);
  costTracker.routingDecisions.push(initialRouting);

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
    model: activeModel,
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

  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  const SILENCE_THRESHOLD_MS = 15000;

  const resetSilenceTimer = (): void => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (reasoningEngine) {
        try {
          const recovery = reasoningEngine.handleSilence();
          if (recovery.recoveryPrompt) {
            injectConversationItem(
              `[System: ${recovery.recoveryPrompt}]`,
            );
            writeCallEvent(tenantId, callSessionId, 'silence_recovery', 'ACTIVE_CONVERSATION', 'ACTIVE_CONVERSATION', {
              prompt: recovery.recoveryPrompt,
            }).catch(() => {});
          }
        } catch (silenceErr) {
          slog.warn('Silence recovery handler failed', { error: String(silenceErr) });
        }
      }
    }, SILENCE_THRESHOLD_MS);
  };

  resetSilenceTimer();

  const attachSessionListeners = (targetSession: RealtimeSession): void => {
    targetSession.on('history_added', (item: RealtimeItem) => {
      const msg = item as RealtimeMessageItem;
      if (msg.type !== 'message') return;

      resetSilenceTimer();

      let line: string | null = null;
      if (msg.role === 'user' && msg.content) {
        for (const c of msg.content) {
          const text = c.text || c.transcript;
          if (text) {
            line = `CALLER: ${text}`;
            costTracker.addUtterance('user', text);

            const utteranceRouting = routeQuery(text);
            costTracker.routingDecisions.push(utteranceRouting);

            if (!hasDowngraded && utteranceRouting.tier === 'premium' && activeModelTier === 'economy') {
              const prevModel = activeModel;
              const prevTier = activeModelTier;
              activeModelTier = utteranceRouting.tier;
              activeModel = TIER_MODEL_MAP[activeModelTier];
              slog.info('Complex query detected on economy tier — upgrading model', {
                query: text.substring(0, 80),
                fromTier: prevTier,
                toTier: activeModelTier,
                reason: utteranceRouting.reason,
              });
              const upgradeConfig = { ...agentConfig, model: activeModel };
              rebuildForHandoff(upgradeConfig, agentConfig.greeting ?? '').catch((err) => {
                slog.warn('Model upgrade failed', { error: String(err) });
                activeModelTier = prevTier;
                activeModel = prevModel;
              });
              writeCallEvent(tenantId, callSessionId, 'model_upgraded', 'ACTIVE_CONVERSATION', 'ACTIVE_CONVERSATION', {
                fromModel: prevModel,
                toModel: activeModel,
                fromTier: prevTier,
                toTier: activeModelTier,
                reason: utteranceRouting.reason,
              }).catch(() => {});
            }

            let classifiedIntent = 'unknown';
            let classifiedConfidence: 'high' | 'medium' | 'low' = 'low';

            if (reasoningEngine) {
              const reasoningClassification = reasoningEngine.classifyIntent(text);
              classifiedIntent = reasoningClassification.intent;
              classifiedConfidence = reasoningClassification.confidence;
            }

            if (ctx.workflowEngine && workflowContext) {
              workflowContext.turnCount++;
              workflowContext.transcript.push(text);
              const legacyClassification = ctx.workflowEngine.classifyIntent(text);

              if (classifiedIntent === 'unknown' && legacyClassification.intent !== 'unknown') {
                classifiedIntent = legacyClassification.intent;
                classifiedConfidence = legacyClassification.confidence;
              }

              const effectiveIntent = classifiedIntent !== 'unknown' ? classifiedIntent : legacyClassification.intent;
              if (effectiveIntent !== 'unknown') {
                workflowContext.intent = effectiveIntent as typeof workflowContext.intent;
                const prevState = workflowContext.state;
                workflowContext.state = 'intent_classification';
                ctx.workflowEngine.recordTransition(
                  prevState,
                  'intent_classification',
                  `caller_utterance:${effectiveIntent}`,
                  workflowContext.slots,
                );
              }
            }

            if (reasoningEngine) {
              try {
                const reasoningResult = reasoningEngine.processUtterance(
                  text,
                  classifiedIntent,
                  classifiedConfidence,
                );
                writeCallEvent(tenantId, callSessionId, 'reasoning_decision', 'ACTIVE_CONVERSATION', 'ACTIVE_CONVERSATION', {
                  turn: reasoningResult.traceEntry.turn,
                  intent: reasoningResult.traceEntry.selectedIntent,
                  confidence: reasoningResult.confidence.overall,
                  confidenceScore: reasoningResult.confidence.numericScore,
                  decision: reasoningResult.action,
                  tool: reasoningResult.toolToExecute,
                  missingSlots: reasoningResult.traceEntry.missingSlots,
                  escalation: reasoningResult.escalation?.trigger,
                }).catch(() => {});

                if (reasoningResult.action === 'escalate_to_human' && ctx.onEscalation) {
                  const escalationReason = reasoningResult.escalation?.reason ?? reasoningResult.reasoning;
                  updateCallState(tenantId, callSessionId, 'ESCALATED', { escalationReason }).catch(() => {});
                  writeCallEvent(tenantId, callSessionId, 'reasoning_escalation', 'ACTIVE_CONVERSATION', 'ESCALATED', {
                    trigger: reasoningResult.escalation?.trigger,
                    output: reasoningResult.escalation?.output,
                    reason: escalationReason,
                  }).catch(() => {});
                  ctx.onEscalation(callSessionId, callSid, escalationReason).catch((escErr) => {
                    slog.error('Reasoning-triggered escalation failed', { error: String(escErr) });
                  });
                }

                if (reasoningResult.action === 'ask_clarifying_question' && reasoningResult.clarifyingQuestion) {
                  writeCallEvent(tenantId, callSessionId, 'reasoning_clarification', 'ACTIVE_CONVERSATION', 'ACTIVE_CONVERSATION', {
                    question: reasoningResult.clarifyingQuestion,
                    missingSlots: reasoningResult.traceEntry.missingSlots,
                    fallbackStep: reasoningResult.fallbackStep,
                  }).catch(() => {});

                  try {
                    injectConversationItem(
                      `[System: The following information is still needed from the caller. Guide the conversation to collect it: "${reasoningResult.clarifyingQuestion}"]`,
                    );
                  } catch (injectErr) {
                    slog.error('Failed to inject clarification', { error: String(injectErr) });
                  }
                }

                if (reasoningResult.action === 'continue_workflow' && reasoningResult.reasoning) {
                  try {
                    injectConversationItem(
                      `[System: Continue the conversation. Current step guidance: ${reasoningResult.reasoning}]`,
                    );
                  } catch (cwErr) {
                    slog.warn('Failed to inject continue_workflow guidance', { error: String(cwErr) });
                  }
                }

                if (reasoningResult.action === 'complete_interaction') {
                  writeCallEvent(tenantId, callSessionId, 'reasoning_complete', 'ACTIVE_CONVERSATION', 'ACTIVE_CONVERSATION', {
                    reason: reasoningResult.reasoning,
                  }).catch(() => {});
                }

                if (
                  classifiedIntent === 'unknown' &&
                  classifiedConfidence === 'low' &&
                  reasoningResult.action !== 'escalate_to_human'
                ) {
                  try {
                    const recovery = reasoningEngine.handlePartialAnswer(text);
                    if (recovery.recoveryPrompt) {
                      injectConversationItem(
                        `[System: The caller's response was unclear. ${recovery.recoveryPrompt}]`,
                      );
                    }
                  } catch (recoveryErr) {
                    slog.warn('Partial answer recovery failed', { error: String(recoveryErr) });
                  }
                }
              } catch (reasoningErr) {
                slog.error('Reasoning engine processing failed', { error: String(reasoningErr) });
              }
            }
            break;
          }
        }
      } else if (msg.role === 'assistant' && msg.content) {
        for (const c of msg.content) {
          if (c.text) {
            line = `AGENT: ${c.text}`;
            costTracker.addUtterance('assistant', c.text);

            if (pendingCompressionSummary) {
              const summary = pendingCompressionSummary;
              pendingCompressionSummary = null;
              try {
                sendSystemMessage(summary);
                slog.info('Injected conversation compression summary into active session');
              } catch (compErr) {
                slog.warn('Failed to inject compression summary', { error: String(compErr) });
              }
            }

            if (reasoningEngine) {
              try {
                const responseSafety = reasoningEngine.checkResponseSafety(c.text);
                if (!responseSafety.allowed) {
                  const criticalViolations = responseSafety.violations
                    .filter((v) => v.severity === 'critical')
                    .map((v) => v.description);
                  writeCallEvent(tenantId, callSessionId, 'safety_response_blocked', 'ACTIVE_CONVERSATION', 'ACTIVE_CONVERSATION', {
                    violations: criticalViolations,
                  }).catch(() => {});
                  slog.warn('Safety gate blocked assistant response — cancelling and correcting', {
                    violations: criticalViolations,
                  });
                  try {
                    sendRealtimeEvent({ type: 'response.cancel' });
                  } catch (cancelErr) {
                    slog.warn('Failed to cancel unsafe response', { error: String(cancelErr) });
                  }
                  try {
                    injectConversationItem(
                      '[System: CRITICAL SAFETY OVERRIDE. Your previous response contained prohibited advice and has been cancelled. You MUST NOT provide medical diagnoses, legal advice, or financial recommendations. Apologize briefly and redirect the caller to a qualified professional. Offer to help with scheduling or taking a message instead.]',
                    );
                  } catch (corrErr) {
                    slog.error('Failed to inject safety correction', { error: String(corrErr) });
                  }
                }
              } catch (safetyErr) {
                slog.warn('Response safety check failed', { error: String(safetyErr) });
              }
            }

            break;
          }
        }
      }

      if (line) {
        lifecycleCoordinator.appendTranscript(callSessionId, redactPHI(line));
      }
    });

    targetSession.on('error', (event) => {
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

    targetSession.on('agent_tool_start', (_context, _agent, toolDef) => {
      const toolInfo = toolDef as { name: string };
      slog.info('Tool execution started', { tool: toolInfo.name });
    });

    targetSession.on('agent_tool_end', (_context, _agent, toolDef, result) => {
      const toolInfo = toolDef as { name: string };
      const resultStr = result as string;
      slog.info('Tool execution completed', {
        tool: toolInfo.name,
        resultLength: resultStr?.length,
      });
    });
  };

  attachSessionListeners(session);

  let isHandoffSwap = false;

  sessionManager.register({
    callSessionId,
    tenantId,
    agentId: agentConfig.agentId,
    callSid,
    startedAt: new Date(),
    cleanup: async () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      try {
        await activeSession.close();
      } catch {}
      lifecycleCoordinator.handleOpenAiSessionEnd(callSessionId);
    },
  });

  const attachCloseHandler = (targetSession: RealtimeSession): void => {
    const emitter = targetSession as unknown as { on(event: string, listener: (...args: unknown[]) => void): void };
    emitter.on('close', () => {
      if (isHandoffSwap) {
        slog.info('Realtime session closed for handoff swap (skipping terminal cleanup)');
        return;
      }

      slog.info('Realtime session closed');

      if (silenceTimer) clearTimeout(silenceTimer);

      const cacheCounters = getSessionCacheCounters(callSessionId);
      costTracker.cacheHits += cacheCounters.hits;
      costTracker.cacheMisses += cacheCounters.misses;
      clearSessionCacheCounters(callSessionId);

      if (reasoningEngine) {
        try {
          const reasoningSummary = reasoningEngine.getCallSummary();
          writeCallEvent(tenantId, callSessionId, 'reasoning_trace', 'ACTIVE_CONVERSATION', 'CALL_COMPLETED', {
            reasoningTrace: reasoningEngine.getTraceEntries(),
            callSummary: reasoningSummary,
          }).catch(() => {});
          slog.info('Reasoning trace persisted', {
            totalTurns: (reasoningSummary as Record<string, unknown>).totalTurns,
            escalationCount: (reasoningSummary as Record<string, unknown>).escalationCount,
          });
        } catch (traceErr) {
          slog.error('Failed to persist reasoning trace', { error: String(traceErr) });
        }
      }

      updateCallState(tenantId, callSessionId, 'CALL_COMPLETED').catch(() => {});
      writeCallEvent(tenantId, callSessionId, 'session_closed', 'ACTIVE_CONVERSATION', 'CALL_COMPLETED').catch(() => {});
      lifecycleCoordinator.handleOpenAiSessionEnd(callSessionId);
      sessionManager.unregister(callSessionId);
    });
  };
  attachCloseHandler(session);

  let activeTransport = wsTransport;
  let activeSession = session;

  const sendAudioToOpenAI = (audio: ArrayBuffer): void => {
    try {
      activeTransport.sendAudio(audio);
    } catch (err) {
      slog.error('Failed to send audio to OpenAI', { error: String(err) });
    }
  };

  let audioOutputHandler: ((audioEvent: TransportLayerAudio) => void) | undefined;
  const onOpenAIAudio = (handler: (audioEvent: TransportLayerAudio) => void): void => {
    audioOutputHandler = handler;
    activeTransport.on('audio', handler);
  };

  const sendRealtimeEvent = (event: Record<string, unknown>): void => {
    (activeTransport as unknown as { sendEvent(e: Record<string, unknown>): void }).sendEvent(event);
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
    activeTransport.on('session.created', () => {
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

  const rebuildForHandoff = async (newAgentConfig: LoadedAgentConfig, handoffGreeting: string): Promise<void> => {
    slog.info('Rebuilding session for workforce handoff', {
      fromAgent: agentConfig.agentId,
      toAgent: newAgentConfig.agentId,
    });

    isHandoffSwap = true;
    try {
      await activeSession.close();
    } catch (closeErr) {
      slog.warn('Error closing previous session during handoff', { error: String(closeErr) });
    }
    isHandoffSwap = false;

    const newToolHandler = buildToolHandler({ ...ctx, agentConfig: newAgentConfig }, callSessionId);
    const newAgentTools = buildRealtimeTools(newAgentConfig.tools, newToolHandler);

    let handoffPrompt = newAgentConfig.systemPrompt;
    if (reasoningEngine) {
      const safetyPolicy = reasoningEngine.getSafetyPolicyPrompt();
      if (safetyPolicy) {
        handoffPrompt += `\n\n${safetyPolicy}`;
      }
    }
    if (callerMemorySummary) {
      handoffPrompt += `\n\n===== CALLER MEMORY =====\n${callerMemorySummary}`;
    }
    if (knowledgeAvailable) {
      handoffPrompt += `\n\n===== KNOWLEDGE BASE =====\nYou have access to a company knowledge base. When a caller asks about products, services, policies, procedures, or FAQs, use the retrieve_knowledge tool to search for relevant information before answering.`;
    }

    const newAgent = new RealtimeAgent({
      name: `${newAgentConfig.agentId}-${tenantId}`,
      instructions: handoffPrompt,
      tools: newAgentTools,
    });

    const newTransport = new OpenAIRealtimeWebSocket({ useInsecureApiKey: true });

    const newSessionConfig = {
      voice: newAgentConfig.voice,
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
          voice: newAgentConfig.voice,
        },
      },
    };

    const newSession = new RealtimeSession(newAgent, {
      transport: newTransport,
      model: newAgentConfig.model,
      config: newSessionConfig,
      tracingDisabled: false,
      tracing: {
        workflowName: `VoiceAI_${newAgentConfig.agentId}`,
        groupId: callSid,
      },
    } as ConstructorParameters<typeof RealtimeSession>[1]);

    activeTransport = newTransport;
    activeSession = newSession;

    attachCloseHandler(newSession);
    attachSessionListeners(newSession);

    if (audioOutputHandler) {
      newTransport.on('audio', audioOutputHandler);
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      newTransport.on('session.created', () => {
        try {
          injectConversationItem(
            `[System: You are taking over this call from another agent. Greet the caller now. Say exactly: "${handoffGreeting}"]`,
          );
        } catch (greetErr) {
          slog.error('Failed to inject handoff greeting', { error: String(greetErr) });
        }
      });

      await newSession.connect({ apiKey });
      slog.info('Handoff session connected', { newAgent: newAgentConfig.agentId });
    }

    await writeCallEvent(tenantId, callSessionId, 'handoff_session_rebuilt', 'HANDOFF', 'ACTIVE_CONVERSATION', {
      newAgentId: newAgentConfig.agentId,
    });
    await updateCallState(tenantId, callSessionId, 'ACTIVE_CONVERSATION');
  };

  const BUDGET_CHECK_INTERVAL_MS = 30000;
  let budgetCheckTimer: ReturnType<typeof setInterval> | null = null;
  let hasDowngraded = false;

  budgetCheckTimer = setInterval(async () => {
    try {
      const modelRate = getModelRate(activeModel);
      const currentCostCents = Math.ceil(
        (costTracker.inputTokens / 1000) * modelRate.inputPer1kTokens +
        (costTracker.outputTokens / 1000) * modelRate.outputPer1kTokens +
        (costTracker.ttsCharacters / 1000) * TTS_COST_PER_1K_CHARS_CENTS,
      );
      const budgetResult = await checkConversationBudget(tenantId, currentCostCents);

      if (budgetResult.shouldEndCall) {
        slog.warn('Budget cap exceeded — ending call', {
          currentCostCents,
          budgetCents: budgetResult.budgetCents,
          percentUsed: budgetResult.percentUsed,
        });
        sendSystemMessage('I appreciate your time, but I need to wrap up our conversation now. Is there anything else urgent I can help you with before we end?');
        setTimeout(() => {
          try { activeSession.close(); } catch {}
        }, 10000);
        if (budgetCheckTimer) clearInterval(budgetCheckTimer);
        budgetCheckTimer = null;
      } else if (budgetResult.shouldDowngrade && !hasDowngraded) {
        hasDowngraded = true;
        const prevModel = activeModel;
        const prevTier = activeModelTier;
        activeModelTier = 'economy';
        activeModel = TIER_MODEL_MAP['economy'];
        slog.warn('Budget threshold reached — downgrading to economy model', {
          currentCostCents,
          percentUsed: budgetResult.percentUsed,
          previousModel: prevModel,
          newModel: activeModel,
        });
        const downgradeConfig = { ...agentConfig, model: activeModel };
        try {
          await rebuildForHandoff(downgradeConfig, agentConfig.greeting ?? 'I\'m still here to help.');
          writeCallEvent(tenantId, callSessionId, 'model_downgraded', 'ACTIVE_CONVERSATION', 'ACTIVE_CONVERSATION', {
            fromModel: prevModel,
            toModel: activeModel,
            reason: 'budget_threshold',
            percentUsed: budgetResult.percentUsed,
          }).catch(() => {});
        } catch (downgradeErr) {
          slog.error('Model downgrade failed', { error: String(downgradeErr) });
          activeModelTier = prevTier;
          activeModel = prevModel;
        }
      }

      if (budgetResult.shouldAlert) {
        writeCallEvent(tenantId, callSessionId, 'budget_alert', 'ACTIVE_CONVERSATION', 'ACTIVE_CONVERSATION', {
          currentCostCents,
          budgetCents: budgetResult.budgetCents,
          percentUsed: budgetResult.percentUsed,
        }).catch(() => {});
      }
    } catch (budgetErr) {
      slog.warn('Budget check failed', { error: String(budgetErr) });
    }
  }, BUDGET_CHECK_INTERVAL_MS);

  const registeredSession = sessionManager.get(callSessionId);
  if (registeredSession) {
    const prevCleanup = registeredSession.cleanup;
    registeredSession.cleanup = async () => {
      if (budgetCheckTimer) clearInterval(budgetCheckTimer);
      await prevCleanup();
    };
  }

  return {
    get session() { return activeSession; },
    callSessionId,
    sendAudioToOpenAI,
    onOpenAIAudio,
    triggerGreeting,
    sendSystemMessage,
    rebuildForHandoff,
    costTracker,
    routedModel: costTracker.activeModel,
    routedTier: costTracker.activeModelTier,
  };
}
