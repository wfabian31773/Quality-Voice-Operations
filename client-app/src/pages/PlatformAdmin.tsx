import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Building2, Users, PhoneCall, DollarSign, ChevronDown, ChevronRight, Ban, CheckCircle, Eye } from 'lucide-react';

interface PlatformStats {
  active_tenants: string;
  total_tenants: string;
  total_users: string;
  total_calls: string;
  calls_last_30d: string;
  calls_last_24h: string;
  total_revenue_cents: string;
  revenue_last_30d_cents: string;
}

interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  created_at: string;
  updated_at: string;
  user_count: string;
  total_calls: string;
  last_call_at: string | null;
  calls_last_30d: string;
}

interface TenantDetail {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  created_at: string;
  user_count: string;
  agent_count: string;
  phone_number_count: string;
  total_calls: string;
  total_cost_cents: string;
}

function formatCents(cents: string | number): string {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    pending: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    suspended: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  );
}

function PlanBadge({ plan }: { plan: string }) {
  const colors: Record<string, string> = {
    starter: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    pro: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
    enterprise: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[plan] ?? 'bg-gray-100 text-gray-600'}`}>
      {plan}
    </span>
  );
}

function TenantDetailPanel({ tenantId }: { tenantId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['platform-tenant-detail', tenantId],
    queryFn: () => api.get<{ tenant: TenantDetail }>(`/platform/tenants/${tenantId}`),
  });

  if (isLoading) return <div className="px-4 py-3 text-sm text-muted">Loading details...</div>;
  if (!data) return null;

  const t = data.tenant;
  return (
    <div className="px-6 py-4 bg-surface-secondary/50 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
      <div>
        <span className="text-muted">Agents</span>
        <div className="font-medium">{t.agent_count}</div>
      </div>
      <div>
        <span className="text-muted">Phone Numbers</span>
        <div className="font-medium">{t.phone_number_count}</div>
      </div>
      <div>
        <span className="text-muted">Total Calls</span>
        <div className="font-medium">{t.total_calls}</div>
      </div>
      <div>
        <span className="text-muted">Total Spend</span>
        <div className="font-medium">{formatCents(t.total_cost_cents)}</div>
      </div>
    </div>
  );
}

export default function PlatformAdmin() {
  const queryClient = useQueryClient();
  const [expandedTenant, setExpandedTenant] = useState<string | null>(null);

  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ['platform-stats'],
    queryFn: () => api.get<{ stats: PlatformStats }>('/platform/stats'),
    refetchInterval: 60_000,
  });

  const { data: tenantsData, isLoading: tenantsLoading } = useQuery({
    queryKey: ['platform-tenants'],
    queryFn: () => api.get<{ tenants: Tenant[] }>('/platform/tenants'),
    refetchInterval: 60_000,
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/platform/tenants/${id}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-tenants'] });
      queryClient.invalidateQueries({ queryKey: ['platform-stats'] });
    },
  });

  const stats = statsData?.stats;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Building2 className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">Platform Administration</h1>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Building2}
          label="Active Tenants"
          value={statsLoading ? '...' : `${stats?.active_tenants ?? 0} / ${stats?.total_tenants ?? 0}`}
        />
        <StatCard
          icon={Users}
          label="Total Users"
          value={statsLoading ? '...' : String(stats?.total_users ?? 0)}
        />
        <StatCard
          icon={PhoneCall}
          label="Calls (30d)"
          value={statsLoading ? '...' : `${stats?.calls_last_30d ?? 0}`}
          sub={statsLoading ? '' : `${stats?.calls_last_24h ?? 0} in last 24h`}
        />
        <StatCard
          icon={DollarSign}
          label="Revenue (30d)"
          value={statsLoading ? '...' : formatCents(stats?.revenue_last_30d_cents ?? '0')}
          sub={statsLoading ? '' : `${formatCents(stats?.total_revenue_cents ?? '0')} total`}
        />
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="font-semibold">All Tenants</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="w-8 px-2"></th>
                <th className="text-left px-4 py-3 font-medium text-muted">Tenant</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Plan</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Users</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Calls (30d)</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Last Activity</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tenantsLoading ? (
                <tr><td colSpan={8} className="text-center py-12 text-muted">Loading...</td></tr>
              ) : !tenantsData?.tenants.length ? (
                <tr><td colSpan={8} className="text-center py-12 text-muted">No tenants found</td></tr>
              ) : (
                tenantsData.tenants.map((tenant) => (
                  <>
                    <tr key={tenant.id} className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                      <td className="px-2">
                        <button
                          onClick={() => setExpandedTenant(expandedTenant === tenant.id ? null : tenant.id)}
                          className="p-1 rounded hover:bg-surface-secondary"
                        >
                          {expandedTenant === tenant.id
                            ? <ChevronDown className="h-4 w-4 text-muted" />
                            : <ChevronRight className="h-4 w-4 text-muted" />}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium">{tenant.name}</div>
                        <div className="text-xs text-muted font-mono">{tenant.slug}</div>
                      </td>
                      <td className="px-4 py-3"><StatusBadge status={tenant.status} /></td>
                      <td className="px-4 py-3"><PlanBadge plan={tenant.plan} /></td>
                      <td className="px-4 py-3 text-muted">{tenant.user_count}</td>
                      <td className="px-4 py-3 text-muted">{tenant.calls_last_30d}</td>
                      <td className="px-4 py-3 text-muted whitespace-nowrap">
                        {tenant.last_call_at ? new Date(tenant.last_call_at).toLocaleDateString() : 'Never'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => setExpandedTenant(expandedTenant === tenant.id ? null : tenant.id)}
                            className="p-1.5 rounded hover:bg-surface-secondary text-muted hover:text-foreground"
                            title="View details"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                          {tenant.status === 'active' ? (
                            <button
                              onClick={() => {
                                if (confirm(`Suspend tenant "${tenant.name}"?`)) {
                                  statusMutation.mutate({ id: tenant.id, status: 'suspended' });
                                }
                              }}
                              className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-muted hover:text-red-600"
                              title="Suspend tenant"
                            >
                              <Ban className="h-4 w-4" />
                            </button>
                          ) : tenant.status === 'suspended' ? (
                            <button
                              onClick={() => {
                                if (confirm(`Reactivate tenant "${tenant.name}"?`)) {
                                  statusMutation.mutate({ id: tenant.id, status: 'active' });
                                }
                              }}
                              className="p-1.5 rounded hover:bg-green-100 dark:hover:bg-green-900/30 text-muted hover:text-green-600"
                              title="Reactivate tenant"
                            >
                              <CheckCircle className="h-4 w-4" />
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                    {expandedTenant === tenant.id && (
                      <tr key={`${tenant.id}-detail`} className="border-b border-border">
                        <td colSpan={8} className="p-0">
                          <TenantDetailPanel tenantId={tenant.id} />
                        </td>
                      </tr>
                    )}
                  </>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub }: { icon: typeof Building2; label: string; value: string; sub?: string }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-muted" />
        <span className="text-sm text-muted">{label}</span>
      </div>
      <div className="text-2xl font-bold">{value}</div>
      {sub && <div className="text-xs text-muted mt-1">{sub}</div>}
    </div>
  );
}
