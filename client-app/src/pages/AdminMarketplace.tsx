import { useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Store, CheckCircle, AlertCircle, DollarSign, Package, Inbox, ShieldCheck,
  ArrowUpCircle, X, History, ListOrdered,
} from 'lucide-react';
import { api } from '../lib/api';
import GlobalScopeBanner from '../components/GlobalScopeBanner';

interface RegistryTemplate {
  id: string;
  slug: string;
  displayName: string;
  currentVersion: string;
  status: string;
  installCount: number;
  activeInstalls: number;
  totalInstalls: number;
  uninstallCount: number;
  upgradeCount: number;
  activationRate: number;
  uninstallRate: number;
  upgradeAdoption: number;
  totalCalls: number;
  callsLast30d: number;
  avgCallDuration: number;
  avgSatisfaction: number;
  totalCampaigns: number;
  completedCampaigns: number;
}

interface SubmissionRow {
  id: string;
  templateId: string | null;
  developerId: string;
  developerName: string;
  developerEmail: string;
  packageName: string;
  packageSlug: string;
  marketplaceCategory: string;
  description: string;
  shortDescription: string | null;
  version: string;
  priceModel: string;
  priceCents: number;
  status: string;
  reviewNotes: string | null;
  reviewedBy: string | null;
  reviewerName: string | null;
  reviewerEmail: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RevenueStats {
  totalRevenueCents: number;
  platformFeesCents: number;
  developerPayoutsCents: number;
  totalPurchases: number;
  byTemplate: Array<{
    templateId: string;
    templateName: string;
    revenueCents: number;
    purchaseCount: number;
  }>;
}

interface TemplateVersion {
  id: string;
  version: string;
  changelog: string;
  releaseNotes: string;
  packageRef: string;
  status: string;
  isLatest: boolean;
  publishedAt: string;
  createdAt: string;
  createdBy: string | null;
}

type Tab = 'registry' | 'submissions' | 'revenue' | 'audit';

export default function AdminMarketplace() {
  const [tab, setTab] = useState<Tab>('registry');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Marketplace Management</h1>
        <p className="text-sm text-purple-200/70 mt-1">
          Manage the global template registry, developer submissions, and platform revenue.
        </p>
      </div>

      <GlobalScopeBanner
        label="Global Registry / All Tenants"
        description="Actions here affect every tenant on the platform. Tenant-scoped install state lives in the tenant Marketplace."
      />

      <div className="flex gap-2 border-b border-border">
        <TabButton active={tab === 'registry'} onClick={() => setTab('registry')} icon={Package} label="Registry" />
        <TabButton active={tab === 'submissions'} onClick={() => setTab('submissions')} icon={Inbox} label="Developer Submissions" />
        <TabButton active={tab === 'revenue'} onClick={() => setTab('revenue')} icon={DollarSign} label="Revenue" />
        <TabButton active={tab === 'audit'} onClick={() => setTab('audit')} icon={History} label="Audit / Recent Decisions" />
      </div>

      {tab === 'registry' && <RegistryTab />}
      {tab === 'submissions' && <SubmissionsTab />}
      {tab === 'revenue' && <RevenueTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}

function TabButton({
  active, onClick, icon: Icon, label,
}: { active: boolean; onClick: () => void; icon: typeof Package; label: string }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
        active ? 'border-purple-500 text-purple-300' : 'border-transparent text-text-muted hover:text-text-primary',
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function RegistryTab() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-template-registry'],
    queryFn: () => api.get<{ templates: RegistryTemplate[] }>('/platform/template-analytics'),
  });

  const templates = data?.templates ?? [];
  const [versionsFor, setVersionsFor] = useState<RegistryTemplate | null>(null);

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox message={(error as Error).message} />;
  if (!templates.length) return <Empty icon={Store} text="No templates in registry" />;

