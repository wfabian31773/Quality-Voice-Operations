import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Shield, ChevronLeft, ChevronRight } from 'lucide-react';

interface AuditEvent {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  changes: Record<string, unknown>;
  ip_address: string | null;
  occurred_at: string;
  actor_user_id: string | null;
  actor_role: string | null;
  actor_email: string | null;
}

const ACTION_OPTIONS = [
  { value: '', label: 'All Actions' },
  { value: 'user.login', label: 'User Login' },
  { value: 'user.role_changed', label: 'Role Change' },
  { value: 'agent.updated', label: 'Agent Updated' },
  { value: 'api_key.created', label: 'API Key Created' },
  { value: 'api_key.revoked', label: 'API Key Revoked' },
  { value: 'tenant.provisioned', label: 'Tenant Provisioned' },
];

function formatAction(action: string): string {
  const found = ACTION_OPTIONS.find((o) => o.value === action);
  return found ? found.label : action.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function AuditLog() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const limit = 25;

  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('limit', String(limit));
  if (action) params.set('action', action);
  if (since) params.set('since', new Date(since).toISOString());
  if (until) params.set('until', new Date(until + 'T23:59:59').toISOString());

  const { data, isLoading } = useQuery({
    queryKey: ['audit-log', page, action, since, until],
    queryFn: () => api.get<{ events: AuditEvent[]; total: number; page: number }>(`/audit-log?${params}`),
    refetchInterval: 30_000,
  });

  const totalPages = data ? Math.ceil(data.total / limit) : 1;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Shield className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">Audit Log</h1>
      </div>

      <div className="flex flex-wrap gap-3">
        <select
          value={action}
          onChange={(e) => { setAction(e.target.value); setPage(1); }}
          className="px-3 py-2 rounded-lg border border-border bg-surface text-sm"
        >
          {ACTION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <input
          type="date"
          value={since}
          onChange={(e) => { setSince(e.target.value); setPage(1); }}
          className="px-3 py-2 rounded-lg border border-border bg-surface text-sm"
          placeholder="From"
        />
        <input
          type="date"
          value={until}
          onChange={(e) => { setUntil(e.target.value); setPage(1); }}
          className="px-3 py-2 rounded-lg border border-border bg-surface text-sm"
          placeholder="To"
        />
        {(action || since || until) && (
          <button
            onClick={() => { setAction(''); setSince(''); setUntil(''); setPage(1); }}
            className="px-3 py-2 text-sm text-muted hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-3 font-medium text-muted">Timestamp</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Actor</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Action</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Resource</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Details</th>
                <th className="text-left px-4 py-3 font-medium text-muted">IP</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} className="text-center py-12 text-muted">Loading...</td></tr>
              ) : !data?.events.length ? (
                <tr><td colSpan={6} className="text-center py-12 text-muted">No audit events found</td></tr>
              ) : (
                data.events.map((event) => (
                  <tr key={event.id} className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                    <td className="px-4 py-3 whitespace-nowrap text-muted">
                      {new Date(event.occurred_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-medium">{event.actor_email ?? 'System'}</span>
                      {event.actor_role && (
                        <span className="ml-1 text-xs text-muted">({event.actor_role})</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary">
                        {formatAction(event.action)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {event.resource_type}
                      {event.resource_id && (
                        <span className="ml-1 text-xs font-mono">{event.resource_id.slice(0, 8)}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted text-xs max-w-48 truncate">
                      {Object.keys(event.changes).length > 0 ? JSON.stringify(event.changes) : '-'}
                    </td>
                    <td className="px-4 py-3 text-muted text-xs font-mono">
                      {event.ip_address ?? '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {data && data.total > limit && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <span className="text-sm text-muted">
              {data.total} events total
            </span>
            <div className="flex items-center gap-2">
              <button
                disabled={page === 1}
                onClick={() => setPage(page - 1)}
                className="p-1 rounded hover:bg-surface-secondary disabled:opacity-50"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm">
                Page {page} of {totalPages}
              </span>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
                className="p-1 rounded hover:bg-surface-secondary disabled:opacity-50"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
