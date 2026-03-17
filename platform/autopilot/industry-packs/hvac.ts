import type { IndustryDetectionRule, OperationalSignals, DetectionResult } from '../types';

function detectEmergencyDemandSpike(signals: OperationalSignals): DetectionResult | null {
  const { callVolume, previousPeriodCallVolume, hourlyCallPattern } = signals;
  if (callVolume.total < 10) return null;

  const changeRate = previousPeriodCallVolume > 0
    ? (callVolume.total - previousPeriodCallVolume) / previousPeriodCallVolume
    : 0;

  if (changeRate > 0.5) {
    const peakHour = hourlyCallPattern.reduce((max, h) => h.calls > max.calls ? h : max, hourlyCallPattern[0]);
    return {
      title: 'HVAC Emergency Demand Spike Detected',
      description: `Call volume increased ${Math.round(changeRate * 100)}% over the previous period (${callVolume.total} vs ${previousPeriodCallVolume} calls). Peak hour: ${peakHour?.hour ?? 'N/A'}:00 with ${peakHour?.calls ?? 0} calls. This may indicate extreme weather driving emergency service requests.`,
      detectedSignal: 'call_volume_spike',
      dataEvidence: { currentVolume: callVolume.total, previousVolume: previousPeriodCallVolume, changeRate, peakHour: peakHour?.hour },
      confidenceScore: Math.min(0.5 + changeRate * 0.3, 0.95),
      recommendedAction: 'Activate after-hours emergency agent and extend service hours to handle surge demand. Consider enabling overflow routing.',
      expectedOutcome: 'Capture 30-50% more emergency service calls and reduce missed call rate during peak demand.',
      reasoning: `A ${Math.round(changeRate * 100)}% increase in call volume typically indicates weather-driven emergency demand in HVAC. Historical patterns show that capturing these calls during surges directly converts to emergency service revenue.`,
      actionType: 'activate_agent',
      actionPayload: { reason: 'hvac_demand_spike', extendHours: true },
      estimatedRevenueImpactCents: Math.round(callVolume.missed * 150 * 100),
    };
  }
  return null;
}

function detectMissedCallSpike(signals: OperationalSignals): DetectionResult | null {
  const { callVolume } = signals;
  if (callVolume.total < 10) return null;

  const missedRate = callVolume.missed / callVolume.total;
  if (missedRate > 0.15) {
    return {
      title: 'High HVAC Missed Call Rate',
      description: `${callVolume.missed} of ${callVolume.total} calls (${Math.round(missedRate * 100)}%) were missed in the past week. Each missed HVAC call represents a potential $150-500 service ticket.`,
      detectedSignal: 'missed_call_spike',
      dataEvidence: { missed: callVolume.missed, total: callVolume.total, missedRate },
      confidenceScore: 0.85,
      recommendedAction: 'Enable after-hours voice agent to capture missed calls and schedule callbacks.',
      expectedOutcome: `Recover approximately ${Math.round(callVolume.missed * 0.6)} missed service opportunities per week.`,
      reasoning: 'HVAC service calls have high conversion rates. Missed calls during business hours often indicate capacity issues, while after-hours misses indicate unserved demand.',
      actionType: 'activate_agent',
      actionPayload: { reason: 'missed_calls', afterHours: true },
      estimatedRevenueImpactCents: Math.round(callVolume.missed * 0.6 * 200 * 100),
    };
  }
  return null;
}

function detectAfterHoursSurge(signals: OperationalSignals): DetectionResult | null {
  const { afterHoursCalls, callVolume } = signals;
  if (callVolume.total < 10) return null;

  const afterHoursRate = afterHoursCalls / callVolume.total;
  if (afterHoursRate > 0.25) {
    return {
      title: 'Significant After-Hours HVAC Call Volume',
      description: `${afterHoursCalls} calls (${Math.round(afterHoursRate * 100)}%) came in after business hours. HVAC emergencies like no-heat or no-AC situations often occur outside normal hours.`,
      detectedSignal: 'after_hours_surge',
      dataEvidence: { afterHoursCalls, total: callVolume.total, afterHoursRate },
      confidenceScore: 0.8,
      recommendedAction: 'Deploy a dedicated after-hours emergency triage agent to classify urgency and dispatch emergency techs for critical issues.',
      expectedOutcome: 'Capture after-hours emergency revenue and improve customer satisfaction with 24/7 availability.',
      reasoning: 'After-hours HVAC calls typically carry premium pricing. A triage agent can qualify emergencies and dispatch appropriately.',
      actionType: 'activate_agent',
      actionPayload: { reason: 'after_hours_coverage', schedule: 'after_hours' },
      estimatedRevenueImpactCents: Math.round(afterHoursCalls * 0.4 * 300 * 100),
    };
  }
  return null;
}

export const hvacAutopilotRules: IndustryDetectionRule[] = [
  {
    id: 'hvac_ap_demand_spike',
    vertical: 'hvac',
    name: 'HVAC Emergency Demand Spike',
    description: 'Detect weather-driven emergency demand spikes',
    category: 'missed_calls',
    severity: 'critical',
    riskTier: 'medium',
    evaluate: detectEmergencyDemandSpike,
  },
  {
    id: 'hvac_ap_missed_calls',
    vertical: 'hvac',
    name: 'HVAC Missed Call Alert',
    description: 'Detect high missed call rates for HVAC service',
    category: 'missed_calls',
    severity: 'warning',
    riskTier: 'low',
    evaluate: detectMissedCallSpike,
  },
  {
    id: 'hvac_ap_after_hours',
    vertical: 'hvac',
    name: 'HVAC After-Hours Surge',
    description: 'Detect significant after-hours call patterns',
    category: 'after_hours',
    severity: 'warning',
    riskTier: 'medium',
    evaluate: detectAfterHoursSurge,
  },
];
