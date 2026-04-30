import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { hasMinRole } from '../lib/useRole';
import { formatCents as formatCentsHelper, formatCurrency } from '../lib/formatCurrency';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
import BillingEstimator from '../components/BillingEstimator';
import {
  ANNUAL_DISCOUNT,
  getDiscountedBasePrice,
  type BillingPeriod,
} from '../components/MinutesPricingCalculator';
import { getPlanMonthlyPriceCents, type PlanTier } from '../../../shared/billing/planCatalog';
import {
  CreditCard, ExternalLink, AlertCircle, TrendingUp,
  Phone, MessageSquare, Brain, Zap, ArrowUpRight,
  FileText, Download, Clock, CheckCircle2, XCircle,
  Sparkles, AlertTriangle, FileEdit, MinusCircle, Loader2,
} from 'lucide-react';
import { StatusBadge, type BadgeTone } from '../components/ui';

interface StatusMeta { tone: BadgeTone; icon: React.ReactNode; tooltip: string; }

function subscriptionMeta(status: string): StatusMeta {
  if (status === 'active') return { tone: 'success', icon: <CheckCircle2 className="h-3 w-3" aria-hidden="true" />, tooltip: 'Subscription is active and billing normally' };
  if (status === 'trialing') return { tone: 'primary', icon: <Sparkles className="h-3 w-3" aria-hidden="true" />, tooltip: 'Free trial — full access until the trial ends' };
  if (status === 'past_due') return { tone: 'warning', icon: <AlertTriangle className="h-3 w-3" aria-hidden="true" />, tooltip: 'Payment is past due — update your card to keep service running' };
  if (status === 'incomplete') return { tone: 'warning', icon: <Loader2 className="h-3 w-3" aria-hidden="true" />, tooltip: 'Subscription setup is incomplete — finish payment to activate' };
  if (status === 'canceled' || status === 'cancelled') return { tone: 'danger', icon: <XCircle className="h-3 w-3" aria-hidden="true" />, tooltip: 'Subscription has been cancelled' };
  return { tone: 'neutral', icon: <MinusCircle className="h-3 w-3" aria-hidden="true" />, tooltip: 'No active paid subscription — using the free tier' };
}

function invoiceMeta(status: string): StatusMeta {
  if (status === 'paid') return { tone: 'success', icon: <CheckCircle2 className="h-3 w-3" aria-hidden="true" />, tooltip: 'Invoice has been paid in full' };
  if (status === 'open') return { tone: 'primary', icon: <Clock className="h-3 w-3" aria-hidden="true" />, tooltip: 'Invoice is open and awaiting payment' };
  if (status === 'draft') return { tone: 'neutral', icon: <FileEdit className="h-3 w-3" aria-hidden="true" />, tooltip: 'Invoice is in draft and not yet finalised' };
  if (status === 'void') return { tone: 'neutral', icon: <MinusCircle className="h-3 w-3" aria-hidden="true" />, tooltip: 'Invoice was voided and is no longer owed' };
  if (status === 'uncollectible') return { tone: 'danger', icon: <XCircle className="h-3 w-3" aria-hidden="true" />, tooltip: 'Invoice is marked uncollectible — payment is unlikely to be recovered' };
  return { tone: 'neutral', icon: <FileText className="h-3 w-3" aria-hidden="true" />, tooltip: `Invoice status: ${status}` };
}

