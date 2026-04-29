/**
 * Custom ESLint rule: no-literal-analytics-label
 *
 * Sibling to `no-literal-cta-name`. Forces the canonical-label
 * argument(s) of the marketing analytics helpers in
 * `client-app/src/lib/analytics.ts` to come from imported constants
 * (typically from `client-app/src/lib/analyticsLabels.ts`) instead of
 * raw string / no-substitution-template literals.
 *
 * Why: Task #950 fixed `trackCTAClick`. The same drift risk applies
 * to `trackFeatureView`, `trackVerticalEngagement`, and
 * `trackSignupConversion` — without a guard, future pages quietly
 * reintroduce one-off literals (`trackFeatureView('hero-card')`,
 * `trackVerticalEngagement(slug, 'view')`) and fragment funnel
 * reports the same way CTAs used to.
 *
 * Helpers and constrained argument positions:
 *
 *   trackFeatureView(feature)              → arg 0 (feature)
 *   trackVerticalEngagement(vertical, action) → arg 1 (action)
 *   trackSignupConversion(plan, step)      → arg 1 (step)
 *
 * The argument positions intentionally NOT constrained — `vertical`
 * (industry slug / scenario title) and `plan` (pricing-tier slug) —
 * are dynamic by design and stay free to be variables, member
 * accesses, or template literals with substitutions.
 *
 * What it flags:
 *     trackFeatureView('hero-card')
 *     trackFeatureView(`gin:${prop.title}`)        // 0 substitutions inside the prefix? still dynamic, see below
 *     trackVerticalEngagement(slug, 'page_view')
 *     trackSignupConversion(plan, 'checkout')
 *     api.trackFeatureView('foo')                  // member calls also covered
 *
 * What it permits:
 *     trackFeatureView(FEATURE.CAPABILITY_VOICE_RUNTIME)
 *     trackFeatureView(card.feature)
 *     trackFeatureView(`gin:${prop.title}`)        // template literal WITH a substitution is dynamic
 *     trackVerticalEngagement(slug, VERTICAL_ACTION.PAGE_VIEW)
 *     trackVerticalEngagement(slug, isHover ? VERTICAL_ACTION.CARD_HOVER : VERTICAL_ACTION.VIEW)
 *     trackSignupConversion(plan, SIGNUP_STEP.CHECKOUT)
 */
'use strict';

// Map of helper-name → array of constrained argument indices. Keep
// this in sync with `client-app/src/lib/analyticsLabels.ts` and the
// helper signatures in `client-app/src/lib/analytics.ts`.
const HELPERS = {
  trackFeatureView: { positions: [0], constant: 'FEATURE' },
  trackVerticalEngagement: { positions: [1], constant: 'VERTICAL_ACTION' },
  trackSignupConversion: { positions: [1], constant: 'SIGNUP_STEP' },
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
  };
  return (labels[helperName] && labels[helperName][index]) || `arg ${index}`;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow raw string-literal labels in `trackFeatureView`, `trackVerticalEngagement`, and `trackSignupConversion`; require an imported constant from `client-app/src/lib/analyticsLabels.ts` (or a dynamic expression) so funnel reports stay aligned.',
      recommended: true,
    },
    schema: [],
    messages: {
      noLiteralLabel:
        'Pass a constant from `client-app/src/lib/analyticsLabels.ts` (e.g. `{{constant}}.X`) instead of the string literal {{value}} as the `{{position}}` argument to `{{helper}}`. If this label is genuinely dynamic per call site, compute it from a variable or property access.',
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
