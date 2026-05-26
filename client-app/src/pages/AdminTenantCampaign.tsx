import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import { format } from 'date-fns';
import { api } from '../lib/api';
import { PageHeader } from '../components/ui';
import { Megaphone } from 'lucide-react';

interface TenantInfo { id: string; name: string; slug: string }
interface AgentInfo { id: string; name: string }

interface Campaign {
  id: string;
  name: string;
  type: string;
  status: string;
  agentId: string;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  config: Record<string, unknown>;
}

interface Metrics {
  total: number;
  attempted: number;
  pending: number;
  dialing: number;
  connected: number;
  completed: number;
  failed: number;
  noAnswer: number;
  voicemail: number;
  skipped: number;
  optedOut: number;
}

interface CampaignResp {
  tenant: TenantInfo;
  campaign: Campaign;
  metrics: Metrics | null;
  agent: AgentInfo | null;
}

interface Contact {
  id: string;
  phoneNumber: string;
  name: string | null;
  status: string;
  outcome: string | null;
  attemptCount: number;
  lastAttemptedAt: string | null;
  createdAt: string;
}

interface ContactsResp {
  contacts: Contact[];
  total: number;
  limit: number;
  offset: number;
}

export default function AdminTenantCampaign() {
  const { tenantId, campaignId } = useParams<{ tenantId: string; campaignId: string }>();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const limit = 25;

  const { data: campaignData, isLoading, error } = useQuery({
    queryKey: ['admin-tenant-campaign', tenantId, campaignId],
    queryFn: () => api.get<CampaignResp>(`/platform/tenants/${tenantId}/campaigns/${campaignId}`),
    enabled: !!tenantId && !!campaignId,
  });

  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('page', String(page));
  if (statusFilter) params.set('status', statusFilter);

  const { data: contactsData, isLoading: contactsLoading } = useQuery({
    queryKey: ['admin-tenant-campaign-contacts', tenantId, campaignId, page, statusFilter],
    queryFn: () => api.get<ContactsResp>(
      `/platform/tenants/${tenantId}/campaigns/${campaignId}/contacts?${params.toString()}`,
    ),
    enabled: !!tenantId && !!campaignId,
  });

  const tenant = campaignData?.tenant;
  const campaign = campaignData?.campaign;
  const metrics = campaignData?.metrics;
  const agent = campaignData?.agent;
  const contacts = contactsData?.contacts ?? [];
  const total = contactsData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-6">
      <PageHeader
        title={campaign ? campaign.name : 'Campaign'}
        description={campaign
          ? `Type ${campaign.type} · status ${campaign.status} · agent ${agent?.name ?? '—'}`
          : 'Loading campaign details…'}
        icon={<Megaphone className="h-5 w-5" />}
        breadcrumbs={
          <button
            type="button"
            onClick={() => navigate(`/admin/analytics/tenants/${tenantId}`)}
            className="inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-primary transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Tenant Analytics
          </button>
        }
      />

      {error && (
        <div className="rounded-lg border border-danger/40 bg-danger-light px-4 py-3 text-sm text-danger">
          Failed to load campaign details. The campaign may not exist for this tenant.
        </div>
      )}

      {isLoading ? (
        <div className="text-text-secondary">Loading...</div>
      ) : campaign ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Stat label="Total Contacts" value={metrics?.total ?? 0} />
            <Stat label="Attempted" value={metrics?.attempted ?? 0} />
            <Stat label="Connected" value={metrics?.connected ?? 0} />
            <Stat label="Completed" value={metrics?.completed ?? 0} />
            <Stat label="Pending" value={metrics?.pending ?? 0} />
            <Stat label="Voicemail" value={metrics?.voicemail ?? 0} />
            <Stat label="No Answer" value={metrics?.noAnswer ?? 0} />
            <Stat label="Failed" value={metrics?.failed ?? 0} />
          </div>

          <div className="bg-card border border-border rounded-xl p-6">
            <h2 className="text-lg font-semibold mb-3 text-text-primary">Schedule</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
              <Row label="Created" value={campaign.createdAt ? format(new Date(campaign.createdAt), 'PPp') : '—'} />
              <Row label="Scheduled" value={campaign.scheduledAt ? format(new Date(campaign.scheduledAt), 'PPp') : '—'} />
              <Row label="Started" value={campaign.startedAt ? format(new Date(campaign.startedAt), 'PPp') : '—'} />
              <Row label="Completed" value={campaign.completedAt ? format(new Date(campaign.completedAt), 'PPp') : '—'} />
              <Row label="Last Updated" value={campaign.updatedAt ? format(new Date(campaign.updatedAt), 'PPp') : '—'} />
            </div>
          </div>

          <div className="bg-card border border-border rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-text-primary">Contacts</h2>
              <select
                value={statusFilter}
                onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
                className="px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm"
              >
                <option value="">All statuses</option>
                <option value="pending">Pending</option>
                <option value="dialing">Dialing</option>
                <option value="connected">Connected</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
                <option value="no_answer">No Answer</option>
                <option value="voicemail">Voicemail</option>
                <option value="skipped">Skipped</option>
                <option value="opted_out">Opted Out</option>
              </select>
            </div>

            {contactsLoading ? (
              <div className="text-text-secondary text-sm">Loading contacts…</div>
            ) : contacts.length === 0 ? (
              <div className="text-text-secondary text-sm">No contacts match this filter.</div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-text-muted-foreground">
                        <th className="pb-2 font-medium">Phone</th>
                        <th className="pb-2 font-medium">Name</th>
                        <th className="pb-2 font-medium">Status</th>
                        <th className="pb-2 font-medium">Outcome</th>
                        <th className="pb-2 font-medium text-right">Attempts</th>
                        <th className="pb-2 font-medium">Last Attempted</th>
                      </tr>
                    </thead>
                    <tbody>
                      {contacts.map((c) => (
                        <tr key={c.id} className="border-b border-border/50">
                          <td className="py-2.5 font-mono text-xs text-text-primary">{c.phoneNumber}</td>
                          <td className="py-2.5 text-text-secondary">{c.name ?? '—'}</td>
                          <td className="py-2.5 text-text-secondary">{c.status}</td>
                          <td className="py-2.5 text-text-secondary">{c.outcome ?? '—'}</td>
                          <td className="py-2.5 text-right text-text-secondary">{c.attemptCount}</td>
                          <td className="py-2.5 text-text-secondary">
                            {c.lastAttemptedAt ? format(new Date(c.lastAttemptedAt), 'MMM d, h:mm a') : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {totalPages > 1 && (
                  <div className="flex items-center justify-between mt-4">
                    <p className="text-xs text-text-secondary">{total} contacts total</p>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                        className="p-2 rounded-lg border border-border hover:bg-surface-hover disabled:opacity-30 transition">
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <span className="text-xs text-text-secondary">Page {page} of {totalPages}</span>
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
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <p className="text-xs text-text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold mt-1 text-text-primary">{value}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className="text-text-primary mt-0.5">{value}</p>
    </div>
  );
}
