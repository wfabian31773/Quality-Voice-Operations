/**
 * Run with: node tools/eslint-rules/no-literal-analytics-label.test.cjs
 *
 * Sibling to `no-literal-cta-name.test.cjs`. Uses ESLint's RuleTester
 * to ensure the rule fires on raw string-literal labels passed to the
 * marketing analytics helpers and the conversion-funnel writers, and
 * stays silent on imported constants and genuinely dynamic
 * expressions.
 */
'use strict';

const { RuleTester } = require('eslint');
const tsParser = require('@typescript-eslint/parser');
const rule = require('./no-literal-analytics-label');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      ecmaFeatures: { jsx: true },
    },
  },
});

ruleTester.run('no-literal-analytics-label', rule, {
  valid: [
    // Canonical pattern: imported constant for each marketing helper.
    'trackFeatureView(FEATURE.CAPABILITY_VOICE_RUNTIME);',
    "trackVerticalEngagement(slug, VERTICAL_ACTION.PAGE_VIEW);",
    "trackSignupConversion(plan, SIGNUP_STEP.CHECKOUT);",
    // Canonical pattern: imported constant for each conversion-funnel writer.
    'trackConversionEvent(CONVERSION_STAGE.PAGE_VIEW, "/pricing");',
    'recordConversionEvent(visitorId, CONVERSION_STAGE.PAID, page);',
    'recordConversionStage(tenantId, callSessionId, CALL_FUNNEL_STAGE.CALL_RECEIVED);',
    // Dynamic per-card label resolved at runtime.
    'trackFeatureView(card.feature);',
    'trackFeatureView(features[i]);',
    'trackConversionEvent(stages[i], "/foo");',
    'recordConversionEvent(visitorId, currentStage, page);',
    'recordConversionStage(tenantId, callId, stage);',
    // Template literal WITH a substitution is dynamic — allowed.
    'trackFeatureView(`gin:${prop.title}`);',
    'trackConversionEvent(`page_${suffix}`, "/foo");',
    // The non-constrained argument positions are intentionally still
    // allowed to be literals: `vertical` for engagement, `plan` for
    // signup conversion, `landingPage` / `tenantId` / `callId` /
    // `visitorId` for the funnel writers.
    "trackVerticalEngagement('finance', VERTICAL_ACTION.CARD_HOVER);",
    "trackSignupConversion('starter', SIGNUP_STEP.ONBOARDING);",
    "trackConversionEvent(CONVERSION_STAGE.PAGE_VIEW, '/pricing');",
    "recordConversionEvent('visitor_123', CONVERSION_STAGE.PAID, '/signup');",
    "recordConversionStage('tenant_42', 'call_99', CALL_FUNNEL_STAGE.QUALIFIED);",
    // Conditional / computed expressions are always fine.
    'trackVerticalEngagement(slug, isHover ? VERTICAL_ACTION.CARD_HOVER : VERTICAL_ACTION.VIEW);',
    'trackSignupConversion(plan, hasCheckout ? SIGNUP_STEP.CHECKOUT : SIGNUP_STEP.ONBOARDING);',
    'trackConversionEvent(isPaid ? CONVERSION_STAGE.PAID : CONVERSION_STAGE.SIGNUP_COMPLETED, page);',
    // Optional chaining or member access through a namespace.
    'analytics.trackFeatureView(FEATURE.CAPABILITY_KNOWLEDGE);',
    'svc.recordConversionEvent(vid, CONVERSION_STAGE.PAID, page);',
    // Unrelated functions with the same first-arg shape — we only
    // target the listed helpers, never their siblings.
    "track('signup_submit', 'signup', plan);",
    "trackCTAClick('contact_sales', '/foo');",
    "trackPageView('/features');",
    // Regression: helpers like `obj.toString()` must not be mistaken
    // for a known analytics helper just because `toString` lives on
    // `Object.prototype`. The rule must use own-property checks.
    "obj.toString('not_a_label');",
    "obj.hasOwnProperty('not_a_label');",
    "toString('not_a_label');",
    // The function definitions themselves bind Identifier params; the
    // rule must not trip on the declaration sites.
    'export function trackFeatureView(feature) { return feature; }',
    'export function trackVerticalEngagement(vertical, action) { return action; }',
    'export function trackSignupConversion(plan, step) { return step; }',
    'export function trackConversionEvent(stage, page) { return stage; }',
    'export async function recordConversionEvent(visitorId, stage, page) { return stage; }',
    'export async function recordConversionStage(tenantId, callId, stage) { return stage; }',
  ],
  invalid: [
    // trackFeatureView — first arg is the feature label.
    {
      code: "trackFeatureView('hero-card');",
      errors: [{ messageId: 'noLiteralLabel' }],
    },
    {
      code: 'trackFeatureView(`capability_voice_runtime`);',
      errors: [{ messageId: 'noLiteralLabel' }],
    },
    {
      code: 'const x = <div onMouseEnter={() => trackFeatureView("gin-card")} />;',
      errors: [{ messageId: 'noLiteralLabel' }],
    },
    // trackVerticalEngagement — only the second arg (action).
    {
      code: "trackVerticalEngagement(slug, 'page_view');",
      errors: [{ messageId: 'noLiteralLabel' }],
    },
    {
      code: "trackVerticalEngagement('finance', 'card_hover');",
      errors: [{ messageId: 'noLiteralLabel' }],
    },
    // trackSignupConversion — only the second arg (step).
    {
      code: "trackSignupConversion(plan, 'checkout');",
      errors: [{ messageId: 'noLiteralLabel' }],
    },
    {
      code: "trackSignupConversion('starter', 'onboarding');",
      errors: [{ messageId: 'noLiteralLabel' }],
    },
    // trackConversionEvent — first arg is the stage.
    {
      code: "trackConversionEvent('page_view', '/pricing');",
      errors: [{ messageId: 'noLiteralLabel' }],
    },
    {
      code: "trackConversionEvent('signup_completed', '/signup', { plan });",
      errors: [{ messageId: 'noLiteralLabel' }],
    },
    {
      code: 'trackConversionEvent(`cta_click`, page);',
      errors: [{ messageId: 'noLiteralLabel' }],
    },
    // recordConversionEvent — second arg (visitorId is dynamic).
    {
      code: "recordConversionEvent(visitorId, 'paid', '/signup');",
      errors: [{ messageId: 'noLiteralLabel' }],
    },
    {
      code: "await recordConversionEvent('visitor_123', 'page_view', '/foo');",
      errors: [{ messageId: 'noLiteralLabel' }],
    },
    // recordConversionStage — third arg (tenantId / callId are dynamic).
    {
      code: "recordConversionStage(tenantId, callId, 'call_received');",
      errors: [{ messageId: 'noLiteralLabel' }],
    },
    {
      code: "recordConversionStage('t', 'c', 'qualified');",
      errors: [{ messageId: 'noLiteralLabel' }],
    },
    // Member-style call (foo.trackFeatureView) must also be guarded
    // so the rule isn't trivially bypassed by re-exporting through a
    // namespace.
    {
      code: "api.trackFeatureView('foo');",
      errors: [{ messageId: 'noLiteralLabel' }],
    },
    {
      code: "svc.recordConversionEvent(vid, 'paid', page);",
      errors: [{ messageId: 'noLiteralLabel' }],
    },
  ],
});

console.log('no-literal-analytics-label: all tests passed');
