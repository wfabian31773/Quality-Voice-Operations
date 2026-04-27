/**
 * Custom ESLint rule: no-cents-divided-by-100
 *
 * Flags inline `(...Cents) / 100` style cents-to-dollar conversions and
 * directs contributors to the centralized `formatCurrency` helper
 * (`client-app/src/lib/formatCurrency.ts` /
 *  `platform/core/formatCurrency.ts`).
 *
 * Pattern matched: any BinaryExpression of the form
 *
 *     <expr ending in an identifier whose name matches /[Cc]ents/> / 100
 *
 * Examples that fail:
 *     priceCents / 100
 *     form.priceCents / 100
 *     budget.maxCostPerConversationCents / 100
 *     (someAmountCents) / 100
 *
 * Examples that pass:
 *     numeric / 100                  // identifier name has no "cents"
 *     amountCents * (sharePercent / 100)
 *     someValue / 1000
 *
 * The rule is automatically skipped inside the canonical
 * `formatCurrency.ts` files via the ESLint config, and individual
 * exceptions (e.g. HTML number-input value bindings that need the
 * dollar value as a primitive number, not a formatted string) can be
 * silenced with a standard `// eslint-disable-next-line` comment.
 */
'use strict';

const CENTS_NAME = /[Cc]ents/;

// Strip wrappers TypeScript / JS commonly puts around an expression that
// don't change which identifier is being divided. This keeps the rule
// from being trivially bypassable via `(x as number) / 100`,
// `<number>x / 100`, `x! / 100`, `x?.priceCents / 100`, etc.
function unwrap(node) {
  let current = node;
  while (current) {
    switch (current.type) {
      case 'TSNonNullExpression':
      case 'TSAsExpression':
      case 'TSTypeAssertion':
      case 'TSSatisfiesExpression':
      case 'TSInstantiationExpression':
        current = current.expression;
        continue;
      case 'ChainExpression':
        current = current.expression;
        continue;
      default:
        return current;
    }
  }
  return current;
}

function leftIdentifierName(node) {
  const current = unwrap(node);
  if (!current) return null;
  if (current.type === 'Identifier') return current.name;
  if (current.type === 'MemberExpression' || current.type === 'OptionalMemberExpression') {
    const prop = current.property;
    if (prop && prop.type === 'Identifier') return prop.name;
  }
  return null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow inline `(...Cents) / 100` conversions; use the shared formatCurrency helper instead.',
      recommended: true,
    },
    schema: [],
    messages: {
      noInlineCents:
        'Avoid inline `{{name}} / 100` for cents→dollars. Use `formatCurrency` from `client-app/src/lib/formatCurrency.ts` or `platform/core/formatCurrency.ts` to centralize the conversion. If you genuinely need a primitive dollar number (e.g. HTML number-input value), add a `// eslint-disable-next-line local/no-cents-divided-by-100` comment with a short justification.',
    },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (node.operator !== '/') return;
        const right = node.right;
        if (!right) return;
        const isHundred =
          (right.type === 'Literal' && right.value === 100) ||
          (right.type === 'NumericLiteral' && right.value === 100);
        if (!isHundred) return;
        const name = leftIdentifierName(node.left);
        if (!name) return;
        if (!CENTS_NAME.test(name)) return;
        context.report({
          node,
          messageId: 'noInlineCents',
          data: { name },
        });
      },
    };
  },
};
