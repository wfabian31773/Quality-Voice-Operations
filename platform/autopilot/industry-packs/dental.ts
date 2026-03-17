import type { IndustryDetectionRule, OperationalSignals, DetectionResult } from '../types';

function detectCancellationPattern(signals: OperationalSignals): DetectionResult | null {
  const { bookingMetrics, callVolume } = signals;
  if (callVolume.total < 5) return null;

  const cancelRate = bookingMetrics.total > 0 ? bookingMetrics.cancelled / bookingMetrics.total : 0;
  if (cancelRate > 0.15) {
    return {
      title: 'High Dental Appointment Cancellation Rate',
      description: `${bookingMetrics.cancelled} of ${bookingMetrics.total} bookings (${Math.round(cancelRate * 100)}%) were cancelled. This creates revenue gaps and scheduling inefficiencies.`,
      detectedSignal: 'cancellation_spike',
      dataEvidence: { cancelled: bookingMetrics.cancelled, total: bookingMetrics.total, cancelRate },
      confidenceScore: 0.8,
      recommendedAction: 'Launch an automated appointment reminder and confirmation campaign 24-48 hours before scheduled visits. Enable waitlist backfill for cancelled slots.',
      expectedOutcome: `Reduce cancellations by 30-40% and recover ${Math.round(bookingMetrics.cancelled * 0.3)} appointment slots per week.`,
      reasoning: 'Dental practices typically lose $200-400 per cancelled appointment. Automated reminders reduce no-shows by 30-40% according to industry benchmarks.',
      actionType: 'launch_campaign',
      actionPayload: { type: 'appointment_reminder', timing: '24h_before' },
      estimatedRevenueImpactCents: Math.round(bookingMetrics.cancelled * 0.3 * 300 * 100),
    };
  }
  return null;
}

function detectNewPatientConversionDrop(signals: OperationalSignals): DetectionResult | null {
  const { callVolume } = signals;
  if (callVolume.total < 10) return null;

  const conversionRate = callVolume.total > 0
    ? callVolume.completed / callVolume.total
    : 0;

  if (conversionRate < 0.6) {
    return {
      title: 'Low Call-to-Booking Conversion Rate',
      description: `Only ${Math.round(conversionRate * 100)}% of calls are completing successfully. Potential new patient inquiries may not be converting to booked appointments.`,
      detectedSignal: 'low_conversion',
      dataEvidence: { completed: callVolume.completed, total: callVolume.total, conversionRate },
      confidenceScore: 0.7,
      recommendedAction: 'Review agent prompts to ensure new patient inquiries are being handled with insurance verification and availability checks. Consider adding online booking tool integration.',
      expectedOutcome: 'Increase booking conversion by 15-25% through improved call handling.',
      reasoning: 'Dental practices with optimized phone handling convert 80%+ of calls. A gap indicates room for improvement in the AI agent conversation flow.',
      actionType: 'create_task',
      actionPayload: { task: 'review_agent_prompts', focus: 'new_patient_conversion' },
      estimatedRevenueImpactCents: Math.round(callVolume.total * 0.15 * 250 * 100),
    };
  }
  return null;
}

function detectNoShowPattern(signals: OperationalSignals): DetectionResult | null {
  const { bookingMetrics } = signals;
  if (bookingMetrics.total < 5) return null;

  const noShowRate = bookingMetrics.noShow / bookingMetrics.total;
  if (noShowRate > 0.1) {
    return {
      title: 'Dental No-Show Rate Above Threshold',
      description: `${bookingMetrics.noShow} no-shows out of ${bookingMetrics.total} appointments (${Math.round(noShowRate * 100)}%). Industry average is 5-7%.`,
      detectedSignal: 'no_show_spike',
      dataEvidence: { noShows: bookingMetrics.noShow, total: bookingMetrics.total, noShowRate },
      confidenceScore: 0.75,
      recommendedAction: 'Implement day-of confirmation calls and enable automated rebooking outreach for no-show patients.',
      expectedOutcome: `Reduce no-shows by 40-50%, recovering approximately ${Math.round(bookingMetrics.noShow * 0.4)} slots per week.`,
      reasoning: 'No-shows cost dental practices $200-400 per empty chair hour. Day-of confirmation calls and rebooking outreach are proven to reduce no-show rates.',
      actionType: 'launch_campaign',
      actionPayload: { type: 'no_show_followup', timing: 'same_day' },
      estimatedRevenueImpactCents: Math.round(bookingMetrics.noShow * 0.4 * 300 * 100),
    };
  }
  return null;
}

export const dentalAutopilotRules: IndustryDetectionRule[] = [
  {
    id: 'dental_ap_cancellations',
    vertical: 'dental',
    name: 'Dental Cancellation Pattern',
    description: 'Detect high appointment cancellation rates',
    category: 'booking_conversion',
    severity: 'warning',
    riskTier: 'low',
    evaluate: detectCancellationPattern,
  },
  {
    id: 'dental_ap_conversion',
    vertical: 'dental',
    name: 'Dental Conversion Drop',
    description: 'Detect low call-to-booking conversion',
    category: 'booking_conversion',
    severity: 'warning',
    riskTier: 'low',
    evaluate: detectNewPatientConversionDrop,
  },
  {
    id: 'dental_ap_no_shows',
    vertical: 'dental',
    name: 'Dental No-Show Pattern',
    description: 'Detect high no-show rates',
    category: 'booking_conversion',
    severity: 'warning',
    riskTier: 'low',
    evaluate: detectNoShowPattern,
  },
];
