import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { hasMinRole } from '../lib/useRole';
import { formatCents as formatCentsHelper, formatCurrency, dollarsToCents } from '../lib/formatCurrency';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
import BillingEstimator, {
  type TrailingWindow,
  type RecommendationEvent,
  type RecommendationAttribution,
  type DiscountEvent,
} from '../components/BillingEstimator';
import {
  ANNUAL_DISCOUNT,
  type BillingPeriod,
} from '../components/MinutesPricingCalculator';
import {
  centsToWholeDollars,
  getDiscountedAnnualMonthlyDollars,
  getPlanMonthlyPriceCents,
  type PlanTier,
} from '../../../shared/billing/planCatalog';
import {
  CreditCard, ExternalLink, AlertCircle, TrendingUp,
  Phone, MessageSquare, Brain, Zap, ArrowUpRight, ArrowDownRight,
  FileText, Download, Clock, CheckCircle2, XCircle, X,
  Sparkles, AlertTriangle, FileEdit, MinusCircle, Loader2,
} from 'lucide-react';
import { StatusBadge, PageHeader, type BadgeTone } from '../components/ui';

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

interface BillingDiscountSummary {
  couponId: string | null;
  name: string | null;
  percentOff: number | null;
  amountOffCents: number | null;
  currency: string | null;
  promotionCode: string | null;
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
  /** Legacy single-discount field (customer-level). Prefer `discounts`. */
  discount?: BillingDiscountSummary | null;
  /** Full list of discounts active on the subscription, de-duped server-side. */
  discounts?: BillingDiscountSummary[];
  /**
   * Stamped by the Stripe webhook when a strict tier downgrade lands on
   * the local subscription (typically the second-phase swap on a
   * Subscription Schedule queued by /billing/schedule-downgrade). The
   * Billing UI uses these to render a one-time
   * "Your downgrade to <Plan> is now active" banner on the next visit;
   * dismissing it POSTs `/billing/acknowledge-downgrade-completion`
   * which nulls both fields server-side. Optional for backward-compat
   * with older API responses that pre-date this field.
   */
  downgrade_completed_at?: string | null;
  downgrade_completed_to_plan?: string | null;
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
  /**
   * Legacy single-discount field. New servers also send the full
   * `discounts` array; old servers send only `discount`. The row falls
   * back to this when `discounts` is missing so an in-flight rollout
   * doesn't drop the badge.
   */
  discount?: BillingDiscountSummary | null;
  /**
   * All discounts applied to the invoice. A Stripe invoice can stack
   * multiple coupons (e.g. customer-level promo + invoice-level
   * one-off), so each one is rendered as its own chip below the
   * invoice metadata.
   */
  discounts?: BillingDiscountSummary[];
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

// Annual-switch confirmation banner: marker stamped by handleUpgrade
// before the Stripe redirect, hydrated only on the ?checkout=success
// return so the banner is bound to a tenant-initiated monthly→annual
// switch (not unrelated tier upgrades or portal changes).
const ANNUAL_SWITCH_MARKER_KEY = 'billing-annual-switch-pending';
// Polling budget for the webhook to flip billing_interval after the
// success redirect; cleared after this if the flip never lands.
const ANNUAL_SWITCH_MAX_WAIT_MS = 30_000;
// Markers older than this are ignored on read so an abandoned tab
// can't fire the banner on a much later unrelated visit.
const ANNUAL_SWITCH_MARKER_MAX_AGE_MS = 30 * 60_000;

type AnnualSwitchMarker = {
  previousInterval: 'monthly';
  initiatedAt: number;
};

function readAnnualSwitchMarker(): AnnualSwitchMarker | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(ANNUAL_SWITCH_MARKER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AnnualSwitchMarker> | null;
    if (
      !parsed
      || parsed.previousInterval !== 'monthly'
      || typeof parsed.initiatedAt !== 'number'
      || Date.now() - parsed.initiatedAt > ANNUAL_SWITCH_MARKER_MAX_AGE_MS
    ) {
      window.sessionStorage.removeItem(ANNUAL_SWITCH_MARKER_KEY);
      return null;
    }
    return { previousInterval: 'monthly', initiatedAt: parsed.initiatedAt };
  } catch {
    return null;
  }
}

function writeAnnualSwitchMarker(marker: AnnualSwitchMarker): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(ANNUAL_SWITCH_MARKER_KEY, JSON.stringify(marker));
  } catch {
    // sessionStorage may be unavailable (private mode / quota).
  }
}

function clearAnnualSwitchMarker(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(ANNUAL_SWITCH_MARKER_KEY);
  } catch {
    // Best-effort.
  }
}

// Tier-upgrade confirmation banner (Task #1366). Mirrors the
// annual-switch marker contract: stamped by handleUpgrade before the
// Stripe redirect on a *strict* tier upgrade (e.g. starter → pro,
// pro → enterprise) and hydrated only on the ?checkout=success return,
// so the banner is bound to a tenant-initiated tier change rather than
// firing on unrelated visits or portal-driven changes.
const TIER_UPGRADE_MARKER_KEY = 'billing-tier-upgrade-pending';
// Polling budget for the webhook to flip the local plan after the
// success redirect; cleared after this if the flip never lands.
const TIER_UPGRADE_MAX_WAIT_MS = 30_000;
// Markers older than this are ignored on read so an abandoned tab
// can't fire the banner on a much later unrelated visit.
const TIER_UPGRADE_MARKER_MAX_AGE_MS = 30 * 60_000;

const TIER_UPGRADE_PLANS = new Set<PlanTier>(['starter', 'pro', 'enterprise']);

type TierUpgradeMarker = {
  previousPlan: PlanTier;
  targetPlan: PlanTier;
  initiatedAt: number;
};

function readTierUpgradeMarker(): TierUpgradeMarker | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(TIER_UPGRADE_MARKER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TierUpgradeMarker> | null;
    if (
      !parsed
      || typeof parsed.previousPlan !== 'string'
      || typeof parsed.targetPlan !== 'string'
      || !TIER_UPGRADE_PLANS.has(parsed.previousPlan as PlanTier)
      || !TIER_UPGRADE_PLANS.has(parsed.targetPlan as PlanTier)
      || parsed.previousPlan === parsed.targetPlan
      || typeof parsed.initiatedAt !== 'number'
      || Date.now() - parsed.initiatedAt > TIER_UPGRADE_MARKER_MAX_AGE_MS
    ) {
      window.sessionStorage.removeItem(TIER_UPGRADE_MARKER_KEY);
      return null;
    }
    return {
      previousPlan: parsed.previousPlan as PlanTier,
      targetPlan: parsed.targetPlan as PlanTier,
      initiatedAt: parsed.initiatedAt,
    };
  } catch {
    return null;
  }
}

function writeTierUpgradeMarker(marker: TierUpgradeMarker): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(TIER_UPGRADE_MARKER_KEY, JSON.stringify(marker));
  } catch {
    // sessionStorage may be unavailable (private mode / quota).
  }
}

function clearTierUpgradeMarker(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(TIER_UPGRADE_MARKER_KEY);
  } catch {
    // Best-effort.
  }
}

// Generic checkout-success confirmation banner (Task #1382). Mirrors
// the annual-switch / tier-upgrade marker contract: stamped by
// handleUpgrade before EVERY Stripe Checkout redirect (regardless of
// whether the change is also a strict tier upgrade or a monthly→annual
// switch) and hydrated only on the ?checkout=success return. The
// resulting banner is suppressed when one of the more specific banners
// is already rendering (annual-switch / tier-upgrade) so we never
// stack two confirmations for the same checkout. For everything else
// (brand-new checkouts, same-tier same-interval re-checkouts that
// attach a discount, etc.) it surfaces a generic "Your new plan is
// active" callout with one chip per discount on `sub.discounts`.
const CHECKOUT_SUCCESS_MARKER_KEY = 'billing-checkout-success-pending';
// Polling budget for the webhook to flip the local subscription into
// active/trialing after the success redirect; cleared after this if
// the flip never lands.
const CHECKOUT_SUCCESS_MAX_WAIT_MS = 30_000;
// Markers older than this are ignored on read so an abandoned tab
// can't fire the banner on a much later unrelated visit.
const CHECKOUT_SUCCESS_MARKER_MAX_AGE_MS = 30 * 60_000;

type CheckoutSuccessMarker = {
  initiatedAt: number;
};

function readCheckoutSuccessMarker(): CheckoutSuccessMarker | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(CHECKOUT_SUCCESS_MARKER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CheckoutSuccessMarker> | null;
    if (
      !parsed
      || typeof parsed.initiatedAt !== 'number'
      || Date.now() - parsed.initiatedAt > CHECKOUT_SUCCESS_MARKER_MAX_AGE_MS
    ) {
      window.sessionStorage.removeItem(CHECKOUT_SUCCESS_MARKER_KEY);
      return null;
    }
    return { initiatedAt: parsed.initiatedAt };
  } catch {
    return null;
  }
}

function writeCheckoutSuccessMarker(marker: CheckoutSuccessMarker): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(CHECKOUT_SUCCESS_MARKER_KEY, JSON.stringify(marker));
  } catch {
    // sessionStorage may be unavailable (private mode / quota).
  }
}

function clearCheckoutSuccessMarker(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(CHECKOUT_SUCCESS_MARKER_KEY);
  } catch {
    // Best-effort.
  }
}

// Tier rank used to decide whether a checkout target is a strict
// upgrade vs a same-tier interval change vs a downgrade. Mirrors the
// server-side `TIER_ORDER` in `planChange.ts`. A target with a higher
// rank than the tenant's current plan triggers the tier-upgrade banner
// after Stripe Checkout completes.
const TIER_RANK: Record<PlanTier, number> = { starter: 0, pro: 1, enterprise: 2 };

const COST_RATES = {
  twilioCostPerMinuteCents: 2,
  aiCostPerMinuteCents: 6,
  smsCostPerMessageCents: 1,
};

function formatDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDiscountLabel(
  discount: BillingDiscountSummary,
  currencyCode: string,
): string {
  const parts: string[] = [];
  if (discount.percentOff != null && Number.isFinite(discount.percentOff)) {
    parts.push(`${Math.round(discount.percentOff)}% off`);
  } else if (
    discount.amountOffCents != null
    && Number.isFinite(discount.amountOffCents)
  ) {
    const ccy = (discount.currency || currencyCode || 'USD').toUpperCase();
    parts.push(
      `${formatCurrency(discount.amountOffCents, { unit: 'cents', currency: ccy })} off`,
    );
  }
  const labelTail = discount.promotionCode || discount.name;
  if (labelTail) parts.push(labelTail);
  if (parts.length === 0) return 'Discount applied';
  return parts.join(' — ');
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

const TRAILING_WINDOW_OPTIONS: ReadonlyArray<TrailingWindow> = [3, 6, 12];
const DEFAULT_TRAILING_WINDOW: TrailingWindow = 3;

// Keys inside the user-scoped `users.preferences` JSONB blob. These follow the
// user across browsers / devices; localStorage is only used as a pre-hydration
// cache so the page doesn't flicker on first paint while the `/me/preferences`
// request is in-flight.
const TRAILING_WINDOW_PREF_KEY = 'billing_trailing_window_months';
const UPGRADE_INTERVAL_PREF_KEY = 'billing_upgrade_interval';

const UPGRADE_INTERVAL_OPTIONS: ReadonlyArray<BillingPeriod> = ['monthly', 'annual'];

interface BillingUserPreferences {
  [TRAILING_WINDOW_PREF_KEY]?: unknown;
  [UPGRADE_INTERVAL_PREF_KEY]?: unknown;
  [key: string]: unknown;
}

function trailingWindowStorageKey(tenantId: string | undefined | null): string | null {
  if (!tenantId) return null;
  return `billing.trailingWindow.${tenantId}`;
}

function upgradeIntervalStorageKey(tenantId: string | undefined | null): string | null {
  if (!tenantId) return null;
  return `billing.upgradeInterval.${tenantId}`;
}

function loadPersistedTrailingWindow(tenantId: string | undefined | null): TrailingWindow {
  const key = trailingWindowStorageKey(tenantId);
  if (!key || typeof window === 'undefined') return DEFAULT_TRAILING_WINDOW;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return DEFAULT_TRAILING_WINDOW;
    const parsed = Number.parseInt(raw, 10);
    if (TRAILING_WINDOW_OPTIONS.includes(parsed as TrailingWindow)) {
      return parsed as TrailingWindow;
    }
  } catch {
    // localStorage access can throw in private browsing — silently fall
    // back to the default rather than blocking the page render.
  }
  return DEFAULT_TRAILING_WINDOW;
}

function writePersistedTrailingWindow(
  tenantId: string | undefined | null,
  value: TrailingWindow,
): void {
  const key = trailingWindowStorageKey(tenantId);
  if (!key || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Best-effort persistence — ignore quota / privacy-mode failures.
  }
}

function readServerTrailingWindow(
  prefs: BillingUserPreferences | null | undefined,
): TrailingWindow | null {
  if (!prefs) return null;
  const raw = prefs[TRAILING_WINDOW_PREF_KEY];
  if (typeof raw !== 'number') return null;
  if (TRAILING_WINDOW_OPTIONS.includes(raw as TrailingWindow)) {
    return raw as TrailingWindow;
  }
  return null;
}

// Returns null if no cached value exists so the caller can decide whether to
// fall back to the subscription's billing_interval (which is the existing
// behaviour for tenants who have never explicitly toggled).
function loadPersistedUpgradeInterval(
  tenantId: string | undefined | null,
): BillingPeriod | null {
  const key = upgradeIntervalStorageKey(tenantId);
  if (!key || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    if (UPGRADE_INTERVAL_OPTIONS.includes(raw as BillingPeriod)) {
      return raw as BillingPeriod;
    }
  } catch {
    // ignore
  }
  return null;
}