interface Subscription {
  plan: string;
  status: string;
  billing_interval: string;
  current_period_start: string;
  current_period_end: string;
  trial_end: string | null;
  cancelled_at: string | null;
  monthly_call_limit: number;
  monthly_sms_limit: number;
  monthly_ai_minute_limit: number;
  overage_enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface Invoice {
  id: string;
  date: string | null;
  amount_cents: number;
  currency: string;
  status: string;
  invoice_pdf: string | null;
  number: string | null;
  description: string | null;
}

interface BudgetResult {
  allowed: boolean;
  reason?: string;
  plan: string;
  status: string;
  usage: {
    callsUsed: number;
    callLimit: number;
    aiMinutesUsed: number;
    aiMinuteLimit: number;
  };
}

const PLAN_LABELS: Record<string, string> = {
  starter: 'Starter',
  pro: 'Pro',
  enterprise: 'Enterprise',
};

const COST_RATES = {
  twilioCostPerMinuteCents: 2,
  aiCostPerMinuteCents: 6,
  smsCostPerMessageCents: 1,
};

function formatDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function InvoiceStatusBadge({ status }: { status: string }) {
  const meta = invoiceMeta(status);
  return (
    <StatusBadge
      tone={meta.tone}
      icon={meta.icon}
      tooltip={meta.tooltip}
      pill={false}
      className="text-[10px] px-1.5 py-0.5 capitalize"
    >
      {status}
    </StatusBadge>
  );
}

function UsageBar({ label, icon: Icon, used, limit, color }: {
  label: string;
  icon: typeof Phone;
  used: number;
  limit: number;
  color: string;
}) {
  const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  const isOverLimit = used > limit && limit < 999_999;
  const isUnlimited = limit >= 999_999;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-text-muted" />
          <span className="text-sm font-medium text-text-primary">{label}</span>
        </div>
        <span className="text-sm text-text-muted">
          {used.toLocaleString()} / {isUnlimited ? 'Unlimited' : limit.toLocaleString()}
        </span>
      </div>
      <div
        className="h-2 bg-surface-hover rounded-full overflow-hidden"
        role="progressbar"
        aria-valuenow={isUnlimited ? used : Math.min(used, limit)}
        aria-valuemin={0}
        aria-valuemax={isUnlimited ? Math.max(used, 1) : limit}
        aria-label={
          isUnlimited
            ? `${label} usage: ${used.toLocaleString()} (unlimited plan)`
            : `${label} usage: ${used.toLocaleString()} of ${limit.toLocaleString()} (${Math.round(pct)}%)${isOverLimit ? ' — over limit' : ''}`
        }
        title={
          isUnlimited
            ? `Unlimited ${label.toLowerCase()} on this plan — usage shown for visibility only`
            : isOverLimit
              ? `You are over your ${label.toLowerCase()} allowance — overage charges may apply`
              : `${Math.round(pct)}% of your ${label.toLowerCase()} allowance used this period`
        }
      >
        <div
          className={`h-full rounded-full transition-all ${isOverLimit ? 'bg-danger' : color}`}
          style={{ width: `${isUnlimited ? Math.min(pct, 30) : pct}%` }}
          aria-hidden="true"
        />
      </div>
      {isOverLimit && (
        <p className="text-xs text-danger">Over limit by {(used - limit).toLocaleString()}</p>
      )}
    </div>
  );
}

