import { Fragment, useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import OperationsAlertsBanner from '../components/OperationsAlertsBanner';
import { formatCents as formatCentsHelper } from '../lib/formatCurrency';
import { StatCard, PageHeader } from '../components/ui';
import {
  isHardBounce,
  isPermanentSmtpError,
  describeRetrySkippedReason,
  type RetrySkippedReasonBadge,
  type RetrySkippedTone,
} from '../lib/smtpErrorClass';
import {
  Building2, Users, PhoneCall, DollarSign, ChevronDown, ChevronRight,
  Ban, CheckCircle, Eye, Package, Plus, Play, Archive, AlertCircle,
  BarChart3, Download as DownloadIcon, TrendingUp, TrendingDown, Activity,
  ThumbsUp, ThumbsDown, MessageSquare, BookOpen,
  LifeBuoy, Mail, RotateCw, Plug, XCircle,
  AlertTriangle, ShieldAlert, ExternalLink, Send, MailX, ShieldOff,
  Clock, ArrowUpDown, Database, PhoneOff,
} from 'lucide-react';

interface DocsFeedbackArticle {
  article_slug: string;
  total_votes: number;
  helpful_count: number;
  not_helpful_count: number;
  comment_count: number;
  new_comment_count: number;
  resolved_comment_count: number;
  hidden_comment_count: number;
  pending_reply_count: number;
  helpful_ratio: number | null;
  last_vote_at: string | null;
}

type DocsFeedbackStatus = 'new' | 'resolved' | 'hidden';

interface DocsFeedbackComment {
  id: number;
  article_slug: string;
  vote: 'helpful' | 'not_helpful';
  comment: string;
  page_path: string | null;
  created_at: string;
  status: DocsFeedbackStatus;
  status_updated_at: string | null;
  status_updated_by: string | null;
  reply_email: string | null;
  reply_count: number;
  last_reply_at?: string | null;
  last_reply_error?: string | null;
  last_reply_retry_skipped_reason?: string | null;
  last_reply_failed?: boolean | null;
  last_reply_permanent?: boolean | null;
  // Auto-retry counters from `docs_feedback_replies.retry_count` /
  // `last_retry_at` on the most recent reply. Driven by the background
  // DocsFeedbackReplyRetryScheduler so the inbox can show whether the
  // pipeline has already burned all auto-retries (admin should reach out
  // another way) or whether the failure is fresh and a retry hasn't
  // kicked in yet (leave it alone for an hour).
  last_reply_retry_count?: number | null;
  last_reply_last_retry_at?: string | null;
}

interface DocsFeedbackReply {
  id: number;
  feedback_id: number;
  sent_by: string | null;
  to_email: string;
  subject: string;
  body: string;
  email_message_id: string | null;
  email_error: string | null;
  retry_skipped_reason: string | null;
  // Number of background auto-retries the DocsFeedbackReplyRetryScheduler
  // has already burned on this row, plus the timestamp of the most recent
  // attempt. Both are bumped in the same conditional UPDATE the scheduler
  // uses to claim a row, so they always advance together. Surfaced in the
  // reply history so an admin can see at-a-glance whether a Failed row
  // still has retries remaining or whether the scheduler has given up.
  retry_count?: number | null;
  last_retry_at?: string | null;
  retry_of: number | null;
  created_at: string;
}

interface DocsFeedbackReplyChain {
  root: DocsFeedbackReply;
  retries: DocsFeedbackReply[];
}

function groupDocsFeedbackReplyChains(
  replies: DocsFeedbackReply[],
): DocsFeedbackReplyChain[] {
  const ascending = [...replies].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  const chainsByRoot = new Map<number, DocsFeedbackReplyChain>();
  for (const r of ascending) {
    if (r.retry_of != null && chainsByRoot.has(r.retry_of)) {
      chainsByRoot.get(r.retry_of)!.retries.push(r);
    } else {
      // Root attempt, or an orphan retry (root row deleted / pre-migration data).
      chainsByRoot.set(r.id, { root: r, retries: [] });
    }
  }
  return Array.from(chainsByRoot.values()).sort(
    (a, b) =>
      new Date(b.root.created_at).getTime() -
      new Date(a.root.created_at).getTime(),
  );
}

type DocsFeedbackSort = 'lowest_ratio' | 'highest_ratio' | 'most_votes' | 'recent';
type DocsFeedbackStatusFilter = DocsFeedbackStatus | 'all' | 'pending_reply';

// Mirrors DOCS_FEEDBACK_REPLY_DELIVERY_ALERT_THRESHOLD on the server, which
// the DocsFeedbackReplyRetryScheduler uses as MAX_RETRY_ATTEMPTS. We hard-
// code it on the client so the inbox can render "Auto-retried N/3" without
// an extra round-trip; if the server constant ever changes both sides need
// to be updated together (see platform/help/docsFeedbackReplyDeliveryAlert.ts).
const DOCS_FEEDBACK_REPLY_AUTO_RETRY_MAX = 3;

/**
 * Compact pill that renders "Auto-retried N/MAX" alongside a Failed badge
 * for a docs feedback reply. Renders nothing when no auto-retries have
 * happened yet. Painted amber when the auto-retry pool has been exhausted
 * (the row will not be retried again) and red while retries are still
 * remaining — same colour language the inbox uses for the Hard bounce
 * vs. plain Failed badges. Hover title surfaces the timestamp of the
 * last attempt so an admin can tell whether the scheduler just gave up
 * (recent) or gave up an hour ago.
 */
function DocsFeedbackAutoRetryBadge({
  retryCount,
  lastRetryAt,
  size = 'sm',
}: {
  retryCount: number | null | undefined;
  lastRetryAt: string | null | undefined;
  size?: 'xs' | 'sm';
}) {
  const retries = retryCount ?? 0;
  if (retries <= 0) return null;
  const exhausted = retries >= DOCS_FEEDBACK_REPLY_AUTO_RETRY_MAX;
  const lastRetryLabel = lastRetryAt
    ? new Date(lastRetryAt).toLocaleString()
    : null;
  const title = lastRetryLabel
    ? `Last auto-retry attempt at ${lastRetryLabel}${
        exhausted
          ? ' — no further auto-retries; reach out another way.'
          : '. The background scheduler will keep retrying every ~90s.'
      }`
    : exhausted
      ? 'Auto-retries exhausted — reach out another way.'
      : 'Background scheduler has retried this reply.';
  const sizing =
    size === 'xs'
      ? 'px-1 py-0.5 text-[9px]'
      : 'px-1.5 py-0.5 text-[10px]';
  const palette = exhausted
    ? 'border-amber-300 bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900'
    : 'border-red-300 bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900';
  return (
    <span
      className={`rounded border uppercase tracking-wide font-medium ${sizing} ${palette}`}
      title={title}
    >
      Auto-retried {retries}/{DOCS_FEEDBACK_REPLY_AUTO_RETRY_MAX}
    </span>
  );
}

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

// Snapshot of the platform-wide `support_recipient_bounce_alerts` dedup
// table — total distinct addresses we've ever paged ops about for a hard
// bounce, plus the last-7d / last-30d windows that make a sender-reputation
// regression visible at a glance.
interface BouncedRecipientStats {
  total: number;
  last_7d: number;
  last_30d: number;
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

interface TemplateListItem {
  id: string;
  slug: string;
  displayName: string;
  currentVersion: string;
  status: string;
}

interface TemplateVersion {
  id: string;
  version: string;
  changelog: string;
  releaseNotes: string;
  packageRef: string;
  isLatest: boolean;
  status: string;
  publishedAt: string;
}

interface TemplateDetail {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  currentVersion: string;
  status: string;
  requiredTools: string[];
  versions: TemplateVersion[];
}

interface TemplateAnalytics {
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

interface ActivationMetricRow {
  tenant_id: string;
  tenant_name: string;
  tenant_plan: string;
  tenant_status: string;
  tenant_created_at: string;
  agent_created_at: string | null;
  agent_deployed_at: string | null;
  phone_connected_at: string | null;
  tools_connected_at: string | null;
  first_call_at: string | null;
  first_workflow_at: string | null;
  time_to_agent_hours: number | null;
  time_to_call_hours: number | null;
  time_to_workflow_hours: number | null;
  milestones_completed: number;
}

interface CostMonitoringData {
  daily: {
    callMinutes: number;
    aiCostCents: number;
    twilioCostCents: number;
    smsCostCents: number;
    callCount: number;
    toolExecutions: number;
    apiRequests: number;
    totalCostCents: number;
  };
  monthly: {
    callMinutes: number;
    callCount: number;
    totalCostCents: number;
    aiCostCents: number;
    twilioCostCents: number;
    revenueCents: number;
  };
  trials: {
    activeTrials: number;
    paidAccounts: number;
    totalAccounts: number;
    conversionRate: number;
  };
  economics: {
    costPerCallCents: number;
    revenuePerCallCents: number;
    marginPerCallCents: number;
  };
  trend: Array<{
    day: string;
    callMinutes: number;
    callCount: number;
    totalCostCents: number;
  }>;
}

type SortField = 'displayName' | 'totalInstalls' | 'activationRate' | 'callsLast30d' | 'uninstallRate' | 'avgSatisfaction' | 'totalCampaigns' | 'upgradeAdoption';
type SortDir = 'asc' | 'desc';

interface ValidationCheck {
  name: string;
  passed: boolean;
  message: string;
}

interface ValidationResult {
  valid: boolean;
  checks: ValidationCheck[];
}

function formatCents(cents: string | number): string {
  return formatCentsHelper(cents);
}

/**
 * Re-render every second while at least one of the supplied "available at"
 * timestamps is still in the future, so a countdown UI can show its
 * remaining seconds without each consumer wiring up its own setInterval.
 * Returns Date.now() at the latest tick.
 */
function useCountdownTick(targetsMs: number[]): number {
  const [now, setNow] = useState(() => Date.now());
  const active = targetsMs.some((t) => t > now);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * Pull a positive integer out of an arbitrary error/response body. Used to
 * read `retry_after_seconds` (from a 429) or `retry_cooldown_seconds` (from
 * a successful retry) without leaking `any` everywhere.
 */
function readPositiveSeconds(body: unknown, key: string): number | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as Record<string, unknown>)[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.ceil(raw);
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    pending: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    suspended: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-surface-hover text-text-secondary'}`}>
      {status}
    </span>
  );
}

// Color/border palette for the retry-skipped reason badges. Each tone is
// distinct enough that ops can tell them apart at a glance in a long inbox
// list without needing to mouse over the tooltip.
const RETRY_SKIPPED_TONE_CLASSES: Record<RetrySkippedTone, string> = {
  hard_bounce:
    'bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
  suppression:
    'bg-purple-100 text-purple-900 border-purple-300 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-900',
  manual_cancel:
    'bg-slate-100 text-slate-800 border-slate-300 dark:bg-slate-800/60 dark:text-slate-200 dark:border-slate-700',
  unsubscribed:
    'bg-rose-100 text-rose-900 border-rose-300 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900',
  unknown:
    'bg-gray-100 text-gray-800 border-gray-300 dark:bg-gray-800/60 dark:text-gray-200 dark:border-gray-700',
};

/**
 * Compact pill rendered alongside a failed-delivery row when the auto-retry
 * pipeline has decided not to attempt the row again. Reads the descriptor
 * from `describeRetrySkippedReason` so a new server-side reason becomes a
 * distinct badge automatically (and an unrecognised reason falls through to
 * a generic "Auto-retry skipped" label instead of breaking the layout).
 */
function RetrySkippedBadge({
  reason,
  size = 'sm',
  variant = 'short',
}: {
  reason: string | null | undefined;
  size?: 'xs' | 'sm';
  variant?: 'short' | 'long';
}) {
  const descriptor: RetrySkippedReasonBadge | null = describeRetrySkippedReason(reason);
  if (!descriptor) return null;
  const sizeClass =
    size === 'xs'
      ? 'px-1 py-0.5 text-[9px]'
      : 'px-1.5 py-0.5 text-[10px]';
  return (
    <span
      title={descriptor.description}
      className={`inline-flex items-center rounded border font-medium uppercase tracking-wide cursor-help ${sizeClass} ${RETRY_SKIPPED_TONE_CLASSES[descriptor.tone]}`}
    >
      {variant === 'long' ? descriptor.longLabel : descriptor.shortLabel}
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
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[plan] ?? 'bg-surface-hover text-text-secondary'}`}>
      {plan}
    </span>
  );
}

function VersionStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    published: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    deprecated: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-surface-hover text-text-secondary'}`}>
      {status}
    </span>
  );
}

// Owner-user onboarding row returned by `/platform/tenants/:id/onboarding`.
// Mirrors the SQL projection in `server/admin-api/routes/platformAdmin.ts`,
// where `onboarding_step` is already clamped to [1..3] and
// `onboarding_completed` is forced to a boolean.
interface TenantOwnerOnboarding {
  user_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  created_at: string;
  last_login_at: string | null;
  role_granted_at: string | null;
  onboarding_step: number;
  onboarding_completed: boolean;
}

// Total step count for the wizard, kept in lock-step with
// `TOTAL_ONBOARDING_STEPS` in `client-app/src/pages/Onboarding.tsx`. Update
// both together if the wizard grows / shrinks a step.
const ONBOARDING_TOTAL_STEPS = 3;

const ONBOARDING_STEP_LABELS: Record<number, string> = {
  1: 'Provisioning',
  2: 'Template selection',
  3: 'Phone number',
};

function OwnerOnboardingBadge({
  step,
  completed,
}: {
  step: number;
  completed: boolean;
}) {
  if (completed) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
        <CheckCircle className="h-3 w-3" />
        Completed
      </span>
    );
  }
  const label = ONBOARDING_STEP_LABELS[step] ?? `Step ${step}`;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
      <AlertCircle className="h-3 w-3" />
      Step {step}/{ONBOARDING_TOTAL_STEPS} · {label}
    </span>
  );
}

