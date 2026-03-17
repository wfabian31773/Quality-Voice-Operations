import { createLogger } from '../core/logger';
import { loadAgentConfig, type AgentLoadContext } from '../../server/voice-gateway/services/agentLoader';
import { WorkforceRoutingService } from './WorkforceRoutingService';
import { getPlatformPool, withTenantContext } from '../db';
import type { HandoffRequest, HandoffResult } from './types';

const logger = createLogger('HANDOFF_ENGINE');

export class HandoffEngine {
  private readonly routingService: WorkforceRoutingService;

  constructor(routingService?: WorkforceRoutingService) {
    this.routingService = routingService ?? new WorkforceRoutingService();
  }

  async executeHandoff(request: HandoffRequest): Promise<HandoffResult> {
    const { teamId, tenantId, callSessionId, fromAgentId, intent, conversationContext } = request;

    logger.info('Handoff requested', {
      teamId,
      tenantId,
      callId: callSessionId,
      fromAgentId,
      intent,
    });

    const resolution = await this.routingService.resolveTargetAgent(tenantId, teamId, intent);

    if (!resolution) {
      logger.warn('No routing target found for handoff', { teamId, intent });
      return {
        success: false,
        reason: `No specialist agent configured for intent: ${intent}`,
      };
    }

    const { member, rule } = resolution;

    if (member.agent_id === fromAgentId) {
      logger.info('Handoff target is same as current agent, skipping', { teamId, intent });
      return {
        success: false,
        reason: 'Target agent is the same as the current agent',
      };
    }

    try {
      const agentConfig = await this.loadTargetAgentConfig(
        tenantId,
        member.agent_id,
        conversationContext,
        request.callerPhone,
      );

      if (!agentConfig) {
        return {
          success: false,
          reason: 'Failed to load target agent configuration',
        };
      }

      const handoffGreeting = this.buildHandoffGreeting(member.role, conversationContext);

      logger.info('Handoff routing resolved', {
        teamId,
        callId: callSessionId,
        fromAgentId,
        toAgentId: member.agent_id,
        intent,
      });

      return {
        success: true,
        targetAgentId: member.agent_id,
        targetAgentConfig: {
          agentId: agentConfig.agentId,
          agentType: member.agent_type ?? 'general',
          systemPrompt: this.augmentPromptWithContext(agentConfig.systemPrompt, conversationContext),
          greeting: handoffGreeting,
          voice: agentConfig.voice,
          model: agentConfig.model,
          tools: agentConfig.tools,
          guardrails: agentConfig.guardrails,
        },
        handoffGreeting,
        reason: `Successfully routed to ${member.role} agent`,
        routingRuleId: rule.id,
        routingInfo: {
          team_id: teamId,
          tenant_id: tenantId,
          call_session_id: callSessionId,
          from_agent_id: fromAgentId,
          to_agent_id: member.agent_id,
          intent,
          routing_rule_id: rule.id,
          context_summary: conversationContext.slice(0, 500),
        },
      };
    } catch (err) {
      logger.error('Handoff execution failed', {
        teamId,
        callId: callSessionId,
        error: String(err),
      });

      await this.routingService.recordHandoff(tenantId, {
        team_id: teamId,
        tenant_id: tenantId,
        call_session_id: callSessionId,
        from_agent_id: fromAgentId,
        to_agent_id: member.agent_id,
        intent,
        routing_rule_id: rule.id,
        reason: `Handoff failed: ${String(err)}`,
        context_summary: conversationContext.slice(0, 500),
        duration_ms: null,
        outcome: 'failed',
      });

      return {
        success: false,
        reason: `Handoff failed: ${String(err)}`,
      };
    }
  }

  private async loadTargetAgentConfig(
    tenantId: string,
    agentId: string,
    conversationContext: string,
    callerPhone?: string,
  ) {
    const pool = getPlatformPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await withTenantContext(client, tenantId, async () => {
        const { rows } = await client.query(
          `SELECT id, name, type, system_prompt, voice, model, tools, escalation_config, metadata
           FROM agents WHERE id = $1`,
          [agentId],
        );
        await client.query('COMMIT');
        return rows[0] as Record<string, unknown> | undefined;
      });
      if (!result) return null;

      const ctx: AgentLoadContext = {
        tenantId: tenantId as import('../core/types').TenantId,
        agentId,
        agentType: result.type as string,
        callerPhone,
        callerMemorySummary: conversationContext,
        dbAgent: {
          name: result.name as string,
          system_prompt: result.system_prompt as string | undefined,
          voice: result.voice as string | undefined,
          model: result.model as string | undefined,
          tools: result.tools as unknown,
          escalation_config: result.escalation_config as Record<string, unknown> | undefined,
          metadata: result.metadata as Record<string, unknown> | undefined,
        },
      };

      return loadAgentConfig(ctx);
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Failed to load target agent config', { tenantId, agentId, error: String(err) });
      return null;
    } finally {
      client.release();
    }
  }

  private augmentPromptWithContext(systemPrompt: string, conversationContext: string): string {
    if (!conversationContext) return systemPrompt;
    return `${systemPrompt}

===== HANDOFF CONTEXT =====
You are taking over this call from another agent. Here is a summary of the conversation so far:
${conversationContext}

Continue the conversation naturally. Acknowledge that you understand the caller's needs based on the context above.
Do NOT ask the caller to repeat information they have already provided.
===== END HANDOFF CONTEXT =====`;
  }

  private buildHandoffGreeting(role: string, _context: string): string {
    const roleGreetings: Record<string, string> = {
      scheduler: "I'm connecting you with our scheduling specialist who can help you with that.",
      dispatcher: "Let me connect you with our dispatch team who can assist you right away.",
      triage: "I'm transferring you to our medical triage specialist for your concern.",
      intake: "Let me connect you with our intake specialist to get your information.",
      support: "I'll connect you with our support team to help with that.",
      billing: "Let me transfer you to our billing department for assistance.",
    };
    return roleGreetings[role] ?? "Let me connect you with the right specialist to help you with that.";
  }
}
