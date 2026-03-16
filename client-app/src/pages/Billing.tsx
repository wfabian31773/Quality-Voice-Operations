import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  CreditCard, ExternalLink, AlertCircle, TrendingUp,
  Phone, MessageSquare, Brain, Zap, ArrowUpRight,
  FileText, Download, Clock,
} from 'lucide-react';

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

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-success/10 text-success',
  trialing: 'bg-primary/10 text-primary',
  past_due: 'bg-warning/10 text-warning',
  canceled: 'bg-danger/10 text-danger',
  cancelled: 'bg-danger/10 text-danger',
  incomplete: 'bg-warning/10 text-warning',
  none: 'bg-text-muted/10 text-text-muted',
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

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const INVOICE_STATUS_STYLES: Record<string, string> = {
  paid: 'bg-success/10 text-success',
  open: 'bg-primary/10 text-primary',
  draft: 'bg-text-muted/10 text-text-muted',
  void: 'bg-text-muted/10 text-text-muted',
  uncollectible: 'bg-danger/10 text-danger',
};

function InvoiceStatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium capitalize ${INVOICE_STATUS_STYLES[status] ?? 'bg-text-muted/10 text-text-muted'}`}>
      {status}
    </span>
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
      <div className="h-2 bg-surface-hover rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${isOverLimit ? 'bg-danger' : color}`}
          style={{ width: `${isUnlimited ? Math.min(pct, 30) : pct}%` }}
        />
      </div>
      {isOverLimit && (
        <p className="text-xs text-danger">Over limit by {(used - limit).toLocaleString()}</p>
      )}
    </div>
  );
}

const ADMIN_ROLES = ['tenant_owner', 'operations_manager', 'billing_admin', 'agent_developer'];

export default function Billing() {
  const { user } = useAuth();
  const isAdmin = ADMIN_ROLES.includes(user?.role ?? '');
  const [upgradeLoading, setUpgradeLoading] = useState<string | null>(null);

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
                <span className={`inline-flex items-center px-2.5 py-1 rounded text-xs font-medium capitalize ${STATUS_STYLES[status] ?? STATUS_STYLES.none}`}>
                  {status === 'none' ? 'Free Tier' : status.replace(/_/g, ' ')}
                </span>
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
                          {new Intl.NumberFormat('en-US', { style: 'currency', currency: inv.currency || 'usd' }).format(inv.amount_cents / 100)}
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
              <h2 className="text-lg font-semibold text-text-primary mb-4">
                {isAdmin ? 'Upgrade Plan' : 'Current Plan'}
              </h2>
              {isAdmin ? (
                <div className="space-y-3">
                  {plan !== 'pro' && (
                    <div className="flex items-center justify-between p-3 bg-surface-hover rounded-lg">
                      <div>
                        <p className="text-sm font-medium text-text-primary">Pro</p>
                        <p className="text-xs text-text-muted">5,000 calls · 2,500 AI min · 10 agents</p>
                      </div>
                      <button
                        onClick={() => handleUpgrade('pro')}
                        disabled={upgradeLoading === 'pro'}
                        className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary hover:bg-primary-hover text-white text-xs font-medium rounded-lg disabled:opacity-50"
                      >
                        {upgradeLoading === 'pro' ? 'Redirecting...' : 'Upgrade'}
                        <ArrowUpRight className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                  {plan !== 'enterprise' && (
                    <div className="flex items-center justify-between p-3 bg-surface-hover rounded-lg">
                      <div>
                        <p className="text-sm font-medium text-text-primary">Enterprise</p>
                        <p className="text-xs text-text-muted">Unlimited calls · Unlimited AI min · Unlimited agents</p>
                      </div>
                      <button
                        onClick={() => handleUpgrade('enterprise')}
                        disabled={upgradeLoading === 'enterprise'}
                        className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary hover:bg-primary-hover text-white text-xs font-medium rounded-lg disabled:opacity-50"
                      >
                        {upgradeLoading === 'enterprise' ? 'Redirecting...' : 'Upgrade'}
                        <ArrowUpRight className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                  {plan === 'enterprise' && (
                    <p className="text-sm text-text-muted text-center py-2">You are on the highest plan.</p>
                  )}
                </div>
              ) : (
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
