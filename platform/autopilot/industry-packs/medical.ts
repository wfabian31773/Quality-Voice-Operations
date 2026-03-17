import type { IndustryDetectionRule, OperationalSignals, DetectionResult } from '../types';

function detectTriageRoutingOverload(signals: OperationalSignals): DetectionResult | null {
  const { callVolume, agentMetrics } = signals;
  if (callVolume.total < 10) return null;

  const escalationRate = callVolume.escalated / callVolume.total;
  if (escalationRate > 0.3) {
    return {
      title: 'High Medical Triage Escalation Rate',
      description: `${callVolume.escalated} of ${callVolume.total} calls (${Math.round(escalationRate * 100)}%) are being escalated. This may indicate the AI agent needs better triage classification or the symptom-to-urgency mapping needs updating.`,
      detectedSignal: 'escalation_overload',
      dataEvidence: { escalated: callVolume.escalated, total: callVolume.total, escalationRate, agentMetrics },
      confidenceScore: 0.8,
      recommendedAction: 'Review and refine the medical triage routing rules. Consider adding intermediate urgency levels and expanding the AI agent symptom classification capabilities.',
      expectedOutcome: 'Reduce unnecessary escalations by 20-30%, freeing clinical staff time while maintaining patient safety.',
      reasoning: 'Medical practices with optimized triage AI maintain escalation rates below 20%. High rates suggest over-cautious classification that burdens on-call providers unnecessarily.',
      actionType: 'update_routing',
      actionPayload: { focus: 'triage_classification', reduceEscalation: true },
      estimatedCostSavingsCents: Math.round(callVolume.escalated * 0.25 * 50 * 100),
    };
  }
  return null;
}

function detectAfterHoursOverflow(signals: OperationalSignals): DetectionResult | null {
  const { afterHoursCalls, callVolume } = signals;
  if (callVolume.total < 5) return null;

  const afterHoursRate = afterHoursCalls / callVolume.total;
  if (afterHoursRate > 0.3) {
    return {
      title: 'High After-Hours Medical Call Volume',
      description: `${afterHoursCalls} calls (${Math.round(afterHoursRate * 100)}%) came in after hours. Medical after-hours calls require careful triage and appropriate escalation to on-call providers.`,
      detectedSignal: 'after_hours_medical_volume',
      dataEvidence: { afterHoursCalls, total: callVolume.total, afterHoursRate },
      confidenceScore: 0.75,
      recommendedAction: 'Ensure after-hours triage agent is properly configured with symptom classification and escalation protocols. Consider extending coverage hours.',
      expectedOutcome: 'Improve patient satisfaction and ensure critical symptoms are escalated promptly while reducing unnecessary on-call pages.',
      reasoning: 'After-hours medical calls often involve urgent symptoms. Proper AI triage reduces unnecessary provider pages by 30-40% while maintaining safety.',
      actionType: 'activate_agent',
      actionPayload: { reason: 'after_hours_medical', urgencyTriage: true },
    };
  }
  return null;
}

function detectMissedUrgentCalls(signals: OperationalSignals): DetectionResult | null {
  const { callVolume } = signals;
  if (callVolume.total < 5) return null;

  if (callVolume.missed > 5) {
    return {
      title: 'Missed Medical Calls Detected',
      description: `${callVolume.missed} calls were missed in the past week. In a medical context, missed calls could mean patients with urgent symptoms are not being triaged.`,
      detectedSignal: 'missed_medical_calls',
      dataEvidence: { missed: callVolume.missed, total: callVolume.total },
      confidenceScore: 0.9,
      recommendedAction: 'Activate 24/7 coverage with the medical triage agent. Ensure all calls are answered and triaged appropriately.',
      expectedOutcome: 'Eliminate missed calls and ensure all patient inquiries are captured and triaged for clinical response.',
      reasoning: 'Missed medical calls carry patient safety risk and potential liability. 24/7 AI triage ensures no call goes unanswered.',
      actionType: 'activate_agent',
      actionPayload: { reason: 'missed_medical_calls', priority: 'high' },
    };
  }
  return null;
}

export const medicalAutopilotRules: IndustryDetectionRule[] = [
  {
    id: 'medical_ap_triage_overload',
    vertical: 'medical',
    name: 'Medical Triage Overload',
    description: 'Detect when triage escalation rate is too high',
    category: 'agent_utilization',
    severity: 'warning',
    riskTier: 'high',
    evaluate: detectTriageRoutingOverload,
  },
  {
    id: 'medical_ap_after_hours',
    vertical: 'medical',
    name: 'Medical After-Hours Volume',
    description: 'Detect high after-hours medical call patterns',
    category: 'after_hours',
    severity: 'warning',
    riskTier: 'medium',
    evaluate: detectAfterHoursOverflow,
  },
  {
    id: 'medical_ap_missed',
    vertical: 'medical',
    name: 'Missed Medical Calls',
    description: 'Detect missed calls in medical context',
    category: 'missed_calls',
    severity: 'critical',
    riskTier: 'high',
    evaluate: detectMissedUrgentCalls,
  },
];
