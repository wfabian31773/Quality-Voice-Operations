/**
 * Custom ESLint rule: no-literal-cta-name
 *
 * Forces every `trackCTAClick(name, …)` call to pass an imported
 * identifier (typically from `client-app/src/lib/analyticsCtas.ts`) or
 * a computed/dynamic expression — never a raw string literal or a
 * no-substitution template literal.
 *
 * Why: Task #426 introduced `analyticsCtas.ts` as the single source of
 * truth for CTA names emitted from public marketing pages. Without a
 * guard, future pages quietly drift back to one-off literals like
 * `trackCTAClick('signup_submit', …)`, fragmenting the funnel reports.
 *
 * What it flags:
 *     trackCTAClick('try_live_demo', '/foo', 'hero')   // Literal
 *     trackCTAClick(`book_demo`, '/foo')               // TemplateLiteral, no exprs
 *     api.trackCTAClick('contact_sales', '/foo')       // member call
 *
 * What it permits:
 *     trackCTAClick(CTA.TRY_LIVE_DEMO, '/foo', 'hero') // Identifier / MemberExpression
 *     trackCTAClick(card.title, '/product', 'go-deeper')
 *     trackCTAClick(ctaType, 'demo', agentType)
 *     trackCTAClick(`industry-${slug}`, '/foo')        // template with substitutions
 *     trackCTAClick(isA ? CTA.A : CTA.B, '/foo')
 *
 * Only the FIRST argument is constrained — `page` and `position` are
 * descriptive metadata that legitimately vary per call site and are
 * intentionally still allowed to be string literals.
 */
'use strict';

function isLiteralStringName(node) {
  if (!node) return false;
  // Plain string literal: 'foo' or "foo".
  if (node.type === 'Literal' && typeof node.value === 'string') return true;
  // TS/Babel sometimes uses StringLiteral instead of Literal.
  if (node.type === 'StringLiteral' && typeof node.value === 'string') return true;
  // Template literal with no `${…}` expressions is identical to a string
  // literal, so `\`foo\`` should be treated the same as `'foo'`.
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

function calleeIsTrackCTAClick(callee) {
  if (!callee) return false;
  // Direct call: trackCTAClick(...)
  if (callee.type === 'Identifier' && callee.name === 'trackCTAClick') return true;
  // Member call: foo.trackCTAClick(...) or foo?.trackCTAClick(...)
  if (
    (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') &&
    callee.property &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'trackCTAClick'
  ) {
    return true;
  }
  return false;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow raw string-literal CTA names in `trackCTAClick(name, …)`; require an imported identifier (e.g. from `client-app/src/lib/analyticsCtas.ts`) or a dynamic expression so funnel reports stay aligned.',
      recommended: true,
    },
    schema: [],
    messages: {
      noLiteralCta:
        'Pass a CTA constant (e.g. `CTA.TRY_LIVE_DEMO` from `client-app/src/lib/analyticsCtas.ts`) instead of the string literal {{value}} to `trackCTAClick`. If this is a genuinely dynamic per-card label, compute it from a variable or property access.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!calleeIsTrackCTAClick(node.callee)) return;
        const first = node.arguments && node.arguments[0];
        if (!first) return;
        // Spread arguments (e.g. `trackCTAClick(...args)`) are dynamic by
        // definition — we can't statically prove they're literals.
        if (first.type === 'SpreadElement') return;
        if (!isLiteralStringName(first)) return;
        const value =
          first.type === 'TemplateLiteral'
            ? `\`${first.quasis[0].value.cooked}\``
            : JSON.stringify(first.value);
        context.report({
          node: first,
          messageId: 'noLiteralCta',
          data: { value },
        });
      },
    };
  },
};
