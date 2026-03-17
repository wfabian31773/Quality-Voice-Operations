import type { IndustryDetectionRule, OperationalSignals, DetectionResult } from '../types';

function detectLeasingInquirySurge(signals: OperationalSignals): DetectionResult | null {
  const { callVolume, previousPeriodCallVolume } = signals;
  if (callVolume.total < 10) return null;

  const changeRate = previousPeriodCallVolume > 0
    ? (callVolume.total - previousPeriodCallVolume) / previousPeriodCallVolume
    : 0;

  if (changeRate > 0.4) {
    return {
      title: 'Leasing Inquiry Surge Detected',
      description: `Call volume increased ${Math.round(changeRate * 100)}% over the previous period (${callVolume.total} vs ${previousPeriodCallVolume} calls). This may indicate seasonal leasing demand or marketing effectiveness.`,
      detectedSignal: 'leasing_inquiry_surge',
      dataEvidence: { currentVolume: callVolume.total, previousVolume: previousPeriodCallVolume, changeRate },
      confidenceScore: 0.75,
      recommendedAction: 'Scale up the leasing inquiry agent and ensure tour scheduling tools are properly configured. Consider launching a targeted outbound campaign for available units.',
      expectedOutcome: 'Capture 40-60% more leasing inquiries during the surge and increase tour booking rate.',
      reasoning: 'Property management leasing follows seasonal patterns. Surges indicate high demand windows where capturing every inquiry directly impacts occupancy rates.',
      actionType: 'activate_agent',
      actionPayload: { reason: 'leasing_surge', enableTourScheduling: true },
      estimatedRevenueImpactCents: Math.round(callVolume.missed * 0.5 * 1000 * 100),
    };
  }
  return null;
}

function detectMaintenanceRequestBacklog(signals: OperationalSignals): DetectionResult | null {
  const { callVolume, agentMetrics } = signals;
  if (callVolume.total < 5) return null;

  const failedRate = callVolume.failed / callVolume.total;
  if (failedRate > 0.1) {
    return {
      title: 'Property Maintenance Request Processing Issues',
      description: `${callVolume.failed} of ${callVolume.total} calls (${Math.round(failedRate * 100)}%) failed. Maintenance requests may not be getting properly logged and dispatched.`,
      detectedSignal: 'maintenance_failures',
      dataEvidence: { failed: callVolume.failed, total: callVolume.total, failedRate },
      confidenceScore: 0.7,
      recommendedAction: 'Review the maintenance request workflow and ensure work order creation tools are functioning correctly. Check for API integration issues with the property management system.',
      expectedOutcome: 'Reduce failed maintenance request calls and ensure all tenant issues are properly logged.',
      reasoning: 'Failed maintenance request calls lead to tenant dissatisfaction and potential lease non-renewals. Each failed call may represent a maintenance emergency.',
      actionType: 'create_task',
      actionPayload: { task: 'review_maintenance_workflow', priority: 'high' },
    };
  }
  return null;
}

function detectEmergencyMaintenancePattern(signals: OperationalSignals): DetectionResult | null {
  const { afterHoursCalls, callVolume } = signals;
  if (callVolume.total < 5) return null;

  const afterHoursRate = afterHoursCalls / callVolume.total;
  if (afterHoursRate > 0.2 && afterHoursCalls > 5) {
    return {
      title: 'After-Hours Property Emergency Call Pattern',
      description: `${afterHoursCalls} calls (${Math.round(afterHoursRate * 100)}%) came in after hours. Property emergencies like water leaks, lockouts, and heating failures require immediate response.`,
      detectedSignal: 'after_hours_emergency',
      dataEvidence: { afterHoursCalls, total: callVolume.total, afterHoursRate },
      confidenceScore: 0.8,
      recommendedAction: 'Deploy an after-hours emergency triage agent that can classify maintenance urgency and dispatch emergency maintenance personnel for critical issues.',
      expectedOutcome: 'Ensure all after-hours property emergencies are triaged and dispatched within minutes, reducing property damage and tenant complaints.',
      reasoning: 'Property emergencies left unaddressed can cause significant damage (burst pipes, security issues). Rapid triage and dispatch minimize damage costs.',
      actionType: 'activate_agent',
      actionPayload: { reason: 'property_emergency_coverage', afterHours: true },
    };
  }
  return null;
}

export const propertyManagementAutopilotRules: IndustryDetectionRule[] = [
  {
    id: 'pm_ap_leasing_surge',
    vertical: 'property-management',
    name: 'Leasing Inquiry Surge',
    description: 'Detect surges in leasing inquiry call volume',
    category: 'booking_conversion',
    severity: 'info',
    riskTier: 'low',
    evaluate: detectLeasingInquirySurge,
  },
  {
    id: 'pm_ap_maintenance_backlog',
    vertical: 'property-management',
    name: 'Maintenance Request Issues',
    description: 'Detect maintenance request processing failures',
    category: 'quality',
    severity: 'warning',
    riskTier: 'medium',
    evaluate: detectMaintenanceRequestBacklog,
  },
  {
    id: 'pm_ap_emergency',
    vertical: 'property-management',
    name: 'Property Emergency Pattern',
    description: 'Detect after-hours emergency maintenance patterns',
    category: 'after_hours',
    severity: 'critical',
    riskTier: 'medium',
    evaluate: detectEmergencyMaintenancePattern,
  },
];
