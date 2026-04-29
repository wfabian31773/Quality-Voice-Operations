/**
 * Canonical CTA names emitted via `trackCTAClick()` from the public
 * marketing site. Pages should import these constants instead of passing
 * raw string literals so funnel reports compare the same logical CTA
 * across pages and copy variants.
 *
 * Convention: snake_case identifiers — distinct from user-visible button
 * copy, which is free to vary by section.
 */
export const CTA = {
  // Demo entry points (any "see/try the live demo" navigation to /demo).
  TRY_LIVE_DEMO: 'try_live_demo',
  // Free-trial signup CTAs that navigate to /signup (or /signup?plan=…).
  START_FREE_TRIAL: 'start_free_trial',
  // Book-a-demo navigational CTA — clicking jumps to /book-demo.
  BOOK_DEMO: 'book_demo',
  // /book-demo form's submit action (separate from BOOK_DEMO so we can
  // split intent from completion in funnel reports).
  BOOK_DEMO_SUBMIT: 'book_demo_submit',
  // Sales / talk-to-us CTAs (Contact Sales, Talk to Us, etc.).
  CONTACT_SALES: 'contact_sales',
  VIEW_PRICING: 'view_pricing',
  SEE_HOW_IT_WORKS: 'see_how_it_works',
  SEE_FEATURES: 'see_features',
  SEE_USE_CASES: 'see_use_cases',
  EXPLORE_AGENTS: 'explore_agents',
  EXPLORE_PLATFORM: 'explore_platform',
  // Talk to engineering / talk to a platform engineer.
  TALK_TO_ENGINEERING: 'talk_to_engineering',
  READ_API_DOCS: 'read_api_docs',
  READ_PRIVACY_MODEL: 'read_privacy_model',
  // GIN-page "see GIN in a demo" CTA.
  SEE_GIN_DEMO: 'see_gin_demo',
  // FederatedIngest "book a platform demo" — kept distinct from BOOK_DEMO
  // so platform-engineer demos can be attributed separately.
  BOOK_PLATFORM_DEMO: 'book_platform_demo',
  PARTNER_WITH_QVO: 'partner_with_qvo',
  TRY_VERTICAL_AGENT: 'try_vertical_agent',
  DEPLOY_AGENT: 'deploy_agent',
  // BookDemo sidebar's secondary trial CTA — distinct from
  // START_FREE_TRIAL so sidebar conversions stay separable.
  START_FREE_TRIAL_FROM_BOOK_DEMO: 'start_free_trial_from_book_demo',
} as const;

export type CTAName = typeof CTA[keyof typeof CTA];
