import { useMemo, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronLeft, ChevronRight, PhoneCall } from 'lucide-react';
import { format } from 'date-fns';
import { api } from '../lib/api';
import GlobalScopeBanner from '../components/GlobalScopeBanner';

interface TenantInfo {
  id: string;
  name: string;
  slug: string;
}

interface CallRow {
  id: string;
  agent_id: string | null;
  agent_name: string | null;
  direction: string;
  lifecycle_state: string;
  caller_number: string | null;
  called_number: string | null;
  start_time: string | null;
  end_time: string | null;
  duration_seconds: number | null;
  total_cost_cents: number | null;
}

interface ApiResp {
  tenant: TenantInfo;
  calls: CallRow[];
  total: number;
  limit: number;
  offset: number;
}

const RANGES: Array<{ value: string; label: string }> = [
  { value: '', label: 'All Time' },
  { value: '24h', label: 'Last 24h' },
  { value: '7d', label: 'Last 7 Days' },
  { value: '30d', label: 'Last 30 Days' },
  { value: '90d', label: 'Last 90 Days' },
];

export default function AdminTenantCalls() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [direction, setDirection] = useState<string>(searchParams.get('direction') ?? '');
  const [range, setRange] = useState<string>(searchParams.get('range') ?? '');
  const limit = 20;

  const sinceIso = useMemo(() => {
    if (!range) return '';
    const now = Date.now();
    if (range === '24h') return new Date(now - 24 * 3600 * 1000).toISOString();
    if (range === '7d') return new Date(now - 7 * 86400 * 1000).toISOString();
    if (range === '30d') return new Date(now - 30 * 86400 * 1000).toISOString();
    if (range === '90d') return new Date(now - 90 * 86400 * 1000).toISOString();
    return '';
  }, [range]);

  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('page', String(page));
  if (direction) params.set('direction', direction);
  if (sinceIso) params.set('since', sinceIso);

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-tenant-calls', tenantId, page, direction, range],
    queryFn: () => api.get<ApiResp>(`/platform/tenants/${tenantId}/calls?${params.toString()}`),
    enabled: !!tenantId,
  });

  const tenant = data?.tenant;
  const calls = data?.calls ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <button
          onClick={() => navigate(`/admin/analytics/tenants/${tenantId}`)}
          className="inline-flex items-center gap-1.5 text-sm text-purple-300 hover:text-purple-200"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Tenant Analytics
        </button>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-white">
          {tenant ? `${tenant.name} — Calls` : 'Tenant Calls'}
        </h1>
        <p className="text-sm text-purple-200/70 mt-1">
          Read-only call list scoped to this tenant.
        </p>
      </div>

      <GlobalScopeBanner
        variant="tenant"
        tenantName={tenant?.name}
        tenantSlug={tenant?.slug}
      />

      <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Date Range</label>
            <select
              value={range}
              onChange={(e) => { setRange(e.target.value); setPage(1); }}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm"
            >
              {RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Direction</label>
            <select
              value={direction}
              onChange={(e) => { setDirection(e.target.value); setPage(1); }}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm"
            >
              <option value="">All</option>
              <option value="inbound">Inbound</option>
              <option value="outbound">Outbound</option>
            </select>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          Failed to load calls for this tenant.
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-12 text-text-secondary">Loading...</div>
      ) : calls.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <PhoneCall className="h-12 w-12 text-text-muted mx-auto mb-3" />
          <p className="text-text-secondary">No calls found for this tenant in the selected window.</p>
        </div>
      ) : (
        <>
          <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-5 py-3 text-text-secondary font-medium">Agent</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Direction</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Status</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Caller</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Duration</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Started</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.id} className="border-b border-border last:border-0">
                    <td className="px-5 py-3 text-text-primary">{c.agent_name || '--'}</td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${c.direction === 'inbound' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
                        {c.direction}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-text-secondary">{c.lifecycle_state}</td>
                    <td className="px-5 py-3 text-text-secondary font-mono text-xs">{c.caller_number || '--'}</td>
                    <td className="px-5 py-3 text-text-secondary">{c.duration_seconds ? `${c.duration_seconds}s` : '--'}</td>
                    <td className="px-5 py-3 text-text-secondary">{c.start_time ? format(new Date(c.start_time), 'MMM d, h:mm a') : '--'}</td>
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
                  className="p-2 rounded-lg border border-border hover:bg-surface-hover disabled:opacity-30 transition">
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-sm text-text-secondary">Page {page} of {totalPages}</span>
                <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                  className="p-2 rounded-lg border border-border hover:bg-surface-hover disabled:opacity-30 transition">
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
