import type { BillingPeriod } from '../components/MinutesPricingCalculator';

/**
 * Cross-surface sync for the marketing-side "monthly vs annual"
 * billing-period choice. The public Pricing page owns the canonical
 * toggle, but other anonymous-visitor surfaces (notably the chat
 * widget's `recommend_plan` card) need to honor the same selection so
 * the price a visitor sees never appears to flip between surfaces.
 *
 * The choice is persisted in `localStorage` (so it survives a refresh
 * and is the same across tabs once they reload) and broadcast via a
 * `CustomEvent` on `window` so other components mounted in the same
 * tab can react instantly without polling.
 */
const STORAGE_KEY = 'qvo:marketing-billing-period';
const EVENT_NAME = 'qvo:marketing-billing-period-change';

function isBillingPeriod(value: unknown): value is BillingPeriod {
  return value === 'monthly' || value === 'annual';
}

export function readBillingPeriodPreference(): BillingPeriod | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isBillingPeriod(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeBillingPeriodPreference(period: BillingPeriod): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, period);
  } catch {
    // ignore (private mode / quota)
  }
  try {
    window.dispatchEvent(new CustomEvent<BillingPeriod>(EVENT_NAME, { detail: period }));
  } catch {
    // ignore (no CustomEvent support)
  }
}

export function subscribeBillingPeriodPreference(
  listener: (period: BillingPeriod) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const handleCustom = (event: Event) => {
    const detail = (event as CustomEvent<BillingPeriod>).detail;
    if (isBillingPeriod(detail)) listener(detail);
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    if (isBillingPeriod(event.newValue)) listener(event.newValue);
  };
  window.addEventListener(EVENT_NAME, handleCustom);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(EVENT_NAME, handleCustom);
    window.removeEventListener('storage', handleStorage);
  };
}
