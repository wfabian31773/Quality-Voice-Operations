import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { PhoneCall, X, ChevronLeft, ChevronRight, Filter } from 'lucide-react';
import { format } from 'date-fns';

interface Call {
  id: string;
  caller_number: string;
  called_number: string;
  direction: string;
  lifecycle_state: string;
  start_time: string;
  end_time: string | null;
  agent_id: string;
  agent_name: string | null;
  duration_seconds: number | null;
}

interface TranscriptEntry {
  id: string;
  role: string;
  content: string;
  sequence_number: number;
  occurred_at: string;
}

interface CallEvent {
  id: string;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
}

interface Agent {
  id: string;
  name: string;
}

function CallDetailDrawer({ callId, onClose }: { callId: string; onClose: () => void }) {
  const { data: callData } = useQuery({
    queryKey: ['call', callId],
    queryFn: () => api.get<{ call: Call }>(`/calls/${callId}`),
  });

  const { data: transcriptData, isLoading: transcriptLoading } = useQuery({
    queryKey: ['transcript', callId],
    queryFn: () => api.get<{ transcript: TranscriptEntry[] }>(`/calls/${callId}/transcript`),
  });

  const { data: eventsData, isLoading: eventsLoading } = useQuery({
    queryKey: ['call-events', callId],
    queryFn: () => api.get<{ events: CallEvent[] }>(`/calls/${callId}/events`),
  });

  const call = callData?.call;
  const transcript = transcriptData?.transcript ?? [];
  const events = eventsData?.events ?? [];
  const [tab, setTab] = useState<'transcript' | 'events'>('transcript');

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div className="w-full max-w-lg bg-surface h-full overflow-y-auto shadow-xl border-l border-border" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border sticky top-0 bg-surface z-10">
          <h2 className="text-lg font-semibold text-text-primary">Call Details</h2>
          <button onClick={onClose}><X className="h-5 w-5 text-text-secondary hover:text-text-primary" /></button>
        </div>

        {call && (
          <div className="px-5 py-4 border-b border-border space-y-2">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div><span className="text-text-secondary">From:</span> <span className="font-mono text-xs">{call.caller_number}</span></div>
              <div><span className="text-text-secondary">To:</span> <span className="font-mono text-xs">{call.called_number}</span></div>
              <div><span className="text-text-secondary">Direction:</span> {call.direction}</div>
              <div><span className="text-text-secondary">Status:</span> {call.lifecycle_state}</div>
              <div><span className="text-text-secondary">Agent:</span> {call.agent_name || '--'}</div>
              <div><span className="text-text-secondary">Duration:</span> {call.duration_seconds ? `${call.duration_seconds}s` : '--'}</div>
              <div><span className="text-text-secondary">Started:</span> {call.start_time ? format(new Date(call.start_time), 'PPp') : '--'}</div>
              <div><span className="text-text-secondary">Ended:</span> {call.end_time ? format(new Date(call.end_time), 'PPp') : '--'}</div>
            </div>
          </div>
        )}

        <div className="border-b border-border">
          <div className="flex px-5">
            <button onClick={() => setTab('transcript')}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition ${tab === 'transcript' ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
              Transcript
            </button>
            <button onClick={() => setTab('events')}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition ${tab === 'events' ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
              Events ({events.length})
            </button>
          </div>
        </div>

        <div className="px-5 py-4">
          {tab === 'transcript' && (
            <>
              {transcriptLoading ? (
                <p className="text-sm text-text-secondary">Loading transcript...</p>
              ) : transcript.length === 0 ? (
                <p className="text-sm text-text-secondary">No transcript available</p>
              ) : (
                <div className="space-y-3">
                  {transcript.map((entry) => (
                    <div key={entry.id || entry.sequence_number} className={`flex ${entry.role === 'assistant' ? 'justify-start' : 'justify-end'}`}>
                      <div className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm ${
                        entry.role === 'assistant'
                          ? 'bg-primary-light text-text-primary rounded-bl-sm'
                          : 'bg-surface-hover text-text-primary rounded-br-sm'
                      }`}>
                        <p className="text-xs font-medium text-text-secondary mb-1 capitalize">{entry.role}</p>
                        <p>{entry.content}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {tab === 'events' && (
            <>
              {eventsLoading ? (
                <p className="text-sm text-text-secondary">Loading events...</p>
              ) : events.length === 0 ? (
                <p className="text-sm text-text-secondary">No events recorded</p>
              ) : (
                <div className="relative">
                  <div className="absolute left-3 top-0 bottom-0 w-px bg-border" />
                  <div className="space-y-4">
                    {events.map((event) => (
                      <div key={event.id} className="relative pl-8">
                        <div className="absolute left-1.5 top-1.5 w-3 h-3 rounded-full bg-primary border-2 border-surface" />
                        <div className="bg-surface-hover rounded-lg p-3">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium text-text-primary">{event.event_type}</span>
                            <span className="text-xs text-text-muted">{event.occurred_at ? format(new Date(event.occurred_at), 'h:mm:ss a') : '--'}</span>
                          </div>
                          {event.from_state && event.to_state && (
                            <p className="text-xs text-text-secondary">{event.from_state} → {event.to_state}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Calls() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [selectedCall, setSelectedCall] = useState<string | null>(null);
  const [filters, setFilters] = useState({ agent_id: '', direction: '', lifecycle_state: '', dateRange: '' });
  const [showFilters, setShowFilters] = useState(false);
  const limit = 20;

  useEffect(() => {
    const highlight = searchParams.get('highlight');
    if (highlight) {
      setSelectedCall(highlight);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const { data: agentsData } = useQuery({
    queryKey: ['agents', 'filter-list'],
    queryFn: () => api.get<{ agents: Agent[] }>('/agents?limit=100'),
  });

  const filterParams = new URLSearchParams();
  filterParams.set('limit', String(limit));
  filterParams.set('page', String(page));
  if (filters.agent_id) filterParams.set('agent_id', filters.agent_id);
  if (filters.direction) filterParams.set('direction', filters.direction);
  if (filters.lifecycle_state) filterParams.set('lifecycle_state', filters.lifecycle_state);
  if (filters.dateRange) {
    const now = new Date();
    let since: Date | null = null;
    if (filters.dateRange === 'today') { since = new Date(now.getFullYear(), now.getMonth(), now.getDate()); }
    else if (filters.dateRange === '7d') { since = new Date(now.getTime() - 7 * 86400000); }
    else if (filters.dateRange === '30d') { since = new Date(now.getTime() - 30 * 86400000); }
    if (since) filterParams.set('since', since.toISOString());
  }

  const { data, isLoading } = useQuery({
    queryKey: ['calls', page, filters],
    queryFn: () => api.get<{ calls: Call[]; total: number }>(`/calls?${filterParams.toString()}`),
  });

  const calls = data?.calls ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / limit);
  const agents = agentsData?.agents ?? [];

  const setFilter = (key: string, val: string) => {
    setFilters((f) => ({ ...f, [key]: val }));
    setPage(1);
  };

  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Call History</h1>
          <p className="text-sm text-text-secondary mt-1">Browse and review past calls with transcripts</p>
        </div>
        <button onClick={() => setShowFilters(!showFilters)}
          className={`inline-flex items-center gap-2 text-sm font-medium px-4 py-2.5 rounded-lg border transition ${activeFilterCount > 0 ? 'border-primary text-primary bg-primary-light' : 'border-border text-text-secondary hover:bg-surface-hover'}`}>
          <Filter className="h-4 w-4" /> Filters {activeFilterCount > 0 && `(${activeFilterCount})`}
        </button>
      </div>

      {showFilters && (
        <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Date Range</label>
              <select value={filters.dateRange} onChange={(e) => setFilter('dateRange', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                <option value="">All Time</option>
                <option value="today">Today</option>
                <option value="7d">Last 7 Days</option>
                <option value="30d">Last 30 Days</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Agent</label>
              <select value={filters.agent_id} onChange={(e) => setFilter('agent_id', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                <option value="">All Agents</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Direction</label>
              <select value={filters.direction} onChange={(e) => setFilter('direction', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                <option value="">All</option>
                <option value="inbound">Inbound</option>
                <option value="outbound">Outbound</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Status</label>
              <select value={filters.lifecycle_state} onChange={(e) => setFilter('lifecycle_state', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm">
                <option value="">All</option>
                <option value="CALL_RECEIVED">Received</option>
                <option value="CALL_CONNECTED">Connected</option>
                <option value="CALL_ENDED">Ended</option>
                <option value="CALL_FAILED">Failed</option>
              </select>
            </div>
          </div>
          {activeFilterCount > 0 && (
            <button onClick={() => { setFilters({ agent_id: '', direction: '', lifecycle_state: '', dateRange: '' }); setPage(1); }}
              className="mt-3 text-xs text-primary hover:text-primary-hover font-medium">Clear all filters</button>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-12 text-text-secondary">Loading...</div>
      ) : calls.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 text-center">
          <PhoneCall className="h-12 w-12 text-text-muted mx-auto mb-3" />
          <p className="text-text-secondary">{activeFilterCount > 0 ? 'No calls match your filters' : 'No calls found'}</p>
        </div>
      ) : (
        <>
          <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-5 py-3 text-text-secondary font-medium">Agent</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Direction</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Status</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Duration</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((call) => (
                  <tr key={call.id} onClick={() => setSelectedCall(call.id)}
                    className="border-b border-border last:border-0 hover:bg-surface-hover cursor-pointer transition-colors">
                    <td className="px-5 py-3 text-text-primary">{call.agent_name || '--'}</td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${call.direction === 'inbound' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
                        {call.direction}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${['CALL_CONNECTED', 'active'].includes(call.lifecycle_state) ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}>
                        {call.lifecycle_state}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-text-secondary">{call.duration_seconds ? `${call.duration_seconds}s` : '--'}</td>
                    <td className="px-5 py-3 text-text-secondary">{call.start_time ? format(new Date(call.start_time), 'MMM d, h:mm a') : '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-text-secondary">{total} calls total</p>
              <div className="flex items-center gap-2">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                  className="p-2 rounded-lg border border-border hover:bg-surface-hover disabled:opacity-30 transition"><ChevronLeft className="h-4 w-4" /></button>
                <span className="text-sm text-text-secondary">Page {page} of {totalPages}</span>
                <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                  className="p-2 rounded-lg border border-border hover:bg-surface-hover disabled:opacity-30 transition"><ChevronRight className="h-4 w-4" /></button>
              </div>
            </div>
          )}
        </>
      )}

      {selectedCall && <CallDetailDrawer callId={selectedCall} onClose={() => setSelectedCall(null)} />}
    </div>
  );
}
