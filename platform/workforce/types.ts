export interface WorkforceTeam {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  status: 'active' | 'inactive';
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WorkforceMember {
  id: string;
  team_id: string;
  agent_id: string;
  tenant_id: string;
  role: string;
  is_receptionist: boolean;
  priority: number;
  status: 'active' | 'inactive';
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  agent_name?: string;
  agent_type?: string;
}

export interface WorkforceRoutingRule {
  id: string;
  team_id: string;
  tenant_id: string;
  intent: string;
  target_member_id: string;
  fallback_member_id: string | null;
  priority: number;
  conditions: Record<string, unknown>;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
  target_agent_name?: string;
  target_role?: string;
  fallback_agent_name?: string;
}

export interface WorkforceTemplate {
  id: string;
  tenant_id: string | null;
  name: string;
  description: string | null;
  vertical: string | null;
  is_system: boolean;
  template_config: WorkforceTemplateConfig;
  created_at: string;
  updated_at: string;
}

export interface WorkforceTemplateConfig {
  roles: WorkforceTemplateRole[];
  routingRules: WorkforceTemplateRoutingRule[];
  outboundAutomations?: WorkforceTemplateOutboundAutomation[];
}

export interface WorkforceTemplateOutboundAutomation {
  type: string;
  description: string;
}

export interface WorkforceTemplateRole {
  role: string;
  agentType: string;
  isReceptionist: boolean;
  description: string;
}

export interface WorkforceTemplateRoutingRule {
  intent: string;
  targetRole: string;
  fallbackRole?: string;
}

export interface WorkforceRoutingHistoryEntry {
  id: string;
  team_id: string;
  tenant_id: string;
  call_session_id: string;
  from_agent_id: string;
  to_agent_id: string;
  intent: string | null;
  routing_rule_id: string | null;
  reason: string | null;
  context_summary: string | null;
  duration_ms: number | null;
  outcome: string | null;
  created_at: string;
  from_agent_name?: string;
  to_agent_name?: string;
}

export interface HandoffRequest {
  teamId: string;
  tenantId: string;
  callSessionId: string;
  callSid: string;
  fromAgentId: string;
  intent: string;
  conversationContext: string;
  callerPhone?: string;
}

export interface HandoffRoutingInfo {
  team_id: string;
  tenant_id: string;
  call_session_id: string;
  from_agent_id: string;
  to_agent_id: string;
  intent: string;
  routing_rule_id: string;
  context_summary: string;
}

export interface HandoffResult {
  success: boolean;
  targetAgentId?: string;
  targetAgentConfig?: {
    agentId: string;
    agentType: string;
    systemPrompt: string;
    greeting: string;
    voice: string;
    model: string;
    tools: unknown[];
    guardrails: string[];
  };
  handoffGreeting?: string;
  reason: string;
  routingRuleId?: string;
  routingInfo?: HandoffRoutingInfo;
}

export interface WorkforceMetrics {
  teamId: string;
  totalHandoffs: number;
  successfulHandoffs: number;
  avgHandoffDurationMs: number;
  handoffsByIntent: Record<string, number>;
  handoffsByAgent: { agentId: string; agentName: string; count: number }[];
  activeCallsByAgent: { agentId: string; agentName: string; activeCalls: number }[];
  recentHandoffs: WorkforceRoutingHistoryEntry[];
}

export interface WorkforceOptimizationInsight {
  id: string;
  tenantId: string;
  teamId: string;
  category: string;
  title: string;
  description: string;
  impactEstimate: string | null;
  difficulty: string;
  estimatedRevenueImpactCents: number | null;
  status: string;
  actionType: string | null;
  actionPayload: Record<string, unknown>;
  sourceData: Record<string, unknown>;
  analysisPeriodStart: string | null;
  analysisPeriodEnd: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  dismissedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkforceRevenueMetrics {
  id: string;
  tenantId: string;
  teamId: string;
  periodStart: string;
  periodEnd: string;
  callsHandled: number;
  bookingsGenerated: number;
  missedCallsRecovered: number;
  estimatedRevenueCents: number;
  missedRevenueCents: number;
  avgTicketValueCents: number;
  agentBreakdown: Array<{
    agentId: string;
    agentName: string;
    callsHandled: number;
    bookingsGenerated: number;
    revenueCents: number;
  }>;
  dailyBreakdown: Array<{
    date: string;
    callsHandled: number;
    bookingsGenerated: number;
    revenueCents: number;
  }>;
  createdAt: string;
  updatedAt: string;
}

export type OutboundCampaignType =
  | 'appointment_reminder'
  | 'follow_up'
  | 'maintenance_reminder'
  | 'review_request'
  | 'reactivation'
  | 'recall'
  | 'lease_renewal'
  | 'custom';

export interface WorkforceOutboundTask {
  id: string;
  tenantId: string;
  teamId: string;
  campaignType: OutboundCampaignType;
  name: string;
  status: string;
  config: Record<string, unknown>;
  campaignId: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  totalContacts: number;
  contactsReached: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
