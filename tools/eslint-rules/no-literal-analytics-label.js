/**
 * Custom ESLint rule: no-literal-analytics-label
 *
 * Sibling to `no-literal-cta-name`. Forces the canonical-label
 * argument(s) of the analytics helpers in
 * `client-app/src/lib/analytics.ts`,
 * `platform/analytics/WebsiteConversionService.ts`, and
 * `platform/analytics/ConversionFunnelService.ts` to come from
 * imported constants (typically from
 * `client-app/src/lib/analyticsLabels.ts` for marketing labels and
 * `shared/analytics/conversionStages.ts` for funnel stages) instead
 * of raw string / no-substitution-template literals.
 *
 * Why: Task #950 fixed `trackCTAClick`. Task #1082 extended the same
 * guard to the marketing helpers (`trackFeatureView`,
 * `trackVerticalEngagement`, `trackSignupConversion`). Task #1178
 * extends it again to the conversion-funnel writers
 * (`trackConversionEvent`, `recordConversionEvent`,
 * `recordConversionStage`) — without a canonical list and a guard,
 * the conversion funnel will fragment the same way the CTA and
 * feature funnels did.
 *
 * Helpers and constrained argument positions:
 *
 *   trackFeatureView(feature)              → arg 0 (feature)
 *   trackVerticalEngagement(vertical, action) → arg 1 (action)
 *   trackSignupConversion(plan, step)      → arg 1 (step)
 *   trackConversionEvent(stage, …)         → arg 0 (stage)
 *   recordConversionEvent(visitorId, stage, …) → arg 1 (stage)
 *   recordConversionStage(tenantId, callId, stage, …) → arg 2 (stage)
 *
 * The argument positions intentionally NOT constrained — `vertical`
 * (industry slug / scenario title), `plan` (pricing-tier slug),
 * `landingPage`, `tenantId`, `visitorId`, `callId` — are dynamic by
 * design and stay free to be variables, member accesses, or
 * template literals with substitutions.
 *
 * What it flags:
 *     trackFeatureView('hero-card')
 *     trackVerticalEngagement(slug, 'page_view')
 *     trackSignupConversion(plan, 'checkout')
 *     trackConversionEvent('page_view', '/foo')
 *     recordConversionEvent(vid, 'paid', '/signup')
 *     recordConversionStage(tid, cid, 'call_received')
 *     api.trackFeatureView('foo')                  // member calls also covered
 *
 * What it permits:
 *     trackFeatureView(FEATURE.CAPABILITY_VOICE_RUNTIME)
 *     trackFeatureView(card.feature)
 *     trackFeatureView(`gin:${prop.title}`)        // template literal WITH a substitution is dynamic
 *     trackVerticalEngagement(slug, VERTICAL_ACTION.PAGE_VIEW)
 *     trackSignupConversion(plan, SIGNUP_STEP.CHECKOUT)
 *     trackConversionEvent(CONVERSION_STAGE.PAGE_VIEW, '/foo')
 *     recordConversionEvent(vid, CONVERSION_STAGE.PAID, page)
 *     recordConversionStage(tid, cid, CALL_FUNNEL_STAGE.CALL_RECEIVED)
 */
'use strict';

// Map of helper-name → constrained argument indices and the
// canonical-constants name to suggest. Keep this in sync with
// `client-app/src/lib/analyticsLabels.ts`,
// `shared/analytics/conversionStages.ts`, and the helper signatures
// in `client-app/src/lib/analytics.ts` and the platform analytics
// services.
const HELPERS = {
  trackFeatureView: { positions: [0], constant: 'FEATURE' },
  trackVerticalEngagement: { positions: [1], constant: 'VERTICAL_ACTION' },
  trackSignupConversion: { positions: [1], constant: 'SIGNUP_STEP' },
  trackConversionEvent: { positions: [0], constant: 'CONVERSION_STAGE' },
  recordConversionEvent: { positions: [1], constant: 'CONVERSION_STAGE' },
  recordConversionStage: { positions: [2], constant: 'CALL_FUNNEL_STAGE' },
};

function isLiteralStringName(node) {
  if (!node) return false;
  if (node.type === 'Literal' && typeof node.value === 'string') return true;
  // TS / Babel sometimes uses StringLiteral instead of Literal.
  if (node.type === 'StringLiteral' && typeof node.value === 'string') return true;
  // Template literal with no `${…}` expressions is identical to a
  // string literal, so `\`foo\`` should be treated the same as
  // `'foo'`. Templates WITH substitutions are dynamic and allowed.
  if (
    node.type === 'TemplateLiteral' &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0 &&
    Array.isArray(node.quasis) &&
    node.quasis.length === 1
  ) {
    return true;
  }
  return false;
}

function isKnownHelper(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(HELPERS, name);
}

function helperFromCallee(callee) {
  if (!callee) return null;
  // Direct call: foo(...)
  if (callee.type === 'Identifier' && isKnownHelper(callee.name)) {
    return callee.name;
  }
  // Member call: obj.foo(...) or obj?.foo(...)
  if (
    (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') &&
    callee.property &&
    callee.property.type === 'Identifier' &&
    isKnownHelper(callee.property.name)
  ) {
    return callee.property.name;
  }
  return null;
}

function positionLabel(helperName, index) {
  const labels = {
    trackFeatureView: ['feature'],
    trackVerticalEngagement: ['vertical', 'action'],
    trackSignupConversion: ['plan', 'step'],
    trackConversionEvent: ['stage'],
    recordConversionEvent: ['visitorId', 'stage'],
    recordConversionStage: ['tenantId', 'callSessionId', 'stage'],
  };
  return (labels[helperName] && labels[helperName][index]) || `arg ${index}`;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow raw string-literal labels in the marketing analytics helpers (`trackFeatureView`, `trackVerticalEngagement`, `trackSignupConversion`) and the conversion-funnel writers (`trackConversionEvent`, `recordConversionEvent`, `recordConversionStage`); require an imported constant from `client-app/src/lib/analyticsLabels.ts` or `shared/analytics/conversionStages.ts` (or a dynamic expression) so funnel reports stay aligned.',
      recommended: true,
    },
    schema: [],
    messages: {
      noLiteralLabel:
        'Pass a constant from `client-app/src/lib/analyticsLabels.ts` or `shared/analytics/conversionStages.ts` (e.g. `{{constant}}.X`) instead of the string literal {{value}} as the `{{position}}` argument to `{{helper}}`. If this label is genuinely dynamic per call site, compute it from a variable or property access.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const helperName = helperFromCallee(node.callee);
        if (!helperName) return;
        const config = HELPERS[helperName];
        const args = node.arguments || [];
        for (const index of config.positions) {
          const arg = args[index];
          if (!arg) continue;
          // Spread arguments (e.g. `helper(...args)`) are dynamic by
          // definition — we can't statically prove they're literals.
          if (arg.type === 'SpreadElement') continue;
          if (!isLiteralStringName(arg)) continue;
          const value =
            arg.type === 'TemplateLiteral'
              ? `\`${arg.quasis[0].value.cooked}\``
              : JSON.stringify(arg.value);
          context.report({
            node: arg,
            messageId: 'noLiteralLabel',
            data: {
              value,
              position: positionLabel(helperName, index),
              helper: helperName,
              constant: config.constant,
            },
          });
        }
      },
    };
  },
};