function TenantDetailPanel({ tenantId }: { tenantId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['platform-tenant-detail', tenantId],
    queryFn: () => api.get<{ tenant: TenantDetail }>(`/platform/tenants/${tenantId}`),
  });

  // Per-owner onboarding state — separate query so a slow / failing
  // onboarding fetch doesn't block the rest of the detail panel from
  // rendering. The endpoint scopes to `tenant_owner` rows so the list is
  // small (typically 1).
  const { data: onboardingData, isLoading: onboardingLoading } = useQuery({
    queryKey: ['platform-tenant-onboarding', tenantId],
    queryFn: () =>
      api.get<{ owners: TenantOwnerOnboarding[] }>(
        `/platform/tenants/${tenantId}/onboarding`,
      ),
  });

  if (isLoading) return <div className="px-4 py-3 text-sm text-text-muted">Loading details...</div>;
  if (!data) return null;

  const t = data.tenant;
  const owners = onboardingData?.owners ?? [];
  return (
    <div className="bg-surface-secondary/50">
      <div className="px-6 py-4 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
        <div>
          <span className="text-text-muted">Agents</span>
          <div className="font-medium">{t.agent_count}</div>
        </div>
        <div>
          <span className="text-text-muted">Phone Numbers</span>
          <div className="font-medium">{t.phone_number_count}</div>
        </div>
        <div>
          <span className="text-text-muted">Total Calls</span>
          <div className="font-medium">{t.total_calls}</div>
        </div>
        <div>
          <span className="text-text-muted">Total Spend</span>
          <div className="font-medium">{formatCents(t.total_cost_cents)}</div>
        </div>
      </div>
      <div className="px-6 pb-4">
        <div className="text-xs uppercase tracking-wide text-text-muted mb-2">
          Owner onboarding
        </div>
        {onboardingLoading ? (
          <div className="text-sm text-text-muted">Loading owner progress...</div>
        ) : owners.length === 0 ? (
          <div className="text-sm text-text-muted">No tenant owners on record.</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="text-left px-3 py-2 font-medium text-text-muted">Owner</th>
                  <th className="text-left px-3 py-2 font-medium text-text-muted">Onboarding</th>
                  <th className="text-left px-3 py-2 font-medium text-text-muted">Signed up</th>
                  <th className="text-left px-3 py-2 font-medium text-text-muted">Last login</th>
                </tr>
              </thead>
              <tbody>
                {owners.map((owner) => {
                  const fullName = [owner.first_name, owner.last_name]
                    .filter(Boolean)
                    .join(' ')
                    .trim();
                  return (
                    <tr key={owner.user_id} className="border-b border-border last:border-0">
                      <td className="px-3 py-2">
                        <div className="font-medium">{fullName || owner.email}</div>
                        {fullName && (
                          <div className="text-xs text-text-muted">{owner.email}</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <OwnerOnboardingBadge
                          step={owner.onboarding_step}
                          completed={owner.onboarding_completed}
                        />
                      </td>
                      <td className="px-3 py-2 text-text-muted whitespace-nowrap">
                        {new Date(owner.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-3 py-2 text-text-muted whitespace-nowrap">
                        {owner.last_login_at
                          ? new Date(owner.last_login_at).toLocaleDateString()
                          : '\u2014'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function CreateVersionForm({ templateId, onClose }: { templateId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [version, setVersion] = useState('');
  const [changelog, setChangelog] = useState('');
  const [releaseNotes, setReleaseNotes] = useState('');

  const createMutation = useMutation({
    mutationFn: () => api.post(`/platform/templates/${templateId}/versions`, {
      version,
      changelog,
      releaseNotes,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-template-detail', templateId] });
      onClose();
    },
  });

  return (
    <div className="border border-border rounded-lg p-4 bg-surface-secondary/50 space-y-3">
      <h4 className="font-medium text-sm">Create New Version</h4>
      <div>
        <label className="text-xs text-text-muted block mb-1">Version (semver)</label>
        <input
          type="text"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          placeholder="e.g. 1.2.0"
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
      </div>
      <div>
        <label className="text-xs text-text-muted block mb-1">Changelog</label>
        <textarea
          value={changelog}
          onChange={(e) => setChangelog(e.target.value)}
          placeholder="What changed in this version..."
          rows={3}
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
        />
      </div>
      <div>
        <label className="text-xs text-text-muted block mb-1">Release Notes (optional)</label>
        <textarea
          value={releaseNotes}
          onChange={(e) => setReleaseNotes(e.target.value)}
          placeholder="Additional notes for this release..."
          rows={2}
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
        />
      </div>
      {createMutation.isError && (
        <div className="text-sm text-red-600 dark:text-red-400">
          {(createMutation.error as Error).message}
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => createMutation.mutate()}
          disabled={!version || !changelog || createMutation.isPending}
          className="px-4 py-2 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50"
        >
          {createMutation.isPending ? 'Creating...' : 'Create Draft'}
        </button>
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm text-text-muted hover:text-text-primary rounded-lg hover:bg-surface-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function TemplateVersionManager({ templateId }: { templateId: string }) {
  const queryClient = useQueryClient();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [validationResults, setValidationResults] = useState<Record<string, ValidationResult>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['platform-template-detail', templateId],
    queryFn: () => api.get<TemplateDetail>(`/marketplace/templates/${templateId}`),
  });

  const validateMutation = useMutation({
    mutationFn: (versionId: string) =>
      api.post<{ validation: ValidationResult }>(`/platform/templates/${templateId}/versions/${versionId}/validate`),
    onSuccess: (result, versionId) => {
      setValidationResults((prev) => ({ ...prev, [versionId]: result.validation }));
    },
  });

  const publishMutation = useMutation({
    mutationFn: (versionId: string) =>
      api.post(`/platform/templates/${templateId}/versions/${versionId}/publish`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-template-detail', templateId] });
      queryClient.invalidateQueries({ queryKey: ['platform-templates-list'] });
    },
  });

  const deprecateMutation = useMutation({
    mutationFn: (versionId: string) =>
      api.patch(`/platform/templates/${templateId}/versions/${versionId}/deprecate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-template-detail', templateId] });
    },
  });

  if (isLoading) return <div className="px-4 py-3 text-sm text-text-muted">Loading template...</div>;
  if (!data) return null;

  const versions = data.versions ?? [];

  return (
    <div className="px-6 py-4 bg-surface-secondary/50 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium">{data.displayName}</h3>
          <p className="text-xs text-text-muted">Current: v{data.currentVersion} | {versions.length} version(s)</p>
        </div>
        <button
          onClick={() => setShowCreateForm(true)}
          className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" /> New Version
        </button>
      </div>

      {showCreateForm && (
        <CreateVersionForm templateId={templateId} onClose={() => setShowCreateForm(false)} />
      )}

      {publishMutation.isError && (
        <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-2 rounded">
          {(publishMutation.error as Error).message}
        </div>
      )}

      {publishMutation.isSuccess && (
        <div className="text-sm text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 p-2 rounded flex items-center gap-2">
          <CheckCircle className="h-4 w-4" /> Version published successfully
        </div>
      )}

      <div className="space-y-2">
        {versions.map((v) => (
          <div key={v.id} className="border border-border rounded-lg p-3 bg-surface">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-medium">v{v.version}</span>
                <VersionStatusBadge status={v.status} />
                {v.isLatest && (
                  <span className="text-xs px-1.5 py-0.5 bg-primary/10 text-primary rounded">latest</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {v.status === 'draft' && (
                  <>
                    <button
                      onClick={() => validateMutation.mutate(v.id)}
                      disabled={validateMutation.isPending}
                      className="p-1.5 rounded hover:bg-surface-secondary text-text-muted hover:text-text-primary"
                      title="Validate"
                    >
                      <AlertCircle className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Publish version ${v.version}?`)) {
                          publishMutation.mutate(v.id);
                        }
                      }}
                      disabled={publishMutation.isPending}
                      className="p-1.5 rounded hover:bg-green-100 dark:hover:bg-green-900/30 text-text-muted hover:text-green-600"
                      title="Publish"
                    >
                      <Play className="h-4 w-4" />
                    </button>
                  </>
                )}
                {v.status === 'published' && !v.isLatest && (
                  <button
                    onClick={() => {
                      if (confirm(`Deprecate version ${v.version}?`)) {
                        deprecateMutation.mutate(v.id);
                      }
                    }}
                    disabled={deprecateMutation.isPending}
                    className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-text-muted hover:text-red-600"
                    title="Deprecate"
                  >
                    <Archive className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
            {v.changelog && (
              <p className="text-xs text-text-muted mt-1">{v.changelog}</p>
            )}
            <p className="text-xs text-text-muted mt-1">
              {v.status === 'draft' ? 'Not yet published' : `Published: ${new Date(v.publishedAt).toLocaleDateString()}`}
            </p>

            {validationResults[v.id] && (
              <div className="mt-2 border-t border-border pt-2 space-y-1">
                <div className="flex items-center gap-1 text-xs font-medium">
                  {validationResults[v.id].valid ? (
                    <><CheckCircle className="h-3.5 w-3.5 text-green-500" /> Validation passed</>
                  ) : (
                    <><AlertCircle className="h-3.5 w-3.5 text-red-500" /> Validation failed</>
                  )}
                </div>
                {validationResults[v.id].checks.map((check, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className={check.passed ? 'text-green-500' : 'text-red-500'}>
                      {check.passed ? '\u2713' : '\u2717'}
                    </span>
                    <span className="text-text-muted">{check.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {versions.length === 0 && (
          <p className="text-sm text-text-muted text-center py-4">No versions created yet</p>
        )}
      </div>
    </div>
  );
}

interface ConnectorHealthRow {
  integrationId: string;
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  connectorType: string;
  provider: string;
  name: string | null;
  isEnabled: boolean;
  lastSyncStatus: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  lastSyncErrorAt: string | null;
  authAlertSentAt: string | null;
  recoveryAlertSentAt: string | null;
  updatedAt: string | null;
  refreshable?: boolean;
}

interface ConnectorRefreshFailure {
  id: string;
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  integrationId: string | null;
  provider: string | null;
  errorMessage: string | null;
  occurredAt: string;
}

type ConnectorTokenHealthStatus =
  | 'healthy'
  | 'expiring'
  | 'expired'
  | 'needs_reconnect'
  | 'unknown';

interface ConnectorTokenHealthRow {
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  integrationId: string;
  integrationType: string;
  provider: string;
  name: string | null;
  lastSyncStatus: string | null;
  lastSyncAt: string | null;
  lastSyncErrorAt: string | null;
  tokenIssuedAt: string | null;
  tokenExpiresAt: string | null;
  tokenDecryptFailed: boolean;
  status: ConnectorTokenHealthStatus;
  expiresInMs: number | null;
  cyclesSinceRefresh: number | null;
  stale: boolean;
}

interface ConnectorExpiringSoonRow {
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  integrationId: string;
  integrationType: string;
  provider: string;
  name: string | null;
  lastSyncStatus: string | null;
  lastSyncAt: string | null;
  tokenIssuedAt: string | null;
  tokenExpiresAt: string | null;
  expiresInMs: number;
}

interface StuckOutboxEventRow {
  id: string;
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  integrationId: string | null;
  integrationProvider: string | null;
  integrationName: string | null;
  integrationType: string | null;
  eventType: string;
  status: 'failed' | 'dead_letter';
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

interface StuckOutboxSummary {
  failed: number;
  deadLetter: number;
  affectedTenants: number;
}

interface ConnectorHealthResponse {
  connectors: ConnectorHealthRow[];
  recentRefreshFailures: ConnectorRefreshFailure[];
  summary: {
    needsReconnect: number;
    syncError: number;
    healthy: number;
    totalEnabled: number;
    affectedTenants: number;
    expiringSoon?: number;
  };
  tokenHealth?: ConnectorTokenHealthRow[];
  tokenHealthRefreshIntervalMs?: number;
  tokenHealthExpiringHorizonMs?: number;
  tokenHealthStaleCycleThreshold?: number;
  expiringSoon?: ConnectorExpiringSoonRow[];
  expiringSoonWindowMs?: number;
  expiringSoonWithinHours?: number;
  stuckOutboxEvents?: StuckOutboxEventRow[];
  stuckOutboxSummary?: StuckOutboxSummary;
  stuckOutboxLimit?: number;
  window: {
    sinceDays: number;
    eventsLimit: number;
    expiringWithinHours?: number;
    stuckOutboxLimit?: number;
  };
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHr / 24);
  if (Number.isNaN(date.getTime())) return '—';
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function ConnectorHealthPanel() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['platform-connector-health'],
    queryFn: () => api.get<ConnectorHealthResponse>('/platform/connector-health'),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center text-text-muted">
        Loading connector health…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center text-red-600 dark:text-red-400">
        Failed to load connector health: {error ? (error as Error).message : 'no data'}
      </div>
    );
  }

  const {
    connectors,
    recentRefreshFailures,
    summary,
    window,
    tokenHealth,
    tokenHealthRefreshIntervalMs,
    tokenHealthExpiringHorizonMs,
    tokenHealthStaleCycleThreshold,
    expiringSoon,
    expiringSoonWindowMs,
    expiringSoonWithinHours,
    stuckOutboxEvents,
    stuckOutboxSummary,
  } = data;
  const reconnectConnectors = connectors.filter((c) => c.lastSyncStatus === 'needs_reconnect');
  const erroredConnectors = connectors.filter((c) => c.lastSyncStatus === 'error');
  const expiringSoonRows = expiringSoon ?? [];
  // Default 48h matches the backend default so the UI heading is sensible
  // even when older payloads omit the explicit window.
  const expiringSoonHours =
    expiringSoonWithinHours
    ?? (expiringSoonWindowMs ? Math.round(expiringSoonWindowMs / (60 * 60 * 1000)) : 48);
  const expiringSoonCount = summary.expiringSoon ?? expiringSoonRows.length;
  const stuckRows = stuckOutboxEvents ?? [];
  const stuckSummary = stuckOutboxSummary ?? {
    failed: 0,
    deadLetter: 0,
    affectedTenants: 0,
  };
  const stuckTotal = stuckSummary.failed + stuckSummary.deadLetter;

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-border rounded-xl p-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-primary" /> Connector Health
          </h2>
          <p className="text-xs text-text-muted mt-1">
            Cross-tenant view of connectors that need a reconnect or are failing to sync, plus
            recent proactive token-refresh failures from the background sweep.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="p-1.5 rounded hover:bg-surface-secondary text-text-muted hover:text-text-primary disabled:opacity-50"
          title="Refresh"
        >
          <RotateCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <div className="bg-surface border border-border rounded-xl p-3">
          <div className="text-xs text-text-muted">Reconnect needed</div>
          <div className={`text-2xl font-bold ${summary.needsReconnect > 0 ? 'text-amber-600 dark:text-amber-400' : ''}`}>
            {summary.needsReconnect}
          </div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-3">
          <div className="text-xs text-text-muted">Sync errors</div>
          <div className={`text-2xl font-bold ${summary.syncError > 0 ? 'text-red-600 dark:text-red-400' : ''}`}>
            {summary.syncError}
          </div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-3">
          <div className="text-xs text-text-muted" title={`Healthy connectors expiring in the next ${expiringSoonHours}h`}>
            Expiring soon
          </div>
          <div className={`text-2xl font-bold ${expiringSoonCount > 0 ? 'text-amber-600 dark:text-amber-400' : ''}`}>
            {expiringSoonCount}
          </div>
          <div className="text-xs text-text-muted mt-0.5">in {expiringSoonHours}h</div>
        </div>
        <div
          className="bg-surface border border-border rounded-xl p-3"
          title="Outbox events parked in failed/dead_letter — see the Stuck connector messages panel below"
        >
          <div className="text-xs text-text-muted">Stuck outbox</div>
          <div className={`text-2xl font-bold ${stuckTotal > 0 ? 'text-red-600 dark:text-red-400' : ''}`}>
            {stuckTotal}
          </div>
          <div className="text-xs text-text-muted mt-0.5">
            {stuckSummary.deadLetter} dead · {stuckSummary.failed} retrying
          </div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-3">
          <div className="text-xs text-text-muted">Healthy</div>
          <div className="text-2xl font-bold text-green-600 dark:text-green-400">{summary.healthy}</div>
          <div className="text-xs text-text-muted mt-0.5">of {summary.totalEnabled} enabled</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-3">
          <div className="text-xs text-text-muted">Affected tenants</div>
          <div className="text-2xl font-bold">{summary.affectedTenants}</div>
        </div>
      </div>

      <ConnectorAttentionTable
        title="Reconnect needed"
        emptyText="No connectors are flagged as needing a reconnect. All OAuth tokens look healthy."
        rows={reconnectConnectors}
        accent="amber"
      />

      <ConnectorAttentionTable
        title="Sync errors"
        emptyText="No connectors are currently in a sync-error state."
        rows={erroredConnectors}
        accent="red"
      />

      <ConnectorExpiringSoonTable
        rows={expiringSoonRows}
        windowHours={expiringSoonHours}
      />

      <StuckOutboxEventsPanel rows={stuckRows} summary={stuckSummary} />

      <VerifiedCallerHealthPanel />

      <ConnectorTokenHealthPanel
        rows={tokenHealth ?? []}
        refreshIntervalMs={tokenHealthRefreshIntervalMs ?? 15 * 60 * 1000}
        expiringHorizonMs={tokenHealthExpiringHorizonMs ?? 24 * 60 * 60 * 1000}
        staleCycleThreshold={tokenHealthStaleCycleThreshold ?? 2}
      />

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              Recent token refresh failures
            </h3>
            <p className="text-xs text-text-muted mt-0.5">
              From <code className="font-mono">connector.token_refresh_failed</code> audit events in the last {window.sinceDays} days.
            </p>
          </div>
        </div>
        {recentRefreshFailures.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-text-muted">
            No proactive token refresh failures in the last {window.sinceDays} days.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="text-left px-4 py-2 font-medium text-text-muted">When</th>
                  <th className="text-left px-4 py-2 font-medium text-text-muted">Tenant</th>
                  <th className="text-left px-4 py-2 font-medium text-text-muted">Provider</th>
                  <th className="text-left px-4 py-2 font-medium text-text-muted">Error</th>
                </tr>
              </thead>
              <tbody>
                {recentRefreshFailures.map((ev) => (
                  <tr key={ev.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 text-xs text-text-muted whitespace-nowrap">
                      <span title={new Date(ev.occurredAt).toLocaleString()}>
                        {formatRelativeTime(ev.occurredAt)}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <div className="font-medium">{ev.tenantName ?? '—'}</div>
                      {ev.tenantSlug && (
                        <div className="text-text-muted font-mono">{ev.tenantSlug}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs font-medium capitalize">{ev.provider ?? '—'}</td>
                    <td className="px-4 py-2 text-xs text-red-600 dark:text-red-400 font-mono break-all max-w-[420px]">
                      {ev.errorMessage ?? '—'}
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

// ----------------------------------------------------------------------------
// Verified caller health (cross-tenant view of expiring / expired / revoked
// outbound caller IDs surfaced from the weekly health scheduler).
// ----------------------------------------------------------------------------

type VerifiedCallerHealthStatus = 'expiring_soon' | 'expired' | 'revoked';

interface VerifiedCallerHealthRow {
  id: string;
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  phoneNumber: string;
  friendlyName: string | null;
  status: VerifiedCallerHealthStatus;
  daysRemaining: number | null;
  expiresAt: string | null;
  lastHealthCheckAt: string | null;
  lastHealthMessage: string | null;
  expiryAlertSentAt: string | null;
}

interface VerifiedCallerHealthResponse {
  callers: VerifiedCallerHealthRow[];
  summary: {
    revoked: number;
    expired: number;
    expiringSoon: number;
    total: number;
    affectedTenants: number;
  };
  limit: number;
}

function verifiedCallerStatusBadge(status: VerifiedCallerHealthStatus): {
  label: string;
  classes: string;
} {
  switch (status) {
    case 'revoked':
      return {
        label: 'Revoked',
        classes:
          'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 border border-red-200 dark:border-red-800',
      };
    case 'expired':
      return {
        label: 'Expired',
        classes:
          'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 border border-red-200 dark:border-red-800',
      };
    case 'expiring_soon':
      return {
        label: 'Expiring soon',
        classes:
          'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border border-amber-200 dark:border-amber-800',
      };
  }
}

/**
 * Render the days-remaining cell. Negative numbers (already expired) read
 * as "expired N days ago", `null` (no `expires_at` — typical for
 * `revoked`) reads as an em-dash with a tooltip.
 */
function VerifiedCallerDaysCell({
  status,
  daysRemaining,
}: {
  status: VerifiedCallerHealthStatus;
  daysRemaining: number | null;
}) {
  if (daysRemaining === null) {
    return (
      <span
        className="text-text-muted"
        title="No expiry timestamp available — typical for revoked callers."
      >
        —
      </span>
    );
  }
  if (daysRemaining < 0) {
    const ago = Math.abs(daysRemaining);
    return (
      <span className="text-red-600 dark:text-red-400 font-medium">
        Expired {ago}d ago
      </span>
    );
  }
  if (daysRemaining === 0) {
    return (
      <span className="text-red-600 dark:text-red-400 font-medium">
        Expires today
      </span>
    );
  }
  const tone =
    status === 'expiring_soon' && daysRemaining <= 7
      ? 'text-amber-700 dark:text-amber-300 font-medium'
      : 'text-text-primary';
  return <span className={tone}>{daysRemaining}d</span>;
}

function VerifiedCallerHealthPanel() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['platform-verified-caller-health'],
    queryFn: () => api.get<VerifiedCallerHealthResponse>('/platform/verified-caller-health'),
    refetchInterval: 60_000,
  });

  // Client-side sort toggle on the days-remaining column. Default is
  // ascending (most urgent first), matching the server's default order.
  // Clicking the header flips between asc / desc so an admin can also
  // see "least urgent first" without paginating.
  const [daysSort, setDaysSort] = useState<'asc' | 'desc'>('asc');

  const reissueAlert = useMutation({
    mutationFn: async (row: VerifiedCallerHealthRow) =>
      api.post<{ ok: boolean; message: string; status: string; emailedRecipients: number }>(
        `/platform/verified-caller-health/${row.tenantId}/${row.id}/alert`,
        {},
      ),
    onSuccess: (resp) => {
      window.alert(resp.message ?? 'Verified caller alert re-issued.');
      queryClient.invalidateQueries({ queryKey: ['platform-verified-caller-health'] });
    },
    onError: (err) => {
      window.alert(`Failed to re-issue alert: ${(err as Error).message}`);
    },
  });

  const baseCallers = data?.callers ?? [];
  const summary = data?.summary;

  // Sort by days-remaining with the same urgency rules the server uses
  // when sorting ascending (revoked first, then null expires_at, then
  // numeric). Descending is the literal reverse so least-urgent rows
  // bubble to the top.
  const sortKey = (r: VerifiedCallerHealthRow): number => {
    if (r.status === 'revoked') return -Number.MAX_SAFE_INTEGER;
    if (r.daysRemaining === null) return -Number.MAX_SAFE_INTEGER + 1;
    return r.daysRemaining;
  };
  const callers = [...baseCallers].sort((a, b) => {
    const diff = sortKey(a) - sortKey(b);
    return daysSort === 'asc' ? diff : -diff;
  });

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <PhoneOff className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            Verified caller health
            <span
              className={`ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                callers.length > 0
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                  : 'bg-surface-secondary text-text-muted border border-border'
              }`}
            >
              {callers.length}
            </span>
          </h3>
          <p className="text-xs text-text-muted mt-0.5">
            Cross-tenant view of verified outbound caller IDs that are about to expire,
            already expired, or were revoked by Twilio. Sourced from the weekly health
            scheduler.
          </p>
          {summary && summary.total > 0 && (
            <p className="text-xs text-text-muted mt-1">
              <span className="text-red-600 dark:text-red-400 font-medium">
                {summary.revoked} revoked
              </span>{' '}
              ·{' '}
              <span className="text-red-600 dark:text-red-400 font-medium">
                {summary.expired} expired
              </span>{' '}
              ·{' '}
              <span className="text-amber-700 dark:text-amber-300 font-medium">
                {summary.expiringSoon} expiring soon
              </span>{' '}
              · {summary.affectedTenants} tenant{summary.affectedTenants === 1 ? '' : 's'} affected
            </p>
          )}
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="p-1.5 rounded hover:bg-surface-secondary text-text-muted hover:text-text-primary disabled:opacity-50"
          title="Refresh"
        >
          <RotateCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {isLoading ? (
        <div className="px-4 py-6 text-center text-sm text-text-muted">
          Loading verified caller health…
        </div>
      ) : error ? (
        <div className="px-4 py-6 text-center text-sm text-red-600 dark:text-red-400">
          Failed to load verified caller health: {(error as Error).message}
        </div>
      ) : callers.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-text-muted">
          No verified callers are flagged as expiring, expired, or revoked. All tenants are healthy.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-2 font-medium text-text-muted">Tenant</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Phone number</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Status</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">
                  <button
                    type="button"
                    onClick={() => setDaysSort((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
                    className="inline-flex items-center gap-1 hover:text-text-primary focus:outline-none focus:ring-1 focus:ring-border rounded"
                    aria-label={`Sort by days remaining, currently ${daysSort === 'asc' ? 'ascending (most urgent first)' : 'descending (least urgent first)'}. Click to toggle.`}
                  >
                    Days remaining
                    <span aria-hidden="true">{daysSort === 'asc' ? '↑' : '↓'}</span>
                  </button>
                </th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Last check</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {callers.map((row) => {
                const badge = verifiedCallerStatusBadge(row.status);
                const isPending =
                  reissueAlert.isPending && reissueAlert.variables?.id === row.id;
                return (
                  <tr key={row.id} className="border-b border-border last:border-0 align-top">
                    <td className="px-4 py-2 text-xs">
                      <div className="font-medium">{row.tenantName ?? '—'}</div>
                      {row.tenantSlug && (
                        <div className="text-text-muted font-mono">{row.tenantSlug}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <div className="font-mono">{row.phoneNumber}</div>
                      {row.friendlyName && (
                        <div className="text-text-muted">{row.friendlyName}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${badge.classes}`}
                      >
                        {badge.label}
                      </span>
                      {row.lastHealthMessage && (
                        <div
                          className="text-text-muted mt-1 max-w-[260px] truncate"
                          title={row.lastHealthMessage}
                        >
                          {row.lastHealthMessage}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs whitespace-nowrap">
                      <VerifiedCallerDaysCell
                        status={row.status}
                        daysRemaining={row.daysRemaining}
                      />
                      {row.expiresAt && (
                        <div className="text-text-muted">
                          {new Date(row.expiresAt).toLocaleDateString()}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-text-muted whitespace-nowrap">
                      <span title={row.lastHealthCheckAt ?? undefined}>
                        {formatRelativeTime(row.lastHealthCheckAt)}
                      </span>
                      {row.expiryAlertSentAt && (
                        <div
                          className="text-text-muted mt-0.5"
                          title={`Last alert sent ${new Date(row.expiryAlertSentAt).toLocaleString()}`}
                        >
                          Alerted {formatRelativeTime(row.expiryAlertSentAt)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <button
                        onClick={() => {
                          if (
                            window.confirm(
                              `Re-issue alert email + in-app notification for ${row.phoneNumber} to ${row.tenantName ?? 'this tenant'}?`,
                            )
                          ) {
                            reissueAlert.mutate(row);
                          }
                        }}
                        disabled={isPending}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-surface hover:bg-surface-secondary text-text-primary text-xs disabled:opacity-50"
                        title="Send the verified-caller alert email to the tenant's admins again, even if one was already sent this week"
                      >
                        <Send className="h-3 w-3" />
                        {isPending ? 'Sending…' : 'Re-issue alert'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Build the same tenant-scoped admin deep link the reconnect/sync-error
 * tables use, so all three "open tenant" affordances behave identically.
 */
function buildTenantConnectorHref(
  tenantId: string,
  integrationId: string,
  tenantSlug: string | null,
): string {
  // Tenant-scoped, read-only connector view for platform admins. The link
  // lands on `/admin/analytics/tenants/:tenantId/connectors`, which is
  // backed by the platform-admin endpoint
  // `GET /platform/tenants/:tenantId/connectors` — no impersonation token
  // swap required, and every load is recorded in `audit_logs`. The
  // `integration` query param tells the landing page which row to scroll
  // to and highlight; `slug` is carried along as a breadcrumb hint for
  // support links/previews. Shared between the Connector Health and
  // Expiring soon tables so URL formatting only lives in one place.
  return (
    `/admin/analytics/tenants/${encodeURIComponent(tenantId)}/connectors` +
    `?integration=${encodeURIComponent(integrationId)}` +
    (tenantSlug ? `&slug=${encodeURIComponent(tenantSlug)}` : '')
  );
}

/**
 * Proactive triage table for connectors whose OAuth token is still valid
 * but expires within the configured window (default 48h). Lets ops nudge
 * customers before the worker actually starts failing.
 */
function ConnectorExpiringSoonTable({
  rows,
  windowHours,
}: {
  rows: ConnectorExpiringSoonRow[];
  windowHours: number;
}) {
  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            Expiring soon
            <span
              className={`ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                rows.length > 0
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                  : 'bg-surface-secondary text-text-muted border border-border'
              }`}
            >
              {rows.length}
            </span>
          </h3>
          <p className="text-xs text-text-muted mt-0.5">
            Healthy OAuth connectors whose token expires in the next {windowHours}h. Reconnect proactively
            to avoid downtime when the background sweep would otherwise fail.
          </p>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-text-muted">
          No healthy connectors are within {windowHours}h of token expiry. Ops queue is clear.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-2 font-medium text-text-muted">Tenant</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Connector</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Last refresh</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Expires</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const href = buildTenantConnectorHref(r.tenantId, r.integrationId, r.tenantSlug);
                return (
                  <tr key={r.integrationId} className="border-b border-border last:border-0 align-top">
                    <td className="px-4 py-2 text-xs">
                      <div className="font-medium">{r.tenantName ?? '—'}</div>
                      {r.tenantSlug && (
                        <div className="text-text-muted font-mono">{r.tenantSlug}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <div className="font-medium capitalize">{r.name ?? r.provider}</div>
                      <div className="text-text-muted">
                        <span className="capitalize">{r.integrationType}</span>
                        {r.provider && r.provider !== r.name && (
                          <span className="font-mono"> · {r.provider}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-xs whitespace-nowrap">
                      <div
                        className="text-text-muted"
                        title={r.tokenIssuedAt ? new Date(r.tokenIssuedAt).toLocaleString() : 'never'}
                      >
                        {formatRelativeTime(r.tokenIssuedAt)}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-xs whitespace-nowrap">
                      <div
                        className="text-amber-700 dark:text-amber-300 font-medium"
                        title={r.tokenExpiresAt ? new Date(r.tokenExpiresAt).toLocaleString() : 'unknown'}
                      >
                        {formatExpiresIn(r.expiresInMs)}
                      </div>
                      {r.tokenExpiresAt && (
                        <div className="text-text-muted text-[10px] mt-0.5">
                          {new Date(r.tokenExpiresAt).toLocaleString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-surface-secondary hover:bg-surface text-text-primary text-xs"
                        title="Open the tenant's Connectors page in a new tab"
                      >
                        <ExternalLink className="h-3 w-3" /> Open tenant connectors
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ConnectorAttentionTable({
  title,
  emptyText,
  rows,
  accent,
}: {
  title: string;
  emptyText: string;
  rows: ConnectorHealthRow[];
  accent: 'amber' | 'red';
}) {
  const accentClasses = accent === 'amber'
    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
    : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h3 className="font-semibold text-sm">
          {title}{' '}
          <span className={`ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${accentClasses}`}>
            {rows.length}
          </span>
        </h3>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-text-muted">{emptyText}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-2 font-medium text-text-muted">Tenant</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Connector</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Last sync</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">First failed</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Last error</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Alerts</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <ConnectorAttentionRow key={c.integrationId} row={c} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ConnectorAttentionRow({ row: c }: { row: ConnectorHealthRow }) {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  const refreshMutation = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; message?: string; error?: string }>(
        `/platform/connector-health/integrations/${c.tenantId}/${c.integrationId}/refresh`,
        {},
      ),
    onSuccess: (data) => {
      setFeedback({ kind: 'success', message: data.message ?? 'Token refresh succeeded.' });
      queryClient.invalidateQueries({ queryKey: ['platform-connector-health'] });
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      setFeedback({ kind: 'error', message: detail || 'Refresh failed.' });
    },
  });

  const alertMutation = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; message?: string; emailedRecipients?: number; status?: string; error?: string }>(
        `/platform/connector-health/integrations/${c.tenantId}/${c.integrationId}/alert`,
        {},
      ),
    onSuccess: (data) => {
      setFeedback({ kind: 'success', message: data.message ?? 'Reconnect email re-issued.' });
      queryClient.invalidateQueries({ queryKey: ['platform-connector-health'] });
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      setFeedback({ kind: 'error', message: detail || 'Failed to re-issue reconnect email.' });
    },
  });

  const truncated = c.lastSyncError && c.lastSyncError.length > 140
    ? `${c.lastSyncError.slice(0, 140)}…`
    : c.lastSyncError;
  // Backend supplies `refreshable` (computed from the same isRefreshableProvider
  // helper the POST /refresh endpoint uses), so the UI doesn't need its own
  // provider list. Default to true on older payloads — the server-side
  // endpoint will return a clean 400 for non-refreshable providers anyway.
  const refreshable = c.refreshable ?? true;
  const refreshing = refreshMutation.isPending;
  const alerting = alertMutation.isPending;
  // Tenant-scoped, read-only connector view for platform admins. URL
  // formatting is centralized in `buildTenantConnectorHref` so this and the
  // Expiring soon table both land on the same audit-logged page.
  const openTenantConnectorsHref = buildTenantConnectorHref(c.tenantId, c.integrationId, c.tenantSlug);

  return (
    <tr className="border-b border-border last:border-0 align-top">
      <td className="px-4 py-2 text-xs">
        <div className="font-medium">{c.tenantName ?? '—'}</div>
        {c.tenantSlug && (
          <div className="text-text-muted font-mono">{c.tenantSlug}</div>
        )}
      </td>
      <td className="px-4 py-2 text-xs">
        <div className="font-medium capitalize">{c.name ?? c.provider}</div>
        <div className="text-text-muted">
          <span className="capitalize">{c.connectorType}</span>
          {c.provider && c.provider !== c.name && (
            <span className="font-mono"> · {c.provider}</span>
          )}
        </div>
      </td>
      <td className="px-4 py-2 text-xs text-text-muted whitespace-nowrap">
        <span title={c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleString() : 'never'}>
          {formatRelativeTime(c.lastSyncAt)}
        </span>
      </td>
      <td className="px-4 py-2 text-xs text-text-muted whitespace-nowrap">
        <span title={c.lastSyncErrorAt ? new Date(c.lastSyncErrorAt).toLocaleString() : 'never'}>
          {formatRelativeTime(c.lastSyncErrorAt)}
        </span>
      </td>
      <td className="px-4 py-2 text-xs">
        <div
          className="font-mono text-red-600 dark:text-red-400 break-all max-w-[360px]"
          title={c.lastSyncError ?? ''}
        >
          {truncated ?? '—'}
        </div>
      </td>
      <td className="px-4 py-2 text-xs whitespace-nowrap">
        {c.authAlertSentAt ? (
          <span
            className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300"
            title={`Reconnect email sent ${new Date(c.authAlertSentAt).toLocaleString()}`}
          >
            <Mail className="h-3 w-3" /> {formatRelativeTime(c.authAlertSentAt)}
          </span>
        ) : (
          <span className="text-text-muted">No email yet</span>
        )}
      </td>
      <td className="px-4 py-2 text-xs">
        <div className="flex flex-col gap-1.5 min-w-[220px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <a
              href={openTenantConnectorsHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-surface-secondary hover:bg-surface text-text-primary text-xs"
              title="Open the tenant's Connectors page in a new tab"
            >
              <ExternalLink className="h-3 w-3" /> Open tenant connectors
            </a>
            <button
              type="button"
              onClick={() => {
                setFeedback(null);
                refreshMutation.mutate();
              }}
              disabled={refreshing || alerting || !refreshable}
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-surface-secondary hover:bg-surface text-text-primary text-xs disabled:opacity-50 disabled:cursor-not-allowed"
              title={refreshable
                ? 'Force an OAuth token refresh now'
                : `${c.provider} does not support OAuth refresh from this panel`}
            >
              <RotateCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? 'Retrying…' : 'Retry refresh'}
            </button>
            <button
              type="button"
              onClick={() => {
                setFeedback(null);
                alertMutation.mutate();
              }}
              disabled={refreshing || alerting}
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-surface-secondary hover:bg-surface text-text-primary text-xs disabled:opacity-50 disabled:cursor-not-allowed"
              title="Re-issue the reconnect email to tenant admins (bypasses the 24h throttle)"
            >
              <Send className={`h-3 w-3 ${alerting ? 'animate-pulse' : ''}`} />
              {alerting ? 'Sending…' : 'Send email'}
            </button>
          </div>
          {feedback && (
            <div
              className={`text-xs px-2 py-1 rounded border max-w-[320px] break-words ${
                feedback.kind === 'success'
                  ? 'bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-700/50 text-green-800 dark:text-green-200'
                  : 'bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-700/50 text-red-800 dark:text-red-200'
              }`}
              role="status"
            >
              {feedback.message}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

function formatNextAttempt(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const diffMs = date.getTime() - Date.now();
  const absMin = Math.floor(Math.abs(diffMs) / 60_000);
  const absHr = Math.floor(absMin / 60);
  const absDays = Math.floor(absHr / 24);
  let label: string;
  if (absMin < 1) label = 'less than a minute';
  else if (absMin < 60) label = `${absMin}m`;
  else if (absHr < 24) label = `${absHr}h ${absMin - absHr * 60}m`;
  else label = `${absDays}d ${absHr - absDays * 24}h`;
  return diffMs >= 0 ? `in ${label}` : `${label} ago`;
}

function StuckOutboxEventsPanel({
  rows,
  summary,
}: {
  rows: StuckOutboxEventRow[];
  summary: StuckOutboxSummary;
}) {
  const total = summary.failed + summary.deadLetter;
  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />
            Stuck connector messages
            <span
              className={`ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                total > 0
                  ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                  : 'bg-surface-secondary text-text-muted border border-border'
              }`}
            >
              {total}
            </span>
            {summary.deadLetter > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
                {summary.deadLetter} dead-letter
              </span>
            )}
            {summary.failed > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                {summary.failed} retrying
              </span>
            )}
          </h3>
          <p className="text-xs text-text-muted mt-0.5">
            Outbox events the drain worker has parked. Failed rows still have automatic retries
            scheduled; dead-letter rows have hit <code className="font-mono">max_attempts</code>
            and need manual intervention. Retry now requeues the row immediately; Mark resolved
            archives a dead-letter row so it stops surfacing here.
          </p>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-text-muted">
          No outbox events are stuck. The drain worker is keeping up across all tenants.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-2 font-medium text-text-muted">Tenant</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Event</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Status</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Attempts</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Next retry</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Last error</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <StuckOutboxEventRowView key={r.id} row={r} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StuckOutboxEventRowView({ row }: { row: StuckOutboxEventRow }) {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  );

  const retryMutation = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; message?: string; error?: string }>(
        `/platform/connector-health/outbox/${row.tenantId}/${row.id}/retry`,
        {},
      ),
    onSuccess: (data) => {
      setFeedback({ kind: 'success', message: data.message ?? 'Outbox event requeued.' });
      queryClient.invalidateQueries({ queryKey: ['platform-connector-health'] });
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      setFeedback({ kind: 'error', message: detail || 'Failed to requeue outbox event.' });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; message?: string; error?: string }>(
        `/platform/connector-health/outbox/${row.tenantId}/${row.id}/archive`,
        {},
      ),
    onSuccess: (data) => {
      setFeedback({ kind: 'success', message: data.message ?? 'Outbox event archived.' });
      queryClient.invalidateQueries({ queryKey: ['platform-connector-health'] });
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      setFeedback({ kind: 'error', message: detail || 'Failed to archive outbox event.' });
    },
  });

  const truncatedError =
    row.lastError && row.lastError.length > 200
      ? `${row.lastError.slice(0, 200)}…`
      : row.lastError;
  const isDeadLetter = row.status === 'dead_letter';
  const retrying = retryMutation.isPending;
  const archiving = archiveMutation.isPending;
  const integrationLabel =
    row.integrationName ?? row.integrationProvider ?? row.integrationType ?? null;

  return (
    <tr className="border-b border-border last:border-0 align-top">
      <td className="px-4 py-2 text-xs">
        <div className="font-medium">{row.tenantName ?? '—'}</div>
        {row.tenantSlug && (
          <div className="text-text-muted font-mono">{row.tenantSlug}</div>
        )}
      </td>
      <td className="px-4 py-2 text-xs">
        <div className="font-medium font-mono">{row.eventType}</div>
        {integrationLabel && (
          <div className="text-text-muted">
            <span className="capitalize">{integrationLabel}</span>
            {row.integrationProvider
              && row.integrationProvider !== integrationLabel
              && (
                <span className="font-mono"> · {row.integrationProvider}</span>
              )}
          </div>
        )}
      </td>
      <td className="px-4 py-2 text-xs">
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
            isDeadLetter
              ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
              : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
          }`}
        >
          {isDeadLetter ? 'Dead-letter' : 'Failed'}
        </span>
      </td>
      <td className="px-4 py-2 text-xs whitespace-nowrap">
        <span
          className={
            row.attempts >= row.maxAttempts
              ? 'text-red-600 dark:text-red-400 font-medium'
              : 'text-text-primary'
          }
        >
          {row.attempts} / {row.maxAttempts}
        </span>
      </td>
      <td className="px-4 py-2 text-xs whitespace-nowrap">
        {isDeadLetter ? (
          <span className="text-text-muted">no automatic retry</span>
        ) : (
          <span
            className="text-text-muted"
            title={row.nextAttemptAt ? new Date(row.nextAttemptAt).toLocaleString() : 'unknown'}
          >
            {formatNextAttempt(row.nextAttemptAt)}
          </span>
        )}
      </td>
      <td className="px-4 py-2 text-xs text-red-600 dark:text-red-400 font-mono break-all max-w-[360px]">
        {truncatedError ?? '—'}
      </td>
      <td className="px-4 py-2 text-xs">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setFeedback(null);
                retryMutation.mutate();
              }}
              disabled={retrying || archiving}
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-surface-secondary hover:bg-surface text-text-primary text-xs disabled:opacity-50"
              title="Reset status to pending and trigger the drain worker on the next cycle"
            >
              <RotateCw className={`h-3 w-3 ${retrying ? 'animate-spin' : ''}`} />
              Retry now
            </button>
            {isDeadLetter && (
              <button
                type="button"
                onClick={() => {
                  setFeedback(null);
                  archiveMutation.mutate();
                }}
                disabled={archiving || retrying}
                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-surface-secondary hover:bg-surface text-text-primary text-xs disabled:opacity-50"
                title="Archive this dead-letter row so it stops appearing here. The original payload stays in the table for forensics."
              >
                <Archive className="h-3 w-3" />
                Mark resolved
              </button>
            )}
          </div>
          {feedback && (
            <div
              className={`text-[11px] ${
                feedback.kind === 'success'
                  ? 'text-green-700 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              {feedback.message}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

function formatExpiresIn(ms: number | null): string {
  if (ms === null) return 'unknown';
  const abs = Math.abs(ms);
  const min = Math.floor(abs / 60_000);
  const hr = Math.floor(min / 60);
  const days = Math.floor(hr / 24);
  let label: string;
  if (min < 1) label = 'less than a minute';
  else if (min < 60) label = `${min}m`;
  else if (hr < 24) label = `${hr}h ${min - hr * 60}m`;
  else label = `${days}d ${hr - days * 24}h`;
  return ms >= 0 ? `in ${label}` : `${label} ago`;
}

function tokenStatusBadgeClasses(status: ConnectorTokenHealthStatus): string {
  switch (status) {
    case 'healthy':
      return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300';
    case 'expiring':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
    case 'expired':
    case 'needs_reconnect':
      return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
    default:
      return 'bg-surface-secondary text-text-muted border border-border';
  }
}

function tokenStatusLabel(status: ConnectorTokenHealthStatus): string {
  switch (status) {
    case 'healthy': return 'Healthy';
    case 'expiring': return 'Expiring soon';
    case 'expired': return 'Expired';
    case 'needs_reconnect': return 'Reconnect needed';
    default: return 'Unknown';
  }
}

type TokenHealthSortKey = 'expiring' | 'lastRefresh' | 'tenant';
type TokenHealthFilter = 'all' | 'attention' | 'expiring' | 'stale' | 'healthy';

function ConnectorTokenHealthPanel({
  rows,
  refreshIntervalMs,
  expiringHorizonMs,
  staleCycleThreshold,
}: {
  rows: ConnectorTokenHealthRow[];
  refreshIntervalMs: number;
  expiringHorizonMs: number;
  staleCycleThreshold: number;
}) {
  const [sortKey, setSortKey] = useState<TokenHealthSortKey>('expiring');
  const [filter, setFilter] = useState<TokenHealthFilter>('all');

  const filtered = rows.filter((r) => {
    switch (filter) {
      case 'attention':
        return r.status === 'expired' || r.status === 'needs_reconnect' || r.stale;
      case 'expiring':
        return r.status === 'expiring' || r.status === 'expired';
      case 'stale':
        return r.stale;
      case 'healthy':
        return r.status === 'healthy';
      default:
        return true;
    }
  });

  // Sort by "expiring soonest" puts unknown/null expiry at the end so ops
  // see actionable rows first; tenant sort is a stable alphabetical fallback.
  const sorted = [...filtered].sort((a, b) => {
    if (sortKey === 'expiring') {
      const aMs = a.expiresInMs;
      const bMs = b.expiresInMs;
      if (aMs === null && bMs === null) return 0;
      if (aMs === null) return 1;
      if (bMs === null) return -1;
      return aMs - bMs;
    }
    if (sortKey === 'lastRefresh') {
      const aT = a.tokenIssuedAt ? new Date(a.tokenIssuedAt).getTime() : 0;
      const bT = b.tokenIssuedAt ? new Date(b.tokenIssuedAt).getTime() : 0;
      return bT - aT;
    }
    const aName = (a.tenantName ?? a.tenantSlug ?? a.tenantId).toLowerCase();
    const bName = (b.tenantName ?? b.tenantSlug ?? b.tenantId).toLowerCase();
    return aName.localeCompare(bName);
  });

  const expiringSoonCount = rows.filter(
    (r) => r.status === 'expiring' || r.status === 'expired',
  ).length;
  const staleCount = rows.filter((r) => r.stale).length;
  const horizonHours = Math.round(expiringHorizonMs / (60 * 60 * 1000));
  const cycleMinutes = Math.round(refreshIntervalMs / 60_000);

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" /> OAuth token freshness
            <span className="ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-surface-secondary text-text-primary border border-border">
              {rows.length}
            </span>
            {expiringSoonCount > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                {expiringSoonCount} expiring
              </span>
            )}
            {staleCount > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
                {staleCount} stale
              </span>
            )}
          </h3>
          <p className="text-xs text-text-muted mt-0.5">
            Last refresh and next expiry per OAuth connector. Tokens expiring within {horizonHours}h are
            flagged; the worker sweeps every ~{cycleMinutes}m and a row badges as "stale" after{' '}
            {staleCycleThreshold} missed cycles.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="text-text-muted">Filter</label>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as TokenHealthFilter)}
            className="border border-border rounded px-2 py-1 bg-surface text-text-primary"
          >
            <option value="all">All</option>
            <option value="attention">Needs attention</option>
            <option value="expiring">Expiring / expired</option>
            <option value="stale">Stale only</option>
            <option value="healthy">Healthy only</option>
          </select>
          <label className="text-text-muted ml-2">Sort</label>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as TokenHealthSortKey)}
            className="border border-border rounded px-2 py-1 bg-surface text-text-primary"
          >
            <option value="expiring">Expiring soonest</option>
            <option value="lastRefresh">Most recently refreshed</option>
            <option value="tenant">Tenant (A–Z)</option>
          </select>
        </div>
      </div>
      {sorted.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-text-muted">
          {rows.length === 0
            ? 'No OAuth connectors enabled across tenants yet.'
            : 'No connectors match the current filter.'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-2 font-medium text-text-muted">Tenant</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Connector</th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">
                  <button
                    type="button"
                    onClick={() => setSortKey('lastRefresh')}
                    className={`inline-flex items-center gap-1 hover:text-text-primary ${sortKey === 'lastRefresh' ? 'text-text-primary' : ''}`}
                  >
                    Last refresh
                    {sortKey === 'lastRefresh' && <ArrowUpDown className="h-3 w-3" />}
                  </button>
                </th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">
                  <button
                    type="button"
                    onClick={() => setSortKey('expiring')}
                    className={`inline-flex items-center gap-1 hover:text-text-primary ${sortKey === 'expiring' ? 'text-text-primary' : ''}`}
                  >
                    Expires
                    {sortKey === 'expiring' && <ArrowUpDown className="h-3 w-3" />}
                  </button>
                </th>
                <th className="text-left px-4 py-2 font-medium text-text-muted">Status</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.integrationId} className="border-b border-border last:border-0 align-top">
                  <td className="px-4 py-2 text-xs">
                    <div className="font-medium">{r.tenantName ?? '—'}</div>
                    {r.tenantSlug && (
                      <div className="text-text-muted font-mono">{r.tenantSlug}</div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    <div className="font-medium capitalize">{r.name ?? r.provider}</div>
                    <div className="text-text-muted">
                      <span className="capitalize">{r.integrationType}</span>
                      {r.provider && r.provider !== r.name && (
                        <span className="font-mono"> · {r.provider}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-xs whitespace-nowrap">
                    <div
                      className="text-text-muted"
                      title={r.tokenIssuedAt ? new Date(r.tokenIssuedAt).toLocaleString() : 'never'}
                    >
                      {formatRelativeTime(r.tokenIssuedAt)}
                    </div>
                    {r.cyclesSinceRefresh !== null && r.cyclesSinceRefresh > 0 && (
                      <div className="text-text-muted text-[10px] mt-0.5">
                        {r.cyclesSinceRefresh} cycle{r.cyclesSinceRefresh === 1 ? '' : 's'} since refresh
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs whitespace-nowrap">
                    <div
                      className={
                        r.expiresInMs !== null && r.expiresInMs < 0
                          ? 'text-red-600 dark:text-red-400'
                          : r.expiresInMs !== null && r.expiresInMs <= expiringHorizonMs
                            ? 'text-amber-700 dark:text-amber-300'
                            : 'text-text-muted'
                      }
                      title={r.tokenExpiresAt ? new Date(r.tokenExpiresAt).toLocaleString() : 'unknown'}
                    >
                      {formatExpiresIn(r.expiresInMs)}
                    </div>
                    {r.tokenExpiresAt && (
                      <div className="text-text-muted text-[10px] mt-0.5">
                        {new Date(r.tokenExpiresAt).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-1">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${tokenStatusBadgeClasses(r.status)}`}
                      >
                        {tokenStatusLabel(r.status)}
                      </span>
                      {r.stale && (
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                          title={`Worker has missed at least ${staleCycleThreshold} refresh cycle${staleCycleThreshold === 1 ? '' : 's'} for this connector`}
                        >
                          <AlertTriangle className="h-3 w-3" /> Stale
                        </span>
                      )}
                      {r.tokenDecryptFailed && (
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                          title="One or more token tracking fields failed to decrypt — check encryption keys"
                        >
                          <ShieldAlert className="h-3 w-3" /> Decrypt failed
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface CallEventsRetentionRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: 'success' | 'failure';
  retention_days: number;
  ensured_partitions: string[];
  dropped_partitions: string[];
  error_message: string | null;
}

interface CallEventsRetentionPartition {
  name: string;
  lower_bound: string | null;
  upper_bound: string | null;
}

interface CallEventsRetentionResponse {
  retentionDays: number;
  intervalMs: number;
  staleAfterMs: number;
  expected: {
    currentMonthPartition: string;
    nextMonthPartition: string;
  };
  partitions: CallEventsRetentionPartition[];
  partitionsExist: {
    currentMonth: boolean;
    nextMonth: boolean;
  };
  lastRun: CallEventsRetentionRun | null;
  lastSuccessfulRun: CallEventsRetentionRun | null;
  recentRuns: CallEventsRetentionRun[];
  status: {
    healthy: boolean;
    stale: boolean;
    missingNextMonth: boolean;
    lastRunFailed: boolean;
    neverRan: boolean;
    reasons: string[];
  };
}

function formatPartitionDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatRunTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatRelativeAge(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'unknown';
  if (ms < 0) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function CallEventsRetentionPanel() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['platform-call-events-retention'],
    queryFn: () =>
      api.get<CallEventsRetentionResponse>('/platform/call-events-retention'),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center text-text-muted">
        Loading call event retention status...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center text-red-600 dark:text-red-400">
        Failed to load retention status: {error ? (error as Error).message : 'no data'}
      </div>
    );
  }

  const { status, lastRun, lastSuccessfulRun, recentRuns, partitions, expected, partitionsExist } = data;

  const headerToneClass = status.healthy
    ? 'bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-700/50'
    : 'bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-700/50';
  const headerIcon = status.healthy ? (
    <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400" />
  ) : (
    <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
  );
  const headerLabel = status.healthy
    ? 'Retention worker is healthy'
    : 'Retention worker needs attention';

  return (
    <div className="space-y-4">
      <div className={`border rounded-xl p-4 flex items-start justify-between gap-4 ${headerToneClass}`}>
        <div className="flex items-start gap-3 min-w-0">
          <div className="flex-shrink-0 mt-0.5">{headerIcon}</div>
          <div className="min-w-0">
            <h2 className="font-semibold flex items-center gap-2">
              <Database className="h-4 w-4" /> {headerLabel}
            </h2>
            <p className="text-xs text-text-muted mt-1">
              Daily worker keeps the partitioned <code className="font-mono">call_events</code> table inside its{' '}
              {data.retentionDays}-day retention window and pre-creates next month's partition.
            </p>
            {status.reasons.length > 0 && (
              <ul className="mt-2 text-xs text-red-700 dark:text-red-300 list-disc list-inside space-y-0.5">
                {status.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="p-1.5 rounded hover:bg-surface-secondary text-text-muted hover:text-text-primary disabled:opacity-50 flex-shrink-0"
          title="Refresh"
        >
          <RotateCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Clock}
          label="Last successful cycle"
          value={lastSuccessfulRun ? formatRelativeAge(lastSuccessfulRun.finished_at ?? lastSuccessfulRun.started_at) : 'Never'}
          sub={
            lastSuccessfulRun
              ? formatRunTimestamp(lastSuccessfulRun.finished_at ?? lastSuccessfulRun.started_at)
              : 'No cycle on record'
          }
          tone={status.stale ? 'warning' : undefined}
        />
        <StatCard
          icon={Database}
          label="Partitions"
          value={String(partitions.length)}
          sub={`Retention window: ${data.retentionDays} days`}
        />
        <StatCard
          icon={partitionsExist.currentMonth ? CheckCircle : AlertTriangle}
          label="Current month partition"
          value={partitionsExist.currentMonth ? 'Ready' : 'Missing'}
          sub={expected.currentMonthPartition}
          tone={partitionsExist.currentMonth ? undefined : 'warning'}
        />
        <StatCard
          icon={partitionsExist.nextMonth ? CheckCircle : AlertTriangle}
          label="Next month partition"
          value={partitionsExist.nextMonth ? 'Ready' : 'Missing'}
          sub={expected.nextMonthPartition}
          tone={partitionsExist.nextMonth ? undefined : 'warning'}
        />
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="font-semibold text-sm">Current partitions</h3>
          <span className="text-xs text-text-muted">{partitions.length} total</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-2.5 font-medium text-text-muted">Partition</th>
                <th className="text-left px-4 py-2.5 font-medium text-text-muted">Range start</th>
                <th className="text-left px-4 py-2.5 font-medium text-text-muted">Range end (exclusive)</th>
                <th className="text-left px-4 py-2.5 font-medium text-text-muted">Role</th>
              </tr>
            </thead>
            <tbody>
              {partitions.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-center py-8 text-text-muted">
                    No partitions found. The scheduler may not have run yet.
                  </td>
                </tr>
              ) : (
                partitions.map((p) => {
                  const role =
                    p.name === expected.currentMonthPartition
                      ? 'Current month'
                      : p.name === expected.nextMonthPartition
                        ? 'Next month'
                        : '';
                  return (
                    <tr key={p.name} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5 font-mono text-xs">{p.name}</td>
                      <td className="px-4 py-2.5 text-text-muted">{formatPartitionDate(p.lower_bound)}</td>
                      <td className="px-4 py-2.5 text-text-muted">{formatPartitionDate(p.upper_bound)}</td>
                      <td className="px-4 py-2.5">
                        {role && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary">
                            {role}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="font-semibold text-sm">Recent retention cycles</h3>
          <span className="text-xs text-text-muted">Showing last {recentRuns.length}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-2.5 font-medium text-text-muted">Started</th>
                <th className="text-left px-4 py-2.5 font-medium text-text-muted">Status</th>
                <th className="text-left px-4 py-2.5 font-medium text-text-muted">Ensured</th>
                <th className="text-left px-4 py-2.5 font-medium text-text-muted">Dropped</th>
                <th className="text-left px-4 py-2.5 font-medium text-text-muted">Notes</th>
              </tr>
            </thead>
            <tbody>
              {recentRuns.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-8 text-text-muted">
                    No retention cycles have been recorded yet.
                  </td>
                </tr>
              ) : (
                recentRuns.map((run) => (
                  <tr key={run.id} className="border-b border-border last:border-0 align-top">
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <div>{formatRunTimestamp(run.started_at)}</div>
                      <div className="text-xs text-text-muted">{formatRelativeAge(run.started_at)}</div>
                    </td>
                    <td className="px-4 py-2.5">
                      {run.status === 'success' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                          <CheckCircle className="h-3 w-3" /> Success
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                          <XCircle className="h-3 w-3" /> Failure
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {run.ensured_partitions.length === 0 ? (
                        <span className="text-text-muted">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {run.ensured_partitions.map((p) => (
                            <code
                              key={p}
                              className="text-xs font-mono px-2 py-0.5 rounded border bg-surface-hover border-border"
                            >
                              {p}
                            </code>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {run.dropped_partitions.length === 0 ? (
                        <span className="text-text-muted">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {run.dropped_partitions.map((p) => (
                            <code
                              key={p}
                              className="text-xs font-mono px-2 py-0.5 rounded border bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300"
                            >
                              {p}
                            </code>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      {run.error_message ? (
                        <span className="text-red-600 dark:text-red-400 break-words">{run.error_message}</span>
                      ) : (
                        <span className="text-text-muted">{run.retention_days}d window</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {lastRun && lastRun.status === 'failure' && (
          <div className="px-4 py-2.5 border-t border-border bg-red-50 dark:bg-red-900/20 text-xs text-red-700 dark:text-red-300">
            Last cycle failed at {formatRunTimestamp(lastRun.started_at)}. Check server logs for{' '}
            <code className="font-mono">CALL_EVENTS_RETENTION</code>.
          </div>
        )}
      </div>
    </div>
  );
}

interface IntegrationProviderStatus {
  provider: string;
  connectorProvider: string;
  label: string;
  category: string;
  configured: boolean;
  requiredEnv: string[];
  missingEnv: string[];
  optionalEnv: { name: string; set: boolean }[];
  docsUrl: string;
  enabledTenantCount: number;
  totalTenantCount: number;
  attemptedTenantCount: number;
}

interface IntegrationsStatusResponse {
  providers: IntegrationProviderStatus[];
  summary: {
    total: number;
    configured: number;
    missing: number;
    blockedTenantDemand: number;
  };
}

function IntegrationsStatusPanel() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['platform-integrations-status'],
    queryFn: () => api.get<IntegrationsStatusResponse>('/platform/integrations-status'),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center text-text-muted">
        Loading integration status...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center text-red-600 dark:text-red-400">
        Failed to load integration status: {error ? (error as Error).message : 'no data'}
      </div>
    );
  }

  const grouped = data.providers.reduce<Record<string, IntegrationProviderStatus[]>>((acc, p) => {
    (acc[p.category] ||= []).push(p);
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-border rounded-xl p-4 flex items-center justify-between">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            <Plug className="h-4 w-4 text-primary" /> OAuth Integration Credentials
          </h2>
          <p className="text-xs text-text-muted mt-1">
            Server-side check of <code className="font-mono">*_CLIENT_ID</code> /{' '}
            <code className="font-mono">*_CLIENT_SECRET</code> environment variables. No secret values are shown — only whether they are set.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-sm text-text-muted">
            <span className="font-semibold text-green-600 dark:text-green-400">{data.summary.configured}</span>
            {' / '}
            {data.summary.total} configured
          </div>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="p-1.5 rounded hover:bg-surface-secondary text-text-muted hover:text-text-primary disabled:opacity-50"
            title="Refresh"
          >
            <RotateCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {data.summary.missing > 0 && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700/50 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-amber-900 dark:text-amber-200">
            <div className="font-medium">
              {data.summary.missing} provider{data.summary.missing === 1 ? '' : 's'} {data.summary.missing === 1 ? 'is' : 'are'} missing server credentials.
            </div>
            <p className="text-xs mt-1 opacity-80">
              Tenants will see a "not configured" message when they try to connect these providers. Set the listed environment variables and restart the server.
            </p>
            {data.summary.blockedTenantDemand > 0 && (
              <p className="text-xs mt-1 font-medium">
                {data.summary.blockedTenantDemand} tenant{data.summary.blockedTenantDemand === 1 ? '' : 's'}-by-provider
                {' '}signal{data.summary.blockedTenantDemand === 1 ? '' : 's'} of demand on missing providers
                {' '}(a tenant blocked on two providers counts twice). Prioritize the rows with the highest counts below.
              </p>
            )}
          </div>
        </div>
      )}

      {Object.entries(grouped).map(([category, providers]) => (
        <div key={category} className="bg-surface border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-2 bg-surface-secondary/50 border-b border-border">
            <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">{category}</h3>
          </div>
          <div className="divide-y divide-border">
            {[...providers]
              .sort((a, b) => {
                const aDemand = Math.max(a.enabledTenantCount, a.attemptedTenantCount);
                const bDemand = Math.max(b.enabledTenantCount, b.attemptedTenantCount);
                if (a.configured !== b.configured) return a.configured ? 1 : -1;
                return bDemand - aDemand;
              })
              .map((p) => (
              <div key={p.provider} className="px-4 py-4 flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{p.label}</span>
                    {p.configured ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                        <CheckCircle className="h-3 w-3" /> Configured
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                        <XCircle className="h-3 w-3" /> Missing credentials
                      </span>
                    )}
                    {(p.enabledTenantCount > 0 || p.attemptedTenantCount > 0) && (
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                          p.configured
                            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                            : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                        }`}
                        title={
                          p.configured
                            ? `${p.enabledTenantCount} tenant(s) currently enabled; ${p.attemptedTenantCount} have ever connected`
                            : `${p.enabledTenantCount} tenant(s) had this enabled before credentials were removed; ${p.attemptedTenantCount} have ever attempted`
                        }
                      >
                        <Users className="h-3 w-3" />
                        {p.enabledTenantCount} active
                        {p.attemptedTenantCount > p.enabledTenantCount && (
                          <span className="opacity-80">
                            {' '}/ {p.attemptedTenantCount} ever
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {p.requiredEnv.map((env) => {
                      const isMissing = p.missingEnv.includes(env);
                      return (
                        <code
                          key={env}
                          className={`text-xs font-mono px-2 py-0.5 rounded border ${
                            isMissing
                              ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800'
                              : 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800'
                          }`}
                          title={isMissing ? 'Not set in environment' : 'Set in environment'}
                        >
                          {env}
                        </code>
                      );
                    })}
                  </div>
                  {p.optionalEnv.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5 items-center">
                      <span className="text-xs text-text-muted">Optional:</span>
                      {p.optionalEnv.map((env) => (
                        <code
                          key={env.name}
                          className={`text-xs font-mono px-2 py-0.5 rounded border ${
                            env.set
                              ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800'
                              : 'bg-surface-hover text-text-muted border-border'
                          }`}
                          title={env.set ? 'Set in environment' : 'Not set (uses default)'}
                        >
                          {env.name}
                        </code>
                      ))}
                    </div>
                  )}
                </div>
                <a
                  href={p.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium text-primary hover:underline whitespace-nowrap flex items-center gap-1 flex-shrink-0"
                >
                  <BookOpen className="h-3.5 w-3.5" /> Setup guide
                </a>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

type PlatformAdminTab =
  | 'tenants'
  | 'templates'
  | 'analytics'
  | 'cost-monitoring'
  | 'activation'
  | 'docs-feedback'
  | 'support'
  | 'integrations'
  | 'connector-health'
  | 'retention';

const PLATFORM_ADMIN_TABS: { key: PlatformAdminTab; label: string; icon: typeof Building2 }[] = [
  { key: 'tenants', label: 'Tenants', icon: Building2 },
  { key: 'templates', label: 'Template Versions', icon: Package },
  { key: 'analytics', label: 'Template Analytics', icon: BarChart3 },
  { key: 'cost-monitoring', label: 'Cost Monitoring', icon: DollarSign },
  { key: 'activation', label: 'Activation', icon: Activity },
  { key: 'docs-feedback', label: 'Docs Feedback', icon: BookOpen },
  { key: 'support', label: 'Support', icon: LifeBuoy },
  { key: 'integrations', label: 'Integrations', icon: Plug },
  { key: 'connector-health', label: 'Connector Health', icon: ShieldAlert },
  { key: 'retention', label: 'Call Event Retention', icon: Database },
];

export default function PlatformAdmin() {
  const { t: adminT } = useTranslation('admin');
  const queryClient = useQueryClient();
  const [expandedTenant, setExpandedTenant] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<PlatformAdminTab>('tenants');
  const [expandedTemplate, setExpandedTemplate] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>('totalInstalls');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ['platform-stats'],
    queryFn: () => api.get<{ stats: PlatformStats }>('/platform/stats'),
    refetchInterval: 60_000,
  });

  // Counter for the platform-wide hard-bounce dedup table. Refreshed at the
  // same cadence as the rest of the dashboard cards so the 7d / 30d windows
  // stay current without the admin having to reload. Failures here must not
  // hide the rest of the dashboard, so the card just shows "—" if the query
  // errors and the rest of the page renders unaffected.
  const { data: bouncedStats, isLoading: bouncedStatsLoading } = useQuery({
    queryKey: ['support-bounced-recipient-stats'],
    queryFn: () =>
      api.get<BouncedRecipientStats>('/support/replies/bounced-recipients/stats'),
    refetchInterval: 60_000,
  });

  const { data: tenantsData, isLoading: tenantsLoading } = useQuery({
    queryKey: ['platform-tenants'],
    queryFn: () => api.get<{ tenants: Tenant[] }>('/platform/tenants'),
    refetchInterval: 60_000,
  });

  const { data: templatesData, isLoading: templatesLoading } = useQuery({
    queryKey: ['platform-templates-list'],
    queryFn: () => api.get<{ templates: TemplateListItem[] }>('/marketplace/templates?status=active&limit=100'),
    enabled: activeTab === 'templates',
  });

  const { data: analyticsData, isLoading: analyticsLoading } = useQuery({
    queryKey: ['platform-template-analytics'],
    queryFn: () => api.get<{ templates: TemplateAnalytics[] }>('/platform/template-analytics'),
    enabled: activeTab === 'analytics',
    refetchInterval: 60_000,
  });

  const { data: costData, isLoading: costLoading } = useQuery({
    queryKey: ['platform-cost-monitoring'],
    queryFn: () => api.get<{ monitoring: CostMonitoringData }>('/platform/cost-monitoring'),
    enabled: activeTab === 'cost-monitoring',
    refetchInterval: 30_000,
  });

  const { data: activationData, isLoading: activationLoading } = useQuery({
    queryKey: ['platform-activation-metrics'],
    queryFn: () => api.get<{ metrics: ActivationMetricRow[] }>('/platform/activation-metrics'),
    enabled: activeTab === 'activation',
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
      <PageHeader
        title={adminT('platform_admin.page_title')}
        description={adminT('platform_admin.page_subtitle')}
        icon={<Building2 className="h-5 w-5" />}
        className="mb-0"
      />

      <OperationsAlertsBanner />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
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
        {/* Platform-wide hard-bounce dedup table size. Click jumps to the
            Support Inbox tab and scrolls to the BouncedRecipientsPanel so the
            admin can drill into the offending addresses. The 7d / 30d sub-line
            is what makes this a useful sender-reputation tripwire — a sudden
            jump in the 7d window is the signal worth paging on. */}
        <StatCard
          icon={ShieldAlert}
          label="Recipients ever hard-bounced"
          value={
            bouncedStatsLoading
              ? '...'
              : String(bouncedStats?.total ?? 0)
          }
          sub={
            bouncedStatsLoading
              ? ''
              : `+${bouncedStats?.last_7d ?? 0} in 7d · +${bouncedStats?.last_30d ?? 0} in 30d`
          }
          tone={
            !bouncedStatsLoading && (bouncedStats?.last_7d ?? 0) > 0
              ? 'warning'
              : undefined
          }
          onClick={() => {
            setActiveTab('support');
            // Defer the scroll until after the tab swap has rendered the
            // panel — the support inbox isn't mounted on other tabs, so
            // getElementById would otherwise return null on the first click
            // from a non-support tab.
            requestAnimationFrame(() => {
              setTimeout(() => {
                document
                  .getElementById('bounced-recipients-panel')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }, 0);
            });
          }}
        />
      </div>

      <div
        role="tablist"
        aria-label="Platform admin sections"
        className="flex flex-wrap gap-1 border-b border-border overflow-x-auto"
      >
        {PLATFORM_ADMIN_TABS.map((t) => {
          const Icon = t.icon;
          const isActive = activeTab === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(t.key)}
              className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {activeTab === 'integrations' && <IntegrationsStatusPanel />}
      {activeTab === 'connector-health' && <ConnectorHealthPanel />}
      {activeTab === 'retention' && <CallEventsRetentionPanel />}

      {activeTab === 'tenants' && (
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="font-semibold">All Tenants</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="w-8 px-2"></th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Tenant</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Plan</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Users</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Calls (30d)</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Last Activity</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tenantsLoading ? (
                  <tr><td colSpan={8} className="text-center py-12 text-text-muted">Loading...</td></tr>
                ) : !tenantsData?.tenants.length ? (
                  <tr><td colSpan={8} className="text-center py-12 text-text-muted">No tenants found</td></tr>
                ) : (
                  tenantsData.tenants.map((tenant) => (
                    <Fragment key={tenant.id}>
                      <tr className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                        <td className="px-2">
                          <button
                            onClick={() => setExpandedTenant(expandedTenant === tenant.id ? null : tenant.id)}
                            className="p-1 rounded hover:bg-surface-secondary"
                          >
                            {expandedTenant === tenant.id
                              ? <ChevronDown className="h-4 w-4 text-text-muted" />
                              : <ChevronRight className="h-4 w-4 text-text-muted" />}
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium">{tenant.name}</div>
                          <div className="text-xs text-text-muted font-mono">{tenant.slug}</div>
                        </td>
                        <td className="px-4 py-3"><StatusBadge status={tenant.status} /></td>
                        <td className="px-4 py-3"><PlanBadge plan={tenant.plan} /></td>
                        <td className="px-4 py-3 text-text-muted">{tenant.user_count}</td>
                        <td className="px-4 py-3 text-text-muted">{tenant.calls_last_30d}</td>
                        <td className="px-4 py-3 text-text-muted whitespace-nowrap">
                          {tenant.last_call_at ? new Date(tenant.last_call_at).toLocaleDateString() : 'Never'}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => setExpandedTenant(expandedTenant === tenant.id ? null : tenant.id)}
                              className="p-1.5 rounded hover:bg-surface-secondary text-text-muted hover:text-text-primary"
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
                                className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-text-muted hover:text-red-600"
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
                                className="p-1.5 rounded hover:bg-green-100 dark:hover:bg-green-900/30 text-text-muted hover:text-green-600"
                                title="Reactivate tenant"
                              >
                                <CheckCircle className="h-4 w-4" />
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                      {expandedTenant === tenant.id && (
                        <tr className="border-b border-border">
                          <td colSpan={8} className="p-0">
                            <TenantDetailPanel tenantId={tenant.id} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'templates' && (
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="font-semibold">Template Version Management</h2>
            <p className="text-xs text-text-muted mt-0.5">Create, validate, publish, and deprecate template versions</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="w-8 px-2"></th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Template</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Slug</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Current Version</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                </tr>
              </thead>
              <tbody>
                {templatesLoading ? (
                  <tr><td colSpan={5} className="text-center py-12 text-text-muted">Loading templates...</td></tr>
                ) : !templatesData?.templates.length ? (
                  <tr><td colSpan={5} className="text-center py-12 text-text-muted">No templates found</td></tr>
                ) : (
                  templatesData.templates.map((t) => (
                    <Fragment key={t.id}>
                      <tr className="border-b border-border last:border-0 hover:bg-surface-secondary/50 cursor-pointer"
                          onClick={() => setExpandedTemplate(expandedTemplate === t.id ? null : t.id)}>
                        <td className="px-2">
                          <button aria-label={expandedTemplate === t.id ? 'Collapse template' : 'Expand template'} aria-expanded={expandedTemplate === t.id} className="p-1 rounded hover:bg-surface-secondary">
                            {expandedTemplate === t.id
                              ? <ChevronDown className="h-4 w-4 text-text-muted" />
                              : <ChevronRight className="h-4 w-4 text-text-muted" />}
                          </button>
                        </td>
                        <td className="px-4 py-3 font-medium">{t.displayName}</td>
                        <td className="px-4 py-3 text-text-muted font-mono text-xs">{t.slug}</td>
                        <td className="px-4 py-3 font-mono text-sm">v{t.currentVersion}</td>
                        <td className="px-4 py-3"><StatusBadge status={t.status} /></td>
                      </tr>
                      {expandedTemplate === t.id && (
                        <tr className="border-b border-border">
                          <td colSpan={5} className="p-0">
                            <TemplateVersionManager templateId={t.id} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'analytics' && (
        <TemplateAnalyticsTab
          data={analyticsData}
          loading={analyticsLoading}
          sortField={sortField}
          sortDir={sortDir}
          onSort={(field) => {
            if (field === sortField) {
              setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
            } else {
              setSortField(field);
              setSortDir('desc');
            }
          }}
        />
      )}

      {activeTab === 'cost-monitoring' && (
        <CostMonitoringTab data={costData} loading={costLoading} />
      )}

      {activeTab === 'activation' && (
        <ActivationMetricsTab data={activationData} loading={activationLoading} />
      )}

      {activeTab === 'docs-feedback' && <DocsFeedbackTab />}

      {activeTab === 'support' && <SupportInboxTab />}
    </div>
  );
}

type DocsFeedbackReplyStateFilter = 'any' | 'failed' | 'hard_bounce';

function DocsFeedbackTab() {
  const [sort, setSort] = useState<DocsFeedbackSort>('lowest_ratio');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<DocsFeedbackStatusFilter>('new');
  const [replyStateFilter, setReplyStateFilter] = useState<DocsFeedbackReplyStateFilter>('any');
  const queryClient = useQueryClient();

  const replyFilterActive = replyStateFilter !== 'any';

  const { data: summaryData, isLoading: summaryLoading } = useQuery({
    queryKey: ['docs-feedback-summary', sort],
    queryFn: () => api.get<{ articles: DocsFeedbackArticle[] }>(`/docs/feedback/summary?sort=${sort}&limit=200`),
    refetchInterval: 60_000,
  });

  const { data: commentsData, isLoading: commentsLoading } = useQuery({
    queryKey: ['docs-feedback-comments', selectedSlug, statusFilter, replyStateFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('limit', selectedSlug ? '100' : '50');
      params.set('status', replyFilterActive ? 'all' : statusFilter);
      if (replyFilterActive) params.set('reply_state', replyStateFilter);
      if (selectedSlug) params.set('article_slug', selectedSlug);
      return api.get<{ comments: DocsFeedbackComment[] }>(`/docs/feedback/comments?${params.toString()}`);
    },
    refetchInterval: 60_000,
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: DocsFeedbackStatus }) =>
      api.patch<{ comment: DocsFeedbackComment }>(`/docs/feedback/comments/${id}`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['docs-feedback-comments'] });
    },
  });

  const articles = summaryData?.articles ?? [];
  const comments = commentsData?.comments ?? [];

  return (
    <div className="space-y-6">
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="font-semibold">Article Helpfulness</h2>
            <p className="text-xs text-text-muted mt-0.5">Reader votes from the &ldquo;Was this helpful?&rdquo; widget across help articles</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-text-muted">Sort</label>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as DocsFeedbackSort)}
              className="text-sm px-2 py-1.5 rounded border border-border bg-surface"
            >
              <option value="lowest_ratio">Lowest helpfulness ratio</option>
              <option value="highest_ratio">Highest helpfulness ratio</option>
              <option value="most_votes">Most votes</option>
              <option value="recent">Most recent vote</option>
            </select>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-3 font-medium text-text-muted">Article</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">Helpfulness</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">Helpful</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">Not helpful</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">Comments</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">Last vote</th>
                <th className="text-right px-4 py-3 font-medium text-text-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {summaryLoading ? (
                <tr><td colSpan={7} className="text-center py-12 text-text-muted">Loading feedback...</td></tr>
              ) : articles.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-12 text-text-muted">No feedback collected yet</td></tr>
              ) : (
                articles.map((a) => {
                  const ratio = a.helpful_ratio;
                  const ratioColor =
                    ratio === null ? 'text-text-muted'
                      : ratio >= 75 ? 'text-green-600'
                      : ratio >= 50 ? 'text-yellow-600'
                      : 'text-red-600';
                  return (
                    <tr key={a.article_slug} className={`border-b border-border last:border-0 hover:bg-surface-secondary/50 ${selectedSlug === a.article_slug ? 'bg-surface-secondary/40' : ''}`}>
                      <td className="px-4 py-3 font-mono text-xs">{a.article_slug}</td>
                      <td className={`px-4 py-3 font-semibold ${ratioColor}`}>
                        {ratio === null ? '—' : `${ratio}%`}
                        <span className="text-text-muted font-normal ml-1">({a.total_votes})</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 text-green-600">
                          <ThumbsUp className="h-3.5 w-3.5" /> {a.helpful_count}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 text-red-600">
                          <ThumbsDown className="h-3.5 w-3.5" /> {a.not_helpful_count}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1">
                          <span className="inline-flex items-center gap-1 text-text-muted">
                            <MessageSquare className="h-3.5 w-3.5" /> {a.comment_count}
                          </span>
                          {a.comment_count > 0 && (
                            <span className="text-xs text-text-muted">
                              {a.new_comment_count} new · {a.resolved_comment_count} resolved · {a.hidden_comment_count} hidden
                            </span>
                          )}
                          {a.pending_reply_count > 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedSlug(a.article_slug);
                                setStatusFilter('pending_reply');
                              }}
                              className="inline-flex items-center gap-1 self-start px-1.5 py-0.5 rounded border border-amber-200 bg-amber-50 text-amber-700 text-[10px] font-medium hover:bg-amber-100"
                              title="Comments with a reply email that haven't been answered yet"
                            >
                              <Mail className="h-3 w-3" />
                              {a.pending_reply_count} pending reply
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-text-muted whitespace-nowrap">
                        {a.last_vote_at ? new Date(a.last_vote_at).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => setSelectedSlug(selectedSlug === a.article_slug ? null : a.article_slug)}
                          className="text-xs px-2 py-1 rounded border border-border hover:bg-surface-secondary"
                        >
                          {selectedSlug === a.article_slug ? 'Clear filter' : 'View comments'}
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="font-semibold">
              {selectedSlug ? `Comments for ${selectedSlug}` : 'Recent Comments'}
            </h2>
            <p className="text-xs text-text-muted mt-0.5">
              {selectedSlug
                ? 'Showing comments only for the selected article'
                : 'Most recent reader comments across all articles'}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-text-muted">Reply state</label>
            <select
              value={replyStateFilter}
              onChange={(e) => setReplyStateFilter(e.target.value as DocsFeedbackReplyStateFilter)}
              className={`text-sm px-2 py-1.5 rounded border border-border bg-surface ${
                replyStateFilter === 'hard_bounce'
                  ? 'text-amber-800 font-medium'
                  : replyStateFilter === 'failed'
                    ? 'text-red-700 font-medium'
                    : ''
              }`}
              title="Narrow the inbox to rows where the outbound reply failed (or specifically hard-bounced and won't auto-retry)."
            >
              <option value="any">Any reply state</option>
              <option value="failed">Failed replies only</option>
              <option value="hard_bounce">Hard-bounced only</option>
            </select>
            <label className="text-xs text-text-muted">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as DocsFeedbackStatusFilter)}
              disabled={replyFilterActive}
              className="text-sm px-2 py-1.5 rounded border border-border bg-surface disabled:opacity-50"
            >
              <option value="new">New</option>
              <option value="pending_reply">Pending reply</option>
              <option value="resolved">Resolved</option>
              <option value="hidden">Hidden</option>
              <option value="all">All</option>
            </select>
          </div>
        </div>
        <div className="divide-y divide-border">
          {commentsLoading ? (
            <div className="text-center py-12 text-text-muted">Loading comments...</div>
          ) : comments.length === 0 ? (
            <div className="text-center py-12 text-text-muted">No comments to show</div>
          ) : (
            comments.map((c) => (
              <DocsFeedbackCommentRow
                key={c.id}
                comment={c}
                onUpdateStatus={(status) => updateStatus.mutate({ id: c.id, status })}
                isStatusPending={updateStatus.isPending && updateStatus.variables?.id === c.id}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function DocsFeedbackCommentRow({
  comment: c,
  onUpdateStatus,
  isStatusPending,
}: {
  comment: DocsFeedbackComment;
  onUpdateStatus: (status: DocsFeedbackStatus) => void;
  isStatusPending: boolean;
}) {
  const queryClient = useQueryClient();
  const [showReply, setShowReply] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  const [replySubject, setReplySubject] = useState('');
  const [markResolved, setMarkResolved] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const { data: repliesData, isLoading: repliesLoading } = useQuery({
    queryKey: ['docs-feedback-replies', c.id],
    queryFn: () =>
      api.get<{ replies: DocsFeedbackReply[] }>(`/docs/feedback/comments/${c.id}/replies`),
    enabled: showHistory,
  });

  const sendReply = useMutation({
    mutationFn: () =>
      api.post<{ success: boolean; message_id?: string }>(
        `/docs/feedback/comments/${c.id}/reply`,
        {
          body: replyBody,
          subject: replySubject || undefined,
          mark_resolved: markResolved,
        },
      ),
    onSuccess: () => {
      setSuccess('Reply sent.');
      setError(null);
      setReplyBody('');
      setReplySubject('');
      setShowReply(false);
      queryClient.invalidateQueries({ queryKey: ['docs-feedback-comments'] });
      queryClient.invalidateQueries({ queryKey: ['docs-feedback-replies', c.id] });
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      setError(detail || 'Failed to send reply');
      setSuccess(null);
    },
  });

  // Cooldown timestamp (ms) until the Retry button is allowed to fire again.
  // Set from `retry_after_seconds` on a 429 (so admins don't have to click
  // to discover they're locked out) and from `retry_cooldown_seconds` on a
  // successful retry (to mirror the server-side per-feedback debounce).
  const [retryCooldownUntil, setRetryCooldownUntil] = useState(0);

  const retryReply = useMutation({
    mutationFn: () =>
      api.post<{
        success: boolean;
        message_id?: string;
        subject?: string;
        retry_cooldown_seconds?: number;
      }>(
        `/docs/feedback/comments/${c.id}/reply/retry`,
        {},
      ),
    onSuccess: (data) => {
      setSuccess('Reply re-sent.');
      setError(null);
      const cooldown = readPositiveSeconds(data, 'retry_cooldown_seconds');
      if (cooldown !== null) {
        setRetryCooldownUntil(Date.now() + cooldown * 1000);
      }
      queryClient.invalidateQueries({ queryKey: ['docs-feedback-comments'] });
      queryClient.invalidateQueries({ queryKey: ['docs-feedback-replies', c.id] });
    },
    onError: (err: unknown) => {
      const status = (err as { status?: number } | null)?.status;
      const body = (err as { body?: unknown } | null)?.body;
      if (status === 429) {
        const wait = readPositiveSeconds(body, 'retry_after_seconds');
        if (wait !== null) {
          setRetryCooldownUntil(Date.now() + wait * 1000);
        }
      }
      const detail = err instanceof Error ? err.message : String(err);
      setError(detail || 'Failed to re-send reply');
      setSuccess(null);
    },
  });

  const now = useCountdownTick([retryCooldownUntil]);
  const retrySecondsLeft = Math.max(0, Math.ceil((retryCooldownUntil - now) / 1000));
  const retryDisabled = retryReply.isPending || retrySecondsLeft > 0;
  const retryLabel = retryReply.isPending
    ? 'Retrying…'
    : retrySecondsLeft > 0
      ? `Retry available in ${retrySecondsLeft}s`
      : 'Retry send';

  const statusBadge =
    c.status === 'resolved' ? 'bg-green-100 text-green-700 border-green-200'
      : c.status === 'hidden' ? 'bg-gray-100 text-gray-600 border-gray-200'
      : 'bg-blue-100 text-blue-700 border-blue-200';

  const replies = repliesData?.replies ?? [];
  const lastReplyFailed = c.last_reply_failed === true;
  // Prefer the server-computed `last_reply_permanent` field (which uses the
  // same isPermanentSmtpError classifier that gates the auto-retry digest)
  // and fall back to the client mirror only if the field is missing — e.g.
  // an old API response cached before this rolled out. Either way, the
  // background scheduler will refuse to retry, so the inbox UI must too.
  const lastReplyPermanent =
    c.last_reply_permanent === true ||
    isHardBounce({
      retry_skipped_reason: c.last_reply_retry_skipped_reason,
      email_error: c.last_reply_error,
    }) ||
    (c.last_reply_permanent == null && isPermanentSmtpError(c.last_reply_error));

  return (
    <div
      className={`px-4 py-3 ${
        lastReplyPermanent
          ? 'border-l-4 border-l-amber-500 bg-amber-50/40'
          : lastReplyFailed
            ? 'border-l-4 border-l-red-500 bg-red-50/40'
            : ''
      }`}
    >
      {lastReplyFailed && (
        <div
          className={`mb-2 flex items-start gap-2 text-xs rounded px-2 py-1.5 border ${
            lastReplyPermanent
              ? 'text-amber-800 bg-amber-100/60 border-amber-300'
              : 'text-red-700 bg-red-100/60 border-red-200'
          }`}
        >
          <Mail className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <div className="font-semibold flex items-center gap-2 flex-wrap">
              {lastReplyPermanent ? 'Hard bounce — reply will not be retried' : 'Last reply failed to send'}
              {lastReplyPermanent ? (
                <span
                  className="px-1.5 py-0.5 rounded border border-amber-400 bg-amber-100 text-amber-900 text-[10px] uppercase tracking-wide font-semibold"
                  title="Permanent SMTP failure — auto-retry skipped, manual retry disabled"
                >
                  Hard bounce
                </span>
              ) : (
                <span
                  className="px-1.5 py-0.5 rounded border border-red-300 bg-red-100 text-red-800 text-[10px] uppercase tracking-wide font-medium"
                  title="Transient delivery failure — safe to retry"
                >
                  Failed
                </span>
              )}
              {/* If the reply was skipped for a non-hard-bounce reason
                  (suppression, manual cancel, unsubscribe, …) show that
                  alongside the Failed pill so ops sees *why* further auto-
                  retries won't happen, even when the SMTP error itself wasn't
                  a 5xx hard bounce. Hidden on hard bounces because the badge
                  above already explains it. */}
              {!lastReplyPermanent &&
                c.last_reply_retry_skipped_reason &&
                !isHardBounce({
                  retry_skipped_reason: c.last_reply_retry_skipped_reason,
                  email_error: c.last_reply_error,
                }) && (
                  <RetrySkippedBadge reason={c.last_reply_retry_skipped_reason} />
                )}
              {/* Auto-retry counter: shown whenever the background
                  DocsFeedbackReplyRetryScheduler has touched this reply at
                  least once. The hover title surfaces the timestamp of the
                  last attempt so an admin can tell whether the scheduler
                  just gave up (recent) or gave up an hour ago — and the
                  pill turns amber once the auto-retry cap is exhausted so
                  it matches the "auto-retries exhausted" treatment of the
                  hard-bounce badge above. */}
              <DocsFeedbackAutoRetryBadge
                retryCount={c.last_reply_retry_count}
                lastRetryAt={c.last_reply_last_retry_at}
              />
            </div>
            {c.last_reply_error && (
              <div className={lastReplyPermanent ? 'text-amber-700' : 'text-red-600'}>
                {c.last_reply_error}
              </div>
            )}
            <div className={lastReplyPermanent ? 'text-amber-700/90' : 'text-red-600/80'}>
              {lastReplyPermanent ? (
                <>
                  The recipient address is permanently unreachable, so re-sending the same body
                  would only burn sender reputation. Reach out another way:{' '}
                  {c.reply_email ? (
                    <a
                      href={`mailto:${c.reply_email}`}
                      title={`Open a fresh email to ${c.reply_email} from your own client to verify the address out-of-band.`}
                      className="underline font-medium text-amber-900 hover:text-amber-950"
                    >
                      contact {c.reply_email}
                    </a>
                  ) : (
                    'no reply email was captured for this comment.'
                  )}
                </>
              ) : (
                'Retry below to re-send the same body, or open the reply form to edit before sending.'
              )}
              {c.last_reply_at && (
                <> Attempted {new Date(c.last_reply_at).toLocaleString()}.</>
              )}
            </div>
          </div>
          {lastReplyPermanent ? (
            <span
              className="ml-2 self-start px-2 py-1 rounded border border-amber-300 bg-amber-50 text-amber-800 text-[11px] whitespace-nowrap cursor-not-allowed"
              title="Retry is disabled because this address hard-bounced. Contact the recipient out-of-band instead."
            >
              Retry disabled
            </span>
          ) : (
            <button
              type="button"
              disabled={retryDisabled}
              onClick={() => {
                setError(null);
                setSuccess(null);
                retryReply.mutate();
              }}
              title={
                retrySecondsLeft > 0
                  ? `Server-side cooldown active. Re-enables in ${retrySecondsLeft}s.`
                  : undefined
              }
              className="ml-2 self-start px-2 py-1 rounded border border-red-300 bg-white text-red-700 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {retryLabel}
            </button>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 text-xs text-text-muted mb-1 flex-wrap">
        {c.vote === 'helpful' ? (
          <span className="inline-flex items-center gap-1 text-green-600"><ThumbsUp className="h-3 w-3" /> helpful</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-red-600"><ThumbsDown className="h-3 w-3" /> not helpful</span>
        )}
        <span className={`px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wide font-medium ${statusBadge}`}>
          {c.status}
        </span>
        <span className="font-mono">{c.article_slug}</span>
        {c.page_path && <span className="text-text-muted">· {c.page_path}</span>}
        {c.reply_count > 0 && (
          <span className="inline-flex items-center gap-1 text-teal-700">
            <Mail className="h-3 w-3" /> {c.reply_count} repl{c.reply_count === 1 ? 'y' : 'ies'}
          </span>
        )}
        <span className="ml-auto">{new Date(c.created_at).toLocaleString()}</span>
      </div>
      <div className="text-sm whitespace-pre-wrap">{c.comment}</div>
      {c.reply_email && (
        <div className="mt-1 text-xs text-text-muted inline-flex items-center gap-1">
          <Mail className="h-3 w-3" />
          <a href={`mailto:${c.reply_email}`} className="text-teal-700 hover:underline">{c.reply_email}</a>
        </div>
      )}
      <div className="mt-2 flex items-center gap-2 text-xs flex-wrap">
        {c.reply_email && (
          <button
            type="button"
            onClick={() => {
              setShowReply((v) => !v);
              setError(null);
              setSuccess(null);
            }}
            className="px-2 py-1 rounded border border-teal-200 text-teal-700 hover:bg-teal-50"
          >
            {showReply ? 'Cancel reply' : 'Reply by email'}
          </button>
        )}
        {c.reply_email && (
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="px-2 py-1 rounded border border-border hover:bg-surface-secondary"
          >
            {showHistory
              ? 'Hide replies'
              : c.reply_count > 0
                ? `Show ${c.reply_count} repl${c.reply_count === 1 ? 'y' : 'ies'}`
                : 'Show reply history'}
          </button>
        )}
        {c.status !== 'resolved' && (
          <button
            type="button"
            disabled={isStatusPending}
            onClick={() => onUpdateStatus('resolved')}
            className="px-2 py-1 rounded border border-border hover:bg-surface-secondary disabled:opacity-50"
          >
            Mark resolved
          </button>
        )}
        {c.status !== 'hidden' && (
          <button
            type="button"
            disabled={isStatusPending}
            onClick={() => onUpdateStatus('hidden')}
            className="px-2 py-1 rounded border border-border hover:bg-surface-secondary disabled:opacity-50"
          >
            Hide
          </button>
        )}
        {c.status !== 'new' && (
          <button
            type="button"
            disabled={isStatusPending}
            onClick={() => onUpdateStatus('new')}
            className="px-2 py-1 rounded border border-border hover:bg-surface-secondary disabled:opacity-50"
          >
            Reopen
          </button>
        )}
        {c.status_updated_by && c.status_updated_at && (
          <span className="text-text-muted ml-auto">
            {c.status} by {c.status_updated_by} · {new Date(c.status_updated_at).toLocaleString()}
          </span>
        )}
      </div>

      {success && <div className="mt-2 text-xs text-green-700">{success}</div>}

      {showReply && c.reply_email && (
        <div className="mt-3 border border-teal-200 rounded-lg bg-teal-50/30 p-3 space-y-2">
          <div className="text-xs text-text-muted">
            Reply will be sent from your support address to <span className="font-mono">{c.reply_email}</span>.
          </div>
          <input
            type="text"
            value={replySubject}
            onChange={(e) => setReplySubject(e.target.value)}
            placeholder={`Subject (default: Re: your feedback on ${c.article_slug})`}
            className="w-full px-2 py-1.5 rounded border border-border text-sm bg-surface"
          />
          <textarea
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            rows={5}
            placeholder="Write your reply..."
            className="w-full px-2 py-1.5 rounded border border-border text-sm bg-surface"
          />
          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={markResolved}
              onChange={(e) => setMarkResolved(e.target.checked)}
            />
            Mark this comment as resolved after sending
          </label>
          {error && <div className="text-xs text-red-600">{error}</div>}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={sendReply.isPending || replyBody.trim().length === 0}
              onClick={() => {
                setError(null);
                sendReply.mutate();
              }}
              className="px-3 py-1.5 text-sm rounded bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50"
            >
              {sendReply.isPending ? 'Sending...' : 'Send reply'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowReply(false);
                setError(null);
              }}
              className="px-3 py-1.5 text-sm rounded border border-border hover:bg-surface-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {showHistory && (
        <div className="mt-3 border border-border rounded-lg bg-surface-secondary/30 p-3 space-y-2">
          {repliesLoading ? (
            <div className="text-xs text-text-muted">Loading replies...</div>
          ) : replies.length === 0 ? (
            <div className="text-xs text-text-muted">No replies yet.</div>
          ) : (
            groupDocsFeedbackReplyChains(replies).map((chain) => {
              const r = chain.root;
              const totalAttempts = 1 + chain.retries.length;
              return (
                <div
                  key={r.id}
                  className="text-xs border border-border rounded p-2 bg-surface"
                >
                  <div className="flex items-center gap-2 text-text-muted mb-1 flex-wrap">
                    <span>{new Date(r.created_at).toLocaleString()}</span>
                    <span>· from {r.sent_by ?? 'admin'}</span>
                    <span>· to {r.to_email}</span>
                    {r.email_error
                      ? (
                        <span className="text-red-600 inline-flex items-center gap-1">
                          · failed: {r.email_error}
                          {isHardBounce(r) && (
                            <span
                              className="px-1 py-0.5 rounded border border-amber-300 bg-amber-50 text-amber-800 text-[9px] uppercase tracking-wide font-medium dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900"
                              title="Permanent SMTP failure — auto-retry skipped"
                            >
                              Hard bounce
                            </span>
                          )}
                          {/* Render a distinct badge for any *non-hard-bounce*
                              skip reason (suppression, manual cancel, recipient
                              unsubscribed, …). Unknown future reasons fall
                              through to the generic "Auto-retry skipped" pill
                              from describeRetrySkippedReason so the row never
                              breaks if the server starts writing a new value
                              before the client knows about it. */}
                          {!isHardBounce(r) && r.retry_skipped_reason && (
                            <RetrySkippedBadge reason={r.retry_skipped_reason} size="xs" />
                          )}
                          {/* Inline auto-retry counter from the background
                              scheduler (not the same as the manual chain
                              "{N} attempts" pill below — that one counts
                              chain.retries rows, this one counts in-place
                              auto-retries on this exact row). */}
                          <DocsFeedbackAutoRetryBadge
                            retryCount={r.retry_count}
                            lastRetryAt={r.last_retry_at}
                            size="xs"
                          />
                        </span>
                      )
                      : <span className="text-green-700">· delivered</span>}
                    {chain.retries.length > 0 && (
                      <span
                        className="px-1.5 py-0.5 rounded border border-amber-200 bg-amber-50 text-amber-700 text-[10px] uppercase tracking-wide"
                        title={`Original attempt followed by ${chain.retries.length} retr${chain.retries.length === 1 ? 'y' : 'ies'} of the same body`}
                      >
                        {totalAttempts} attempts
                      </span>
                    )}
                  </div>
                  <div className="text-sm font-medium mb-1">{r.subject}</div>
                  <div className="text-sm whitespace-pre-wrap">{r.body}</div>
                  {chain.retries.length > 0 && (
                    <div className="mt-2 pl-3 border-l-2 border-amber-200 space-y-1">
                      <div className="text-[10px] uppercase tracking-wide text-amber-700 font-semibold">
                        Retries of this attempt
                      </div>
                      {chain.retries.map((retry, idx) => (
                        <div
                          key={retry.id}
                          className="flex items-center gap-2 text-text-muted flex-wrap"
                        >
                          <span
                            className="px-1.5 py-0.5 rounded border border-amber-200 bg-amber-50 text-amber-700 text-[10px] uppercase tracking-wide"
                            title={`Same body re-sent; original attempt at ${new Date(r.created_at).toLocaleString()}`}
                          >
                            Retry #{idx + 1}
                          </span>
                          <span>{new Date(retry.created_at).toLocaleString()}</span>
                          <span>· from {retry.sent_by ?? 'admin'}</span>
                          {retry.email_error
                            ? (
                              <span className="text-red-600 inline-flex items-center gap-1">
                                · failed: {retry.email_error}
                                {isHardBounce(retry) && (
                                  <span
                                    className="px-1 py-0.5 rounded border border-amber-300 bg-amber-50 text-amber-800 text-[9px] uppercase tracking-wide font-medium dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900"
                                    title="Permanent SMTP failure — auto-retry skipped"
                                  >
                                    Hard bounce
                                  </span>
                                )}
                                {!isHardBounce(retry) && retry.retry_skipped_reason && (
                                  <RetrySkippedBadge reason={retry.retry_skipped_reason} size="xs" />
                                )}
                                <DocsFeedbackAutoRetryBadge
                                  retryCount={retry.retry_count}
                                  lastRetryAt={retry.last_retry_at}
                                  size="xs"
                                />
                              </span>
                            )
                            : <span className="text-green-700">· delivered</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

interface SupportTicket {
  id: string;
  tenant_id: string | null;
  tenant_name: string | null;
  user_id: string | null;
  user_email: string | null;
  plan: string | null;
  topic: string;
  message: string;
  recent_errors: string | null;
  context: Record<string, unknown> | null;
  routed_to: string;
  status: string;
  email_message_id: string | null;
  email_error: string | null;
  retry_skipped_reason: string | null;
  created_at: string;
  updated_at: string;
  // Server-side LATERAL join: surfaces the most recent outbound admin reply's
  // SMTP error and timestamp so the inbox can render hard-bounce badges
  // against replies and apply the "Hard bounces only" filter without an
  // extra round trip per row.
  last_outbound_reply_error?: string | null;
  last_outbound_reply_at?: string | null;
}

interface SupportReply {
  id: number;
  ticket_id: string;
  direction: 'outbound' | 'inbound' | 'system';
  author_user_id: string | null;
  author_email: string | null;
  body: string;
  email_message_id: string | null;
  email_error: string | null;
  /**
   * Server-computed flag (via platform/email/smtpErrorClass.isPermanentSmtpError)
   * that's true when the prior delivery error is a hard SMTP failure (5xx,
   * "no such user", mailbox full, …). When true the manual /retry endpoint
   * refuses to re-send and the row also leaves the auto-retry pool.
   */
  permanent_failure?: boolean;
  /**
   * Persisted skip reason written by the scheduler / write-paths when they
   * decide not to auto-retry (currently only `'permanent_smtp_failure'`).
   * Drives the "Hard bounce — won't auto-retry" badge directly so the UI
   * does not depend on the client-side classifier for new rows.
   */
  retry_skipped_reason: string | null;
  source: string | null;
  created_at: string;
}

function SupportInboxTab() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'in_progress' | 'resolved' | 'closed'>('open');
  const [hardBounceOnly, setHardBounceOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['support-tickets', statusFilter, hardBounceOnly],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('status', statusFilter);
      params.set('limit', '200');
      if (hardBounceOnly) params.set('reply_state', 'hard_bounce');
      return api.get<{ tickets: SupportTicket[] }>(`/support/tickets?${params.toString()}`);
    },
    refetchInterval: 60_000,
  });

  const { data: stats } = useQuery({
    queryKey: ['support-ticket-stats'],
    queryFn: () =>
      api.get<{
        total: number;
        open: number;
        email_failed: number;
        email_failed_open: number;
        reply_email_failed: number;
        reply_email_failed_open: number;
        hard_bounce: number;
        hard_bounce_open: number;
      }>(`/support/tickets/stats`),
    refetchInterval: 60_000,
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/support/tickets/${id}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      queryClient.invalidateQueries({ queryKey: ['support-ticket-stats'] });
    },
  });

  const tickets = data?.tickets ?? [];

  const failedCount = stats?.email_failed ?? 0;
  const failedOpenCount = stats?.email_failed_open ?? 0;
  const replyFailedCount = stats?.reply_email_failed ?? 0;
  const replyFailedOpenCount = stats?.reply_email_failed_open ?? 0;
  const hardBounceCount = stats?.hard_bounce ?? 0;
  const hardBounceOpenCount = stats?.hard_bounce_open ?? 0;
  return (
    <div className="space-y-4">
      {failedCount > 0 && (
        <div className="flex items-start gap-3 p-3 rounded-lg border border-red-300 bg-red-50 text-red-900">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div className="text-sm">
            <div className="font-medium">
              {failedCount} ticket{failedCount === 1 ? '' : 's'} with initial-send email delivery errors
              {failedOpenCount > 0 && failedOpenCount !== failedCount && (
                <span className="font-normal"> ({failedOpenCount} still open)</span>
              )}
            </div>
            <div className="text-xs mt-0.5">
              The platform team has been alerted. Check SMTP configuration and the routing destinations below.
            </div>
          </div>
        </div>
      )}
      {replyFailedCount > 0 && (
        <div className="flex items-start gap-3 p-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-900">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div className="text-sm">
            <div className="font-medium">
              {replyFailedCount} ticket{replyFailedCount === 1 ? '' : 's'} with admin reply delivery errors
              {replyFailedOpenCount > 0 && replyFailedOpenCount !== replyFailedCount && (
                <span className="font-normal"> ({replyFailedOpenCount} still open)</span>
              )}
              {hardBounceCount > 0 && (
                <>
                  {' '}<span className="font-normal text-amber-800">·</span>{' '}
                  <span className="font-medium">
                    {hardBounceCount} hard bounce{hardBounceCount === 1 ? '' : 's'}
                  </span>
                  {hardBounceOpenCount > 0 && hardBounceOpenCount !== hardBounceCount && (
                    <span className="font-normal"> ({hardBounceOpenCount} still open)</span>
                  )}
                </>
              )}
            </div>
            <div className="text-xs mt-0.5">
              An outbound admin reply failed to deliver. Auto-retries run in the background; persistent failures
              raise an operations alert. Open the ticket to see the failed reply and re-send manually.
              {hardBounceCount > 0 && (
                <> Use the &ldquo;Hard bounces only&rdquo; filter to focus on permanently undeliverable addresses.</>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex gap-2">
          {(['open', 'in_progress', 'resolved', 'closed', 'all'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-sm rounded-lg border ${
                statusFilter === s
                  ? 'bg-primary text-white border-primary'
                  : 'bg-surface border-border text-text-muted hover:text-text-primary'
              }`}
            >
              {s.replace('_', ' ')}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-1.5 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={hardBounceOnly}
              onChange={(e) => setHardBounceOnly(e.target.checked)}
            />
            <span className={hardBounceOnly ? 'text-red-700 font-medium' : ''}>
              Hard bounces only
              {/* The count next to this label has to be the global hard-bounce
                  total (status-agnostic) — the stats endpoint isn't
                  status-scoped, and showing "(7)" while the visible "open"
                  inbox only contains 2 of them would look inconsistent. To
                  avoid that confusion we only surface the count when the
                  status filter is "all" (the visible list matches the global
                  count) or when the hard-bounce filter is already on (the
                  user is explicitly asking for the global subset). */}
              {hardBounceCount > 0 && (statusFilter === 'all' || hardBounceOnly) && (
                <span className="ml-1 text-text-muted font-normal">({hardBounceCount})</span>
              )}
            </span>
          </label>
          <div className="text-xs text-text-muted">{tickets.length} ticket{tickets.length === 1 ? '' : 's'}</div>
        </div>
      </div>

      <BouncedRecipientsPanel
        onOpenTicket={(ticketId) => {
          setStatusFilter('all');
          setHardBounceOnly(false);
          setExpandedId(ticketId);
        }}
      />

      <UnsubscribedAddressesPanel />

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-secondary">
              <th className="w-8 px-2"></th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">Ticket</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">From</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">Topic</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">Plan</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">Routed To</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">Created</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={9} className="text-center py-12 text-text-muted">Loading tickets...</td></tr>
            ) : tickets.length === 0 ? (
              <tr><td colSpan={9} className="text-center py-12 text-text-muted">No tickets found</td></tr>
            ) : (
              tickets.map((t) => (
                <Fragment key={t.id}>
                  <tr className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                    <td className="px-2">
                      <button
                        onClick={() => setExpandedId(expandedId === t.id ? null : t.id)}
                        className="p-1 rounded hover:bg-surface-secondary"
                      >
                        {expandedId === t.id
                          ? <ChevronDown className="h-4 w-4 text-text-muted" />
                          : <ChevronRight className="h-4 w-4 text-text-muted" />}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-mono text-xs">{t.id}</div>
                      {t.email_error && (
                        <div
                          className="text-xs text-red-600 mt-1 flex items-center gap-1 flex-wrap"
                          title={t.email_error}
                        >
                          <AlertCircle className="h-3 w-3" />
                          {isHardBounce(t)
                            ? 'email failed (hard bounce)'
                            : 'email failed'}
                          {/* Surface non-hard-bounce skip reasons (suppression,
                              manual cancel, unsubscribe, …) as a distinct pill
                              so ops can triage from the row without expanding
                              the ticket. Unknown reasons fall through to the
                              generic "Auto-retry skipped" badge. */}
                          {!isHardBounce(t) && t.retry_skipped_reason && (
                            <RetrySkippedBadge reason={t.retry_skipped_reason} size="xs" />
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div>{t.user_email ?? '—'}</div>
                      <div className="text-xs text-text-muted">{t.tenant_name ?? t.tenant_id ?? '—'}</div>
                    </td>
                    <td className="px-4 py-3">{t.topic}</td>
                    <td className="px-4 py-3"><PlanBadge plan={t.plan ?? 'trial'} /></td>
                    <td className="px-4 py-3 text-text-muted text-xs">{t.routed_to}</td>
                    <td className="px-4 py-3">
                      <select
                        value={t.status}
                        onChange={(e) => updateStatus.mutate({ id: t.id, status: e.target.value })}
                        className="text-xs px-2 py-1 rounded border border-border bg-surface"
                      >
                        <option value="open">open</option>
                        <option value="in_progress">in_progress</option>
                        <option value="resolved">resolved</option>
                        <option value="closed">closed</option>
                      </select>
                    </td>
                    <td className="px-4 py-3 text-text-muted text-xs">{new Date(t.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      {t.user_email && (
                        <button
                          onClick={() => setExpandedId(expandedId === t.id ? null : t.id)}
                          className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-primary text-white hover:opacity-90"
                        >
                          <Mail className="h-3 w-3" /> Reply
                        </button>
                      )}
                    </td>
                  </tr>
                  {expandedId === t.id && (
                    <tr className="bg-surface-secondary/30">
                      <td colSpan={9} className="px-6 py-4">
                        <TicketThread ticket={t} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface BouncedRecipientTicket {
  ticket_id: string;
  ticket_status: string;
  occurrence_count: number;
  last_failure_at: string;
  last_error: string;
}

interface SuppressionEntry {
  email_lower: string;
  reason: string;
  source: string | null;
  last_error: string | null;
  added_at: string;
  added_by_user_id: string | null;
  notes: string | null;
}

interface BouncedRecipient {
  user_email: string;
  occurrence_count: number;
  last_failure_at: string;
  last_error: string;
  ticket_count: number;
  tickets: BouncedRecipientTicket[];
  // ISO timestamp of when ops was first paged about this address. Null
  // means the per-recipient first-bounce alert hasn't fired yet for this
  // recipient, e.g. the address is being shown only because of bounces
  // recorded before the alert pipeline shipped. Populated server-side from
  // the `support_recipient_bounce_alerts` dedup table.
  alerted_at: string | null;
  suppression: SuppressionEntry | null;
}

interface BouncedRecipientsResponse {
  recipients: BouncedRecipient[];
  total: number;
  truncated: boolean;
}

function SuppressedBadge({
  suppression,
  size = 'sm',
}: {
  suppression: SuppressionEntry;
  size?: 'xs' | 'sm';
}) {
  // Tooltip explains *who* suppressed and *why*. Manual ops entries get the
  // admin user id so on-call can chase the original decision; auto entries
  // surface the source label (e.g. 'support_reply_retry_scheduler') so it's
  // obvious the bounce loop did it on its own.
  const wasManual = !!suppression.added_by_user_id;
  const tooltipParts = [
    wasManual
      ? `Suppressed by admin (${suppression.added_by_user_id ?? '?'})`
      : `Auto-suppressed (${suppression.source ?? 'system'})`,
    `Added ${new Date(suppression.added_at).toLocaleString()}`,
    `Reason: ${suppression.reason}`,
  ];
  if (suppression.notes) tooltipParts.push(`Notes: ${suppression.notes}`);
  const padding = size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border border-orange-300 bg-orange-50 text-orange-800 dark:bg-orange-950/40 dark:text-orange-200 dark:border-orange-900 ${padding}`}
      title={tooltipParts.join(' · ')}
    >
      <ShieldOff className={size === 'xs' ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
      Suppressed{wasManual ? ' by ops' : ''}
    </span>
  );
}

function BouncedRecipientsPanel({
  onOpenTicket,
}: {
  onOpenTicket: (ticketId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [openEmails, setOpenEmails] = useState<Set<string>>(new Set());
  // Per-row "show notes input" toggle. Drafts are kept here so flipping
  // between rows doesn't blow away half-typed text. Cleared after a
  // successful suppress so the next click on the same address starts blank.
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [showNoteFor, setShowNoteFor] = useState<string | null>(null);
  // Per-row error surface so a failed suppress / unsuppress doesn't get
  // silently swallowed — keyed on the lowercased email so the badge change
  // doesn't lose track of which row failed.
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['support-bounced-recipients'],
    queryFn: () =>
      api.get<BouncedRecipientsResponse>(
        `/support/replies/bounced-recipients?limit=200`,
      ),
    refetchInterval: 60_000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['support-bounced-recipients'] });
    // Refresh any open ticket thread so the in-thread suppression badge
    // updates without a manual reload.
    queryClient.invalidateQueries({ queryKey: ['support-ticket-replies'] });
  };

  // Drops the dedup row in `support_recipient_bounce_alerts` so the next
  // bounce on this address re-fires the per-recipient first-bounce ops
  // alert. Optimistically clears `alerted_at` in the cached panel data so
  // the badge disappears immediately without waiting for the 60s refetch.
  const clearAlert = useMutation({
    mutationFn: (email: string) =>
      api.delete<{ cleared: boolean; email_lower: string }>(
        `/support/replies/bounced-recipients/${encodeURIComponent(email)}/alert`,
      ),
    onSuccess: (_data, email) => {
      queryClient.setQueryData<BouncedRecipientsResponse>(
        ['support-bounced-recipients'],
        (prev) => {
          if (!prev) return prev;
          const lower = email.trim().toLowerCase();
          return {
            ...prev,
            recipients: prev.recipients.map((r) =>
              r.user_email.trim().toLowerCase() === lower
                ? { ...r, alerted_at: null }
                : r,
            ),
          };
        },
      );
    },
  });

  const suppressMutation = useMutation({
    mutationFn: ({ email, notes }: { email: string; notes: string | null }) =>
      api.post<{ success: boolean; suppression: SuppressionEntry | null }>(
        `/support/email-suppressions`,
        { email, notes: notes ?? undefined },
      ),
    onSuccess: (_data, vars) => {
      const key = vars.email.toLowerCase();
      setRowErrors((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setNoteDrafts((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setShowNoteFor((cur) => (cur === key ? null : cur));
      invalidate();
    },
    onError: (err, vars) => {
      const key = vars.email.toLowerCase();
      setRowErrors((prev) => ({
        ...prev,
        [key]: err instanceof Error ? err.message : 'Suppress failed',
      }));
    },
  });

  const unsuppressMutation = useMutation({
    mutationFn: (email: string) =>
      api.delete<{ success: boolean }>(
        `/support/email-suppressions/${encodeURIComponent(email.toLowerCase())}`,
      ),
    onSuccess: (_data, email) => {
      const key = email.toLowerCase();
      setRowErrors((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      invalidate();
    },
    onError: (err, email) => {
      const key = email.toLowerCase();
      setRowErrors((prev) => ({
        ...prev,
        [key]: err instanceof Error ? err.message : 'Unsuppress failed',
      }));
    },
  });

  const recipients = data?.recipients ?? [];
  const total = data?.total ?? 0;
  const truncated = data?.truncated ?? false;

  // Hide the section entirely when there's nothing to act on — admins don't
  // need a "0 recipients" placeholder cluttering the inbox in the happy case.
  if (!isLoading && recipients.length === 0) {
    return null;
  }

  const toggleEmail = (email: string) => {
    setOpenEmails((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  };

  return (
    // The id is the scroll target for the "Recipients ever hard-bounced"
    // dashboard card — clicking the card switches to the support tab and
    // calls scrollIntoView on this element.
    <div
      id="bounced-recipients-panel"
      className="bg-surface border border-border rounded-xl overflow-hidden scroll-mt-4"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-surface-secondary border-b border-border hover:bg-surface-secondary/70"
      >
        <div className="flex items-center gap-2 text-left">
          {expanded
            ? <ChevronDown className="h-4 w-4 text-text-muted" />
            : <ChevronRight className="h-4 w-4 text-text-muted" />}
          <ShieldAlert className="h-4 w-4 text-red-600" />
          <div>
            <div className="text-sm font-medium">
              Bounced recipients
              <span className="ml-2 text-xs text-text-muted font-normal">
                {isLoading
                  ? 'loading…'
                  : `${total} address${total === 1 ? '' : 'es'} with permanent SMTP failures`}
                {truncated && ' (showing first 200)'}
              </span>
            </div>
            <div className="text-xs text-text-muted mt-0.5">
              Addresses that have produced at least one hard bounce on an outbound reply.
              Use this list to clean records, contact users via another channel, or suspend
              tickets that can&rsquo;t be answered by email.
            </div>
          </div>
        </div>
      </button>
      {expanded && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface">
              <th className="w-8 px-2"></th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">Recipient</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">Failures</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">Tickets</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">Last failure</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">Alerted</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">Most recent error</th>
              <th className="text-left px-4 py-3 font-medium text-text-muted">Suppression</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="text-center py-8 text-text-muted">Loading…</td></tr>
            ) : (
              recipients.map((r) => {
                const key = r.user_email.toLowerCase();
                const isSuppressed = !!r.suppression;
                const noteOpen = showNoteFor === key;
                const draft = noteDrafts[key] ?? '';
                const rowError = rowErrors[key];
                const suppressing =
                  suppressMutation.isPending &&
                  suppressMutation.variables?.email.toLowerCase() === key;
                const unsuppressing =
                  unsuppressMutation.isPending &&
                  unsuppressMutation.variables?.toLowerCase() === key;
                return (
                <Fragment key={r.user_email}>
                  <tr className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                    <td className="px-2">
                      <button
                        type="button"
                        onClick={() => toggleEmail(r.user_email)}
                        className="p-1 rounded hover:bg-surface-secondary"
                        aria-label={openEmails.has(r.user_email) ? 'Collapse tickets' : 'Expand tickets'}
                      >
                        {openEmails.has(r.user_email)
                          ? <ChevronDown className="h-4 w-4 text-text-muted" />
                          : <ChevronRight className="h-4 w-4 text-text-muted" />}
                      </button>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span>{r.user_email}</span>
                        {isSuppressed && (
                          <SuppressedBadge suppression={r.suppression!} size="xs" />
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-red-100 text-red-800">
                        <AlertCircle className="h-3 w-3" />
                        {r.occurrence_count}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-text-muted">
                      {r.ticket_count} ticket{r.ticket_count === 1 ? '' : 's'}
                    </td>
                    <td className="px-4 py-3 text-xs text-text-muted">
                      {new Date(r.last_failure_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {r.alerted_at ? (
                        <div className="flex items-center gap-2">
                          <span
                            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800"
                            title={`Ops was paged about this address at ${new Date(r.alerted_at).toLocaleString()}`}
                          >
                            <ShieldAlert className="h-3 w-3" />
                            Alerted
                          </span>
                          <button
                            type="button"
                            onClick={() => clearAlert.mutate(r.user_email)}
                            disabled={
                              clearAlert.isPending &&
                              clearAlert.variables === r.user_email
                            }
                            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-border hover:bg-surface-secondary disabled:opacity-50"
                            title="Drop the dedup row so the next bounce on this address re-pages ops"
                          >
                            {clearAlert.isPending &&
                            clearAlert.variables === r.user_email
                              ? 'Clearing…'
                              : 'Clear alert'}
                          </button>
                        </div>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-red-700 max-w-md truncate" title={r.last_error}>
                      {r.last_error}
                    </td>
                    <td className="px-4 py-3">
                      {/* Suppress / Unsuppress action. Suppression is reversible
                          (DELETE removes the row) but unsubscribes are not — we
                          never expose an unsubscribe-clear button here on
                          purpose, see the helper docstrings. */}
                      <div className="flex flex-col gap-1">
                        {isSuppressed ? (
                          <button
                            type="button"
                            disabled={unsuppressing}
                            onClick={() => unsuppressMutation.mutate(r.user_email)}
                            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-border bg-surface hover:bg-surface-secondary disabled:opacity-50"
                            title="Remove this address from the suppression list so future replies attempt delivery again."
                          >
                            <RotateCw className={`h-3 w-3 ${unsuppressing ? 'animate-spin' : ''}`} />
                            {unsuppressing ? 'Unsuppressing…' : 'Unsuppress'}
                          </button>
                        ) : noteOpen ? (
                          <div className="flex flex-col gap-1">
                            <textarea
                              value={draft}
                              onChange={(e) =>
                                setNoteDrafts((prev) => ({ ...prev, [key]: e.target.value }))
                              }
                              maxLength={1000}
                              rows={2}
                              placeholder="Optional note (why suppress?)"
                              className="text-xs px-2 py-1 rounded border border-border bg-surface w-56"
                            />
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                disabled={suppressing}
                                onClick={() =>
                                  suppressMutation.mutate({
                                    email: r.user_email,
                                    notes: draft.trim() ? draft.trim() : null,
                                  })
                                }
                                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50"
                              >
                                <ShieldOff className="h-3 w-3" />
                                {suppressing ? 'Suppressing…' : 'Confirm'}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setShowNoteFor(null);
                                }}
                                className="text-xs px-2 py-1 rounded border border-border hover:bg-surface-secondary"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setShowNoteFor(key)}
                            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-orange-300 bg-orange-50 text-orange-800 hover:bg-orange-100 dark:bg-orange-950/40 dark:text-orange-200 dark:border-orange-900"
                            title="Stop every future support send to this address until an admin unsuppresses it."
                          >
                            <ShieldOff className="h-3 w-3" />
                            Suppress
                          </button>
                        )}
                        {rowError && (
                          <div className="text-[10px] text-red-600" title={rowError}>
                            {rowError}
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                  {openEmails.has(r.user_email) && (
                    <tr className="bg-surface-secondary/30">
                      <td colSpan={7} className="px-6 py-3">
                        <div className="text-xs text-text-muted mb-2">
                          Affected tickets (newest failure first):
                        </div>
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-text-muted">
                              <th className="text-left py-1 font-medium">Ticket</th>
                              <th className="text-left py-1 font-medium">Status</th>
                              <th className="text-left py-1 font-medium">Failures</th>
                              <th className="text-left py-1 font-medium">Last failure</th>
                              <th className="text-left py-1 font-medium">Last error</th>
                              <th className="py-1"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.tickets.map((tk) => (
                              <tr key={tk.ticket_id} className="border-t border-border/50">
                                <td className="py-1.5 pr-3 font-mono">{tk.ticket_id}</td>
                                <td className="py-1.5 pr-3">{tk.ticket_status}</td>
                                <td className="py-1.5 pr-3">{tk.occurrence_count}</td>
                                <td className="py-1.5 pr-3 text-text-muted">
                                  {new Date(tk.last_failure_at).toLocaleString()}
                                </td>
                                <td
                                  className="py-1.5 pr-3 text-red-700 max-w-xs truncate"
                                  title={tk.last_error}
                                >
                                  {tk.last_error}
                                </td>
                                <td className="py-1.5">
                                  <button
                                    type="button"
                                    onClick={() => onOpenTicket(tk.ticket_id)}
                                    className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-border hover:bg-surface"
                                  >
                                    <ExternalLink className="h-3 w-3" />
                                    Open ticket
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface UnsubscribedAddress {
  email_lower: string;
  source: string | null;
  unsubscribed_at: string;
}

interface RecentResubscribe {
  email_lower: string;
  resubscribed_source: string | null;
  resubscribed_at: string;
  previous_unsubscribed_at: string | null;
  previous_source: string | null;
}

interface UnsubscribedAddressesResponse {
  unsubscribes: UnsubscribedAddress[];
  total: number;
  truncated: boolean;
  recent_resubscribes?: RecentResubscribe[];
  resubscribe_window_days?: number;
  recent_resubscribes_truncated?: boolean;
}

// Lists addresses on the support unsubscribe list. The send-side gate
// (`checkSupportEmailSkip`) already blocks outbound mail to these recipients;
// this panel just gives ops a discoverable answer to "is X@Y opted out?"
// without dropping into SQL.
//
// We also surface a "Recently resubscribed" sub-section sourced from the
// `support_email_unsubscribe_audit` table. The resubscribe endpoint
// DELETEs the unsubscribe row, so without this audit trail an address
// would just silently disappear from the list with no explanation —
// support reps couldn't answer "I thought I asked to stop" complaints
// without grepping server logs. The window is 30 days (server-side
// constant), long enough to cover a typical complaint cycle.
function UnsubscribedAddressesPanel() {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['support-unsubscribed-addresses'],
    queryFn: () =>
      api.get<UnsubscribedAddressesResponse>(`/support/unsubscribed?limit=200`),
    refetchInterval: 60_000,
  });

  const unsubscribes = data?.unsubscribes ?? [];
  const total = data?.total ?? 0;
  const truncated = data?.truncated ?? false;
  const recentResubscribes = data?.recent_resubscribes ?? [];
  const resubscribeWindowDays = data?.resubscribe_window_days ?? 30;
  const recentResubscribesTruncated = data?.recent_resubscribes_truncated ?? false;

  // Hide the panel entirely only when BOTH lists are empty — a recent
  // resubscribe is itself useful context for ops ("the address you're
  // hunting for came off the list two days ago"), so we keep the panel
  // visible whenever either list has content. The inbox still stays
  // uncluttered in the truly-quiet case.
  if (!isLoading && unsubscribes.length === 0 && recentResubscribes.length === 0) {
    return null;
  }

  const needle = filter.trim().toLowerCase();
  const filteredUnsubs = needle
    ? unsubscribes.filter((u) => u.email_lower.includes(needle))
    : unsubscribes;
  const filteredResubs = needle
    ? recentResubscribes.filter((r) => r.email_lower.includes(needle))
    : recentResubscribes;

  // Header summary line — show counts for both lists so support reps can
  // tell at a glance whether the interesting signal is "lots of new
  // opt-outs" vs "a wave of resubscribes" without expanding the panel.
  const summaryParts: string[] = [];
  if (isLoading) {
    summaryParts.push('loading…');
  } else {
    summaryParts.push(
      `${total} address${total === 1 ? '' : 'es'} on the support opt-out list`,
    );
    if (truncated) {
      summaryParts.push(`showing first ${unsubscribes.length}`);
    }
    if (recentResubscribes.length > 0) {
      // Append "(more not shown)" when the audit window had more rows
      // than RESUBSCRIBE_LIMIT — otherwise ops has no way to tell
      // whether the panel is showing every resubscribe or just the
      // most-recent slice.
      const resubLabel = `${recentResubscribes.length}${recentResubscribesTruncated ? '+' : ''} resubscribed in the last ${resubscribeWindowDays} days`;
      summaryParts.push(resubLabel);
    }
  }

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-surface-secondary border-b border-border hover:bg-surface-secondary/70"
      >
        <div className="flex items-center gap-2 text-left">
          {expanded
            ? <ChevronDown className="h-4 w-4 text-text-muted" />
            : <ChevronRight className="h-4 w-4 text-text-muted" />}
          <MailX className="h-4 w-4 text-amber-600" />
          <div>
            <div className="text-sm font-medium">
              Unsubscribed addresses
              <span className="ml-2 text-xs text-text-muted font-normal">
                {summaryParts.join(' · ')}
              </span>
            </div>
            <div className="text-xs text-text-muted mt-0.5">
              Recipients who clicked the unsubscribe link or sent a one-click
              opt-out header. Outbound support replies skip these addresses
              automatically.
            </div>
          </div>
        </div>
      </button>
      {expanded && (
        <div>
          <div className="px-4 py-2 border-b border-border bg-surface">
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by email (e.g. user@example.com)"
              className="w-full max-w-sm text-xs px-2 py-1 rounded border border-border bg-surface"
            />
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface">
                <th className="text-left px-4 py-3 font-medium text-text-muted">Address</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">Source</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">Unsubscribed at</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={3} className="text-center py-8 text-text-muted">Loading…</td></tr>
              ) : filteredUnsubs.length === 0 ? (
                <tr><td colSpan={3} className="text-center py-8 text-text-muted">No matching addresses</td></tr>
              ) : (
                filteredUnsubs.map((u) => (
                  <tr
                    key={u.email_lower}
                    className="border-b border-border last:border-0 hover:bg-surface-secondary/50"
                  >
                    <td className="px-4 py-3 font-mono text-xs">{u.email_lower}</td>
                    <td className="px-4 py-3 text-xs text-text-muted">
                      {u.source ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-text-muted">
                      {new Date(u.unsubscribed_at).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {/* "Recently resubscribed" — populated from the audit table. We
              render it as a separate sub-section below the active opt-out
              list (instead of mixing the two) because the row meanings
              are different: the top table is "currently blocked", this
              one is "previously blocked but opted back in". Conflating
              them would make the first table lie about the live state of
              the send-side gate. */}
          {recentResubscribes.length > 0 && (
            <div>
              <div className="px-4 py-3 border-y border-border bg-surface-secondary/40">
                <div className="text-xs font-medium text-text-muted">
                  Recently resubscribed (last {resubscribeWindowDays} days)
                </div>
                <div className="text-[11px] text-text-muted mt-0.5">
                  Addresses that came off the opt-out list. Useful for
                  sanity-checking "I thought I asked to stop" complaints.
                </div>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface">
                    <th className="text-left px-4 py-3 font-medium text-text-muted">Address</th>
                    <th className="text-left px-4 py-3 font-medium text-text-muted">Resubscribed via</th>
                    <th className="text-left px-4 py-3 font-medium text-text-muted">Resubscribed at</th>
                    <th className="text-left px-4 py-3 font-medium text-text-muted">Originally opted out</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredResubs.length === 0 ? (
                    <tr><td colSpan={4} className="text-center py-6 text-text-muted">No matching resubscribes</td></tr>
                  ) : (
                    filteredResubs.map((r) => (
                      <tr
                        key={`${r.email_lower}-${r.resubscribed_at}`}
                        className="border-b border-border last:border-0 hover:bg-surface-secondary/50"
                      >
                        <td className="px-4 py-3 font-mono text-xs">{r.email_lower}</td>
                        <td className="px-4 py-3 text-xs text-text-muted">
                          {r.resubscribed_source ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-xs text-text-muted">
                          {new Date(r.resubscribed_at).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-xs text-text-muted">
                          {r.previous_unsubscribed_at
                            ? (
                              <>
                                {new Date(r.previous_unsubscribed_at).toLocaleString()}
                                {r.previous_source ? (
                                  <span className="ml-1 text-[11px]">
                                    (via {r.previous_source})
                                  </span>
                                ) : null}
                              </>
                            )
                            : '—'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TicketThread({ ticket }: { ticket: SupportTicket }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['support-ticket-replies', ticket.id],
    queryFn: () =>
      api.get<{ replies: SupportReply[]; suppression: SuppressionEntry | null }>(
        `/support/tickets/${ticket.id}/replies`,
      ),
    refetchInterval: 30_000,
  });

  // Suppression state for the ticket recipient. Drives the "Suppressed by
  // ops" pill above the conversation and the in-thread Suppress / Unsuppress
  // toggle. The mutations target the same admin endpoints as the Bounced
  // recipients panel, so a change in either place reflects in the other on
  // the next invalidation.
  const [threadSuppressError, setThreadSuppressError] = useState<string | null>(null);
  const [threadNoteOpen, setThreadNoteOpen] = useState(false);
  const [threadNoteDraft, setThreadNoteDraft] = useState('');

  const suppressFromThread = useMutation({
    mutationFn: ({ email, notes }: { email: string; notes: string | null }) =>
      api.post<{ success: boolean }>(`/support/email-suppressions`, {
        email,
        notes: notes ?? undefined,
      }),
    onSuccess: () => {
      setThreadSuppressError(null);
      setThreadNoteOpen(false);
      setThreadNoteDraft('');
      queryClient.invalidateQueries({ queryKey: ['support-ticket-replies', ticket.id] });
      queryClient.invalidateQueries({ queryKey: ['support-bounced-recipients'] });
    },
    onError: (err) => {
      setThreadSuppressError(err instanceof Error ? err.message : 'Suppress failed');
    },
  });

  const unsuppressFromThread = useMutation({
    mutationFn: (email: string) =>
      api.delete<{ success: boolean }>(
        `/support/email-suppressions/${encodeURIComponent(email.toLowerCase())}`,
      ),
    onSuccess: () => {
      setThreadSuppressError(null);
      queryClient.invalidateQueries({ queryKey: ['support-ticket-replies', ticket.id] });
      queryClient.invalidateQueries({ queryKey: ['support-bounced-recipients'] });
    },
    onError: (err) => {
      setThreadSuppressError(err instanceof Error ? err.message : 'Unsuppress failed');
    },
  });

  const sendReply = useMutation({
    mutationFn: (body: string) =>
      api.post<{ success: boolean; email_delivered: boolean; reply: SupportReply }>(
        `/support/tickets/${ticket.id}/replies`,
        { body },
      ),
    onSuccess: () => {
      setDraft('');
      queryClient.invalidateQueries({ queryKey: ['support-ticket-replies', ticket.id] });
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
    },
  });

  const changeStatus = useMutation({
    mutationFn: (status: string) =>
      api.patch(`/support/tickets/${ticket.id}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-ticket-replies', ticket.id] });
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      queryClient.invalidateQueries({ queryKey: ['support-ticket-stats'] });
    },
  });

  // Track which reply id is mid-retry and per-reply error text. Multiple
  // failed replies in the same thread can each have their own retry button.
  const [retryingReplyId, setRetryingReplyId] = useState<number | null>(null);
  const [retryErrors, setRetryErrors] = useState<Record<number, string>>({});
  // Tracks which reply (if any) is currently being marked as "stop auto-
  // retrying" so we can disable the button + show a spinning indicator.
  // Errors from that endpoint are surfaced inline next to the row.
  const [cancellingReplyId, setCancellingReplyId] = useState<number | null>(null);
  const [cancelErrors, setCancelErrors] = useState<Record<number, string>>({});
  // Per-reply cooldown timestamps (ms) until the corresponding Retry button
  // is allowed to fire again. Populated from `retry_after_seconds` on a 429
  // and from `retry_cooldown_seconds` on a successful retry, so admins see
  // the same per-reply cooldown the server enforces without round-tripping a
  // click first.
  const [retryCooldownByReply, setRetryCooldownByReply] = useState<Record<number, number>>({});

  const retryReply = useMutation({
    mutationFn: (replyId: number) =>
      api.post<{
        success: boolean;
        email_delivered: boolean;
        reply: SupportReply;
        retry_cooldown_seconds?: number;
      }>(
        `/support/tickets/${ticket.id}/replies/${replyId}/retry`,
        {},
      ),
    onMutate: (replyId) => {
      setRetryingReplyId(replyId);
      setRetryErrors((prev) => {
        if (!(replyId in prev)) return prev;
        const next = { ...prev };
        delete next[replyId];
        return next;
      });
    },
    onSuccess: (data, replyId) => {
      // Whether the retry delivered or not, the server has already updated the
      // existing reply row with the latest email_message_id / email_error and
      // we'll re-render it via the invalidated query — no extra inline error
      // is needed here (it would just duplicate the "Email delivery error: …"
      // line below the body).
      setRetryErrors((prev) => {
        if (!(replyId in prev)) return prev;
        const next = { ...prev };
        delete next[replyId];
        return next;
      });
      const cooldown = readPositiveSeconds(data, 'retry_cooldown_seconds');
      if (cooldown !== null) {
        const until = Date.now() + cooldown * 1000;
        setRetryCooldownByReply((prev) => ({ ...prev, [replyId]: until }));
      }
      queryClient.invalidateQueries({ queryKey: ['support-ticket-replies', ticket.id] });
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      queryClient.invalidateQueries({ queryKey: ['support-ticket-stats'] });
    },
    onError: (err, replyId) => {
      const status = (err as { status?: number } | null)?.status;
      const body = (err as { body?: unknown } | null)?.body;
      if (status === 429) {
        const wait = readPositiveSeconds(body, 'retry_after_seconds');
        if (wait !== null) {
          const until = Date.now() + wait * 1000;
          setRetryCooldownByReply((prev) => ({ ...prev, [replyId]: until }));
        }
      }
      // The HTTP call itself failed (network error, 5xx, etc.) so the row
      // state on the server didn't change — surface the transport error
      // inline so the admin knows the retry never actually ran.
      setRetryErrors((prev) => ({
        ...prev,
        [replyId]: err instanceof Error ? err.message : 'Retry failed',
      }));
    },
    onSettled: () => {
      setRetryingReplyId(null);
    },
  });

  // Manual "Stop auto-retries" — flips `retry_skipped_reason` to
  // `'manual_cancel'` on the server so the SupportReplyRetryScheduler will
  // skip this reply on its next sweep. Useful when ops has already replied
  // through another channel and doesn't want the customer to receive another
  // automated retry. The server returns the updated row so we can
  // invalidate the same caches as a successful retry.
  const cancelRetries = useMutation({
    mutationFn: (replyId: number) =>
      api.post<{ success: boolean; reply: SupportReply }>(
        `/support/tickets/${ticket.id}/replies/${replyId}/cancel-retries`,
        {},
      ),
    onMutate: (replyId) => {
      setCancellingReplyId(replyId);
      setCancelErrors((prev) => {
        if (!(replyId in prev)) return prev;
        const next = { ...prev };
        delete next[replyId];
        return next;
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-ticket-replies', ticket.id] });
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      queryClient.invalidateQueries({ queryKey: ['support-ticket-stats'] });
    },
    onError: (err, replyId) => {
      setCancelErrors((prev) => ({
        ...prev,
        [replyId]: err instanceof Error ? err.message : 'Cancel failed',
      }));
    },
    onSettled: () => {
      setCancellingReplyId(null);
    },
  });

  // Drive the per-row "Retry available in Xs" countdown by ticking once a
  // second while at least one reply still has time left on its cooldown.
  const nowMs = useCountdownTick(Object.values(retryCooldownByReply));

  const isResolved = ticket.status === 'resolved' || ticket.status === 'closed';

  const replies = data?.replies ?? [];
  const suppression = data?.suppression ?? null;
  const trimmed = draft.trim();
  const sendError = sendReply.error instanceof Error ? sendReply.error.message : null;
  const lastReply = sendReply.data;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div className="space-y-3">
        <div>
          <div className="text-xs font-medium text-text-muted mb-1">Original message</div>
          <pre className="whitespace-pre-wrap text-sm bg-surface p-3 rounded border border-border">{ticket.message}</pre>
          <div className="text-xs text-text-muted mt-1 flex items-center gap-2 flex-wrap">
            <span>
              {ticket.user_email ?? '—'} · {new Date(ticket.created_at).toLocaleString()}
            </span>
            {suppression && <SuppressedBadge suppression={suppression} size="xs" />}
          </div>
          {/* In-thread suppress / unsuppress controls. Placed next to the
              recipient identity so the action is obvious in context — admins
              don't have to scroll back up to the Bounced recipients panel
              to flip the flag for the address they're already looking at. */}
          {ticket.user_email && (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              {suppression ? (
                <button
                  type="button"
                  disabled={unsuppressFromThread.isPending}
                  onClick={() => unsuppressFromThread.mutate(ticket.user_email!)}
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-border bg-surface hover:bg-surface-secondary disabled:opacity-50"
                  title="Remove this address from the suppression list so future replies attempt delivery again."
                >
                  <RotateCw className={`h-3 w-3 ${unsuppressFromThread.isPending ? 'animate-spin' : ''}`} />
                  {unsuppressFromThread.isPending ? 'Unsuppressing…' : 'Unsuppress recipient'}
                </button>
              ) : threadNoteOpen ? (
                <div className="flex flex-col gap-1">
                  <textarea
                    value={threadNoteDraft}
                    onChange={(e) => setThreadNoteDraft(e.target.value)}
                    maxLength={1000}
                    rows={2}
                    placeholder="Optional note (why suppress?)"
                    className="text-xs px-2 py-1 rounded border border-border bg-surface w-72"
                  />
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={suppressFromThread.isPending}
                      onClick={() =>
                        suppressFromThread.mutate({
                          email: ticket.user_email!,
                          notes: threadNoteDraft.trim() ? threadNoteDraft.trim() : null,
                        })
                      }
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50"
                    >
                      <ShieldOff className="h-3 w-3" />
                      {suppressFromThread.isPending ? 'Suppressing…' : 'Confirm suppress'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setThreadNoteOpen(false);
                      }}
                      className="text-xs px-2 py-1 rounded border border-border hover:bg-surface-secondary"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setThreadNoteOpen(true)}
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-orange-300 bg-orange-50 text-orange-800 hover:bg-orange-100 dark:bg-orange-950/40 dark:text-orange-200 dark:border-orange-900"
                  title="Stop every future support send to this address until an admin unsuppresses it."
                >
                  <ShieldOff className="h-3 w-3" />
                  Suppress recipient
                </button>
              )}
              {threadSuppressError && (
                <div className="text-[10px] text-red-600" title={threadSuppressError}>
                  {threadSuppressError}
                </div>
              )}
            </div>
          )}
        </div>
        {ticket.recent_errors && (
          <div>
            <div className="text-xs font-medium text-text-muted mb-1">Recent errors</div>
            <pre className="whitespace-pre-wrap text-xs bg-red-50 dark:bg-red-950/20 p-3 rounded border border-border font-mono">{ticket.recent_errors}</pre>
          </div>
        )}
        {ticket.context && Object.keys(ticket.context).length > 0 && (
          <div>
            <div className="text-xs font-medium text-text-muted mb-1">Context</div>
            <pre className="text-xs bg-surface p-3 rounded border border-border font-mono">{JSON.stringify(ticket.context, null, 2)}</pre>
          </div>
        )}
        {ticket.email_error && (
          <div className="text-xs text-red-600 flex items-center gap-1 flex-wrap">
            <span>Initial email delivery error: {ticket.email_error}</span>
            {isHardBounce(ticket) && (
              <span
                className="ml-1 px-1.5 py-0.5 rounded border border-amber-300 bg-amber-50 text-amber-800 text-[10px] uppercase tracking-wide font-medium dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900"
                title="Permanent SMTP failure — auto-retry skipped"
              >
                Hard bounce — won&rsquo;t auto-retry
              </span>
            )}
            {/* Non-hard-bounce skip reasons (suppression, manual cancel,
                unsubscribed, future) get the descriptive badge so the detail
                view explains why the initial routed-send won't be re-attempted. */}
            {!isHardBounce(ticket) && ticket.retry_skipped_reason && (
              <RetrySkippedBadge reason={ticket.retry_skipped_reason} variant="long" />
            )}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div className="text-xs font-medium text-text-muted">Conversation</div>
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {isLoading ? (
            <div className="text-xs text-text-muted">Loading replies…</div>
          ) : replies.length === 0 ? (
            <div className="text-xs text-text-muted italic">No replies yet.</div>
          ) : (
            replies.map((r) => {
              if (r.direction === 'system') {
                return (
                  <div
                    key={r.id}
                    className="text-xs text-text-muted italic text-center py-1.5 px-3 border-y border-dashed border-border"
                  >
                    {r.body} · {new Date(r.created_at).toLocaleString()}
                  </div>
                );
              }
              const isOutbound = r.direction === 'outbound';
              // Drive the hard-bounce signal from the authoritative server
              // state. `permanent_failure` is the live flag the server
              // computes per request from email_error; `retry_skipped_reason`
              // is the persisted column the scheduler / write-paths stamp
              // (currently `'permanent_smtp_failure'`). Either one is enough
              // — they match for new rows and `retry_skipped_reason` keeps
              // the badge stable across renders for older rows whose server
              // flag may not be populated. `isHardBounce` falls back to the
              // legacy SMTP classifier on email_error for pre-migration rows.
              const isPermanentFailure =
                isOutbound &&
                !!r.email_error &&
                (r.permanent_failure === true || isHardBounce(r));
              // Any non-hard-bounce skip reason (manual cancel, suppression,
              // unsubscribed, …) — surface it as its own pill alongside the
              // generic Failed badge so ops sees *why* further auto-retries
              // were turned off without having to read the SMTP error string.
              const otherSkipDescriptor =
                isOutbound &&
                !!r.email_error &&
                !isPermanentFailure &&
                r.retry_skipped_reason
                  ? describeRetrySkippedReason(r.retry_skipped_reason)
                  : null;
              let badge: { label: string; className: string; title: string } | null = null;
              if (isOutbound) {
                if (r.email_error) {
                  badge = isPermanentFailure
                    ? {
                        // Distinct dark-red styling so a hard bounce reads
                        // differently from a transient "still down" failure.
                        // The retry button is suppressed for these rows.
                        label: 'Permanent failure',
                        className:
                          'bg-red-200 text-red-900 border-red-500 dark:bg-red-900/60 dark:text-red-100 dark:border-red-700',
                        title:
                          'Hard SMTP failure (5xx, address rejected, mailbox full, …) — won\'t retry. Investigate the recipient address before resending manually.',
                      }
                    : {
                        label: 'Failed',
                        className:
                          'bg-red-100 text-red-700 border-red-300 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900',
                        title: r.email_error,
                      };
                } else if (r.email_message_id) {
                  badge = {
                    label: 'Sent',
                    className: 'bg-green-100 text-green-700 border-green-300 dark:bg-green-950/40 dark:text-green-300 dark:border-green-900',
                    title: `SMTP message id: ${r.email_message_id}`,
                  };
                } else {
                  badge = {
                    label: 'Logged (dev)',
                    className: 'bg-muted/30 text-text-muted border-border',
                    title: 'No SMTP delivery — reply was logged to the server console (development mode).',
                  };
                }
              }
              // Suppress the retry button for hard bounces: re-sending to a
              // recipient the server has explicitly rejected only burns
              // sender reputation (server enforces the same gate via 409).
              // We allow manual retry for the other skip reasons (suppression
              // / manual cancel / unsubscribe) on purpose — admins still need
              // an escape hatch in case the suppression entry was wrong, the
              // cancel was a mistake, or the unsubscribe was for a different
              // address. The server returns 409 if it disagrees, so even a
              // mis-click can't actually re-send to a hard-bounced recipient.
              const canRetry =
                isOutbound && !!r.email_error && !isPermanentFailure && !!ticket.user_email;
              // Show the "Stop auto-retries" button only when the row is
              // currently failing AND hasn't already been skipped by some
              // other path (hard bounce / manual cancel / etc.). Hard bounces
              // already leave the auto-retry pool on their own.
              const canCancelRetries =
                isOutbound &&
                !!r.email_error &&
                !isPermanentFailure &&
                !r.retry_skipped_reason;
              const isRetrying = retryingReplyId === r.id && retryReply.isPending;
              const retryError = retryErrors[r.id];
              const cooldownUntil = retryCooldownByReply[r.id] ?? 0;
              const retrySecondsLeft = Math.max(0, Math.ceil((cooldownUntil - nowMs) / 1000));
              const retryDisabled = isRetrying || retrySecondsLeft > 0;
              const retryLabel = isRetrying
                ? 'Retrying…'
                : retrySecondsLeft > 0
                  ? `Retry available in ${retrySecondsLeft}s`
                  : 'Retry send';
              return (
                <div
                  key={r.id}
                  className={`p-3 rounded border ${
                    isOutbound
                      ? r.email_error
                        ? 'bg-red-50 border-red-300 dark:bg-red-950/20 dark:border-red-900'
                        : 'bg-primary/5 border-primary/20'
                      : 'bg-surface border-border'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs text-text-muted mb-1 gap-2">
                    <span className="flex items-center gap-2 min-w-0 flex-wrap">
                      <strong className="text-text-primary">
                        {isOutbound ? 'Support' : 'Customer'}
                      </strong>
                      {r.author_email ? <span className="truncate">· {r.author_email}</span> : null}
                      {badge && (
                        <span
                          title={badge.title}
                          className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium uppercase tracking-wide cursor-help ${badge.className}`}
                        >
                          {badge.label}
                        </span>
                      )}
                      {/* Distinct skip-reason pill (manual cancel, suppression,
                          unsubscribed, …) — keeps the existing "Failed" / "Permanent
                          failure" semantics intact while explaining *why* further
                          auto-retries are off. Hard bounces are intentionally
                          excluded because the "Permanent failure" badge above
                          already conveys that. */}
                      {otherSkipDescriptor && (
                        <RetrySkippedBadge reason={r.retry_skipped_reason!} />
                      )}
                      {canRetry && (
                        <button
                          type="button"
                          onClick={() => retryReply.mutate(r.id)}
                          disabled={retryDisabled}
                          title={
                            retrySecondsLeft > 0
                              ? `Server-side cooldown active. Re-enables in ${retrySecondsLeft}s.`
                              : `Re-send to ${ticket.user_email}`
                          }
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-red-300 dark:border-red-900 bg-white dark:bg-red-950/20 text-red-700 dark:text-red-300 text-[11px] font-medium hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          <RotateCw className={`h-3 w-3 ${isRetrying ? 'animate-spin' : ''}`} />
                          {retryLabel}
                        </button>
                      )}
                      {canCancelRetries && (
                        <button
                          type="button"
                          onClick={() => cancelRetries.mutate(r.id)}
                          disabled={cancellingReplyId === r.id && cancelRetries.isPending}
                          title="Stop the background scheduler from auto-retrying this reply. Use after you've already replied to the customer through another channel."
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-border bg-surface text-text-muted text-[11px] font-medium hover:bg-surface-secondary disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          Stop auto-retries
                        </button>
                      )}
                    </span>
                    <span className="shrink-0">{new Date(r.created_at).toLocaleString()}</span>
                  </div>
                  <div className="whitespace-pre-wrap text-sm">{r.body}</div>
                  {r.email_error && (
                    <div className="text-xs text-red-600 mt-1">
                      Email delivery error: {r.email_error}
                      {isPermanentFailure && (
                        <div className="text-amber-700 dark:text-amber-400 mt-0.5">
                          Classified as a permanent SMTP failure — the
                          background scheduler will not auto-retry this reply.
                          Use “Retry send” above only after fixing the
                          recipient address.
                        </div>
                      )}
                    </div>
                  )}
                  {isPermanentFailure && (
                    <div className="text-xs text-red-700 dark:text-red-300 mt-1">
                      Won&apos;t retry — recipient address was permanently rejected. Fix the address (or
                      reply to the customer through another channel) before resending manually.
                    </div>
                  )}
                  {retryError && (
                    <div className="text-xs text-red-600 mt-1">Retry failed: {retryError}</div>
                  )}
                  {cancelErrors[r.id] && (
                    <div className="text-xs text-red-600 mt-1">
                      Couldn&rsquo;t stop auto-retries: {cancelErrors[r.id]}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="space-y-2 pt-2 border-t border-border">
          <label className="text-xs font-medium text-text-muted">
            Reply to {ticket.user_email ?? 'customer'}
          </label>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={5}
            placeholder="Type your reply…"
            className="w-full text-sm rounded-lg border border-border bg-surface p-3 focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs text-text-muted">
              Sent via the same SMTP path. Customer replies thread back automatically.
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => changeStatus.mutate(isResolved ? 'open' : 'resolved')}
                disabled={changeStatus.isPending}
                className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg border border-border bg-surface hover:bg-surface-secondary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {changeStatus.isPending
                  ? 'Updating…'
                  : isResolved
                    ? 'Reopen ticket'
                    : 'Mark resolved'}
              </button>
              <button
                type="button"
                onClick={() => trimmed && sendReply.mutate(trimmed)}
                disabled={!trimmed || sendReply.isPending || !ticket.user_email}
                className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg bg-primary text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Mail className="h-3.5 w-3.5" />
                {sendReply.isPending ? 'Sending…' : 'Send reply'}
              </button>
            </div>
          </div>
          {changeStatus.error instanceof Error && (
            <div className="text-xs text-red-600">{changeStatus.error.message}</div>
          )}
          {sendError && <div className="text-xs text-red-600">{sendError}</div>}
          {lastReply && !sendError && (
            <div className="text-xs text-green-600">
              {lastReply.email_delivered ? 'Reply sent.' : 'Reply recorded, but email delivery failed.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CostMonitoringTab({ data, loading }: { data: { monitoring: CostMonitoringData } | undefined; loading: boolean }) {
  if (loading) return <div className="text-center py-12 text-text-muted">Loading cost data...</div>;
  if (!data) return <div className="text-center py-12 text-text-muted">No data available</div>;

  const m = data.monitoring;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="h-4 w-4 text-text-muted" />
            <span className="text-sm text-text-muted">Daily Call Minutes</span>
          </div>
          <div className="text-2xl font-bold">{m.daily.callMinutes.toLocaleString()}</div>
          <div className="text-xs text-text-muted mt-1">{m.daily.callCount} calls today</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="h-4 w-4 text-text-muted" />
            <span className="text-sm text-text-muted">Daily AI Cost</span>
          </div>
          <div className="text-2xl font-bold">{formatCents(String(m.daily.aiCostCents))}</div>
          <div className="text-xs text-text-muted mt-1">{formatCents(String(m.daily.totalCostCents))} total cost</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <PhoneCall className="h-4 w-4 text-text-muted" />
            <span className="text-sm text-text-muted">Daily Twilio Spend</span>
          </div>
          <div className="text-2xl font-bold">{formatCents(String(m.daily.twilioCostCents))}</div>
          <div className="text-xs text-text-muted mt-1">SMS: {formatCents(String(m.daily.smsCostCents))}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Users className="h-4 w-4 text-text-muted" />
            <span className="text-sm text-text-muted">Active Trials</span>
          </div>
          <div className="text-2xl font-bold">{m.trials.activeTrials}</div>
          <div className="text-xs text-text-muted mt-1">{m.trials.paidAccounts} paid accounts</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface border border-border rounded-xl p-6">
          <h3 className="font-semibold mb-4">Trial-to-Paid Conversion</h3>
          <div className="flex items-center gap-4">
            <div className="text-4xl font-bold text-primary">{m.trials.conversionRate}%</div>
            <div className="text-sm text-text-muted">
              <div>{m.trials.paidAccounts} paid / {m.trials.totalAccounts} total</div>
              <div>{m.trials.activeTrials} active trials</div>
            </div>
          </div>
        </div>

        <div className="bg-surface border border-border rounded-xl p-6">
          <h3 className="font-semibold mb-4">Unit Economics</h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-xs text-text-muted mb-1">Cost/Call</div>
              <div className="text-lg font-bold">{formatCents(String(m.economics.costPerCallCents))}</div>
            </div>
            <div>
              <div className="text-xs text-text-muted mb-1">Revenue/Call</div>
              <div className="text-lg font-bold text-green-600 dark:text-green-400">{formatCents(String(m.economics.revenuePerCallCents))}</div>
            </div>
            <div>
              <div className="text-xs text-text-muted mb-1">Margin/Call</div>
              <div className={`text-lg font-bold ${m.economics.marginPerCallCents >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {formatCents(String(m.economics.marginPerCallCents))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-6">
        <h3 className="font-semibold mb-4">Monthly Summary</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          <div>
            <div className="text-xs text-text-muted mb-1">Call Minutes</div>
            <div className="text-lg font-bold">{m.monthly.callMinutes.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">Total Calls</div>
            <div className="text-lg font-bold">{m.monthly.callCount.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">AI Cost</div>
            <div className="text-lg font-bold">{formatCents(String(m.monthly.aiCostCents))}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">Twilio Cost</div>
            <div className="text-lg font-bold">{formatCents(String(m.monthly.twilioCostCents))}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">Total Cost</div>
            <div className="text-lg font-bold">{formatCents(String(m.monthly.totalCostCents))}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">Revenue</div>
            <div className="text-lg font-bold text-green-600 dark:text-green-400">{formatCents(String(m.monthly.revenueCents))}</div>
          </div>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-6">
        <h3 className="font-semibold mb-4">Daily Usage (Tool & API)</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs text-text-muted mb-1">Tool Executions Today</div>
            <div className="text-lg font-bold">{m.daily.toolExecutions.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">API Requests Today</div>
            <div className="text-lg font-bold">{m.daily.apiRequests.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {m.trend.length > 0 && (
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="font-semibold">30-Day Trend</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Date</th>
                  <th className="text-right px-4 py-3 font-medium text-text-muted">Calls</th>
                  <th className="text-right px-4 py-3 font-medium text-text-muted">Minutes</th>
                  <th className="text-right px-4 py-3 font-medium text-text-muted">Cost</th>
                </tr>
              </thead>
              <tbody>
                {m.trend.map((day) => (
                  <tr key={day.day} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 text-text-muted">{new Date(day.day).toLocaleDateString()}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{day.callCount}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{day.callMinutes}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatCents(String(day.totalCostCents))}</td>
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

function SortableHeader({ label, field, currentField, currentDir, onSort }: {
  label: string;
  field: SortField;
  currentField: SortField;
  currentDir: SortDir;
  onSort: (f: SortField) => void;
}) {
  const active = field === currentField;
  return (
    <th
      className="text-right px-4 py-3 font-medium text-text-muted cursor-pointer select-none hover:text-text-primary transition-colors"
      onClick={() => onSort(field)}
    >
      <span className="inline-flex items-center gap-1 justify-end">
        {label}
        {active ? (
          <span className="text-primary text-[10px]">{currentDir === 'asc' ? '\u25B2' : '\u25BC'}</span>
        ) : (
          <span className="text-text-muted/40 text-[10px]">{'\u25BC'}</span>
        )}
      </span>
    </th>
  );
}

function BarChart({ data, labelKey, valueKey, secondaryKey, barColor, secondaryColor }: {
  data: TemplateAnalytics[];
  labelKey: keyof TemplateAnalytics;
  valueKey: keyof TemplateAnalytics;
  secondaryKey?: keyof TemplateAnalytics;
  barColor: string;
  secondaryColor?: string;
}) {
  const maxVal = Math.max(...data.map(d => Number(d[valueKey]) || 0), 1);
  return (
    <div className="space-y-2">
      {data.map((d) => {
        const val = Number(d[valueKey]) || 0;
        const secVal = secondaryKey ? (Number(d[secondaryKey]) || 0) : 0;
        const pct = (val / maxVal) * 100;
        const secPct = secondaryKey ? (secVal / maxVal) * 100 : 0;
        return (
          <div key={d.id} className="flex items-center gap-3">
            <div className="w-32 truncate text-xs text-text-muted text-right" title={String(d[labelKey])}>
              {String(d[labelKey])}
            </div>
            <div className="flex-1 flex items-center gap-1">
              <div className="flex-1 h-5 bg-surface-hover rounded overflow-hidden relative">
                {secondaryKey && (
                  <div
                    className={`absolute top-0 left-0 h-full rounded ${secondaryColor ?? 'bg-primary/30'}`}
                    style={{ width: `${secPct}%` }}
                  />
                )}
                <div
                  className={`absolute top-0 left-0 h-full rounded ${barColor}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-xs tabular-nums text-text-muted w-12 text-right">{val.toLocaleString()}</span>
              {secondaryKey && (
                <span className="text-xs tabular-nums text-text-muted/60 w-12 text-right">{secVal.toLocaleString()}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TemplateAnalyticsTab({ data, loading, sortField, sortDir, onSort }: {
  data: { templates: TemplateAnalytics[] } | undefined;
  loading: boolean;
  sortField: SortField;
  sortDir: SortDir;
  onSort: (f: SortField) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!data?.templates?.length) {
    return (
      <div className="bg-surface border border-border rounded-xl p-12 text-center">
        <BarChart3 className="h-10 w-10 text-text-muted mx-auto mb-3" />
        <p className="text-text-muted">No template analytics data available yet.</p>
        <p className="text-xs text-text-muted mt-1">Analytics will populate as tenants install and use templates.</p>
      </div>
    );
  }

  const templates = data.templates;
  const sorted = [...templates].sort((a, b) => {
    const aVal = a[sortField];
    const bVal = b[sortField];
    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    return sortDir === 'asc' ? (Number(aVal) - Number(bVal)) : (Number(bVal) - Number(aVal));
  });

  const chartData = [...templates].sort((a, b) => b.totalInstalls - a.totalInstalls).slice(0, 10);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={DownloadIcon}
          label="Total Installs"
          value={String(templates.reduce((s, t) => s + t.totalInstalls, 0))}
          sub={`${templates.reduce((s, t) => s + t.activeInstalls, 0)} active`}
        />
        <StatCard
          icon={Activity}
          label="Avg Activation Rate"
          value={`${templates.length > 0 ? Math.round(templates.reduce((s, t) => s + t.activationRate, 0) / templates.length) : 0}%`}
        />
        <StatCard
          icon={PhoneCall}
          label="Template Calls (30d)"
          value={String(templates.reduce((s, t) => s + t.callsLast30d, 0))}
          sub={`${templates.reduce((s, t) => s + t.totalCalls, 0)} total`}
        />
        <StatCard
          icon={TrendingUp}
          label="Avg Satisfaction"
          value={(() => {
            const withScores = templates.filter(t => t.avgSatisfaction > 0);
            return withScores.length > 0
              ? (withScores.reduce((s, t) => s + t.avgSatisfaction, 0) / withScores.length).toFixed(1)
              : '\u2014';
          })()}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface border border-border rounded-xl p-5">
          <h3 className="font-semibold text-sm mb-1">Installs by Template</h3>
          <p className="text-xs text-text-muted mb-4">Total installs (dark) vs active installs (light)</p>
          <BarChart data={chartData} labelKey="displayName" valueKey="activeInstalls" secondaryKey="totalInstalls" barColor="bg-primary" secondaryColor="bg-primary/25" />
        </div>
        <div className="bg-surface border border-border rounded-xl p-5">
          <h3 className="font-semibold text-sm mb-1">Call Volume by Template (30d)</h3>
          <p className="text-xs text-text-muted mb-4">Calls generated through template-installed agents</p>
          <BarChart data={[...templates].sort((a, b) => b.callsLast30d - a.callsLast30d).slice(0, 10)} labelKey="displayName" valueKey="callsLast30d" barColor="bg-green-500" />
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="font-semibold">Template Performance</h2>
          <p className="text-xs text-text-muted mt-0.5">Click column headers to sort. Includes call and campaign metrics.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-3 font-medium text-text-muted cursor-pointer select-none hover:text-text-primary" onClick={() => onSort('displayName')}>
                  <span className="inline-flex items-center gap-1">
                    Template
                    {sortField === 'displayName' ? <span className="text-primary text-[10px]">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span> : <span className="text-text-muted/40 text-[10px]">{'\u25BC'}</span>}
                  </span>
                </th>
                <SortableHeader label="Installs" field="totalInstalls" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <th className="text-right px-4 py-3 font-medium text-text-muted">Active</th>
                <SortableHeader label="Activation" field="activationRate" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <SortableHeader label="Upgrade Adoption" field="upgradeAdoption" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <SortableHeader label="Uninstalls" field="uninstallRate" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <SortableHeader label="Calls (30d)" field="callsLast30d" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <SortableHeader label="Campaigns" field="totalCampaigns" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <th className="text-right px-4 py-3 font-medium text-text-muted">Avg Duration</th>
                <SortableHeader label="CSAT" field="avgSatisfaction" currentField={sortField} currentDir={sortDir} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((t) => (
                <tr key={t.id} className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                  <td className="px-4 py-3">
                    <div className="font-medium">{t.displayName}</div>
                    <div className="text-xs text-text-muted font-mono">{t.slug} · v{t.currentVersion}</div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.totalInstalls}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.activeInstalls}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={`inline-flex items-center gap-1 ${t.activationRate >= 70 ? 'text-green-600 dark:text-green-400' : t.activationRate >= 40 ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'}`}>
                      {t.activationRate >= 70 ? <TrendingUp className="h-3 w-3" /> : t.activationRate < 40 ? <TrendingDown className="h-3 w-3" /> : null}
                      {t.activationRate}%
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <span className={`inline-flex items-center gap-1 ${t.upgradeAdoption >= 50 ? 'text-green-600 dark:text-green-400' : t.upgradeAdoption >= 20 ? 'text-yellow-600 dark:text-yellow-400' : 'text-text-muted'}`}>
                      {t.upgradeAdoption}%
                      <span className="text-text-muted/60">({t.upgradeCount})</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <span className={t.uninstallRate > 30 ? 'text-red-600 dark:text-red-400' : ''}>{t.uninstallCount} ({t.uninstallRate}%)</span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.callsLast30d.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.totalCampaigns > 0 ? `${t.completedCampaigns}/${t.totalCampaigns}` : '\u2014'}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.avgCallDuration > 0 ? `${Math.floor(t.avgCallDuration / 60)}m ${t.avgCallDuration % 60}s` : '\u2014'}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.avgSatisfaction > 0 ? t.avgSatisfaction.toFixed(1) : '\u2014'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {templates.map((t) => (
          <div key={t.id} className="bg-surface border border-border rounded-xl p-5">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="font-semibold text-sm">{t.displayName}</h3>
                <p className="text-xs text-text-muted">v{t.currentVersion}</p>
              </div>
              <StatusBadge status={t.status} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <MetricItem label="Conversion Rate" value={`${t.activationRate}%`} trend={t.activationRate >= 50 ? 'up' : t.activationRate >= 20 ? 'neutral' : 'down'} />
              <MetricItem label="Avg Call Duration" value={t.avgCallDuration > 0 ? `${Math.floor(t.avgCallDuration / 60)}m ${t.avgCallDuration % 60}s` : '\u2014'} />
              <MetricItem label="CSAT Score" value={t.avgSatisfaction > 0 ? t.avgSatisfaction.toFixed(1) : '\u2014'} trend={t.avgSatisfaction >= 4 ? 'up' : t.avgSatisfaction >= 3 ? 'neutral' : t.avgSatisfaction > 0 ? 'down' : undefined} />
              <MetricItem label="Calls (30d)" value={t.callsLast30d.toLocaleString()} />
              <MetricItem label="Upgrade Adoption" value={`${t.upgradeAdoption}%`} trend={t.upgradeAdoption >= 50 ? 'up' : t.upgradeAdoption >= 20 ? 'neutral' : 'down'} />
              <MetricItem label="Uninstall Rate" value={`${t.uninstallRate}%`} trend={t.uninstallRate <= 10 ? 'up' : t.uninstallRate <= 30 ? 'neutral' : 'down'} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricItem({ label, value, trend }: { label: string; value: string; trend?: 'up' | 'down' | 'neutral' }) {
  return (
    <div>
      <p className="text-xs text-text-muted mb-0.5">{label}</p>
      <div className="flex items-center gap-1">
        <span className="text-sm font-semibold">{value}</span>
        {trend === 'up' && <TrendingUp className="h-3 w-3 text-green-500" />}
        {trend === 'down' && <TrendingDown className="h-3 w-3 text-red-500" />}
      </div>
    </div>
  );
}

function MilestoneIcon({ done }: { done: boolean }) {
  if (done) return <CheckCircle className="h-4 w-4 text-green-500" />;
  return <AlertCircle className="h-4 w-4 text-text-muted" />;
}

function formatHours(hours: number | null): string {
  if (hours === null) return '\u2014';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

// Shape returned by `/platform/onboarding-funnel` (Task #612). All counts
// are bucketised server-side with FILTER (...) over the canonicalised
// step + completed flags so the UI just renders the numbers.
interface OnboardingFunnel {
  total: number;
  completed: number;
  step_1: number;
  step_2: number;
  step_3: number;
}

function OnboardingFunnelCards() {
  const [days, setDays] = useState(30);
  const { data, isLoading } = useQuery({
    queryKey: ['platform-onboarding-funnel', days],
    queryFn: () =>
      api.get<{ days: number; funnel: OnboardingFunnel }>(
        `/platform/onboarding-funnel?days=${days}`,
      ),
    refetchInterval: 60_000,
  });
  const funnel = data?.funnel;
  // Percent-of-total helper. Returns "—" when the total is 0 so the card
  // doesn't render a bogus "0%" the moment the platform is freshly
  // bootstrapped.
  const pct = (n: number | undefined): string => {
    if (!funnel || !funnel.total) return '—';
    const v = n ?? 0;
    return `${Math.round((v / funnel.total) * 100)}%`;
  };
  return (
    <div className="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-semibold">Onboarding wizard funnel</h2>
          <p className="text-xs text-text-muted">
            Where new tenant owners stand in the 3-step setup wizard, scoped to
            users that signed up in the selected window.
          </p>
        </div>
        <select
          aria-label="Funnel window"
          value={days}
          onChange={(e) => setDays(parseInt(e.target.value, 10))}
          className="text-sm border border-border rounded-lg px-2 py-1 bg-surface focus:outline-none focus:ring-2 focus:ring-primary/50"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
      {isLoading ? (
        <div className="text-sm text-text-muted">Loading funnel...</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div className="border border-border rounded-lg p-3">
            <div className="text-xs text-text-muted">New owners</div>
            <div className="text-2xl font-bold">{funnel?.total ?? 0}</div>
            <div className="text-xs text-text-muted mt-1">in window</div>
          </div>
          <div className="border border-border rounded-lg p-3">
            <div className="text-xs text-text-muted">Step 1 · Provisioning</div>
            <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">
              {funnel?.step_1 ?? 0}
            </div>
            <div className="text-xs text-text-muted mt-1">
              {pct(funnel?.step_1)} of new
            </div>
          </div>
          <div className="border border-border rounded-lg p-3">
            <div className="text-xs text-text-muted">Step 2 · Template</div>
            <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">
              {funnel?.step_2 ?? 0}
            </div>
            <div className="text-xs text-text-muted mt-1">
              {pct(funnel?.step_2)} of new
            </div>
          </div>
          <div className="border border-border rounded-lg p-3">
            <div className="text-xs text-text-muted">Step 3 · Phone number</div>
            <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">
              {funnel?.step_3 ?? 0}
            </div>
            <div className="text-xs text-text-muted mt-1">
              {pct(funnel?.step_3)} of new
            </div>
          </div>
          <div className="border border-border rounded-lg p-3">
            <div className="text-xs text-text-muted">Completed</div>
            <div className="text-2xl font-bold text-green-600 dark:text-green-400">
              {funnel?.completed ?? 0}
            </div>
            <div className="text-xs text-text-muted mt-1">
              {pct(funnel?.completed)} of new
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ActivationMetricsTab({ data, loading }: { data: { metrics: ActivationMetricRow[] } | undefined; loading: boolean }) {
  // Render the wizard funnel even if the per-tenant activation table is
  // still loading or empty — the two are independent queries and product
  // cares about the funnel even on a fresh platform with no completed
  // activations yet.
  if (loading) {
    return (
      <div className="space-y-6">
        <OnboardingFunnelCards />
        <div className="text-center py-12 text-text-muted">Loading activation metrics...</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-6">
        <OnboardingFunnelCards />
        <div className="text-center py-12 text-text-muted">No data available</div>
      </div>
    );
  }

  const metrics = data.metrics;
  const totalTenants = metrics.length;
  const withAgent = metrics.filter((m) => m.agent_created_at).length;
  const withCall = metrics.filter((m) => m.first_call_at).length;
  const withWorkflow = metrics.filter((m) => m.first_workflow_at).length;
  const stuckTenants = metrics.filter((m) => m.milestones_completed < 2 && m.milestones_completed > 0);

  const TOTAL_MILESTONES = 6;
  const avgTimeToAgent = metrics
    .filter((m) => m.time_to_agent_hours !== null)
    .reduce((sum, m, _, arr) => sum + (m.time_to_agent_hours ?? 0) / arr.length, 0);
  const avgTimeToCall = metrics
    .filter((m) => m.time_to_call_hours !== null)
    .reduce((sum, m, _, arr) => sum + (m.time_to_call_hours ?? 0) / arr.length, 0);
  const avgTimeToWorkflow = metrics
    .filter((m) => m.time_to_workflow_hours !== null)
    .reduce((sum, m, _, arr) => sum + (m.time_to_workflow_hours ?? 0) / arr.length, 0);

  return (
    <div className="space-y-6">
      <OnboardingFunnelCards />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="text-sm text-text-muted mb-1">Agent Created</div>
          <div className="text-2xl font-bold">{withAgent} <span className="text-sm text-text-muted font-normal">/ {totalTenants}</span></div>
          <div className="text-xs text-text-muted mt-1">Avg time: {formatHours(avgTimeToAgent)}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="text-sm text-text-muted mb-1">First Call</div>
          <div className="text-2xl font-bold">{withCall} <span className="text-sm text-text-muted font-normal">/ {totalTenants}</span></div>
          <div className="text-xs text-text-muted mt-1">Avg time: {formatHours(avgTimeToCall)}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="text-sm text-text-muted mb-1">First Workflow</div>
          <div className="text-2xl font-bold">{withWorkflow} <span className="text-sm text-text-muted font-normal">/ {totalTenants}</span></div>
          <div className="text-xs text-text-muted mt-1">Avg time: {formatHours(avgTimeToWorkflow)}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="text-sm text-text-muted mb-1">Stuck Tenants</div>
          <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">{stuckTenants.length}</div>
          <div className="text-xs text-text-muted mt-1">Started but stalled (&lt;2 milestones)</div>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="font-semibold">Tenant Activation Progress</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-3 font-medium text-text-muted">Tenant</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">Plan</th>
                <th className="text-center px-4 py-3 font-medium text-text-muted">Agent</th>
                <th className="text-center px-4 py-3 font-medium text-text-muted">Deploy</th>
                <th className="text-center px-4 py-3 font-medium text-text-muted">Phone</th>
                <th className="text-center px-4 py-3 font-medium text-text-muted">Tools</th>
                <th className="text-center px-4 py-3 font-medium text-text-muted">1st Call</th>
                <th className="text-center px-4 py-3 font-medium text-text-muted">Workflow</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">Time to Agent</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">Time to Call</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">Time to Workflow</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">Progress</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((m) => (
                <tr key={m.tenant_id} className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                  <td className="px-4 py-3">
                    <div className="font-medium">{m.tenant_name}</div>
                    <div className="text-xs text-text-muted">{new Date(m.tenant_created_at).toLocaleDateString()}</div>
                  </td>
                  <td className="px-4 py-3"><PlanBadge plan={m.tenant_plan} /></td>
                  <td className="px-4 py-3 text-center"><MilestoneIcon done={!!m.agent_created_at} /></td>
                  <td className="px-4 py-3 text-center"><MilestoneIcon done={!!m.agent_deployed_at} /></td>
                  <td className="px-4 py-3 text-center"><MilestoneIcon done={!!m.phone_connected_at} /></td>
                  <td className="px-4 py-3 text-center"><MilestoneIcon done={!!m.tools_connected_at} /></td>
                  <td className="px-4 py-3 text-center"><MilestoneIcon done={!!m.first_call_at} /></td>
                  <td className="px-4 py-3 text-center"><MilestoneIcon done={!!m.first_workflow_at} /></td>
                  <td className="px-4 py-3 text-text-muted">{formatHours(m.time_to_agent_hours)}</td>
                  <td className="px-4 py-3 text-text-muted">{formatHours(m.time_to_call_hours)}</td>
                  <td className="px-4 py-3 text-text-muted">{formatHours(m.time_to_workflow_hours)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-16 bg-surface-hover rounded-full h-2">
                        <div
                          className={`h-2 rounded-full ${
                            m.milestones_completed >= 5 ? 'bg-green-500' :
                            m.milestones_completed >= 3 ? 'bg-blue-500' :
                            m.milestones_completed >= 1 ? 'bg-amber-500' : 'bg-gray-400'
                          }`}
                          style={{ width: `${Math.round((m.milestones_completed / TOTAL_MILESTONES) * 100)}%` }}
                        />
                      </div>
                      <span className="text-xs text-text-muted">{m.milestones_completed}/{TOTAL_MILESTONES}</span>
                    </div>
                  </td>
                </tr>
              ))}
              {metrics.length === 0 && (
                <tr><td colSpan={12} className="text-center py-12 text-text-muted">No tenant data yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
