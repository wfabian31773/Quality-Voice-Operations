import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatCents } from '../../lib/formatCurrency';
import { useTenantCurrency } from '../../hooks/useTenantCurrency';
import {
  buildAgentCallsQuery,
  computeAgentInsights,
  formatCallDuration,
  formatRate,
  insightSinceIso,
  type InsightRange,
  type StudioCallRow,
} from '../../lib/voiceAgentStudioMetrics';

const RANGES: { id: InsightRange; label: string }[] = [
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: '100', label: 'Last 100 conversations' },
];

export default function VoiceAgentInsightsTab({ agentId }: { agentId: string }) {
  const currency = useTenantCurrency();
  const [range, setRange] = useState<InsightRange>('30d');
  const since = insightSinceIso(range);

  const queryString = useMemo(
    () => buildAgentCallsQuery({
      agentId,
      limit: 100,
      since,
    }),
    [agentId, since],
  );

  const { data, isLoading } = useQuery({
    queryKey: ['agent-insights', agentId, queryString],
    queryFn: () => api.get<{ calls?: StudioCallRow[] }>(`/calls?${queryString}`),
  });
  const insights = useMemo(
    () => computeAgentInsights(data?.calls ?? []),
    [data?.calls],
  );

  const cards = [
    { label: 'Conversations', value: String(insights.conversationCount) },
    { label: 'Total minutes', value: insights.totalMinutes.toFixed(1) },
    { label: `Cost (${currency})`, value: formatCents(insights.totalCostCents, { currency }) },
    { label: 'Tool calls', value: String(insights.toolCallCount) },
    { label: 'Duration (p50)', value: formatCallDuration(insights.durationP50Seconds) },
    { label: 'Time to first audio (p50)', value: '—' },
    { label: 'Error rate', value: formatRate(insights.errorRate) },
    { label: 'Transfer rate', value: formatRate(insights.transferRate) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-success">
          Live calls: {isLoading ? '…' : insights.liveCallCount}
        </p>
        <div className="flex flex-wrap gap-1 rounded-full bg-surface-secondary p-1">
          {RANGES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setRange(item.id)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                range === item.id
                  ? 'bg-surface text-text-primary shadow-sm'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {cards.map((card) => (
          <div key={card.label} className="rounded-xl border border-border bg-surface px-4 py-5">
            <p className="text-xs uppercase tracking-wide text-text-muted">{card.label}</p>
            <p className="mt-2 text-2xl font-semibold text-text-primary">{card.value}</p>
          </div>
        ))}
      </div>

      <p className="text-xs text-text-muted">
        Cost, tools, duration, errors, and transfers come from this agent's call history
        (up to 100 conversations in the selected window). Time to first audio is not stored
        on call sessions, so that card stays empty.
      </p>
    </div>
  );
}
