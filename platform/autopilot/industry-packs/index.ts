import type { IndustryDetectionRule, OperationalSignals, DetectionResult } from '../types';
import { hvacAutopilotRules } from './hvac';
import { dentalAutopilotRules } from './dental';
import { medicalAutopilotRules } from './medical';
import { propertyManagementAutopilotRules } from './property-management';

const BASE_RULES: IndustryDetectionRule[] = [
  {
    id: 'base_missed_call_spike',
    vertical: 'general',
    name: 'Missed Call Spike',
    description: 'Detect when missed call rate exceeds threshold',
    category: 'missed_calls',
    severity: 'warning',
    riskTier: 'low',
    evaluate: (signals: OperationalSignals): DetectionResult | null => {
      if (signals.callVolume.total < 10) return null;
      const missedRate = signals.callVolume.missed / signals.callVolume.total;
      if (missedRate > 0.2) {
        return {
          title: 'Missed Call Rate Above 20%',
          description: `${signals.callVolume.missed} of ${signals.callVolume.total} calls (${Math.round(missedRate * 100)}%) were missed this week.`,
          detectedSignal: 'missed_call_rate',
          dataEvidence: { missed: signals.callVolume.missed, total: signals.callVolume.total, missedRate },
          confidenceScore: 0.85,
          recommendedAction: 'Enable after-hours agent or increase agent capacity to handle call volume.',
          expectedOutcome: `Recover approximately ${Math.round(signals.callVolume.missed * 0.6)} calls per week.`,
          reasoning: 'A missed call rate above 20% indicates insufficient coverage. Each missed call is a lost business opportunity.',
          actionType: 'activate_agent',
          actionPayload: { reason: 'missed_call_coverage' },
          estimatedRevenueImpactCents: Math.round(signals.callVolume.missed * 0.5 * 100 * 100),
        };
      }
      return null;
    },
  },
  {
    id: 'base_agent_underutilization',
    vertical: 'general',
    name: 'Agent Underutilization',
    description: 'Detect agents with very low call volume',
    category: 'agent_utilization',
    severity: 'info',
    riskTier: 'low',
    evaluate: (signals: OperationalSignals): DetectionResult | null => {
      if (signals.agentMetrics.length < 2) return null;
      const totalCalls = signals.agentMetrics.reduce((sum, a) => sum + a.calls, 0);
      if (totalCalls < 10) return null;
      const avgCalls = totalCalls / signals.agentMetrics.length;
      const underused = signals.agentMetrics.filter(a => a.calls < avgCalls * 0.2 && a.calls < 3);
      if (underused.length > 0) {
        return {
          title: 'Underutilized AI Agents Detected',
          description: `${underused.length} agent(s) handled fewer than 20% of average calls: ${underused.map(a => a.agentName).join(', ')}.`,
          detectedSignal: 'agent_underutilization',
          dataEvidence: { underused: underused.map(a => ({ name: a.agentName, calls: a.calls })), avgCalls },
          confidenceScore: 0.7,
          recommendedAction: 'Review underutilized agent routing rules and consider consolidating or redeploying these agents.',
          expectedOutcome: 'Optimize resource allocation and reduce unnecessary agent costs.',
          reasoning: 'Agents handling minimal calls may have misconfigured routing or overlap with other agents.',
          actionType: 'create_task',
          actionPayload: { task: 'review_agent_routing', agents: underused.map(a => a.agentId) },
        };
      }
      return null;
    },
  },
  {
    id: 'base_high_failure_rate',
    vertical: 'general',
    name: 'High Call Failure Rate',
    description: 'Detect when call failure rate is abnormally high',
    category: 'quality',
    severity: 'critical',
    riskTier: 'medium',
    evaluate: (signals: OperationalSignals): DetectionResult | null => {
      if (signals.callVolume.total < 10) return null;
      const failureRate = signals.callVolume.failed / signals.callVolume.total;
      if (failureRate > 0.1) {
        return {
          title: 'High Call Failure Rate Alert',
          description: `${signals.callVolume.failed} of ${signals.callVolume.total} calls (${Math.round(failureRate * 100)}%) failed. This indicates potential system issues affecting call quality.`,
          detectedSignal: 'high_failure_rate',
          dataEvidence: { failed: signals.callVolume.failed, total: signals.callVolume.total, failureRate },
          confidenceScore: 0.9,
          recommendedAction: 'Investigate call failure causes - check agent configurations, tool integrations, and telephony provider status.',
          expectedOutcome: 'Resolve the root cause and bring failure rate below 5%.',
          reasoning: 'A failure rate above 10% typically indicates a systemic issue. Immediate investigation is needed.',
          actionType: 'send_alert',
          actionPayload: { alertType: 'system_health', priority: 'high' },
        };
      }
      return null;
    },
  },
  {
    id: 'base_tool_failures',
    vertical: 'general',
    name: 'Tool Integration Failures',
    description: 'Detect tools with high failure rates',
    category: 'quality',
    severity: 'warning',
    riskTier: 'medium',
    evaluate: (signals: OperationalSignals): DetectionResult | null => {
      const failingTools = signals.toolFailures.filter(t => t.total > 5 && t.failures / t.total > 0.2);
      if (failingTools.length === 0) return null;
      return {
        title: 'Tool Integration Reliability Issues',
        description: `${failingTools.length} tool(s) have failure rates above 20%: ${failingTools.map(t => `${t.tool} (${t.failures}/${t.total} failures)`).join(', ')}.`,
        detectedSignal: 'tool_failures',
        dataEvidence: { failingTools },
        confidenceScore: 0.85,
        recommendedAction: 'Review and fix the failing tool integrations. Check API keys, endpoints, and error logs.',
        expectedOutcome: 'Restore tool reliability and improve overall call completion rate.',
        reasoning: 'Tool failures directly impact call quality and customer experience. Tools with >20% failure rate need immediate attention.',
        actionType: 'create_task',
        actionPayload: { task: 'fix_tool_integrations', tools: failingTools.map(t => t.tool) },
      };
    },
  },
];

const INDUSTRY_RULES: Record<string, IndustryDetectionRule[]> = {
  hvac: hvacAutopilotRules,
  dental: dentalAutopilotRules,
  medical: medicalAutopilotRules,
  'medical-after-hours': medicalAutopilotRules,
  'property-management': propertyManagementAutopilotRules,
};

export function getIndustryPackRules(industry: string | null): IndustryDetectionRule[] {
  const rules = [...BASE_RULES];
  if (industry && INDUSTRY_RULES[industry]) {
    rules.push(...INDUSTRY_RULES[industry]);
  }
  return rules;
}

export function getAvailableIndustryPacks(): Array<{ vertical: string; displayName: string; ruleCount: number }> {
  return [
    { vertical: 'hvac', displayName: 'HVAC Services', ruleCount: hvacAutopilotRules.length },
    { vertical: 'dental', displayName: 'Dental Office', ruleCount: dentalAutopilotRules.length },
    { vertical: 'medical', displayName: 'Medical / After-Hours', ruleCount: medicalAutopilotRules.length },
    { vertical: 'property-management', displayName: 'Property Management', ruleCount: propertyManagementAutopilotRules.length },
  ];
}