  return (
    <>
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-hover">
              <tr className="text-left text-text-secondary">
                <th className="px-4 py-3 font-medium">Template</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Active Installs</th>
                <th className="px-4 py-3 font-medium text-right">Activation %</th>
                <th className="px-4 py-3 font-medium text-right">Uninstall %</th>
                <th className="px-4 py-3 font-medium text-right">Upgrade Adoption</th>
                <th className="px-4 py-3 font-medium text-right">Calls 30d</th>
                <th className="px-4 py-3 font-medium text-right">Avg CSAT</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="border-t border-border/40">
                  <td className="px-4 py-3">
                    <div className="font-medium text-text-primary">{t.displayName}</div>
                    <div className="text-xs text-text-secondary">{t.slug} &middot; v{t.currentVersion}</div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={t.status} />
                  </td>
                  <td className="px-4 py-3 text-right">{t.activeInstalls.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{t.activationRate}%</td>
                  <td className="px-4 py-3 text-right">{t.uninstallRate}%</td>
                  <td className="px-4 py-3 text-right">{t.upgradeAdoption}%</td>
                  <td className="px-4 py-3 text-right">{t.callsLast30d.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">{t.avgSatisfaction.toFixed(1)}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setVersionsFor(t)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border border-border text-text-secondary hover:text-text-primary hover:bg-surface-hover"
                    >
                      <ListOrdered className="h-3.5 w-3.5" /> Versions
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {versionsFor && (
        <VersionsModal template={versionsFor} onClose={() => setVersionsFor(null)} />
      )}
    </>
  );
}

function VersionsModal({ template, onClose }: { template: RegistryTemplate; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-template-versions', template.id],
    queryFn: () => api.get<{ versions: TemplateVersion[] }>(`/platform/templates/${template.id}/versions`),
  });
  const versions = data?.versions ?? [];

  const publishMutation = useMutation({
    mutationFn: (versionId: string) =>
      api.post(`/platform/templates/${template.id}/versions/${versionId}/publish`, {}),
    onSuccess: () => {
      refetch();
      queryClient.invalidateQueries({ queryKey: ['admin-template-registry'] });
    },
  });

  const deprecateMutation = useMutation({
    mutationFn: (versionId: string) =>
      api.patch(`/platform/templates/${template.id}/versions/${versionId}/deprecate`, {}),
    onSuccess: () => {
      refetch();
      queryClient.invalidateQueries({ queryKey: ['admin-template-registry'] });
    },
  });

  const busy = publishMutation.isPending || deprecateMutation.isPending;
  const mutationError = (publishMutation.error ?? deprecateMutation.error) as Error | null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h3 className="text-lg font-semibold text-text-primary">Versions — {template.displayName}</h3>
            <p className="text-xs text-text-secondary">{template.slug}</p>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5 overflow-y-auto">
          {isLoading && <Loading />}
          {error && <ErrorBox message={(error as Error).message} />}
          {!isLoading && !error && versions.length === 0 && <Empty icon={Package} text="No versions yet" />}
          {!isLoading && !error && versions.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-text-secondary text-left">
                <tr>
                  <th className="pb-2 font-medium">Version</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Published</th>
                  <th className="pb-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id} className="border-t border-border/40">
                    <td className="py-2.5 text-text-primary">
                      <div className="font-medium">v{v.version}{v.isLatest && <span className="ml-2 text-xs text-green-400">latest</span>}</div>
                      {v.changelog && <div className="text-xs text-text-secondary truncate max-w-md">{v.changelog}</div>}
                    </td>
                    <td className="py-2.5"><StatusBadge status={v.status} /></td>
                    <td className="py-2.5 text-text-secondary text-xs">{new Date(v.publishedAt).toLocaleDateString()}</td>
                    <td className="py-2.5 text-right space-x-2">
                      {v.status === 'draft' && (
                        <button
                          onClick={() => publishMutation.mutate(v.id)}
                          disabled={busy}
                          className="px-2.5 py-1 text-xs rounded bg-primary text-white hover:bg-primary-hover disabled:opacity-50"
                        >
                          Publish
                        </button>
                      )}
                      {v.status === 'published' && (
                        <button
                          onClick={() => deprecateMutation.mutate(v.id)}
                          disabled={busy}
                          className="px-2.5 py-1 text-xs rounded border border-border text-text-secondary hover:text-text-primary disabled:opacity-50"
                        >
                          Deprecate
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {mutationError && (
            <div className="mt-3 text-sm text-red-400">{mutationError.message}</div>
          )}
        </div>
      </div>
    </div>
  );
}

type DateRangePreset = 'all' | '7d' | '30d' | '90d' | 'custom';
type DecisionFilter = 'all' | 'approved' | 'rejected';

interface ReviewerOption {
  id: string;
  name: string | null;
  email: string | null;
  decisionCount: number;
}

function AuditTab() {
  const [reviewerId, setReviewerId] = useState<string>('');
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>('all');
  const [datePreset, setDatePreset] = useState<DateRangePreset>('all');
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');

  const reviewersQuery = useQuery({
    queryKey: ['admin-marketplace-reviewers'],
    queryFn: () => api.get<{ reviewers: ReviewerOption[] }>('/platform/marketplace/reviewers'),
  });

  const { reviewedFromIso, reviewedToIso } = computeDateRange(datePreset, customFrom, customTo);

  const statusParam = decisionFilter === 'all'
    ? 'approved,rejected,published'
    : decisionFilter === 'approved'
      ? 'approved,published'
      : 'rejected';

  const params = new URLSearchParams({ status: statusParam, limit: '100' });
  if (reviewerId) params.set('reviewerId', reviewerId);
  if (reviewedFromIso) params.set('reviewedFrom', reviewedFromIso);
  if (reviewedToIso) params.set('reviewedTo', reviewedToIso);

  const queryString = params.toString();

  const submissionsQuery = useQuery({
    queryKey: ['admin-marketplace-audit', queryString],
    queryFn: () => api.get<{ submissions: SubmissionRow[]; total: number }>(
      `/platform/marketplace/submissions?${queryString}`,
    ),
  });

  const items = (submissionsQuery.data?.submissions ?? []);
  const total = submissionsQuery.data?.total ?? 0;
  const reviewers = reviewersQuery.data?.reviewers ?? [];

  const filtersActive = reviewerId !== '' || decisionFilter !== 'all' || datePreset !== 'all';

  const resetFilters = () => {
    setReviewerId('');
    setDecisionFilter('all');
    setDatePreset('all');
    setCustomFrom('');
    setCustomTo('');
  };

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-xl p-4 flex flex-wrap items-end gap-3">
        <FilterField label="Reviewer">
          <select
            value={reviewerId}
            onChange={(e) => setReviewerId(e.target.value)}
            className="bg-surface-hover border border-border rounded px-2 py-1.5 text-sm text-text-primary min-w-[180px]"
          >
            <option value="">All reviewers</option>
            {reviewers.map((r) => (
              <option key={r.id} value={r.id}>
                {(r.name || r.email || r.id.slice(0, 8))} ({r.decisionCount})
              </option>
            ))}
          </select>
        </FilterField>

        <FilterField label="Decision">
          <select
            value={decisionFilter}
            onChange={(e) => setDecisionFilter(e.target.value as DecisionFilter)}
            className="bg-surface-hover border border-border rounded px-2 py-1.5 text-sm text-text-primary"
          >
            <option value="all">All decisions</option>
            <option value="approved">Approved only</option>
            <option value="rejected">Rejected only</option>
          </select>
        </FilterField>

        <FilterField label="Date range">
          <select
            value={datePreset}
            onChange={(e) => setDatePreset(e.target.value as DateRangePreset)}
            className="bg-surface-hover border border-border rounded px-2 py-1.5 text-sm text-text-primary"
          >
            <option value="all">All time</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
            <option value="custom">Custom…</option>
          </select>
        </FilterField>

        {datePreset === 'custom' && (
          <>
            <FilterField label="From">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="bg-surface-hover border border-border rounded px-2 py-1.5 text-sm text-text-primary"
              />
            </FilterField>
            <FilterField label="To">
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="bg-surface-hover border border-border rounded px-2 py-1.5 text-sm text-text-primary"
              />
            </FilterField>
          </>
        )}

        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-text-secondary">{total} decision{total === 1 ? '' : 's'}</span>
          {filtersActive && (
            <button
              type="button"
              onClick={resetFilters}
              className="text-xs px-2.5 py-1.5 rounded border border-border text-text-secondary hover:text-text-primary"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {submissionsQuery.isLoading ? (
        <Loading />
      ) : !items.length ? (
        <Empty
          icon={History}
          text={filtersActive ? 'No decisions match the current filters' : 'No moderation decisions yet'}
        />
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-hover">
                <tr className="text-left text-text-secondary">
                  <th className="px-4 py-3 font-medium">Submission</th>
                  <th className="px-4 py-3 font-medium">Decision</th>
                  <th className="px-4 py-3 font-medium">Reviewer</th>
                  <th className="px-4 py-3 font-medium">When</th>
                  <th className="px-4 py-3 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id} className="border-t border-border/40">
                    <td className="px-4 py-3 text-text-primary">
                      <div className="font-medium">{s.packageName} <span className="text-xs text-text-secondary">v{s.version}</span></div>
                      <div className="text-xs text-text-secondary">{s.developerEmail}</div>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={s.status} /></td>
                    <td className="px-4 py-3 text-text-secondary text-xs">{s.reviewerName ?? s.reviewerEmail ?? s.reviewedBy ?? '—'}</td>
                    <td className="px-4 py-3 text-text-secondary text-xs">
                      {s.reviewedAt ? new Date(s.reviewedAt).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-3 text-text-secondary text-xs max-w-md truncate">{s.reviewNotes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

function computeDateRange(
  preset: DateRangePreset,
  customFrom: string,
  customTo: string,
): { reviewedFromIso?: string; reviewedToIso?: string } {
  if (preset === 'all') return {};
  if (preset === 'custom') {
    const fromIso = customFrom ? new Date(`${customFrom}T00:00:00`).toISOString() : undefined;
    const toIso = customTo ? new Date(`${customTo}T23:59:59.999`).toISOString() : undefined;
    return { reviewedFromIso: fromIso, reviewedToIso: toIso };
  }
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
  const from = new Date();
  from.setDate(from.getDate() - days);
  return { reviewedFromIso: from.toISOString() };
}

function SubmissionsTab() {
  const queryClient = useQueryClient();
  const [reviewing, setReviewing] = useState<SubmissionRow | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-marketplace-submissions'],
    queryFn: () => api.get<{ submissions: SubmissionRow[] }>('/platform/marketplace/submissions'),
  });

  const submissions = data?.submissions ?? [];

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox message={(error as Error).message} />;
  if (!submissions.length) return <Empty icon={Inbox} text="No developer submissions pending review" />;

  return (
    <>
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-hover">
              <tr className="text-left text-text-secondary">
                <th className="px-4 py-3 font-medium">Submission</th>
                <th className="px-4 py-3 font-medium">Developer</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Submitted</th>
                <th className="px-4 py-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((s) => {
                const isPending = ['submitted', 'in_review'].includes(s.status);
                return (
                  <tr key={s.id} className="border-t border-border/40 align-top">
                    <td className="px-4 py-3 text-text-primary">
                      <div className="font-medium">{s.packageName} <span className="text-xs text-text-secondary">v{s.version}</span></div>
                      <div className="text-xs text-text-secondary truncate max-w-md">{s.shortDescription ?? s.description}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div>{s.developerName}</div>
                      <div className="text-xs text-text-secondary">{s.developerEmail}</div>
                    </td>
                    <td className="px-4 py-3 capitalize">{s.marketplaceCategory.replace(/_/g, ' ')}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={s.status} />
                      {!isPending && s.reviewedAt && (
                        <div className="mt-1 text-xs text-text-secondary space-y-0.5">
                          <div>by {s.reviewerName ?? s.reviewerEmail ?? s.reviewedBy ?? 'unknown'}</div>
                          <div>{new Date(s.reviewedAt).toLocaleString()}</div>
                          {s.reviewNotes && (
                            <div className="italic max-w-xs truncate" title={s.reviewNotes}>"{s.reviewNotes}"</div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-secondary text-xs">
                      {new Date(s.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setReviewing(s)}
                        disabled={!isPending}
                        className="px-3 py-1 text-xs font-medium rounded bg-primary text-white hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Review
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {reviewing && (
        <ReviewModal
          submission={reviewing}
          onClose={() => setReviewing(null)}
          onReviewed={() => {
            setReviewing(null);
            queryClient.invalidateQueries({ queryKey: ['admin-marketplace-submissions'] });
          }}
        />
      )}
    </>
  );
}

function ReviewModal({
  submission, onClose, onReviewed,
}: { submission: SubmissionRow; onClose: () => void; onReviewed: () => void }) {
  const [decision, setDecision] = useState<'approved' | 'rejected'>('approved');
  const [notes, setNotes] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/platform/marketplace/submissions/${submission.id}/review`, {
        decision,
        reviewNotes: notes,
      }),
    onSuccess: onReviewed,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-lg font-semibold text-text-primary">Review Submission</h3>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="bg-surface-hover rounded-lg p-3 text-sm space-y-1">
            <div><span className="text-text-secondary">Package:</span> <span className="font-medium">{submission.packageName}</span></div>
            <div><span className="text-text-secondary">Version:</span> <span className="font-medium">{submission.version}</span></div>
            <div><span className="text-text-secondary">Category:</span> <span className="font-medium capitalize">{submission.marketplaceCategory.replace(/_/g, ' ')}</span></div>
            <div><span className="text-text-secondary">Developer:</span> <span>{submission.developerName} ({submission.developerEmail})</span></div>
            <div className="pt-1 text-xs text-text-secondary">{submission.description}</div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => setDecision('approved')}
              className={clsx(
                'flex-1 px-3 py-2 rounded-lg text-sm font-medium border',
                decision === 'approved'
                  ? 'bg-green-500/10 border-green-500/40 text-green-400'
                  : 'border-border text-text-secondary hover:text-text-primary',
              )}
            >
              <CheckCircle className="h-4 w-4 inline mr-1" /> Approve
            </button>
            <button
              onClick={() => setDecision('rejected')}
              className={clsx(
                'flex-1 px-3 py-2 rounded-lg text-sm font-medium border',
                decision === 'rejected'
                  ? 'bg-red-500/10 border-red-500/40 text-red-400'
                  : 'border-border text-text-secondary hover:text-text-primary',
              )}
            >
              <X className="h-4 w-4 inline mr-1" /> Reject
            </button>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Reviewer notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              placeholder="Optional notes for the developer..."
            />
          </div>

          {mutation.isError && (
            <div className="text-sm text-red-400">{(mutation.error as Error).message}</div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg border border-border text-text-secondary hover:text-text-primary">
              Cancel
            </button>
            <button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover disabled:opacity-50"
            >
              {mutation.isPending ? 'Submitting...' : 'Submit Review'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RevenueTab() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-marketplace-revenue'],
    queryFn: () => api.get<{ revenue: RevenueStats }>('/platform/marketplace/revenue'),
  });

  const revenue = data?.revenue;

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox message={(error as Error).message} />;
  if (!revenue) return <Empty icon={DollarSign} text="No revenue data available" />;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Stat
          label="Total Marketplace Revenue"
          value={`$${(revenue.totalRevenueCents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
          icon={DollarSign}
        />
        <Stat
          label="Total Purchases"
          value={revenue.totalPurchases.toLocaleString()}
          icon={ShieldCheck}
        />
        <Stat
          label="Avg Revenue / Purchase"
          value={
            revenue.totalPurchases > 0
              ? `$${(revenue.totalRevenueCents / revenue.totalPurchases / 100).toFixed(2)}`
              : '—'
          }
          icon={ArrowUpCircle}
        />
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-text-primary">Revenue by Template</h3>
        </div>
        {!revenue.byTemplate.length ? (
          <div className="p-8 text-center text-text-secondary text-sm">No paid templates yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-hover">
                <tr className="text-left text-text-secondary">
                  <th className="px-4 py-3 font-medium">Template</th>
                  <th className="px-4 py-3 font-medium text-right">Purchases</th>
                  <th className="px-4 py-3 font-medium text-right">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {revenue.byTemplate.map((row) => (
                  <tr key={row.templateId} className="border-t border-border/40">
                    <td className="px-4 py-3 text-text-primary">{row.templateName}</td>
                    <td className="px-4 py-3 text-right">{row.purchaseCount.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right font-medium">
                      ${(row.revenueCents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}
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

function Stat({ label, value, icon: Icon }: { label: string; value: string; icon: typeof DollarSign }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 flex items-center gap-3">
      <div className="h-10 w-10 rounded-lg bg-purple-500/15 flex items-center justify-center">
        <Icon className="h-5 w-5 text-purple-400" />
      </div>
      <div>
        <p className="text-xs text-text-secondary">{label}</p>
        <p className="text-lg font-semibold text-text-primary">{value}</p>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'active' || status === 'approved' || status === 'published'
      ? 'bg-green-500/15 text-green-400'
      : status === 'pending' || status === 'draft' || status === 'in_review'
        ? 'bg-amber-500/15 text-amber-400'
        : status === 'rejected' || status === 'deprecated' || status === 'disabled'
          ? 'bg-red-500/15 text-red-400'
          : 'bg-gray-500/15 text-text-muted';
  return (
    <span className={clsx('inline-flex px-2 py-0.5 rounded text-xs font-medium capitalize', cls)}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function Loading() {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="animate-spin h-8 w-8 border-4 border-purple-500 border-t-transparent rounded-full" />
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="bg-card border border-red-500/30 rounded-xl p-8 text-center">
      <AlertCircle className="h-10 w-10 text-red-400 mx-auto mb-2" />
      <p className="text-text-primary font-medium">Failed to load</p>
      <p className="text-sm text-text-secondary mt-1">{message}</p>
    </div>
  );
}

function Empty({ icon: Icon, text }: { icon: typeof Store; text: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-12 text-center">
      <Icon className="h-12 w-12 text-text-muted mx-auto mb-3" />
      <p className="text-text-secondary">{text}</p>
    </div>
  );
}
