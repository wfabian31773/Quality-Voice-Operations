import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { AudioLines, RefreshCw, Search } from 'lucide-react';
import { api } from '../../lib/api';
import { callLifecycleLabel } from '../../lib/statusLabels';
import {
  buildAgentCallsQuery,
  formatCallDuration,
  type StudioCallRow,
} from '../../lib/voiceAgentStudioMetrics';
import { useTranslation } from 'react-i18next';

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'CALL_CONNECTED', label: 'Live' },
  { value: 'CALL_COMPLETED', label: 'Completed' },
  { value: 'CALL_FAILED', label: 'Failed' },
  { value: 'CALL_ESCALATED', label: 'Escalated' },
];

export default function VoiceAgentConversationsTab({ agentId }: { agentId: string }) {
  const { t } = useTranslation('tenant');
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [lifecycleState, setLifecycleState] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;

  const queryString = useMemo(
    () => buildAgentCallsQuery({
      agentId,
      limit,
      page,
      q,
      lifecycleState: lifecycleState || undefined,
    }),
    [agentId, page, q, lifecycleState],
  );

  const { data, refetch, isFetching, isLoading } = useQuery({
    queryKey: ['agent-calls', agentId, queryString],
    queryFn: () => api.get<{ calls?: StudioCallRow[]; total?: number }>(`/calls?${queryString}`),
  });
  const rows = data?.calls ?? [];
  const total = data?.total ?? rows.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-4">
      <p className="rounded-xl bg-surface-secondary px-4 py-3 text-sm text-text-secondary">
        Conversations are retained with the rest of your call history. Open a row to inspect it on Calls.
      </p>

      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-center"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setQ(searchInput);
        }}
      >
        <label className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search caller, destination, or id"
            className="w-full rounded-full border border-border bg-surface py-2 pl-9 pr-3 text-sm text-text-primary"
          />
        </label>
        <label className="shrink-0">
          <span className="sr-only">Status</span>
          <select
            value={lifecycleState}
            onChange={(event) => {
              setLifecycleState(event.target.value);
              setPage(1);
            }}
            className="rounded-full border border-border bg-surface px-3 py-2 text-sm text-text-primary"
          >
            {STATUS_FILTERS.map((item) => (
              <option key={item.label} value={item.value}>{item.label}</option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-full border border-border px-3 py-2 text-sm font-medium text-text-primary"
        >
          Search
        </button>
        <button
          type="button"
          onClick={() => void refetch()}
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-2 text-sm"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </form>

      {isLoading ? (
        <p className="py-10 text-center text-sm text-text-muted">Loading conversations…</p>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <AudioLines className="h-8 w-8 text-text-muted" />
          <p className="text-sm text-text-secondary">
            {q || lifecycleState
              ? 'No conversations match these filters.'
              : 'No conversations yet. Conversations will appear here after callers reach this agent.'}
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-text-secondary">
                  <th className="px-4 py-2.5 font-medium">Time</th>
                  <th className="px-4 py-2.5 font-medium">Id</th>
                  <th className="px-4 py-2.5 font-medium">Caller</th>
                  <th className="px-4 py-2.5 font-medium">Destination</th>
                  <th className="px-4 py-2.5 font-medium">Duration</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-border last:border-0 hover:bg-surface-hover">
                    <td className="whitespace-nowrap px-4 py-3 text-text-secondary">
                      {row.start_time ? format(new Date(row.start_time), 'MMM d, h:mm a') : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to={`/calls?q=${encodeURIComponent(row.id)}&highlight=${encodeURIComponent(row.id)}`}
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        {row.id}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-text-primary">{row.caller_number || '—'}</td>
                    <td className="px-4 py-3 text-text-secondary">{row.called_number || '—'}</td>
                    <td className="px-4 py-3 text-text-secondary">{formatCallDuration(row.duration_seconds)}</td>
                    <td className="px-4 py-3 text-text-secondary">
                      {row.lifecycle_state ? callLifecycleLabel(t, row.lifecycle_state) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-sm text-text-muted">
            <p>{total} conversation{total === 1 ? '' : 's'}</p>
            {totalPages > 1 ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  className="rounded-full border border-border px-3 py-1 disabled:opacity-40"
                >
                  Previous
                </button>
                <span>Page {page} of {totalPages}</span>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                  className="rounded-full border border-border px-3 py-1 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
