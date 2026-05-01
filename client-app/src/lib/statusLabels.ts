/**
 * Localized labels for backend-driven enum strings (tenant statuses, billing
 * plans, template-version states, call lifecycle states, tool-execution
 * outcomes, etc.).
 *
 * These helpers exist because the API speaks raw English enum strings
 * (`'active'`, `'trial'`, `'CALL_FAILED'`, `'success'`, …) but those values
 * are also rendered straight into status badges and pills throughout the
 * tenant- and platform-admin UIs. Without a translation layer, German /
 * Spanish / French / pt-BR users still see English enum tokens — and
 * sometimes ALL_CAPS_WITH_UNDERSCORES — in the middle of an otherwise
 * localized page.
 *
 * Each helper expects an i18next `t` function already bound to the right
 * namespace (so callers don't have to remember which string lives where):
 *
 *  - `tenantStatusLabel`, `planLabel`, `versionStatusLabel` → expect the
 *    `admin` namespace `t` (lookup under `platform_admin.badges.*`).
 *  - `callLifecycleLabel`, `callDirectionLabel`, `toolExecStatusLabel` →
 *    expect the `tenant` namespace `t` (lookup under `calls.lifecycle.*`,
 *    `calls.direction.*`, `calls.tool_status.*`).
 *
 * If a key is missing from the locale file (e.g. a brand-new server-side
 * status the UI hasn't been taught about yet), every helper falls through
 * to a humanized version of the raw enum (`'past_due'` → `'Past due'`,
 * `'CALL_RECEIVED'` → `'Call received'`) so the badge keeps rendering
 * something readable instead of breaking the layout or surfacing the raw
 * SCREAMING_SNAKE token to end users.
 */
import type { TFunction } from 'i18next';

/**
 * Convert a raw enum token (`'past_due'`, `'CALL_RECEIVED'`, `'NO-ANSWER'`)
 * into a human-readable fallback label (`'Past due'`, `'Call received'`,
 * `'No answer'`). Used as the `defaultValue` for every i18n lookup in this
 * module so unknown server-side tokens still render reasonably.
 */
function humanize(value: string): string {
  if (!value) return value;
  const cleaned = value.replace(/[_-]+/g, ' ').toLowerCase().trim();
  if (!cleaned) return value;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** Tenant lifecycle status (`active` / `pending` / `suspended` / `trial`). */
export function tenantStatusLabel(t: TFunction, status: string): string {
  if (!status) return '';
  return t(`platform_admin.badges.${status}`, { defaultValue: humanize(status) });
}

/** Tenant billing plan tier (`starter` / `pro` / `enterprise` / `free`). */
export function planLabel(t: TFunction, plan: string): string {
  if (!plan) return '';
  return t(`platform_admin.badges.${plan}`, { defaultValue: humanize(plan) });
}

/** Template-version state (`draft` / `published` / `deprecated`). */
export function versionStatusLabel(t: TFunction, status: string): string {
  if (!status) return '';
  return t(`platform_admin.badges.${status}`, { defaultValue: humanize(status) });
}

/**
 * Call session lifecycle state. Backend values are SCREAMING_SNAKE_CASE
 * (`CALL_RECEIVED`, `AGENT_CONNECTED`, …) plus a few legacy lowercase ones
 * (`active`). Lookups map both forms into a localized label.
 */
export function callLifecycleLabel(t: TFunction, state: string): string {
  if (!state) return '';
  return t(`calls.lifecycle.${state}`, { defaultValue: humanize(state) });
}

/** Call direction (`inbound` / `outbound`). */
export function callDirectionLabel(t: TFunction, direction: string): string {
  if (!direction) return '';
  return t(`calls.direction.${direction}`, { defaultValue: humanize(direction) });
}

/** Tool-execution outcome (`success` / `failed` / `timeout` / `pending`). */
export function toolExecStatusLabel(t: TFunction, status: string): string {
  if (!status) return '';
  return t(`calls.tool_status.${status}`, { defaultValue: humanize(status) });
}