export default function Billing() {
  const { user } = useAuth();
  const isAdmin = hasMinRole(user?.role ?? '', 'manager');
  const queryClient = useQueryClient();
  const [upgradeLoading, setUpgradeLoading] = useState<string | null>(null);
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('monthly');
  const [billingPeriodInitialized, setBillingPeriodInitialized] = useState(false);
  const currency = useTenantCurrency();
  const formatCents = (cents: number | string | bigint | null | undefined) => formatCentsHelper(cents, { currency });

  // Stripe Checkout redirects back to /billing?checkout=success after a
  // successful upgrade. The trial-status query is cached aggressively
  // (30 minutes, no implicit refetch) to keep the TrialBanner from spamming
  // /tenants/me/trial-status across every tenant page, so we have to
  // explicitly drop the cached "still on trial" snapshot whenever the user
  // returns from a successful checkout.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('checkout') === 'success') {
      queryClient.invalidateQueries({ queryKey: ['trial-status'] });
      queryClient.invalidateQueries({ queryKey: ['billing-subscription'] });
      // The Stripe price attached to the subscription just changed (new
      // checkout = new subscription items), so the catalog override cached
      // by the BillingEstimator is now stale even though our 30-minute
      // staleTime would otherwise keep it.
      queryClient.invalidateQueries({ queryKey: ['billing-effective-rate'] });
      // Plan switch also resets the "cheapest plan" baseline — the
      // recommendation card needs to recompute against the new current
      // plan rather than the previous one.
      queryClient.invalidateQueries({ queryKey: ['billing-usage-trailing', 3] });
      // The upgrade-preview cache key is keyed off the tenant's CURRENT
      // plan, which just changed — drop it so the "Next tier up" card
      // re-fetches against the new starting tier on first render.
      queryClient.invalidateQueries({ queryKey: ['billing-upgrade-preview'] });
    }
  }, [queryClient]);

  const { data: subData, isLoading: subLoading, error: subError } = useQuery({
    queryKey: ['billing-subscription'],
    queryFn: () => api.get<{ subscription: Subscription | null; plan?: string; status?: string }>('/billing/subscription'),
  });

  const { data: usageData, isLoading: usageLoading } = useQuery({
    queryKey: ['billing-usage'],
    queryFn: () => api.get<{ usage: Record<string, number> }>('/billing/usage'),
    refetchInterval: 60_000,
  });

  const { data: budgetData } = useQuery({
    queryKey: ['billing-budget'],
    queryFn: () => api.get<BudgetResult>('/billing/budget'),
    refetchInterval: 60_000,
  });

  const { data: invoiceData, isLoading: invoiceLoading, error: invoiceError } = useQuery({
    queryKey: ['billing-invoices'],
    queryFn: () => api.get<{ invoices: Invoice[] }>('/billing/invoices'),
    enabled: isAdmin,
  });

  // Trailing complete-month AI minute totals (default: 3 months) used by
  // the BillingEstimator's plan-recommendation banner. Excludes the
  // in-progress month so we recommend off finalized data, not a partial
  // MTD slice. Cached for an hour because last-month totals don't shift
  // intra-day; the recommendation just needs to be fresh-ish, not live.
  const { data: trailingUsageData } = useQuery({
    queryKey: ['billing-usage-trailing', 3],
    queryFn: () => api.get<{
      months: number;
      monthsWithData: number;
      monthly: Array<{ month: string; aiMinutes: number }>;
      averageAiMinutes: number;
    }>('/billing/usage/trailing?months=3'),
    staleTime: 60 * 60 * 1000,
  });

  // Live per-minute overage + base price sourced from the tenant's actual
  // Stripe subscription items. Falls back to catalog defaults server-side
  // when no Stripe subscription exists, so the BillingEstimator stays
  // accurate for tenants on a custom / negotiated / grandfathered price.
  const { data: effectiveRateData } = useQuery({
    queryKey: ['billing-effective-rate'],
    queryFn: () => api.get<{
      basePriceCents: number;
      overageRatePerMinute: number;
      basePriceSource: 'stripe' | 'catalog';
      overagePriceSource: 'stripe' | 'catalog';
    }>('/billing/effective-rate'),
    // The Stripe subscription rate is stable across a billing period, so a
    // 30-minute stale window keeps every page navigation from re-hitting
    // Stripe — the override only matters when it differs from the catalog
    // default and that change is invariably accompanied by a new
    // subscription/checkout event that already invalidates this key.
    staleTime: 30 * 60 * 1000,
  });

  useEffect(() => {
    if (billingPeriodInitialized) return;
    const interval = subData?.subscription?.billing_interval;
    if (!interval) return;
    setBillingPeriod(interval === 'annual' ? 'annual' : 'monthly');
    setBillingPeriodInitialized(true);
  }, [subData, billingPeriodInitialized]);

  // Tenant-specific upgrade quote for the BillingEstimator's "Next tier
  // up" card. The endpoint applies any active customer-level coupon /
  // promotion code attached in Stripe so the card matches what Sales
  // negotiated, instead of showing the published catalog list price. The
  // server returns `{ upgrade: null }` when the tenant is already on the
  // top tier (Enterprise) — we leave the prop undefined in that case so
  // the component falls back to its existing top-tier placeholder.
  const { data: upgradePreviewData } = useQuery({
    queryKey: ['billing-upgrade-preview'],
    queryFn: () => api.get<{
      upgrade: {
        plan: string;
        basePriceCents: number;
        overageRatePerMinute: number;
        basePriceSource: 'stripe' | 'catalog';
        overagePriceSource: 'stripe' | 'catalog';
      } | null;
    }>('/billing/upgrade-preview'),
    // Same staleness model as /billing/effective-rate — the discount
    // attached to a customer record changes rarely (Sales applies it
    // manually) and is invalidated below on a successful checkout.
    staleTime: 30 * 60 * 1000,
  });

  const portalMutation = useMutation({
    mutationFn: () => api.post<{ url: string }>('/billing/portal', {
      returnUrl: window.location.href,
    }),
    onSuccess: (data) => { window.location.href = data.url; },
  });

  const checkoutMutation = useMutation({
    mutationFn: (params: { plan: string; interval: string }) =>
      api.post<{ url: string }>('/billing/checkout', {
        plan: params.plan,
        interval: params.interval,
        successUrl: `${window.location.origin}/billing?checkout=success`,
        cancelUrl: `${window.location.origin}/billing?checkout=cancelled`,
      }),
    onSuccess: (data) => { window.location.href = data.url; },
    onError: () => setUpgradeLoading(null),
  });

  const handleUpgrade = (plan: string, interval: string = 'monthly') => {
    setUpgradeLoading(plan);
    checkoutMutation.mutate({ plan, interval });
  };

  const sub = subData?.subscription;
  const plan = sub?.plan ?? subData?.plan ?? 'starter';
  const status = sub?.status ?? subData?.status ?? 'none';
  const usage = usageData?.usage ?? {};
  const budget = budgetData;

  const callsUsed = budget?.usage.callsUsed ?? (usage.calls_inbound ?? 0) + (usage.calls_outbound ?? 0);
  const callLimit = budget?.usage.callLimit ?? sub?.monthly_call_limit ?? 500;
  const aiMinutesUsed = budget?.usage.aiMinutesUsed ?? (usage.ai_minutes ?? 0);
  const aiMinuteLimit = budget?.usage.aiMinuteLimit ?? sub?.monthly_ai_minute_limit ?? 250;
  const smsUsed = usage.sms_sent ?? 0;
  const smsLimit = sub?.monthly_sms_limit ?? 1000;

  const estTwilioCostCents = aiMinutesUsed * COST_RATES.twilioCostPerMinuteCents;
  const estAiCostCents = aiMinutesUsed * COST_RATES.aiCostPerMinuteCents;
  const estSmsCostCents = smsUsed * COST_RATES.smsCostPerMessageCents;
  const estTotalCostCents = estTwilioCostCents + estAiCostCents + estSmsCostCents;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const dayOfMonth = now.getDate();
  const daysInMonth = monthEnd.getDate();
  const projectionMultiplier = dayOfMonth > 0 ? daysInMonth / dayOfMonth : 1;
  const projectedTotalCents = Math.round(estTotalCostCents * projectionMultiplier);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Billing</h1>
          <p className="text-sm text-text-muted mt-0.5">Manage your subscription, usage, and payment methods</p>
        </div>
        {sub && isAdmin && (
          <button
            onClick={() => portalMutation.mutate()}
            disabled={portalMutation.isPending}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-surface border border-border hover:bg-surface-hover text-text-primary text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
          >
            <CreditCard className="h-4 w-4" />
            {portalMutation.isPending ? 'Opening...' : 'Manage Payment Methods'}
            <ExternalLink className="h-3.5 w-3.5 text-text-muted" />
          </button>
        )}
      </div>

      {subError && (
        <div className="bg-danger/10 text-danger text-sm px-4 py-3 rounded-lg flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          Failed to load subscription: {subError.message}
        </div>
      )}

      {subLoading ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 bg-surface border border-border rounded-xl p-6">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h2 className="text-lg font-semibold text-text-primary">Subscription</h2>
                  <p className="text-sm text-text-muted mt-0.5">Your current plan and billing details</p>
                </div>
                {(() => {
                  const meta = subscriptionMeta(status);
                  return (
                    <StatusBadge
                      tone={meta.tone}
                      icon={meta.icon}
                      tooltip={meta.tooltip}
                      pill={false}
                      className="text-xs px-2.5 py-1 capitalize"
                    >
                      {status === 'none' ? 'Free Tier' : status.replace(/_/g, ' ')}
                    </StatusBadge>
                  );
                })()}
              </div>

              <div className="flex items-baseline gap-2 mb-4">
                <span className="text-3xl font-bold text-text-primary">{PLAN_LABELS[plan] ?? plan}</span>
                {sub?.billing_interval && (
                  <span className="text-sm text-text-muted capitalize">({sub.billing_interval})</span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-text-muted">Current Period</p>
                  <p className="text-text-primary font-medium">
                    {sub ? `${formatDate(sub.current_period_start)} — ${formatDate(sub.current_period_end)}` : '—'}
                  </p>
                </div>
                <div>
                  <p className="text-text-muted">Next Renewal</p>
                  <p className="text-text-primary font-medium">
                    {sub?.cancelled_at ? 'Cancelled' : sub ? formatDate(sub.current_period_end) : '—'}
                  </p>
                </div>
                {sub?.trial_end && new Date(sub.trial_end) > new Date() && (
                  <div className="col-span-2">
                    <p className="text-text-muted">Trial Ends</p>
                    <p className="text-primary font-medium">{formatDate(sub.trial_end)}</p>
                  </div>
                )}
              </div>

              {sub?.cancelled_at && (
                <div className="mt-4 bg-warning/10 text-warning text-sm px-3 py-2 rounded-lg">
                  Subscription cancelled on {formatDate(sub.cancelled_at)}. Access continues until end of billing period.
                </div>
              )}
            </div>

            <div className="bg-surface border border-border rounded-xl p-6">
              <h2 className="text-lg font-semibold text-text-primary mb-2">Estimated Cost</h2>
              <p className="text-sm text-text-muted mb-4">Current month usage cost</p>
              <p className="text-3xl font-bold text-text-primary">{formatCents(estTotalCostCents)}</p>
              <div className="mt-3 flex items-center gap-1.5 text-sm text-text-muted">
                <TrendingUp className="h-3.5 w-3.5" />
                <span>Projected: {formatCents(projectedTotalCents)}/mo</span>
              </div>
            </div>
          </div>

          <div className="bg-surface border border-border rounded-xl p-6">
            <h2 className="text-lg font-semibold text-text-primary mb-1">Usage This Month</h2>
            <p className="text-sm text-text-muted mb-5">
              {formatDate(monthStart.toISOString())} — {formatDate(monthEnd.toISOString())}
            </p>

            {usageLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin h-6 w-6 border-3 border-primary border-t-transparent rounded-full" />
              </div>
            ) : (
              <div className="space-y-5">
                <UsageBar label="Calls" icon={Phone} used={callsUsed} limit={callLimit} color="bg-primary" />
                <UsageBar label="AI Minutes" icon={Brain} used={aiMinutesUsed} limit={aiMinuteLimit} color="bg-success" />
                <UsageBar label="SMS Sent" icon={MessageSquare} used={smsUsed} limit={smsLimit} color="bg-warning" />
              </div>
            )}

            {sub?.overage_enabled && (
              <p className="mt-4 text-xs text-text-muted">
                Overage is enabled. Usage beyond plan limits will be billed at metered rates.
              </p>
            )}
            {!sub?.overage_enabled && status !== 'none' && (
              <p className="mt-4 text-xs text-warning">
                Overage is disabled. Services will be restricted when limits are reached.
              </p>
            )}
          </div>

          <BillingEstimator
            currentPlan={plan}
            monthToDateAiMinutes={aiMinutesUsed}
            rateOverride={effectiveRateData
              ? {
                  basePriceCents:
                    effectiveRateData.basePriceSource === 'stripe'
                      ? effectiveRateData.basePriceCents
                      : null,
                  overageRatePerMinute:
                    effectiveRateData.overagePriceSource === 'stripe'
                      ? effectiveRateData.overageRatePerMinute
                      : null,
                }
              : undefined}
            upgradePreview={upgradePreviewData?.upgrade
              ? {
                  // The upgrade endpoint always quotes the post-discount
                  // base, even when the underlying price came from the
                  // catalog (because the discount applies on top). So we
                  // pass it through unconditionally — `null` would let
                  // the component snap back to the catalog and undo the
                  // discount we just resolved.
                  basePriceCents: upgradePreviewData.upgrade.basePriceCents,
                  // Overage on the comparison card matches the upgrade
                  // quote: percent_off coupons get reflected, amount_off
                  // coupons do not (the server already applied that rule).
                  overageRatePerMinute:
                    upgradePreviewData.upgrade.overageRatePerMinute,
                }
              : undefined}
            projectionMultiplier={projectionMultiplier}
            currency={currency}
            trailingMonthlyAiMinutes={
              // Only feed the recommendation card when at least one of
              // the trailing months actually had AI usage. A brand-new
              // tenant whose entire trailing window is zero-filled would
              // otherwise see "Switch to Starter, save $300/mo!" before
              // they've ever placed a call — the recommendation needs
              // *some* signal to be actionable.
              trailingUsageData && trailingUsageData.monthsWithData > 0
                ? trailingUsageData.monthly.map((m) => m.aiMinutes)
                : undefined
            }
          />

          {sub && isAdmin && (
            <div className="bg-surface border border-border rounded-xl">
              <div className="p-6 border-b border-border">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-text-primary">Invoice History</h2>
                    <p className="text-sm text-text-muted mt-0.5">Your recent invoices and payment history</p>
                  </div>
                  <button
                    onClick={() => portalMutation.mutate()}
                    disabled={portalMutation.isPending}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-surface border border-border hover:bg-surface-hover text-text-primary text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
                  >
                    {portalMutation.isPending ? 'Opening...' : 'View All in Stripe'}
                    <ExternalLink className="h-3.5 w-3.5 text-text-muted" />
                  </button>
                </div>
              </div>

              {invoiceLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="animate-spin h-6 w-6 border-3 border-primary border-t-transparent rounded-full" />
                </div>
              ) : invoiceError ? (
                <div className="p-6 text-center text-sm">
                  <AlertCircle className="h-8 w-8 mx-auto mb-2 text-danger/50" />
                  <p className="text-danger">Failed to load invoices: {invoiceError.message}</p>
                  <p className="text-xs text-text-muted mt-1">Try refreshing the page or view invoices in Stripe.</p>
                </div>
              ) : !invoiceData?.invoices?.length ? (
                <div className="p-6 text-center text-sm text-text-muted">
                  <FileText className="h-8 w-8 mx-auto mb-2 text-text-muted/50" />
                  No invoices yet. Invoices will appear here once your first billing cycle completes.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {invoiceData.invoices.map((inv) => (
                    <div key={inv.id} className="px-6 py-4 flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-surface-hover">
                          <FileText className="h-4 w-4 text-text-muted" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-text-primary">
                              {inv.number ?? inv.id.slice(0, 12)}
                            </span>
                            <InvoiceStatusBadge status={inv.status} />
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <Clock className="h-3 w-3 text-text-muted" />
                            <span className="text-xs text-text-muted">
                              {inv.date ? formatDate(inv.date) : '—'}
                            </span>
                            {inv.description && (
                              <span className="text-xs text-text-muted">· {inv.description}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="text-sm font-semibold text-text-primary">
                          {formatCurrency(inv.amount_cents, { unit: 'cents', currency: (inv.currency || 'usd').toUpperCase() })}
                        </span>
                        {inv.invoice_pdf && (
                          <a
                            href={inv.invoice_pdf}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10 rounded-lg transition-colors"
                          >
                            <Download className="h-3.5 w-3.5" />
                            PDF
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-surface border border-border rounded-xl p-6">
              <h2 className="text-lg font-semibold text-text-primary mb-1">Cost Breakdown</h2>
              <p className="text-xs text-text-muted mb-4">Estimated based on current usage and default rates</p>
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <Phone className="h-4 w-4 text-primary" />
                    <span className="text-text-muted">Telephony (Twilio)</span>
                  </div>
                  <span className="text-text-primary font-medium">{formatCents(estTwilioCostCents)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <Brain className="h-4 w-4 text-success" />
                    <span className="text-text-muted">AI Minutes (OpenAI)</span>
                  </div>
                  <span className="text-text-primary font-medium">{formatCents(estAiCostCents)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 text-warning" />
                    <span className="text-text-muted">SMS Messages</span>
                  </div>
                  <span className="text-text-primary font-medium">{formatCents(estSmsCostCents)}</span>
                </div>
                <div className="border-t border-border pt-3 flex items-center justify-between text-sm font-semibold">
                  <span className="text-text-primary">Total This Month</span>
                  <span className="text-text-primary">{formatCents(estTotalCostCents)}</span>
                </div>
              </div>
            </div>

            <div className="bg-surface border border-border rounded-xl p-6">
              <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
                <h2 className="text-lg font-semibold text-text-primary">
                  {isAdmin ? 'Upgrade Plan' : 'Current Plan'}
                </h2>
                {isAdmin && (
                  <div
                    role="group"
                    aria-label="Billing period"
                    data-testid="billing-upgrade-interval-toggle"
                    className="inline-flex items-center bg-surface-hover border border-border rounded-md p-0.5 text-[11px]"
                  >
                    <button
                      type="button"
                      data-testid="billing-upgrade-interval-monthly"
                      aria-pressed={billingPeriod === 'monthly'}
                      onClick={() => setBillingPeriod('monthly')}
                      className={`px-2.5 py-1 rounded font-semibold transition-colors ${
                        billingPeriod === 'monthly'
                          ? 'bg-primary text-white shadow-sm'
                          : 'text-text-muted hover:text-text-primary'
                      }`}
                    >
                      Monthly
                    </button>
                    <button
                      type="button"
                      data-testid="billing-upgrade-interval-annual"
                      aria-pressed={billingPeriod === 'annual'}
                      onClick={() => setBillingPeriod('annual')}
                      className={`px-2.5 py-1 rounded font-semibold transition-colors inline-flex items-center gap-1 ${
                        billingPeriod === 'annual'
                          ? 'bg-primary text-white shadow-sm'
                          : 'text-text-muted hover:text-text-primary'
                      }`}
                    >
                      Annual
                      <span
                        className={`text-[9px] font-semibold px-1 py-0.5 rounded-full ${
                          billingPeriod === 'annual' ? 'bg-white/20 text-white' : 'bg-success/10 text-success'
                        }`}
                      >
                        −{Math.round(ANNUAL_DISCOUNT * 100)}%
                      </span>
                    </button>
                  </div>
                )}
              </div>
              {isAdmin ? (() => {
                type CardKind = 'upgrade' | 'switch_annual';
                interface UpgradeCard { tier: PlanTier; kind: CardKind }
                const TIER_ORDER: Record<PlanTier, number> = { starter: 0, pro: 1, enterprise: 2 };
                const ALL_TIERS: PlanTier[] = ['starter', 'pro', 'enterprise'];
                const currentRank = TIER_ORDER[plan as PlanTier] ?? 0;
                const isAnnual = billingPeriod === 'annual';
                const onMonthlySub = sub?.billing_interval === 'monthly';
                const cards: UpgradeCard[] = ALL_TIERS.flatMap((tier): UpgradeCard[] => {
                  const rank = TIER_ORDER[tier];
                  if (rank > currentRank) return [{ tier, kind: 'upgrade' }];
                  // Same-tier card only appears so a monthly tenant can
                  // move to annual on the plan they already pay for.
                  if (tier === plan && onMonthlySub && isAnnual) {
                    return [{ tier, kind: 'switch_annual' }];
                  }
                  return [];
                });

                if (cards.length === 0) {
                  return (
                    <p className="text-sm text-text-muted text-center py-2">You are on the highest plan.</p>
                  );
                }

                return (
                  <div className="space-y-3">
                    {cards.map(({ tier, kind }) => {
                      const baseMonthlyCents = getPlanMonthlyPriceCents(tier);
                      const cardIsAnnual = kind === 'switch_annual' ? true : isAnnual;
                      const cardInterval: BillingPeriod = cardIsAnnual ? 'annual' : 'monthly';
                      const effectiveMonthlyCents = Math.round(
                        getDiscountedBasePrice(baseMonthlyCents, cardInterval),
                      );
                      const summary =
                        tier === 'starter'
                          ? '500 calls · 250 AI min · 2 agents'
                          : tier === 'pro'
                            ? '5,000 calls · 2,500 AI min · 10 agents'
                            : 'Unlimited calls · Unlimited AI min · Unlimited agents';
                      const label = tier === 'starter' ? 'Starter' : tier === 'pro' ? 'Pro' : 'Enterprise';
                      const cta =
                        upgradeLoading === tier
                          ? 'Redirecting...'
                          : kind === 'switch_annual'
                            ? 'Switch to annual'
                            : 'Upgrade';
                      return (
                        <div
                          key={`${tier}-${kind}`}
                          data-testid={`billing-upgrade-card-${tier}`}
                          data-card-kind={kind}
                          className="flex items-center justify-between p-3 bg-surface-hover rounded-lg gap-3"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-text-primary">
                              {label}
                              {kind === 'switch_annual' && (
                                <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-success bg-success/10 px-1.5 py-0.5 rounded-full">
                                  Save {Math.round(ANNUAL_DISCOUNT * 100)}%
                                </span>
                              )}
                            </p>
                            <p className="text-xs text-text-muted">{summary}</p>
                            <p
                              data-testid={`billing-upgrade-price-${tier}`}
                              className="text-xs text-text-primary mt-1"
                            >
                              {cardIsAnnual ? (
                                <>
                                  <span className="line-through text-text-muted mr-1">
                                    {formatCentsHelper(baseMonthlyCents, { currency, minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                  </span>
                                  <span className="font-semibold">
                                    {formatCentsHelper(effectiveMonthlyCents, { currency, minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                  </span>
                                  <span className="text-text-muted">/mo</span>
                                  <span
                                    data-testid={`billing-upgrade-annual-note-${tier}`}
                                    className="ml-1 text-text-muted"
                                  >
                                    · billed annually
                                  </span>
                                </>
                              ) : (
                                <>
                                  <span className="font-semibold">
                                    {formatCentsHelper(baseMonthlyCents, { currency, minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                  </span>
                                  <span className="text-text-muted">/mo</span>
                                </>
                              )}
                            </p>
                          </div>
                          <button
                            data-testid={`billing-upgrade-button-${tier}`}
                            onClick={() => handleUpgrade(tier, cardInterval)}
                            disabled={upgradeLoading === tier}
                            className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary hover:bg-primary-hover text-white text-xs font-medium rounded-lg disabled:opacity-50 shrink-0"
                          >
                            {cta}
                            <ArrowUpRight className="h-3 w-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                );
              })() : (
                <p className="text-sm text-text-muted">Contact your organization admin to manage plan changes.</p>
              )}

              {sub && isAdmin && (
                <div className="mt-4 pt-4 border-t border-border">
                  <button
                    onClick={() => portalMutation.mutate()}
                    disabled={portalMutation.isPending}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 border border-border text-text-primary text-sm font-medium rounded-lg hover:bg-surface-hover disabled:opacity-50 transition-colors"
                  >
                    <Zap className="h-4 w-4" />
                    {portalMutation.isPending ? 'Opening...' : 'Manage Billing in Stripe'}
                    <ExternalLink className="h-3.5 w-3.5 text-text-muted" />
                  </button>
                  <p className="text-xs text-text-muted text-center mt-2">View invoices, update payment methods, or cancel</p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
