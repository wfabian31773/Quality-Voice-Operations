import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import { PhoneCall, Bot, Clock, TrendingUp, AlertTriangle, Wifi, WifiOff } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface CallSession {
  id: string;
  direction: string;
  lifecycle_state: string;
  start_time: string;
  end_time: string | null;
  duration_seconds: number | null;
  agent_id: string;
  agent_name: string | null;
  escalation_target: string | null;
}

interface ActiveCall {
  id: string;
  direction: string;
  lifecycle_state: string;
  start_time: string;
  agent_id: string;
  agent_name: string | null;
  caller_number: string | null;
  escalation_target: string | null;
}

function StatCard({ icon: Icon, label, value, color }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string | number; color: string }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
      <div className="flex items-center gap-3">
        <div className={`p-2.5 rounded-lg ${color}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-sm text-text-secondary">{label}</p>
          <p className="text-2xl font-bold text-text-primary">{value}</p>
        </div>
      </div>
    </div>
  );
}

function todayIso(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

function useSSEActiveCalls(): { activeCalls: ActiveCall[]; connected: boolean } {
  const [activeCalls, setActiveCalls] = useState<ActiveCall[]>([]);
  const [connected, setConnected] = useState(false);
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource('/api/calls/live', { withCredentials: true });
    esRef.current = es;

    es.addEventListener('active_calls', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as ActiveCall[];
        setActiveCalls(data);
        setConnected(true);
        queryClient.invalidateQueries({ queryKey: ['calls', 'recent'] });
      } catch {}
    });

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [queryClient]);

  return { activeCalls, connected };
}

export default function Dashboard() {
  const todaySince = todayIso();
  const { activeCalls: liveActiveCalls, connected: sseConnected } = useSSEActiveCalls();

  const { data: callsData, isLoading: callsLoading } = useQuery({
    queryKey: ['calls', 'recent'],
    queryFn: () => api.get<{ calls: CallSession[]; total: number }>('/calls?limit=50'),
    refetchInterval: 10000,
  });

  const { data: todayData } = useQuery({
    queryKey: ['calls', 'today-volume', todaySince],
    queryFn: () => api.get<{ calls: CallSession[]; total: number }>(`/calls?limit=1&since=${encodeURIComponent(todaySince)}`),
    refetchInterval: 15000,
  });

  const { data: agentsData } = useQuery({
    queryKey: ['agents', 'count'],
    queryFn: () => api.get<{ agents: unknown[]; total: number }>('/agents?limit=1'),
  });

  const calls = callsData?.calls ?? [];
  const activeCallCount = liveActiveCalls.length;
  const totalToday = todayData?.total ?? 0;
  const agentCount = agentsData?.total ?? 0;
  const escalations = calls.filter((c) => c.escalation_target).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Dashboard</h1>
          <p className="text-sm text-text-secondary mt-1">Real-time overview of your voice operations</p>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          {sseConnected ? (
            <><Wifi className="h-3.5 w-3.5 text-green-500" /><span className="text-green-600 dark:text-green-400">Live</span></>
          ) : (
            <><WifiOff className="h-3.5 w-3.5 text-gray-400" /><span className="text-text-secondary">Connecting…</span></>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard icon={PhoneCall} label="Active Calls" value={activeCallCount} color="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" />
        <StatCard icon={TrendingUp} label="Today's Volume" value={totalToday} color="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" />
        <StatCard icon={AlertTriangle} label="Escalations" value={escalations} color="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" />
        <StatCard icon={Bot} label="Agents" value={agentCount} color="bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" />
        <StatCard icon={Clock} label="Avg Duration" value={calls.length > 0 ? `${Math.round(calls.reduce((sum, c) => sum + (c.duration_seconds ?? 0), 0) / calls.filter(c => c.duration_seconds).length || 0)}s` : '--'} color="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" />
      </div>

      <div className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-text-primary">Recent Calls</h2>
        </div>
        {callsLoading ? (
          <div className="p-8 text-center text-text-secondary">Loading...</div>
        ) : calls.length === 0 ? (
          <div className="p-8 text-center text-text-secondary">No calls yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-5 py-3 text-text-secondary font-medium">Agent</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Direction</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Status</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Duration</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {calls.slice(0, 10).map((call) => (
                  <tr key={call.id} className="border-b border-border last:border-0 hover:bg-surface-hover transition-colors">
                    <td className="px-5 py-3 text-text-primary">{call.agent_name || call.agent_id || '--'}</td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${call.direction === 'inbound' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
                        {call.direction}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${['active', 'CALL_CONNECTED'].includes(call.lifecycle_state) ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}>
                        {call.lifecycle_state}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-text-secondary">{call.duration_seconds ? `${call.duration_seconds}s` : '--'}</td>
                    <td className="px-5 py-3 text-text-secondary">
                      {call.start_time ? formatDistanceToNow(new Date(call.start_time), { addSuffix: true }) : '--'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
