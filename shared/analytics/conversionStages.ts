/**
 * Canonical labels for the conversion-funnel analytics writers.
 *
 * Sibling to `client-app/src/lib/analyticsLabels.ts` (CTA / feature /
 * vertical / signup-step constants). This module covers the *funnel
 * stage* argument(s) that the conversion-event helpers consume on
 * both the client and the server:
 *
 *   client: trackConversionEvent(stage, …)
 *   server: recordConversionEvent(visitorId, stage, …)   (website funnel)
 *   server: recordConversionStage(tenantId, callId, stage, …) (call funnel)
 *
 * Without a single source of truth the conversion funnel will
 * fragment the same way the CTA and feature funnels did before
 * Tasks #426 and #1082 — every page would invent its own
 * `'page_view'`, `'cta_click'`, `'signup_completed'` literal and the
 * funnel report would split the same logical event across half a
 * dozen labels. Drift is enforced statically by the
 * `local/no-literal-analytics-label` ESLint rule, which now pins the
 * stage argument of the three helpers above.
 *
 * Convention: snake_case identifiers — stable wire-format strings
 * persisted in `website_conversion_events.stage` and
 * `call_conversion_stages.stage`. Renaming a value here is a
 * funnel-report-breaking change; add new ones instead and migrate
 * call sites over.
 *
 * This module is import-safe from `client-app/`, `server/`,
 * `platform/`, and `shared/` — it has no runtime dependencies and is
 * safe to bundle into the browser.
 */

// Website conversion funnel — fired from the public marketing site
// and the Stripe webhook on paid checkout. Backed by the
// `website_conversion_events.stage` column. Order roughly mirrors
// the visitor journey but is not enforced at the type level — the
// funnel report (`WEBSITE_FUNNEL_STAGES`) is the canonical ordering.
export const CONVERSION_STAGE = {
  // Marketing page load — the top of the funnel. Fired by every
  // public landing page (`Landing`, `Pricing`, `CaseStudies`,
  // `BookDemo`, `VerticalLanding/*`).
  PAGE_VIEW: 'page_view',
  // Any CTA click that's worth attributing to the funnel — e.g.
  // "Start free trial" / "Try live demo" on a marketing page.
  CTA_CLICK: 'cta_click',
  // User entered the in-page interactive demo (Demo.tsx /
  // VerticalLanding hero "Try live demo" button).
  DEMO_STARTED: 'demo_started',
  // User finished a demo conversation. Distinct from
  // `DEMO_REQUESTED` (sales-led booking).
  DEMO_COMPLETED: 'demo_completed',
  // User submitted the BookDemo form requesting a live sales demo.
  DEMO_REQUESTED: 'demo_requested',
  // User landed on the signup form. Fired by Signup.tsx on mount.
  SIGNUP_STARTED: 'signup_started',
  // Signup form submitted successfully and account created.
  SIGNUP_COMPLETED: 'signup_completed',
  // First trial provisioned for the new account.
  TRIAL_STARTED: 'trial_started',
  // Stripe checkout completed — paid conversion. Recorded server-
  // side from the webhook so it can't be spoofed by the client.
  PAID: 'paid',
  // ROI calculator: user requested an emailed report after running
  // the calculator. Tracked separately because it's a strong intent
  // signal mid-funnel.
  ROI_REPORT_REQUESTED: 'roi_report_requested',
} as const;

export type ConversionStage = typeof CONVERSION_STAGE[keyof typeof CONVERSION_STAGE];

// Full set of valid stages — used by the server route to validate
// incoming `POST /api/conversion/event` bodies and by tests.
export const ALL_CONVERSION_STAGES: readonly ConversionStage[] = Object.freeze(
  Object.values(CONVERSION_STAGE),
);

// Per-call conversion funnel — fired from the voice gateway and the
// `record_call_outcome` agent tool. Backed by the
// `call_conversion_stages.stage` column. These stages are *ordered*:
// `getConversionFunnel` walks them as a strict left-to-right funnel,
// so order in this object also defines the report order.
export const CALL_FUNNEL_STAGE = {
  // Inbound call accepted by the voice gateway. Fired once per
  // `call_sessions` row from `createCallSession`.
  CALL_RECEIVED: 'call_received',
  // Caller passed agent qualification (intent / identity / etc).
  QUALIFIED: 'qualified',
  // Agent offered an appointment slot.
  APPOINTMENT_OFFERED: 'appointment_offered',
  // Caller booked the offered slot.
  APPOINTMENT_BOOKED: 'appointment_booked',
  // Booking confirmed end-to-end (e.g. SMS confirmation received).
  CONFIRMED: 'confirmed',
} as const;

export type CallFunnelStage = typeof CALL_FUNNEL_STAGE[keyof typeof CALL_FUNNEL_STAGE];

// Ordered list — `Object.values` on a const-typed object preserves
// insertion order, which matches the funnel ordering above. Kept
// frozen so downstream code can't mutate it in place.
export const CALL_FUNNEL_STAGES: readonly CallFunnelStage[] = Object.freeze(
  Object.values(CALL_FUNNEL_STAGE),
);