function writePersistedUpgradeInterval(
  tenantId: string | undefined | null,
  value: BillingPeriod,
): void {
  const key = upgradeIntervalStorageKey(tenantId);
  if (!key || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function readServerUpgradeInterval(
  prefs: BillingUserPreferences | null | undefined,
): BillingPeriod | null {
  if (!prefs) return null;
  const raw = prefs[UPGRADE_INTERVAL_PREF_KEY];
  if (typeof raw !== 'string') return null;
  if (UPGRADE_INTERVAL_OPTIONS.includes(raw as BillingPeriod)) {
    return raw as BillingPeriod;
  }
  return null;
}

export default function Billing() {
  const { t: tenantT } = useTranslation('tenant');
  const { user } = useAuth();
  const isAdmin = hasMinRole(user?.role ?? '', 'manager');
  const queryClient = useQueryClient();
  const location = useLocation();
  const [upgradeLoading, setUpgradeLoading] = useState<string | null>(null);
  // Annual-switch banner state. Marker is only hydrated on the
  // ?checkout=success URL so a stale sessionStorage value can't fire
  // the banner on unrelated visits. `returnedAt` is when that URL was
  // observed and bounds the webhook-lag polling.
  const [annualSwitchMarker, setAnnualSwitchMarker] =
    useState<AnnualSwitchMarker | null>(null);
  const [annualSwitchReturnedAt, setAnnualSwitchReturnedAt] =
    useState<number | null>(null);
  const [annualSwitchAcknowledged, setAnnualSwitchAcknowledged] = useState(false);
  const [annualSwitchDismissed, setAnnualSwitchDismissed] = useState(false);
  // Tier-upgrade banner state. Mirrors the annual-switch lifecycle:
  // marker is only hydrated on the ?checkout=success URL so a stale
  // sessionStorage value can't fire the banner on unrelated visits.
  // `returnedAt` bounds the webhook-lag polling.
  const [tierUpgradeMarker, setTierUpgradeMarker] =
    useState<TierUpgradeMarker | null>(null);
  const [tierUpgradeReturnedAt, setTierUpgradeReturnedAt] =
    useState<number | null>(null);
  const [tierUpgradeAcknowledged, setTierUpgradeAcknowledged] = useState(false);
  const [tierUpgradeDismissed, setTierUpgradeDismissed] = useState(false);
  // Generic checkout-success banner state. Marker is only hydrated on
  // the ?checkout=success URL so a stale sessionStorage value can't
  // fire the banner on unrelated visits. `returnedAt` bounds the
  // webhook-lag polling. The banner is suppressed at render time when
  // the annual-switch or tier-upgrade banner is already showing for
  // the same checkout — see the IIFE below.
  const [checkoutSuccessMarker, setCheckoutSuccessMarker] =
    useState<CheckoutSuccessMarker | null>(null);
  const [checkoutSuccessReturnedAt, setCheckoutSuccessReturnedAt] =
    useState<number | null>(null);
  const [checkoutSuccessAcknowledged, setCheckoutSuccessAcknowledged] = useState(false);
  const [checkoutSuccessDismissed, setCheckoutSuccessDismissed] = useState(false);
  // Downgrade-completion banner state. The marker itself lives on the
  // server (subscriptions.downgrade_completed_at / _to_plan) so it
  // survives a fresh device + first visit after the schedule fires.
  // Local dismissal is mirrored here so the banner disappears
  // immediately when the user clicks X, without waiting for the
  // POST /billing/acknowledge-downgrade-completion round-trip to
  // complete and the subsequent /billing/subscription refetch to
  // return cleared columns.
  const [downgradeCompletionDismissed, setDowngradeCompletionDismissed] =
    useState(false);
  // Monthly / Annual upgrade-interval toggle. Authoritative store is the
  // per-user `users.preferences` JSONB blob (key `billing_upgrade_interval`)
  // so the choice follows the user across browsers and devices. localStorage
  // is kept as a pre-hydration cache (keyed by tenant) so the toggle doesn't
  // flicker on first paint while `/me/preferences` is in flight. When no
  // value has ever been saved we fall back to the subscription's
  // `billing_interval` (existing behaviour) so users on annual billing keep
  // landing on the Annual tab by default.
  const [billingPeriod, setBillingPeriodState] = useState<BillingPeriod>(
    () => loadPersistedUpgradeInterval(user?.tenantId ?? null) ?? 'monthly',
  );
  const [billingPeriodInitialized, setBillingPeriodInitialized] = useState<boolean>(
    () => loadPersistedUpgradeInterval(user?.tenantId ?? null) !== null,
  );
  // Persisted trailing window for the plan-recommendation card.
  // Authoritative store is the per-user `users.preferences` JSONB blob
  // (key `billing_trailing_window_months`) so the choice follows the
  // user across browsers and devices. localStorage is kept as a
  // pre-hydration cache (keyed by tenant) so the toggle doesn't flicker
  // on first paint while `/me/preferences` is in flight.
  const [trailingWindow, setTrailingWindowState] = useState<TrailingWindow>(() =>
    loadPersistedTrailingWindow(user?.tenantId ?? null),
  );
  // Hydration is idempotent per user. Reset on user OR tenant change so
  // a user-switch (or a tenant-switch by the same user) re-hydrates from
  // the new account's preferences instead of keeping the previous one.
  const serverHydratedRef = useRef(false);
  const userTouchedTrailingWindowRef = useRef(false);
  const upgradeIntervalServerHydratedRef = useRef(false);
  const userTouchedUpgradeIntervalRef = useRef(false);
  const loadedForUserRef = useRef<string | null>(user?.userId ?? null);
  const loadedForTenantRef = useRef<string | null>(user?.tenantId ?? null);
  useEffect(() => {
    const userId = user?.userId ?? null;
    const tenantId = user?.tenantId ?? null;
    if (
      loadedForUserRef.current === userId
      && loadedForTenantRef.current === tenantId
    ) {
      return;
    }
    loadedForUserRef.current = userId;
    loadedForTenantRef.current = tenantId;
    setTrailingWindowState(loadPersistedTrailingWindow(tenantId));
    serverHydratedRef.current = false;
    userTouchedTrailingWindowRef.current = false;
    const cachedInterval = loadPersistedUpgradeInterval(tenantId);
    setBillingPeriodState(cachedInterval ?? 'monthly');
    setBillingPeriodInitialized(cachedInterval !== null);
    upgradeIntervalServerHydratedRef.current = false;
    userTouchedUpgradeIntervalRef.current = false;
  }, [user?.userId, user?.tenantId]);

  const { data: preferencesData } = useQuery({
    queryKey: ['user-preferences', user?.userId ?? null],
    queryFn: () =>
      api.get<{ preferences: BillingUserPreferences | null }>('/me/preferences'),
    enabled: Boolean(user?.userId),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!preferencesData) return;
    if (serverHydratedRef.current) return;
    if (userTouchedTrailingWindowRef.current) {
      // User clicked before the server responded — their choice already
      // wrote through to localStorage and the server. Just mark done.
      serverHydratedRef.current = true;
      return;
    }
    const serverValue = readServerTrailingWindow(preferencesData.preferences);
    if (serverValue !== null) {
      setTrailingWindowState(serverValue);
      writePersistedTrailingWindow(user?.tenantId ?? null, serverValue);
    } else if (trailingWindow !== DEFAULT_TRAILING_WINDOW) {
      // No server value yet, but legacy localStorage holds a non-default
      // pick from the browser-only implementation. Migrate it up so the
      // user's other devices pick it up from now on.
      api
        .patch<{ preferences: BillingUserPreferences }>('/me/preferences', {
          [TRAILING_WINDOW_PREF_KEY]: trailingWindow,
        })
        .then((result) => {
          queryClient.setQueryData(
            ['user-preferences', user?.userId ?? null],
            { preferences: result.preferences ?? {} },
          );
        })
        .catch(() => {
          // Best-effort migration; the next explicit toggle will retry.
        });
    }
    serverHydratedRef.current = true;
  }, [preferencesData, trailingWindow, user?.tenantId, user?.userId, queryClient]);

  const setTrailingWindow = (next: TrailingWindow) => {
    userTouchedTrailingWindowRef.current = true;
    setTrailingWindowState(next);
    writePersistedTrailingWindow(user?.tenantId ?? null, next);
    api
      .patch<{ preferences: BillingUserPreferences }>('/me/preferences', {
        [TRAILING_WINDOW_PREF_KEY]: next,
      })
      .then((result) => {
        // Keep the React Query cache in sync so any other consumer of
        // `/me/preferences` (or a remount of this page) reads the new
        // value without a follow-up GET.
        queryClient.setQueryData(
          ['user-preferences', user?.userId ?? null],
          { preferences: result.preferences ?? {} },
        );
      })
      .catch(() => {
        // Best-effort: localStorage already holds the value for this
        // browser, and the next toggle will retry.
      });
  };

  // Hydrate the Monthly / Annual upgrade-interval toggle from the per-user
  // preferences blob the same way the trailing-window picker does. Skipped
  // entirely if the user already toggled before the GET resolved (their
  // explicit click is more authoritative than a stale server value).
  useEffect(() => {
    if (!preferencesData) return;
    if (upgradeIntervalServerHydratedRef.current) return;
    if (userTouchedUpgradeIntervalRef.current) {
      upgradeIntervalServerHydratedRef.current = true;
      return;
    }
    const serverValue = readServerUpgradeInterval(preferencesData.preferences);
    if (serverValue !== null) {
      setBillingPeriodState(serverValue);
      setBillingPeriodInitialized(true);
      writePersistedUpgradeInterval(user?.tenantId ?? null, serverValue);
    } else {
      // No server value yet. If localStorage already has a non-default pick
      // (e.g. set by a previous failed PATCH on this browser, or a future
      // legacy world), migrate it up so the user's other devices pick it up.
      const cached = loadPersistedUpgradeInterval(user?.tenantId ?? null);
      if (cached !== null) {
        api
          .patch<{ preferences: BillingUserPreferences }>('/me/preferences', {
            [UPGRADE_INTERVAL_PREF_KEY]: cached,
          })
          .then((result) => {
            queryClient.setQueryData(
              ['user-preferences', user?.userId ?? null],
              { preferences: result.preferences ?? {} },
            );
          })
          .catch(() => {
            // Best-effort migration; the next explicit toggle will retry.
          });
      }
    }
    upgradeIntervalServerHydratedRef.current = true;
  }, [preferencesData, user?.tenantId, user?.userId, queryClient]);

  const setBillingPeriod = (next: BillingPeriod) => {
    userTouchedUpgradeIntervalRef.current = true;
    setBillingPeriodState(next);
    setBillingPeriodInitialized(true);
    writePersistedUpgradeInterval(user?.tenantId ?? null, next);
    api
      .patch<{ preferences: BillingUserPreferences }>('/me/preferences', {
        [UPGRADE_INTERVAL_PREF_KEY]: next,
      })
      .then((result) => {
        queryClient.setQueryData(
          ['user-preferences', user?.userId ?? null],
          { preferences: result.preferences ?? {} },
        );
      })
      .catch(() => {
        // Best-effort: localStorage already holds the value for this
        // browser, and the next toggle will retry.
      });
  };
  const currency = useTenantCurrency();
  const formatCents = (cents: number | string | bigint | null | undefined) => formatCentsHelper(cents, { currency });

  // Stripe Checkout redirects back to /billing?checkout=success or
  // /billing?checkout=cancelled. We always strip the query param so a
  // reload doesn't re-fire side effects, and on success we drop cached
  // billing snapshots so the page reflects the new plan immediately.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkoutParam = params.get('checkout');
    if (checkoutParam === 'success') {
      queryClient.invalidateQueries({ queryKey: ['trial-status'] });
      queryClient.invalidateQueries({ queryKey: ['billing-subscription'] });
      queryClient.invalidateQueries({ queryKey: ['billing-effective-rate'] });
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === 'billing-usage-trailing',
      });
      queryClient.invalidateQueries({ queryKey: ['billing-upgrade-preview'] });
      // Hydrate the annual-switch and tier-upgrade markers only on the
      // success redirect (not on plain visits). The redirect is the
      // only signal that the tenant just came back from Stripe
      // Checkout. We stamp the return time so each polling budget is
      // measured from now, not from when the original click happened
      // (Checkout itself can take longer than the polling budget).
      //
      // The two markers are mutually exclusive at write time
      // (handleUpgrade clears the annual marker when it stamps a tier
      // marker) — a strict tier upgrade is the bigger story and
      // shouldn't be hidden behind the smaller annual-switch banner.
      const annualMarker = readAnnualSwitchMarker();
      const tierMarker = readTierUpgradeMarker();
      const checkoutMarker = readCheckoutSuccessMarker();
      if (annualMarker) {
        setAnnualSwitchMarker(annualMarker);
        setAnnualSwitchReturnedAt((prev) => prev ?? Date.now());
      }
      if (tierMarker) {
        setTierUpgradeMarker(tierMarker);
        setTierUpgradeReturnedAt((prev) => prev ?? Date.now());
      }
      if (checkoutMarker) {
        setCheckoutSuccessMarker(checkoutMarker);
        setCheckoutSuccessReturnedAt((prev) => prev ?? Date.now());
      }
      if (!annualMarker && !tierMarker && !checkoutMarker) {
        // No markers to wait on — strip the param immediately so a
        // reload doesn't re-fire the success-side effects.
        const url = new URL(window.location.href);
        url.searchParams.delete('checkout');
        window.history.replaceState({}, '', url.toString());
      }
      // Otherwise we leave ?checkout=success in the URL until at least
      // one banner resolves (renders or polling gives up); a reload
      // before the webhook lands re-runs this effect and resumes
      // polling instead of silently dropping the marker.
    } else if (checkoutParam === 'cancelled') {
      clearAnnualSwitchMarker();
      clearTierUpgradeMarker();
      clearCheckoutSuccessMarker();
      setAnnualSwitchMarker(null);
      setAnnualSwitchReturnedAt(null);
      setTierUpgradeMarker(null);
      setTierUpgradeReturnedAt(null);
      setCheckoutSuccessMarker(null);
      setCheckoutSuccessReturnedAt(null);
      const url = new URL(window.location.href);
      url.searchParams.delete('checkout');
      window.history.replaceState({}, '', url.toString());
    }
    // location.search is included so a SPA navigation that only
    // changes the query string re-runs this effect.
  }, [queryClient, location.search]);

  // Strip ?checkout=success once the marker has resolved (banner
  // rendered or polling gave up). Keeps the URL clean without losing
  // the redirect signal during the wait window above.
  const stripCheckoutParamFromUrl = useCallback(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has('checkout')) return;
    url.searchParams.delete('checkout');
    window.history.replaceState({}, '', url.toString());
  }, []);

  const dismissAnnualSwitchBanner = useCallback(() => {
    setAnnualSwitchDismissed(true);
    setAnnualSwitchMarker(null);
    clearAnnualSwitchMarker();
    stripCheckoutParamFromUrl();
  }, [stripCheckoutParamFromUrl]);

  const dismissTierUpgradeBanner = useCallback(() => {
    setTierUpgradeDismissed(true);
    setTierUpgradeMarker(null);
    clearTierUpgradeMarker();
    stripCheckoutParamFromUrl();
  }, [stripCheckoutParamFromUrl]);

  const dismissCheckoutSuccessBanner = useCallback(() => {
    setCheckoutSuccessDismissed(true);
    setCheckoutSuccessMarker(null);
    clearCheckoutSuccessMarker();
    stripCheckoutParamFromUrl();
  }, [stripCheckoutParamFromUrl]);

  // Dismiss the downgrade-completion banner. We hide locally first
  // (so the X feels instant) and POST the acknowledge endpoint
  // fire-and-forget — failures don't matter because the next visit
  // will re-render the banner if the columns weren't actually nulled
  // server-side, which is the safest fallback.
  const dismissDowngradeCompletionBanner = useCallback(() => {
    setDowngradeCompletionDismissed(true);
    api
      .post('/billing/acknowledge-downgrade-completion', {})
      .then(() => {
        // Refetch so the cached subscription drops the cleared columns
        // and the banner stays gone on a soft reload.
        queryClient.invalidateQueries({ queryKey: ['billing-subscription'] });
      })
      .catch(() => {
        // Best-effort; the banner is already hidden in this tab and
        // the server-side columns will get cleared on the next call.
      });
  }, [queryClient]);

  // Records impression / click events from the BillingEstimator banner.
  // Completion is attributed server-side from the Stripe webhook, so
  // we don't write anything here for switch_completed.
  const handleRecommendationEvent = useCallback(
    (event: RecommendationEvent) => {
      api
        .post('/billing/recommendation-event', {
          eventType: event.type,
          currentTier: event.currentTier,
          recommendedTier: event.recommendedTier,
          monthlySavingsCents: event.monthlySavingsCents,
          pitch: event.pitch,
          ...(event.trailingWindowMonths !== undefined
            ? { trailingWindowMonths: event.trailingWindowMonths }
            : {}),
        })
        .catch(() => {
          // Analytics failures must not block the upgrade flow.
        });
    },
    [],
  );

  // Discount badge impression / click. Fire-and-forget; completion is
  // attributed server-side from the Stripe webhook.
  const handleDiscountEvent = useCallback((event: DiscountEvent) => {
    api
      .post('/billing/recommendation-event', {
        eventType: event.type,
        currentTier: event.currentTier,
        recommendedTier: event.tier,
        ...(event.couponId ? { couponId: event.couponId } : {}),
        ...(event.promotionCode ? { promotionCode: event.promotionCode } : {}),
      })
      .catch(() => {
        // Analytics failures must not block the upgrade flow.
      });
  }, []);

  // Annual-savings nudge click. Recorded under the existing
  // `annual-only` pitch (current_tier === recommended_tier); the
  // `metadata.source` field separates the in-callout CTA from the
  // same-tier upgrade card so conversion paths can be compared.
  const handleAnnualNudgeClick = useCallback(
    (event: {
      source: 'callout' | 'upgrade-card';
      currentTier: PlanTier;
      annualSavingsCents: number;
      liveRateBadgeVisible: boolean;
    }) => {
      const safeAnnualSavings = Number.isFinite(event.annualSavingsCents)
        ? Math.max(0, Math.round(event.annualSavingsCents))
        : 0;
      // Stored as monthly to stay comparable with the banner's rows;
      // the original annual figure is preserved in metadata.
      const monthlySavingsCents = Math.round(safeAnnualSavings / 12);
      api
        .post('/billing/recommendation-event', {
          eventType: 'click',
          currentTier: event.currentTier,
          recommendedTier: event.currentTier,
          monthlySavingsCents,
          pitch: 'annual-only',
          metadata: {
            source: event.source,
            annualSavingsCents: safeAnnualSavings,
            liveRateBadgeVisible: event.liveRateBadgeVisible,
          },
        })
        .catch(() => {
          // Analytics failures must not block the upgrade flow.
        });
    },
    [],
  );

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

  // Trailing complete-month AI minute totals (window selected by the
  // tenant: 3, 6, or 12 months) used by the BillingEstimator's
  // plan-recommendation banner. Excludes the in-progress month so we
  // recommend off finalized data, not a partial MTD slice. Cached for an
  // hour because last-month totals don't shift intra-day; the
  // recommendation just needs to be fresh-ish, not live. We keep the
  // previous window's data visible while a new window refetches so the
  // recommendation card doesn't flicker when the tenant toggles.
  const { data: trailingUsageData } = useQuery({
    queryKey: ['billing-usage-trailing', trailingWindow],
    queryFn: () => api.get<{
      months: number;
      monthsWithData: number;
      monthly: Array<{ month: string; aiMinutes: number }>;
      monthlyPriorYear?: Array<{ month: string; aiMinutes: number | null }>;
      averageAiMinutes: number;
    }>(`/billing/usage/trailing?months=${trailingWindow}&compareToPriorYear=true`),
    staleTime: 60 * 60 * 1000,
    placeholderData: (prev) => prev,
  });

  // Live per-minute overage + base price sourced from the tenant's actual
  // Stripe subscription items. Falls back to catalog defaults server-side
  // when no Stripe subscription exists, so the BillingEstimator stays
  // accurate for tenants on a custom / negotiated / grandfathered price.
  //
  // The `monthlyBasePriceCents` / `annualBasePriceCents` pair powers the
  // in-card "Save $X/yr by switching to annual" callout below for tenants
  // currently on monthly billing — same source the public pricing
  // calculator already uses, so the quote a tenant sees on the dashboard
  // matches what they'd see on /pricing.
  const { data: effectiveRateData } = useQuery({
    queryKey: ['billing-effective-rate'],
    queryFn: () => api.get<{
      basePriceCents: number;
      overageRatePerMinute: number;
      basePriceSource: 'stripe' | 'catalog';
      overagePriceSource: 'stripe' | 'catalog';
      monthlyBasePriceCents: number;
      monthlyBasePriceSource: 'stripe' | 'catalog';
      annualBasePriceCents: number;
      annualBasePriceSource: 'stripe' | 'catalog';
      // Per-message SMS rate (in dollars) and its provenance. Optional
      // for backward-compat with older API responses — the
      // BillingEstimator hides its SMS rate row when the field is
      // missing rather than rendering a misleading "$0.00/msg".
      smsRatePerMessage?: number;
      smsPriceSource?: 'stripe' | 'catalog';
      // Per-minute Twilio (carrier) rate (in dollars), its provenance,
      // and the Stripe price id backing it. Optional for backward-compat
      // with older API responses — the BillingEstimator hides the Twilio
      // rate row when the field is missing rather than rendering a
      // misleading "$0.00/min" line.
      twilioRatePerMinute?: number;
      twilioPriceSource?: 'stripe' | 'catalog';
      twilioPriceId?: string | null;
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
    // If the user has an explicitly-saved upgrade-interval preference,
    // defer to the hydration effect — applying the subscription-derived
    // default would race-overwrite the user's saved value when both
    // queries resolve in the same render cycle.
    const savedPref = preferencesData?.preferences
      ? readServerUpgradeInterval(preferencesData.preferences)
      : null;
    if (savedPref !== null) return;
    // Implicit default derived from the tenant's current subscription —
    // never write this through to /me/preferences. We only persist values
    // the user has explicitly chosen via the toggle.
    setBillingPeriodState(interval === 'annual' ? 'annual' : 'monthly');
    setBillingPeriodInitialized(true);
  }, [subData, billingPeriodInitialized, preferencesData]);

  // Tenant-specific upgrade quote for the BillingEstimator's "Next tier
  // up" card. The endpoint applies any active customer-level coupon /
  // promotion code attached in Stripe so the card matches what Sales
  // negotiated, instead of showing the published catalog list price. The
  // server returns `{ upgrade: null }` when the tenant is already on the
  // top tier (Enterprise) — we leave the prop undefined in that case so
  // the component falls back to its existing top-tier placeholder.
  // Downgrade preview shape returned by `GET /billing/downgrade-preview`.
  // Used to quote the next-invoice total Stripe will produce on the
  // new tier (which differs from catalog when the tenant has a
  // customer-level coupon). The downgrade scheduler defers the price
  // swap to `current_period_end`, so there is no unused time on the
  // higher tier to credit — the response intentionally has no
  // `prorationCreditCents` field.
  type DowngradePreviewResp = {
    plan: string;
    interval: 'monthly' | 'annual';
    nextInvoiceTotalCents: number;
    nextInvoiceAt: string | null;
    basePriceCents: number;
    currency: string;
    source: 'stripe' | 'catalog' | 'mixed';
    basePriceSource: 'stripe' | 'catalog';
    basePriceId: string | null;
    discount: {
      couponId: string | null;
      name: string | null;
      percentOff: number | null;
      amountOffCents: number | null;
      currency: string | null;
      promotionCode: string | null;
    } | null;
  };

  const { data: upgradePreviewData } = useQuery({
    queryKey: ['billing-upgrade-preview'],
    queryFn: () => api.get<{
      upgrade: {
        plan: string;
        basePriceCents: number;
        overageRatePerMinute: number;
        basePriceSource: 'stripe' | 'catalog';
        overagePriceSource: 'stripe' | 'catalog';
        // Stripe price ids backing the quoted base / overage rates when
        // the corresponding source is `'stripe'`. Surfaced through the
        // BillingEstimator's "Live Stripe rate" badge as a
        // `data-overage-price-id` attribute so QA / support can confirm
        // exactly which Stripe price drove the upgrade quote.
        basePriceId?: string | null;
        overagePriceId?: string | null;
        // Customer-level coupon / promotion-code metadata that explains
        // why the quoted base price came in below the published catalog
        // rate. Surfaced to the tenant as a small badge on the "Next
        // tier up" card so Sales/Support don't have to field "is the
        // discount still applied?" calls. `null` when the tenant has no
        // active discount or when the upgrade-preview lookup degraded
        // to catalog defaults.
        discount: {
          couponId: string | null;
          name: string | null;
          percentOff: number | null;
          amountOffCents: number | null;
          currency: string | null;
          promotionCode: string | null;
        } | null;
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

  // Task #1405: coupon redemption happens here — either via the
  // Stripe Customer Portal launched by `portalMutation` above, or
  // via an inline promo code attached during a Checkout flow.
  // Marketplace listing cards cache the customer-level discount
  // preview (`marketplace-customer-discount`) for 60s via React
  // Query's `staleTime` (Task #1380), which means a buyer who
  // applies a fresh coupon here would otherwise keep seeing the
  // old preview when they navigate back to /marketplace inside
  // that window. Invalidating on unmount guarantees that any SPA
  // navigation away from /billing — back to /marketplace, or via
  // any other route on the way there — refetches the snapshot
  // before the next listing render. The Stripe Portal redirect
  // itself is a full page navigation, after which the React Query
  // cache resets on the fresh load, so there is no parallel case
  // to handle for that flow.
  useEffect(() => {
    return () => {
      queryClient.invalidateQueries({ queryKey: ['marketplace-customer-discount'] });
    };
  }, [queryClient]);

  const checkoutMutation = useMutation({
    mutationFn: (params: {
      plan: string;
      interval: string;
      recommendation?: RecommendationAttribution;
      discount?: { couponId: string | null; promotionCode: string | null };
    }) =>
      api.post<{ url: string }>('/billing/checkout', {
        plan: params.plan,
        interval: params.interval,
        successUrl: `${window.location.origin}/billing?checkout=success`,
        cancelUrl: `${window.location.origin}/billing?checkout=cancelled`,
        ...(params.recommendation ? { recommendation: params.recommendation } : {}),
        ...(params.discount ? { discount: params.discount } : {}),
      }),
    onSuccess: (data) => { window.location.href = data.url; },
    onError: () => {
      setUpgradeLoading(null);
      // Checkout never reached Stripe so the success-redirect markers
      // stamped by handleUpgrade are now stale. Clear them so a future
      // unrelated visit to /billing?checkout=success (e.g. a different
      // completed checkout) can't hydrate them and fire the wrong
      // banner before they age out of sessionStorage.
      clearAnnualSwitchMarker();
      clearTierUpgradeMarker();
      clearCheckoutSuccessMarker();
    },
  });

  // Downgrades go through a dedicated server endpoint that uses Stripe
  // Subscription Schedules to defer the plan swap until `current_period_end`.
  // Reusing /billing/checkout would create a parallel subscription AND
  // flip the local subscriptions row to the lower plan immediately on
  // checkout completion, both of which contradict the "takes effect at
  // next renewal" copy on the downgrade card.
  const [downgradeNotice, setDowngradeNotice] = useState<{
    plan: string;
    scheduledFor: string;
  } | null>(null);

  const downgradeMutation = useMutation({
    mutationFn: (params: {
      plan: string;
      interval: string;
      recommendation?: RecommendationAttribution;
    }) =>
      api.post<{ scheduled: { scheduleId: string; scheduledFor: string; targetPlan: string; targetInterval: string } }>(
        '/billing/schedule-downgrade',
        {
          plan: params.plan,
          interval: params.interval,
          ...(params.recommendation ? { recommendation: params.recommendation } : {}),
        },
      ),
    onSuccess: (data) => {
      setUpgradeLoading(null);
      setDowngradeNotice({
        plan: data.scheduled.targetPlan,
        scheduledFor: data.scheduled.scheduledFor,
      });
      // Refresh the subscription view so any UI surfaces that key off
      // the latest record (e.g. Estimated Cost) recompute against the
      // server's view of the schedule. Also drop the cached downgrade
      // previews — the credit + next-invoice numbers depend on the
      // current paid period, which the schedule update just changed.
      queryClient.invalidateQueries({ queryKey: ['billing-subscription'] });
      queryClient.invalidateQueries({ queryKey: ['billing-downgrade-preview'] });
    },
    onError: () => setUpgradeLoading(null),
  });

  const handleUpgrade = (
    plan: string,
    interval: string = 'monthly',
    recommendation?: RecommendationAttribution,
    discount?: { couponId: string | null; promotionCode: string | null },
  ) => {
    setUpgradeLoading(plan);
    // Determine whether this checkout is a *strict* tier upgrade
    // (e.g. starter → pro, pro → enterprise). When it is, stamp the
    // tier-upgrade marker so the post-redirect banner can fire and
    // proactively clear any annual-switch marker — the two banners
    // compete for the same slot on the page and the tier change is
    // the bigger story (it actually expands the tenant's limits).
    //
    // For pure interval changes (same tier, monthly → annual) we keep
    // the existing annual-switch marker semantics. Anything else
    // (downgrades go through handleDowngrade, but be defensive)
    // clears both markers so a stale one can't bleed into this
    // checkout.
    const currentInterval = sub?.billing_interval ?? 'none';
    const currentPlan = sub?.plan ?? 'starter';
    const targetPlan = plan;
    const isKnownTier = (p: string): p is PlanTier =>
      p === 'starter' || p === 'pro' || p === 'enterprise';
    const isStrictTierUpgrade =
      isKnownTier(currentPlan)
      && isKnownTier(targetPlan)
      && TIER_RANK[targetPlan] > TIER_RANK[currentPlan];

    if (isStrictTierUpgrade && isKnownTier(currentPlan) && isKnownTier(targetPlan)) {
      writeTierUpgradeMarker({
        previousPlan: currentPlan,
        targetPlan,
        initiatedAt: Date.now(),
      });
      // Tier change supersedes any pending annual-switch banner so we
      // don't render two stacked confirmations on return.
      clearAnnualSwitchMarker();
    } else if (interval === 'annual' && currentInterval === 'monthly') {
      writeAnnualSwitchMarker({
        previousInterval: 'monthly',
        initiatedAt: Date.now(),
      });
      clearTierUpgradeMarker();
    } else {
      clearAnnualSwitchMarker();
      clearTierUpgradeMarker();
    }
    // Always stamp the generic checkout-success marker so the
    // post-redirect banner can fire for cases the more specific
    // markers don't cover (brand-new checkouts, same-tier same-interval
    // re-checkouts that attach a discount, etc.). At render time the
    // generic banner is suppressed when the annual-switch or
    // tier-upgrade banner is already showing for the same checkout, so
    // stamping it unconditionally here doesn't risk stacked banners.
    writeCheckoutSuccessMarker({ initiatedAt: Date.now() });
    checkoutMutation.mutate({ plan, interval, recommendation, discount });
  };

  const handleDowngrade = (
    targetPlan: string,
    interval: string = 'monthly',
    preview?: DowngradePreviewResp | null,
    recommendation?: RecommendationAttribution,
  ) => {
    const currentLabel = PLAN_LABELS[plan] ?? plan;
    const targetLabel = PLAN_LABELS[targetPlan] ?? targetPlan;
    const baseMessage = sub?.current_period_end
      ? tenantT('common.confirms.downgrade_plan_with_date', {
          current: currentLabel,
          target: targetLabel,
          date: formatDate(sub.current_period_end),
        })
      : tenantT('common.confirms.downgrade_plan', {
          current: currentLabel,
          target: targetLabel,
        });
    // Append the next-invoice quote when we have a preview. The
    // downgrade scheduler defers the price swap to `current_period_end`,
    // so the tenant pays for the full higher-tier period and there is
    // no proration credit to surface alongside this line.
    const nextInvoiceCopy = preview && preview.nextInvoiceTotalCents != null
      ? ' ' + (preview.nextInvoiceAt
          ? tenantT('common.confirms.downgrade_next_invoice_with_date', {
              amount: formatCentsHelper(preview.nextInvoiceTotalCents, { currency: preview.currency || currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }),
              date: formatDate(preview.nextInvoiceAt),
            })
          : tenantT('common.confirms.downgrade_next_invoice', {
              amount: formatCentsHelper(preview.nextInvoiceTotalCents, { currency: preview.currency || currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }),
            }))
      : '';
    // Banner-driven downgrades skip the window.confirm step — clicking
    // the BillingEstimator's "Switch to <Plan>" CTA is itself the
    // explicit consent (the banner shows the same monthly-savings copy
    // that this confirm dialog would show, and is the user-facing entry
    // point we're attributing the conversion to).
    if (!recommendation) {
      const ok = window.confirm(`${baseMessage}${nextInvoiceCopy}`);
      if (!ok) return;
    }
    setUpgradeLoading(targetPlan);
    downgradeMutation.mutate({ plan: targetPlan, interval, recommendation });
  };

  const sub = subData?.subscription;
  const plan = sub?.plan ?? subData?.plan ?? 'starter';
  const status = sub?.status ?? subData?.status ?? 'none';
  const usage = usageData?.usage ?? {};
  const budget = budgetData;

  // One-time guarantee: once the banner is renderable, drop the
  // sessionStorage marker and the URL param so reloads/fresh visits
  // don't re-fire it. The in-memory marker keeps the banner visible
  // until dismiss. Idempotent via `annualSwitchAcknowledged`.
  //
  // Also drop the generic checkout-success marker here so the
  // fallback banner doesn't surface later (e.g. after the user
  // dismisses the annual banner) for the same checkout — the annual
  // case already has its own confirmation.
  useEffect(() => {
    if (annualSwitchAcknowledged) return;
    if (!annualSwitchMarker) return;
    if (sub?.billing_interval !== 'annual') return;
    if (status !== 'active' && status !== 'trialing') return;
    clearAnnualSwitchMarker();
    clearCheckoutSuccessMarker();
    setCheckoutSuccessMarker(null);
    setCheckoutSuccessReturnedAt(null);
    setCheckoutSuccessAcknowledged(true);
    stripCheckoutParamFromUrl();
    setAnnualSwitchAcknowledged(true);
  }, [
    annualSwitchAcknowledged,
    annualSwitchMarker,
    sub?.billing_interval,
    status,
    stripCheckoutParamFromUrl,
  ]);

  // Webhook-lag polling: while a marker is pending and the local
  // subscription still shows monthly, re-fetch every 3s up to the
  // budget measured from `returnedAt`. Self-rescheduling because a
  // refetch that returns identical data may not re-run this effect
  // (react-query keeps the same data reference under structural
  // sharing), so we cannot rely on `sub` changing to drive the loop.
  useEffect(() => {
    if (!annualSwitchMarker) return;
    if (annualSwitchReturnedAt === null) return;
    if (sub?.billing_interval === 'annual') return;
    let cancelled = false;
    let handle: number | undefined;
    const tick = () => {
      if (cancelled) return;
      if (Date.now() - annualSwitchReturnedAt > ANNUAL_SWITCH_MAX_WAIT_MS) {
        clearAnnualSwitchMarker();
        setAnnualSwitchMarker(null);
        setAnnualSwitchReturnedAt(null);
        stripCheckoutParamFromUrl();
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['billing-subscription'] });
      queryClient.invalidateQueries({ queryKey: ['billing-effective-rate'] });
      handle = window.setTimeout(tick, 3_000);
    };
    handle = window.setTimeout(tick, 3_000);
    return () => {
      cancelled = true;
      if (handle !== undefined) window.clearTimeout(handle);
    };
  }, [
    annualSwitchMarker,
    annualSwitchReturnedAt,
    sub?.billing_interval,
    queryClient,
    stripCheckoutParamFromUrl,
  ]);

  // Tier-upgrade acknowledgement: once the local subscription reflects
  // the new (higher) tier, drop the sessionStorage marker and the URL
  // param so reloads/fresh visits don't re-fire the banner. The
  // in-memory marker stays until the user dismisses, so the banner
  // remains rendered. Idempotent via `tierUpgradeAcknowledged`.
  //
  // Also drop the generic checkout-success marker here so the
  // fallback banner doesn't surface later (e.g. after the user
  // dismisses the tier-upgrade banner) for the same checkout — the
  // tier-upgrade case already has its own confirmation.
  useEffect(() => {
    if (tierUpgradeAcknowledged) return;
    if (!tierUpgradeMarker) return;
    if (sub?.plan !== tierUpgradeMarker.targetPlan) return;
    if (status !== 'active' && status !== 'trialing') return;
    clearTierUpgradeMarker();
    clearCheckoutSuccessMarker();
    setCheckoutSuccessMarker(null);
    setCheckoutSuccessReturnedAt(null);
    setCheckoutSuccessAcknowledged(true);
    stripCheckoutParamFromUrl();
    setTierUpgradeAcknowledged(true);
  }, [
    tierUpgradeAcknowledged,
    tierUpgradeMarker,
    sub?.plan,
    status,
    stripCheckoutParamFromUrl,
  ]);

  // Webhook-lag polling for the tier-upgrade banner. Same shape as
  // the annual-switch loop above; runs while the marker is pending
  // and the local plan hasn't caught up to the target yet.
  useEffect(() => {
    if (!tierUpgradeMarker) return;
    if (tierUpgradeReturnedAt === null) return;
    if (sub?.plan === tierUpgradeMarker.targetPlan) return;
    let cancelled = false;
    let handle: number | undefined;
    const tick = () => {
      if (cancelled) return;
      if (Date.now() - tierUpgradeReturnedAt > TIER_UPGRADE_MAX_WAIT_MS) {
        clearTierUpgradeMarker();
        setTierUpgradeMarker(null);
        setTierUpgradeReturnedAt(null);
        stripCheckoutParamFromUrl();
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['billing-subscription'] });
      queryClient.invalidateQueries({ queryKey: ['billing-effective-rate'] });
      handle = window.setTimeout(tick, 3_000);
    };
    handle = window.setTimeout(tick, 3_000);
    return () => {
      cancelled = true;
      if (handle !== undefined) window.clearTimeout(handle);
    };
  }, [
    tierUpgradeMarker,
    tierUpgradeReturnedAt,
    sub?.plan,
    queryClient,
    stripCheckoutParamFromUrl,
  ]);

  // Generic checkout-success acknowledgement: once the local
  // subscription is loaded, active/trialing AND has been touched by
  // the webhook since the user clicked checkout, drop the
  // sessionStorage marker and the URL param so reloads/fresh visits
  // don't re-fire the banner. The in-memory marker stays until the
  // user dismisses, so the banner remains rendered. Idempotent via
  // `checkoutSuccessAcknowledged`.
  //
  // The freshness check (`sub.updated_at` newer than the marker's
  // `initiatedAt`) is critical for existing customers doing a
  // same-plan re-checkout (e.g. attaching a discount). Their
  // subscription is already `active` before checkout, so without it
  // the acknowledgement would fire immediately on return — polling
  // would stop and stale `sub.discounts` (without the new discount
  // chips) could render forever. Allow ~60s of client/server clock
  // skew on the comparison; checkout always takes at least a few
  // seconds, so this won't false-positive against pre-checkout state.
  useEffect(() => {
    if (checkoutSuccessAcknowledged) return;
    if (!checkoutSuccessMarker) return;
    if (status !== 'active' && status !== 'trialing') return;
    if (!sub?.updated_at) return;
    const subUpdatedMs = Date.parse(sub.updated_at);
    if (Number.isNaN(subUpdatedMs)) return;
    if (subUpdatedMs < checkoutSuccessMarker.initiatedAt - 60_000) return;
    clearCheckoutSuccessMarker();
    stripCheckoutParamFromUrl();
    setCheckoutSuccessAcknowledged(true);
  }, [
    checkoutSuccessAcknowledged,
    checkoutSuccessMarker,
    status,
    sub?.updated_at,
    stripCheckoutParamFromUrl,
  ]);

  // Webhook-lag polling for the generic checkout-success banner. Same
  // shape as the annual-switch / tier-upgrade loops above. Runs until
  // acknowledgement (the freshness check above succeeds) OR the
  // budget measured from `returnedAt` is exhausted.
  //
  // Notably we do NOT skip on `status === active/trialing` — existing
  // customers re-checking out for a discount are already active, but
  // the new `sub.discounts` row only lands when the webhook fires.
  // Skipping polling there would leave the banner stuck without
  // chips. We also do not skip when an annual-switch / tier-upgrade
  // marker is also pending: react-query dedupes simultaneous refetches
  // of the same query, so the duplicate `invalidateQueries` calls per
  // tick are effectively a no-op, and either of those markers
  // acknowledging will clear our marker (see their effects above) and
  // tear this loop down on the next render.
  useEffect(() => {
    if (!checkoutSuccessMarker) return;
    if (checkoutSuccessReturnedAt === null) return;
    let cancelled = false;
    let handle: number | undefined;
    const tick = () => {
      if (cancelled) return;
      if (Date.now() - checkoutSuccessReturnedAt > CHECKOUT_SUCCESS_MAX_WAIT_MS) {
        clearCheckoutSuccessMarker();
        setCheckoutSuccessMarker(null);
        setCheckoutSuccessReturnedAt(null);
        stripCheckoutParamFromUrl();
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['billing-subscription'] });
      handle = window.setTimeout(tick, 3_000);
    };
    handle = window.setTimeout(tick, 3_000);
    return () => {
      cancelled = true;
      if (handle !== undefined) window.clearTimeout(handle);
    };
  }, [
    checkoutSuccessMarker,
    checkoutSuccessReturnedAt,
    queryClient,
    stripCheckoutParamFromUrl,
  ]);

  // Tiers strictly below the tenant's current plan, paired with the
  // interval shown on the toggle. Empty when the tenant has no paid
  // subscription so `useQueries` below stays a no-op.
  const downgradeCandidates = useMemo<Array<{ tier: PlanTier; interval: BillingPeriod }>>(() => {
    const TIER_ORDER: Record<PlanTier, number> = { starter: 0, pro: 1, enterprise: 2 };
    const ALL: PlanTier[] = ['starter', 'pro', 'enterprise'];
    const currentRank = TIER_ORDER[plan as PlanTier] ?? 0;
    const canDowngrade = !!sub && status !== 'none';
    if (!canDowngrade) return [];
    return ALL
      .filter((t) => (TIER_ORDER[t] ?? 0) < currentRank)
      .map((tier) => ({ tier, interval: billingPeriod }));
  }, [plan, sub, status, billingPeriod]);

  // One query per (tier, interval) candidate. Cached 30m; explicitly
  // invalidated on a successful schedule change below.
  const downgradePreviewQueries = useQueries({
    queries: downgradeCandidates.map(({ tier, interval }) => ({
      queryKey: ['billing-downgrade-preview', tier, interval],
      queryFn: () => api.get<{ downgrade: DowngradePreviewResp | null }>(
        `/billing/downgrade-preview?plan=${encodeURIComponent(tier)}&interval=${encodeURIComponent(interval)}`,
      ),
      staleTime: 30 * 60 * 1000,
    })),
  });

  const downgradePreviews = useMemo(() => {
    const m = new Map<string, DowngradePreviewResp | null>();
    downgradeCandidates.forEach((c, idx) => {
      const data = downgradePreviewQueries[idx]?.data?.downgrade ?? null;
      m.set(`${c.tier}|${c.interval}`, data);
    });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downgradeCandidates, downgradePreviewQueries]);

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
      <PageHeader
        icon={<CreditCard className="h-5 w-5" />}
        title="Billing"
        description="Manage your subscription, usage, and payment methods"
        actions={sub && isAdmin && (
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
      />

      {subError && (
        <div className="bg-danger/10 text-danger text-sm px-4 py-3 rounded-lg flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          Failed to load subscription: {subError.message}
        </div>
      )}

      {downgradeNotice && (
        <div
          role="status"
          className="bg-success/10 text-success text-sm px-4 py-3 rounded-lg flex items-center gap-2"
          data-testid="downgrade-scheduled-notice"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          Downgrade to {PLAN_LABELS[downgradeNotice.plan] ?? downgradeNotice.plan} scheduled for {formatDate(downgradeNotice.scheduledFor)}. You will keep your current plan until then.
        </div>
      )}

      {/* One-time monthly→annual switch confirmation. Gating + lifecycle
          live in the effects above; see ANNUAL_SWITCH_MARKER_KEY. */}
      {(() => {
        const showBanner =
          annualSwitchMarker !== null
          && !annualSwitchDismissed
          && sub?.billing_interval === 'annual'
          && (status === 'active' || status === 'trialing');
        if (!showBanner) return null;
        const monthlyCents = effectiveRateData?.monthlyBasePriceCents;
        const annualEquivCents = effectiveRateData?.annualBasePriceCents;
        const planLabel = PLAN_LABELS[plan] ?? plan;
        // Only render the savings clause when both rates are finite
        // and annual is actually cheaper, to avoid "saving $0/yr".
        const hasSavings =
          typeof monthlyCents === 'number'
          && typeof annualEquivCents === 'number'
          && Number.isFinite(monthlyCents)
          && Number.isFinite(annualEquivCents)
          && monthlyCents > annualEquivCents;
        const annualSavingsCents = hasSavings
          ? (monthlyCents - annualEquivCents) * 12
          : 0;
        // Prefer `discounts`; fall back to legacy `discount` for
        // older server builds.
        const discountList: BillingDiscountSummary[] =
          sub?.discounts && sub.discounts.length > 0
            ? sub.discounts
            : sub?.discount
              ? [sub.discount]
              : [];
        const discountTooltip = discountList.length > 1
          ? `${discountList.length} discounts are stacked on your new subscription. Each is shown on Stripe Checkout and on every invoice it applies to.`
          : 'Active discount applied to your new subscription. Shown on Stripe Checkout and on every invoice this discount applies to.';
        return (
          <div
            role="status"
            data-testid="billing-annual-switch-success-banner"
            className="bg-success/10 border border-success/30 text-text-primary text-sm px-4 py-3 rounded-lg flex items-start gap-3"
          >
            <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5 text-success" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-success">
                You're now on annual billing
              </p>
              <p className="text-sm mt-0.5 text-text-muted">
                Your {planLabel} plan switched to annual billing.
                {hasSavings && annualSavingsCents > 0 && (
                  <>
                    {' '}You're saving{' '}
                    <span
                      data-testid="billing-annual-switch-success-savings"
                      className="font-semibold text-success"
                    >
                      {formatCents(annualSavingsCents)}/yr
                    </span>{' '}
                    vs the monthly rate.
                  </>
                )}
              </p>
              {discountList.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {discountList.map((d, idx) => (
                    <span
                      key={`${d.couponId ?? 'coupon'}-${d.promotionCode ?? 'code'}-${idx}`}
                      data-testid="billing-annual-switch-success-discount-badge"
                      className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-xs font-semibold text-success"
                      title={discountTooltip}
                    >
                      <Sparkles className="h-3 w-3" aria-hidden="true" />
                      <span>Active discount: {formatDiscountLabel(d, currency)}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={dismissAnnualSwitchBanner}
              data-testid="billing-annual-switch-success-dismiss"
              className="shrink-0 rounded-md p-1 text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
              aria-label="Dismiss annual billing confirmation"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        );
      })()}

      {/* One-time tier-upgrade confirmation banner. Gating + lifecycle
          live in the effects above; see TIER_UPGRADE_MARKER_KEY. Only
          renders once the local subscription plan has caught up to the
          marker's target tier so we don't claim "you're now on Pro"
          before the webhook has actually flipped the row. */}
      {(() => {
        const showBanner =
          tierUpgradeMarker !== null
          && !tierUpgradeDismissed
          && sub?.plan === tierUpgradeMarker.targetPlan
          && (status === 'active' || status === 'trialing');
        if (!showBanner || !tierUpgradeMarker) return null;
        const newPlanLabel = PLAN_LABELS[tierUpgradeMarker.targetPlan] ?? tierUpgradeMarker.targetPlan;
        // Same discount-chip logic as the annual-switch banner: prefer
        // the full `discounts` array, fall back to the legacy single
        // `discount` field for older server builds.
        const discountList: BillingDiscountSummary[] =
          sub?.discounts && sub.discounts.length > 0
            ? sub.discounts
            : sub?.discount
              ? [sub.discount]
              : [];
        const discountTooltip = discountList.length > 1
          ? `${discountList.length} discounts are stacked on your new subscription. Each is shown on Stripe Checkout and on every invoice it applies to.`
          : 'Active discount applied to your new subscription. Shown on Stripe Checkout and on every invoice this discount applies to.';
        return (
          <div
            role="status"
            data-testid="billing-tier-upgrade-success-banner"
            className="bg-success/10 border border-success/30 text-text-primary text-sm px-4 py-3 rounded-lg flex items-start gap-3"
          >
            <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5 text-success" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-success">
                {tenantT('settings.billing.tier_upgrade_banner.title', { plan: newPlanLabel })}
              </p>
              <p className="text-sm mt-0.5 text-text-muted">
                {tenantT('settings.billing.tier_upgrade_banner.body', { plan: newPlanLabel })}
              </p>
              {discountList.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {discountList.map((d, idx) => (
                    <span
                      key={`${d.couponId ?? 'coupon'}-${d.promotionCode ?? 'code'}-${idx}`}
                      data-testid="billing-tier-upgrade-success-discount-badge"
                      className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-xs font-semibold text-success"
                      title={discountTooltip}
                    >
                      <Sparkles className="h-3 w-3" aria-hidden="true" />
                      <span>Active discount: {formatDiscountLabel(d, currency)}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={dismissTierUpgradeBanner}
              data-testid="billing-tier-upgrade-success-dismiss"
              className="shrink-0 rounded-md p-1 text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
              aria-label={tenantT('settings.billing.tier_upgrade_banner.dismiss_aria')}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        );
      })()}

      {/* Generic post-checkout confirmation banner (Task #1382).
          Renders for any successful checkout completion that isn't
          already covered by the more specific annual-switch or
          tier-upgrade banners above (brand-new checkouts, same-tier
          same-interval re-checkouts that attach a discount, etc.).
          Gating + lifecycle live in the effects above; see
          CHECKOUT_SUCCESS_MARKER_KEY. */}
      {(() => {
        // Mirror the show conditions of the two more specific banners
        // so we can suppress the generic one when either is rendering
        // — the generic banner is meant as a fallback, not a stack.
        const annualShown =
          annualSwitchMarker !== null
          && !annualSwitchDismissed
          && sub?.billing_interval === 'annual'
          && (status === 'active' || status === 'trialing');
        const tierShown =
          tierUpgradeMarker !== null
          && !tierUpgradeDismissed
          && sub?.plan === tierUpgradeMarker.targetPlan
          && (status === 'active' || status === 'trialing');
        const showBanner =
          checkoutSuccessMarker !== null
          && !checkoutSuccessDismissed
          && (status === 'active' || status === 'trialing')
          && !annualShown
          && !tierShown;
        if (!showBanner) return null;
        const planLabel = PLAN_LABELS[plan] ?? plan;
        const discountList: BillingDiscountSummary[] =
          sub?.discounts && sub.discounts.length > 0
            ? sub.discounts
            : sub?.discount
              ? [sub.discount]
              : [];
        const discountTooltip = discountList.length > 1
          ? `${discountList.length} discounts are stacked on your new subscription. Each is shown on Stripe Checkout and on every invoice it applies to.`
          : 'Active discount applied to your new subscription. Shown on Stripe Checkout and on every invoice this discount applies to.';
        return (
          <div
            role="status"
            data-testid="billing-checkout-success-banner"
            className="bg-success/10 border border-success/30 text-text-primary text-sm px-4 py-3 rounded-lg flex items-start gap-3"
          >
            <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5 text-success" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-success">
                Your new plan is active
              </p>
              <p className="text-sm mt-0.5 text-text-muted">
                Your {planLabel} plan is set up and ready to go.
              </p>
              {discountList.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {discountList.map((d, idx) => (
                    <span
                      key={`${d.couponId ?? 'coupon'}-${d.promotionCode ?? 'code'}-${idx}`}
                      data-testid="billing-checkout-success-discount-badge"
                      className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-xs font-semibold text-success"
                      title={discountTooltip}
                    >
                      <Sparkles className="h-3 w-3" aria-hidden="true" />
                      <span>Active discount: {formatDiscountLabel(d, currency)}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={dismissCheckoutSuccessBanner}
              data-testid="billing-checkout-success-dismiss"
              className="shrink-0 rounded-md p-1 text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
              aria-label="Dismiss checkout confirmation"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        );
      })()}

      {/* One-time downgrade-completion banner. The marker lives on the
          server (subscriptions.downgrade_completed_*), set by the
          Stripe webhook when the deferred Subscription Schedule swap
          actually applies the lower tier. Persisted server-side so it
          survives a fresh device / first visit after the schedule
          fires. Dismiss POSTs the acknowledge endpoint to null the
          columns; we also hide locally for instant feedback. */}
      {(() => {
        const completedAt = sub?.downgrade_completed_at;
        const completedToPlan = sub?.downgrade_completed_to_plan;
        const showBanner =
          !downgradeCompletionDismissed
          && typeof completedAt === 'string'
          && completedAt.length > 0
          && typeof completedToPlan === 'string'
          && completedToPlan.length > 0;
        if (!showBanner) return null;
        const newPlanLabel = PLAN_LABELS[completedToPlan as string] ?? (completedToPlan as string);
        return (
          <div
            role="status"
            data-testid="billing-downgrade-completion-banner"
            className="bg-success/10 border border-success/30 text-text-primary text-sm px-4 py-3 rounded-lg flex items-start gap-3"
          >
            <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5 text-success" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-success">
                {tenantT('billing.downgrade_completion_banner.title', { plan: newPlanLabel })}
              </p>
              <p className="text-sm mt-0.5 text-text-muted">
                {tenantT('billing.downgrade_completion_banner.body', { plan: newPlanLabel })}
              </p>
            </div>
            <button
              type="button"
              onClick={dismissDowngradeCompletionBanner}
              data-testid="billing-downgrade-completion-dismiss"
              className="shrink-0 rounded-md p-1 text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
              aria-label={tenantT('billing.downgrade_completion_banner.dismiss_aria')}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        );
      })()}

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

              {(() => {
                // Prefer `discounts`; fall back to legacy `discount` when
                // talking to an older server build.
                const list: BillingDiscountSummary[] =
                  sub?.discounts && sub.discounts.length > 0
                    ? sub.discounts
                    : sub?.discount
                      ? [sub.discount]
                      : [];
                if (list.length === 0) return null;
                const tooltip = list.length > 1
                  ? `${list.length} discounts are stacked on your subscription. Each is shown on Stripe Checkout and on every invoice it applies to.`
                  : 'Active discount applied to your subscription. Shown on Stripe Checkout and on every invoice this discount applies to.';
                return (
                  <div className="mb-4 flex flex-wrap items-center gap-1.5">
                    {list.map((d, idx) => (
                      <div
                        key={`${d.couponId ?? 'coupon'}-${d.promotionCode ?? 'code'}-${idx}`}
                        data-testid="billing-subscription-discount-badge"
                        className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-xs font-semibold text-success"
                        title={tooltip}
                      >
                        <Sparkles className="h-3 w-3" aria-hidden="true" />
                        <span>Active discount: {formatDiscountLabel(d, currency)}</span>
                      </div>
                    ))}
                  </div>
                );
              })()}

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

              {/*
                Annual savings callout. Surfaces the per-month equivalent of the
                tenant's tier on annual billing alongside their current monthly
                rate so they don't have to open /pricing in a new tab to see
                the comparison. Only renders when:
                  - the tenant has an active subscription on monthly billing
                  - `/billing/effective-rate` has resolved
                  - the annual quote is meaningfully cheaper than the monthly
                    quote (`annualSavingsCents > 0`) — guards against catalog
                    misconfigurations where the two prices come out equal.
                Sourcing follows the same convention as the public pricing
                calculator: a `Live rate` badge appears when either price came
                from Stripe (the tenant's actual subscription or the published
                `STRIPE_PRICE_<TIER>_<INTERVAL>` env var), so a custom
                negotiated rate is honoured here too.
              */}
              {sub?.billing_interval === 'monthly'
                && (status === 'active' || status === 'trialing')
                && effectiveRateData && (() => {
                // Gating intent: only nudge tenants whose subscription is
                // currently in good standing toward annual. A `past_due`,
                // `incomplete`, or `cancelled` monthly sub has bigger
                // problems than a 20%-off pitch, and surfacing the
                // callout there would be actively confusing.
                const monthlyCents = effectiveRateData.monthlyBasePriceCents;
                const annualEquivCents = effectiveRateData.annualBasePriceCents;
                // Defence in depth: the response shape says these fields are
                // always present, but a stale client / test fixture / partial
                // server rollout could omit them. Guard so the callout stays
                // hidden instead of rendering "Save NaN/yr".
                if (
                  typeof monthlyCents !== 'number'
                  || typeof annualEquivCents !== 'number'
                  || !Number.isFinite(monthlyCents)
                  || !Number.isFinite(annualEquivCents)
                ) {
                  return null;
                }
                const annualSavingsCents = (monthlyCents - annualEquivCents) * 12;
                if (annualSavingsCents <= 0) return null;
                const liveRate =
                  effectiveRateData.monthlyBasePriceSource === 'stripe'
                  || effectiveRateData.annualBasePriceSource === 'stripe';
                const planLabel = PLAN_LABELS[plan] ?? plan;
                return (
                  <div
                    data-testid="billing-annual-savings-callout"
                    className="mt-4 rounded-lg border border-success/30 bg-success/[0.04] px-3 py-3"
                  >
                    <div className="flex items-start gap-2">
                      <Sparkles className="h-4 w-4 text-success shrink-0 mt-0.5" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-text-primary">
                          Save{' '}
                          <span
                            data-testid="billing-annual-savings-amount"
                            className="text-success"
                          >
                            {formatCents(annualSavingsCents)}/yr
                          </span>{' '}
                          by switching to annual billing
                          {liveRate && (
                            <span
                              data-testid="billing-annual-savings-live-rate"
                              className="ml-1.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-success bg-success/10 px-1.5 py-0.5 rounded-full"
                              title="Sourced from your live Stripe pricing"
                            >
                              Live rate
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-text-muted mt-0.5">
                          Your {planLabel} plan is{' '}
                          <span
                            data-testid="billing-annual-savings-monthly-base"
                            className="font-medium text-text-primary"
                          >
                            {formatCents(monthlyCents)}/mo
                          </span>{' '}
                          on monthly billing. Annual billing works out to{' '}
                          <span
                            data-testid="billing-annual-savings-annual-equivalent"
                            className="font-medium text-text-primary"
                          >
                            {formatCents(annualEquivCents)}/mo
                          </span>
                          {' '}({Math.round(((monthlyCents - annualEquivCents) / monthlyCents) * 100)}% off).
                        </p>
                        {isAdmin && (
                          <button
                            data-testid="billing-annual-savings-switch-button"
                            onClick={() => {
                              handleAnnualNudgeClick({
                                source: 'callout',
                                currentTier: plan as PlanTier,
                                annualSavingsCents,
                                liveRateBadgeVisible: liveRate,
                              });
                              handleUpgrade(plan, 'annual');
                            }}
                            disabled={upgradeLoading === plan}
                            className="mt-2 inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-primary hover:bg-primary-hover text-white disabled:opacity-50"
                          >
                            {upgradeLoading === plan ? 'Redirecting...' : 'Switch to annual'}
                            <ArrowUpRight className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}
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
            // The interval-agnostic `basePriceCents` drives the
            // current-invoice math (already normalised to a monthly
            // equivalent of the tenant's actual subscription). The
            // separate `monthlyBasePriceCents`/`annualBasePriceCents`
            // pair is forwarded below so the current-tier card can
            // render the in-card "or $Y/mo billed annually · save
            // $Z/yr" line — same source the Subscription card's
            // annual-savings callout (and the public pricing
            // calculator's monthly/annual toggle) already use.
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
                  // Always pass the SMS rate when present — even when
                  // the source is `catalog`, surfacing the rate the
                  // tenant is actually billed at is more useful than
                  // hiding it. The "Live Stripe rate" badge is
                  // separately gated on `smsPriceSource === 'stripe'`
                  // so a catalog-sourced rate renders without the
                  // badge (matching the AI-overage convention).
                  smsRatePerMessage: effectiveRateData.smsRatePerMessage ?? null,
                  smsPriceSource: effectiveRateData.smsPriceSource ?? null,
                  // Twilio (carrier) per-minute rate follows the same
                  // convention as SMS — always pass the rate when present
                  // so a tenant on a catalog/env-default rate still sees
                  // what's driving their telephony line on the invoice.
                  // The "Live Stripe rate" badge is gated separately on
                  // `twilioPriceSource === 'stripe'` (matching the
                  // AI-overage / SMS conventions). The Stripe price id is
                  // forwarded so the badge can expose it as a data attribute
                  // for QA / support diagnostics.
                  twilioRatePerMinute: effectiveRateData.twilioRatePerMinute ?? null,
                  twilioPriceSource: effectiveRateData.twilioPriceSource ?? null,
                  twilioPriceId: effectiveRateData.twilioPriceId ?? null,
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
                  // Provenance flags drive the "Live Stripe rate" badge
                  // on the upgrade card. Mirrors the convention the
                  // current-tier card already uses via `rateOverride`,
                  // so a tenant on a metered-price override sees the
                  // same badge on both cards (and a tenant on the
                  // catalog fallback sees neither).
                  basePriceSource: upgradePreviewData.upgrade.basePriceSource,
                  overagePriceSource:
                    upgradePreviewData.upgrade.overagePriceSource,
                  // Optional Stripe price id backing the overage rate —
                  // surfaced as a data attribute on the badge for QA /
                  // support diagnostics. Only rendered when the overage
                  // actually came from Stripe.
                  overagePriceId:
                    upgradePreviewData.upgrade.overagePriceId ?? null,
                  // Coupon / promotion-code metadata so the comparison
                  // card can render a "25% off — PROMO25" badge that
                  // explains why the quote is below catalog. `null` when
                  // no customer-level discount is active.
                  discount: upgradePreviewData.upgrade.discount,
                }
              : undefined}
            projectionMultiplier={projectionMultiplier}
            currency={currency}
            // The recommendation banner's "Switch to <Plan>" CTA reuses
            // the same Stripe Checkout flow as the upgrade cards below.
            // The banner exposes its own monthly/annual toggle so the
            // tenant can pick the interval they want before we hand off
            // to Stripe — the chosen interval is forwarded here and the
            // headline savings copy in the banner stays in sync. The
            // recommendation snapshot is forwarded too so Stripe
            // checkout can stamp it into session metadata for
            // server-side attribution. Gated on `isAdmin` so read-only
            // roles never even see the button — the BillingEstimator
            // hides the CTA (and the toggle) when `onSwitchPlan` is
            // omitted.
            onSwitchPlan={isAdmin
              ? (tier, interval, recommendation) => {
                  // The recommendation banner can recommend any tier
                  // — strict downgrades (e.g. Pro → Starter when the
                  // tenant's trailing usage is under the lower tier's
                  // cap) must NOT go through Stripe Checkout. The
                  // checkout endpoint guards against this with a 400
                  // (`DOWNGRADE_REQUIRES_SCHEDULE`) because Checkout
                  // doesn't support deferred plan changes; route
                  // banner-attributed downgrades to the schedule API
                  // instead so they actually take effect at period end.
                  const tierOrder: Record<PlanTier, number> = { starter: 0, pro: 1, enterprise: 2 };
                  const currentRank = tierOrder[plan as PlanTier];
                  const targetRank = tierOrder[tier];
                  if (
                    typeof currentRank === 'number' &&
                    typeof targetRank === 'number' &&
                    targetRank < currentRank
                  ) {
                    handleDowngrade(tier, interval, undefined, recommendation);
                    return;
                  }
                  handleUpgrade(tier, interval, recommendation);
                }
              : undefined}
            switchingPlan={(upgradeLoading as PlanTier | null) ?? null}
            trailingWindow={trailingWindow}
            onTrailingWindowChange={setTrailingWindow}
            availableTrailingWindows={TRAILING_WINDOW_OPTIONS}
            onRecommendationEvent={handleRecommendationEvent}
            // Discount badge analytics. Impression fires from
            // BillingEstimator when the badge renders; the matching
            // click is fired below from the upgrade CTA. Tenant id
            // scopes the impression dedup so a tab reused across
            // tenants still attributes correctly.
            onDiscountEvent={handleDiscountEvent}
            tenantId={user?.tenantId ?? null}
            // Forward the tenant's current Stripe billing interval so the
            // recommendation card's "already on the cheapest plan" variant
            // can decide whether to surface the annual-savings pitch (only
            // shown when the tenant is currently on monthly billing).
            // Coerced to the BillingPeriod union; anything else is treated
            // as already-on-annual and suppresses the pitch.
            currentBillingInterval={
              sub?.billing_interval === 'monthly' ? 'monthly' : 'annual'
            }
            // Monthly + annual base-price quotes for the in-card
            // annual-equivalent line. The component handles all the
            // gating (monthly billing only, annual quote actually
            // cheaper, fields present), so we forward whatever
            // `/billing/effective-rate` returned and let it decide.
            monthlyBasePriceCents={effectiveRateData?.monthlyBasePriceCents ?? null}
            annualBasePriceCents={effectiveRateData?.annualBasePriceCents ?? null}
            trailingMonthlyAiMinutes={
              // Only feed the recommendation card when at least one of
              // the trailing months actually had AI usage. A brand-new
              // tenant whose entire trailing window is zero-filled would
              // otherwise see "Switch to Starter, save $300/mo!" before
              // they've ever placed a call — the recommendation needs
              // *some* signal to be actionable.
              //
              // The full zero-filled series is forwarded as-is so the
              // average-of-trailing-N math matches the backend's
              // intentional "divide by N, not by months-with-data"
              // semantics. The BillingEstimator separately surfaces the
              // months-with-data count in its "based on N complete
              // months" copy.
              trailingUsageData && trailingUsageData.monthsWithData > 0
                ? trailingUsageData.monthly.map((m) => m.aiMinutes)
                : undefined
            }
            trailingMonthlyBreakdown={
              // Same gating as `trailingMonthlyAiMinutes` — no recommendation
              // card means no chart either. The full breakdown (including
              // zero-usage months) is forwarded as-is so seasonal lulls
              // remain visible in the bar chart inside the card.
              trailingUsageData && trailingUsageData.monthsWithData > 0
                ? trailingUsageData.monthly
                : undefined
            }
            trailingMonthlyPriorYearBreakdown={
              trailingUsageData && trailingUsageData.monthsWithData > 0
                ? trailingUsageData.monthlyPriorYear
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
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            <Clock className="h-3 w-3 text-text-muted" />
                            <span className="text-xs text-text-muted">
                              {inv.date ? formatDate(inv.date) : '—'}
                            </span>
                            {inv.description && (
                              <span className="text-xs text-text-muted">· {inv.description}</span>
                            )}
                            {(() => {
                              // Prefer the new `discounts` array (which
                              // contains every coupon stacked on the
                              // invoice). Fall back to the legacy
                              // single-discount field so an older server
                              // build still renders one chip during a
                              // rollout. Both fields are never combined
                              // — `discounts` already supersedes
                              // `discount` when present.
                              const list: BillingDiscountSummary[] =
                                inv.discounts && inv.discounts.length > 0
                                  ? inv.discounts
                                  : inv.discount
                                    ? [inv.discount]
                                    : [];
                              if (list.length === 0) return null;
                              const tooltip = list.length > 1
                                ? `${list.length} discounts were applied to this invoice.`
                                : 'A discount was applied to this invoice.';
                              return list.map((d, idx) => (
                                <span
                                  key={`${d.couponId ?? 'coupon'}-${d.promotionCode ?? 'code'}-${idx}`}
                                  data-testid="billing-invoice-discount-badge"
                                  className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success"
                                  title={tooltip}
                                >
                                  <Sparkles className="h-2.5 w-2.5" aria-hidden="true" />
                                  {formatDiscountLabel(d, inv.currency || currency)}
                                </span>
                              ));
                            })()}
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
                type CardKind = 'upgrade' | 'downgrade' | 'switch_annual';
                interface PlanCard { tier: PlanTier; kind: CardKind }
                const TIER_ORDER: Record<PlanTier, number> = { starter: 0, pro: 1, enterprise: 2 };
                const ALL_TIERS: PlanTier[] = ['starter', 'pro', 'enterprise'];
                const currentRank = TIER_ORDER[plan as PlanTier] ?? 0;
                const isAnnual = billingPeriod === 'annual';
                const onMonthlySub = sub?.billing_interval === 'monthly';
                // Downgrade cards only render when the tenant actually has a
                // paid subscription — there is nothing to downgrade FROM on
                // the free tier, and a "Downgrade to Starter" card on a brand
                // new tenant would be misleading.
                const canDowngrade = !!sub && status !== 'none';
                const cards: PlanCard[] = ALL_TIERS.flatMap((tier): PlanCard[] => {
                  const rank = TIER_ORDER[tier];
                  if (rank > currentRank) return [{ tier, kind: 'upgrade' }];
                  if (rank < currentRank && canDowngrade) return [{ tier, kind: 'downgrade' }];
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
                      // Round in whole dollars (via the shared helper)
                      // before converting back to cents so the displayed
                      // per-month price and the savings line stay on the
                      // same rounding basis, matching the /pricing card
                      // and the in-page MinutesPricingCalculator.
                      const baseMonthlyDollars = centsToWholeDollars(baseMonthlyCents);
                      const effectiveMonthlyDollars = cardIsAnnual
                        ? getDiscountedAnnualMonthlyDollars(baseMonthlyDollars)
                        : baseMonthlyDollars;
                      const effectiveMonthlyCents = dollarsToCents(effectiveMonthlyDollars);
                      const annualSavingsCents = cardIsAnnual
                        ? dollarsToCents((baseMonthlyDollars - effectiveMonthlyDollars) * 12)
                        : 0;
                      const summary =
                        tier === 'starter'
                          ? '500 calls · 250 AI min · 2 agents'
                          : tier === 'pro'
                            ? '5,000 calls · 2,500 AI min · 10 agents'
                            : 'Unlimited calls · Unlimited AI min · Unlimited agents';
                      const label = tier === 'starter' ? 'Starter' : tier === 'pro' ? 'Pro' : 'Enterprise';
                      const isLoading = upgradeLoading === tier;
                      const cta =
                        isLoading
                          ? 'Redirecting...'
                          : kind === 'switch_annual'
                            ? 'Switch to annual'
                            : kind === 'downgrade'
                              ? 'Downgrade'
                              : 'Upgrade';
                      const downgradePreview = kind === 'downgrade'
                        ? downgradePreviews.get(`${tier}|${cardInterval}`) ?? null
                        : null;
                      // Only the upgrade card matching the resolved
                      // upgrade-preview target carries discount attribution
                      // (downgrades / annual-switches / non-target tiers
                      // skip it).
                      const upgradePreview = upgradePreviewData?.upgrade ?? null;
                      const previewMatches =
                        upgradePreview != null
                        && upgradePreview.plan === tier
                        && upgradePreview.discount != null
                        && (
                          (upgradePreview.discount.couponId?.trim().length ?? 0) > 0
                          || (upgradePreview.discount.promotionCode?.trim().length ?? 0) > 0
                        );
                      const upgradeDiscountPayload =
                        kind === 'upgrade' && previewMatches && upgradePreview?.discount
                          ? {
                              couponId: upgradePreview.discount.couponId ?? null,
                              promotionCode: upgradePreview.discount.promotionCode ?? null,
                            }
                          : undefined;
                      const onClick = () => {
                        if (kind === 'downgrade') {
                          handleDowngrade(tier, cardInterval, downgradePreview);
                          return;
                        }
                        if (kind === 'switch_annual') {
                          // The upgrade-card surface never renders the
                          // "Live rate" badge, so it's always false here.
                          handleAnnualNudgeClick({
                            source: 'upgrade-card',
                            currentTier: plan as PlanTier,
                            annualSavingsCents,
                            liveRateBadgeVisible: false,
                          });
                        }
                        if (upgradeDiscountPayload) {
                          handleDiscountEvent({
                            type: 'discount_click',
                            tier: tier as PlanTier,
                            currentTier: plan as PlanTier,
                            couponId: upgradeDiscountPayload.couponId,
                            promotionCode: upgradeDiscountPayload.promotionCode,
                          });
                        }
                        handleUpgrade(
                          tier,
                          cardInterval,
                          undefined,
                          upgradeDiscountPayload,
                        );
                      };
                      const CtaIcon = kind === 'downgrade' ? ArrowDownRight : ArrowUpRight;
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
                              {kind === 'downgrade' && (
                                <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted bg-surface border border-border px-1.5 py-0.5 rounded-full">
                                  Downgrade
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
                            {cardIsAnnual && annualSavingsCents > 0 && (
                              <p
                                data-testid={`billing-upgrade-savings-${tier}`}
                                className="text-[11px] text-success font-medium mt-1"
                              >
                                Saves {formatCentsHelper(annualSavingsCents, { currency, minimumFractionDigits: 0, maximumFractionDigits: 0 })}/yr vs monthly billing
                              </p>
                            )}
                            {kind === 'downgrade' && (
                              <p
                                data-testid={`billing-downgrade-note-${tier}`}
                                className="text-[11px] text-text-muted mt-1"
                              >
                                Takes effect at next renewal{sub?.current_period_end ? ` on ${formatDate(sub.current_period_end)}` : ''}
                              </p>
                            )}
                            {kind === 'downgrade' && downgradePreview && downgradePreview.discount && (
                              <p
                                data-testid={`billing-downgrade-next-invoice-${tier}`}
                                className="text-[11px] text-success font-medium mt-1"
                              >
                                Next invoice: {formatCentsHelper(downgradePreview.nextInvoiceTotalCents, {
                                  currency: downgradePreview.currency || currency,
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 2,
                                })}
                                {downgradePreview.discount.name ? ` (${downgradePreview.discount.name})` : ''}
                              </p>
                            )}
                          </div>
                          <button
                            data-testid={`billing-upgrade-button-${tier}`}
                            onClick={onClick}
                            disabled={isLoading}
                            className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg disabled:opacity-50 shrink-0 ${
                              kind === 'downgrade'
                                ? 'bg-surface border border-border text-text-primary hover:bg-surface-hover'
                                : 'bg-primary hover:bg-primary-hover text-white'
                            }`}
                          >
                            {cta}
                            <CtaIcon className="h-3 w-3" />
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
