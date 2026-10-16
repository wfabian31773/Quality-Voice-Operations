import { describe, expect, it } from 'vitest';
import {
  buildAgentCallsQuery,
  computeAgentInsights,
  formatAssignedNumbers,
  formatCallDuration,
  formatRate,
  insightSinceIso,
  isFailedCall,
  isLiveCallState,
  isTransferredCall,
  isValidPostCallEmail,
  percentile,
  phonesAvailableToAssign,
  phonesRoutedToAgent,
  readPostCallPreference,
  type StudioCallRow,
  type StudioPhoneNumber,
} from './voiceAgentStudioMetrics';

function call(overrides: Partial<StudioCallRow> = {}): StudioCallRow {
  return { id: 'call-1', ...overrides };
}

describe('isLiveCallState', () => {
  it('treats connected and legacy in-progress states as live', () => {
    expect(isLiveCallState('CALL_CONNECTED')).toBe(true);
    expect(isLiveCallState('active')).toBe(true);
    expect(isLiveCallState('in_progress')).toBe(true);
    expect(isLiveCallState('CALL_COMPLETED')).toBe(false);
    expect(isLiveCallState(undefined)).toBe(false);
  });
});

describe('isFailedCall / isTransferredCall', () => {
  it('counts failed lifecycle and failed tools as errors', () => {
    expect(isFailedCall(call({ lifecycle_state: 'CALL_FAILED' }))).toBe(true);
    expect(isFailedCall(call({ failed_tool_count: 2 }))).toBe(true);
    expect(isFailedCall(call({ lifecycle_state: 'CALL_COMPLETED', failed_tool_count: 0 }))).toBe(false);
  });

  it('counts escalations and transfer outcomes only', () => {
    expect(isTransferredCall(call({ lifecycle_state: 'CALL_ESCALATED' }))).toBe(true);
    expect(isTransferredCall(call({ outcome_type: 'urgent_transfer' }))).toBe(true);
    expect(isTransferredCall(call({ next_action: 'Warm transfer to on-call' }))).toBe(true);
    expect(isTransferredCall(call({ outcome_type: 'callback_next_business_day' }))).toBe(false);
  });
});

describe('percentile', () => {
  it('returns null for an empty set and interpolates the median', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10], 50)).toBe(10);
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
  });
});

describe('formatters', () => {
  it('formats durations and rates without inventing values', () => {
    expect(formatCallDuration(null)).toBe('—');
    expect(formatCallDuration(12)).toBe('12s');
    expect(formatCallDuration(125)).toBe('2m 5s');
    expect(formatCallDuration(120)).toBe('2m');
    expect(formatRate(null)).toBe('—');
    expect(formatRate(0.125)).toBe('12.5%');
  });
});

describe('computeAgentInsights', () => {
  it('aggregates cost, tools, minutes, and rates from real call fields', () => {
    const insights = computeAgentInsights([
      call({
        id: 'a',
        lifecycle_state: 'CALL_CONNECTED',
        duration_seconds: 60,
        total_cost_cents: 25,
        tool_count: 2,
        failed_tool_count: 0,
      }),
      call({
        id: 'b',
        lifecycle_state: 'CALL_FAILED',
        duration_seconds: 120,
        total_cost_cents: 75,
        tool_count: 4,
        failed_tool_count: 1,
        outcome_type: 'urgent_transfer',
      }),
    ]);

    expect(insights.conversationCount).toBe(2);
    expect(insights.liveCallCount).toBe(1);
    expect(insights.totalMinutes).toBe(3);
    expect(insights.totalCostCents).toBe(100);
    expect(insights.toolCallCount).toBe(6);
    expect(insights.durationP50Seconds).toBe(90);
    expect(insights.timeToFirstAudioP50).toBeNull();
    expect(insights.errorRate).toBe(0.5);
    expect(insights.transferRate).toBe(0.5);
  });

  it('keeps rates empty when there are no conversations', () => {
    const insights = computeAgentInsights([]);
    expect(insights.errorRate).toBeNull();
    expect(insights.transferRate).toBeNull();
    expect(insights.durationP50Seconds).toBeNull();
    expect(insights.timeToFirstAudioP50).toBeNull();
  });
});

describe('phone helpers', () => {
  const phones: StudioPhoneNumber[] = [
    { id: '1', phone_number: '+15551111111', friendly_name: 'Front desk', routed_agent_id: 'agent-a', routing_active: true },
    { id: '2', phone_number: '+15552222222', routed_agent_id: 'agent-b', routing_active: true },
    { id: '3', phone_number: '+15553333333', routed_agent_id: null },
  ];

  it('splits inventory into routed and available numbers', () => {
    expect(phonesRoutedToAgent(phones, 'agent-a').map((phone) => phone.id)).toEqual(['1']);
    expect(phonesAvailableToAssign(phones).map((phone) => phone.id)).toEqual(['3']);
    expect(formatAssignedNumbers(phonesRoutedToAgent(phones, 'agent-a'))).toBe('Front desk');
  });
});

describe('post-call preference', () => {
  it('reads stored metadata without inferring a send pipeline', () => {
    expect(readPostCallPreference(null)).toEqual({ enabled: false, email: '' });
    expect(readPostCallPreference({
      postCallNotify: true,
      postCallEmail: ' ops@example.com ',
    })).toEqual({ enabled: true, email: 'ops@example.com' });
  });

  it('accepts empty or well-formed emails', () => {
    expect(isValidPostCallEmail('')).toBe(true);
    expect(isValidPostCallEmail('ops@example.com')).toBe(true);
    expect(isValidPostCallEmail('not-an-email')).toBe(false);
  });
});

describe('query helpers', () => {
  it('builds agent-scoped call queries and range windows', () => {
    expect(buildAgentCallsQuery({
      agentId: 'agent-a',
      limit: 20,
      q: ' +1555 ',
      lifecycleState: 'CALL_COMPLETED',
    })).toBe('agent_id=agent-a&limit=20&q=%2B1555&lifecycle_state=CALL_COMPLETED');

    const now = new Date('2026-08-30T12:00:00.000Z');
    expect(insightSinceIso('100', now)).toBeUndefined();
    expect(insightSinceIso('7d', now)).toBe('2026-08-23T12:00:00.000Z');
    expect(insightSinceIso('30d', now)).toBe('2026-07-31T12:00:00.000Z');
  });
});
