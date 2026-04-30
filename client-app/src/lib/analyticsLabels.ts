/**
 * Canonical labels for the marketing analytics helpers besides
 * `trackCTAClick` — see `client-app/src/lib/analyticsCtas.ts` for that.
 *
 * Pages should import these constants instead of passing raw string
 * literals so funnel reports compare the same logical event across
 * pages and copy variants. Drift is enforced by the
 * `local/no-literal-analytics-label` ESLint rule, which pins the
 * argument positions that must be canonical:
 *
 *   trackFeatureView(feature)         → arg 0 is canonical
 *   trackVerticalEngagement(v, action) → arg 1 (action) is canonical
 *   trackSignupConversion(plan, step) → arg 1 (step) is canonical
 *   trackConversionEvent(stage, …)    → arg 0 (stage) is canonical
 *
 * Convention: snake_case identifiers — distinct from user-visible UI
 * copy, which is free to vary by section / locale.
 *
 * The conversion-funnel stage constants live in
 * `shared/analytics/conversionStages.ts` so they can be imported
 * from both the client and the server-side writers
 * (`recordConversionEvent`, `recordConversionStage`); they are
 * re-exported below so client-app pages can pick them up alongside
 * the marketing-only constants without a second import.
 */

export {
  CONVERSION_STAGE,
  ALL_CONVERSION_STAGES,
  CALL_FUNNEL_STAGE,
  CALL_FUNNEL_STAGES,
} from '../../../shared/analytics/conversionStages';
export type {
  ConversionStage,
  CallFunnelStage,
} from '../../../shared/analytics/conversionStages';

// trackFeatureView(feature) — feature is the entire label.
export const FEATURE = {
  // Features.tsx — six positional platform-capability cards. Names
  // intentionally do NOT mirror the i18n title strings (those are
  // free to vary by locale and copy revision).
  CAPABILITY_VOICE_RUNTIME: 'capability_voice_runtime',
  CAPABILITY_AGENT_BUILDER: 'capability_agent_builder',
  CAPABILITY_TOOL_ENGINE: 'capability_tool_engine',
  CAPABILITY_DASHBOARD: 'capability_dashboard',
  CAPABILITY_KNOWLEDGE: 'capability_knowledge',
  CAPABILITY_INTEGRATIONS: 'capability_integrations',

  // FederatedIngest.tsx — three positional use-case cards driven by
  // i18n (`federated_ingest_page.use_cases.items`). The `federated-ingest:`
  // prefix is preserved so historical funnel data lines up.
  FEDERATED_INGEST_RUN_OWN_STACK: 'federated-ingest:run_own_stack',
  FEDERATED_INGEST_BRING_PARTNER_AGENTS: 'federated-ingest:bring_partner_agents',
  FEDERATED_INGEST_BRIDGE_LEGACY_IVR: 'federated-ingest:bridge_legacy_ivr',

  // GlobalIntelligenceNetwork.tsx — three positional value-prop cards
  // driven by i18n (`gin_page.value_props.items`). The `gin:` prefix is
  // preserved for the same reason.
  GIN_SEE_WHERE_YOU_STAND: 'gin:see_where_you_stand',
  GIN_LEARN_FROM_TOP_QUARTILE: 'gin:learn_from_top_quartile',
  GIN_POWER_EVOLUTION_ENGINE: 'gin:power_evolution_engine',
} as const;

export type FeatureName = typeof FEATURE[keyof typeof FEATURE];

// trackVerticalEngagement(vertical, action) — only the `action` (2nd
// argument) is constrained. The `vertical` argument is intentionally
// dynamic (it carries the slug or scenario title) so funnel reports
// can split by industry.
export const VERTICAL_ACTION = {
  // VerticalLanding.tsx — one fired per /industries/* page load.
  PAGE_VIEW: 'page_view',
  // VerticalAgents.tsx — agent-card hover.
  CARD_HOVER: 'card_hover',
  // VerticalAgents.tsx — "see industry" link in the agent card.
  SEE_INDUSTRY: 'see_industry',
  // VerticalAgents.tsx — "try demo" link in the agent card.
  TRY_DEMO: 'try_demo',
  // AgentsShowcase.tsx — "deploy" CTA inside the agent card.
  DEPLOY_CLICK: 'deploy_click',
  // UseCases.tsx — scenario-card hover. Kept as the bare `view`
  // string to preserve historical analytics continuity.
  VIEW: 'view',
} as const;

export type VerticalAction = typeof VERTICAL_ACTION[keyof typeof VERTICAL_ACTION];

// trackSignupConversion(plan, step) — only the `step` (2nd argument)
// is constrained. The `plan` argument is dynamic (price tier slug).
export const SIGNUP_STEP = {
  // Signup.tsx — the API returned a Stripe checkout URL; the user is
  // about to be redirected to billing.
  CHECKOUT: 'checkout',
  // Signup.tsx — no checkout URL; the user is sent into the
  // in-product onboarding flow.
  ONBOARDING: 'onboarding',
} as const;

export type SignupStep = typeof SIGNUP_STEP[keyof typeof SIGNUP_STEP];
