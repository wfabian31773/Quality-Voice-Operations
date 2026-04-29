/**
 * Custom ESLint rule: no-dollars-times-100
 *
 * The reverse direction of `no-cents-divided-by-100`: flags inline
 * `<x> * 100` style dollars→cents conversions and steers contributors
 * to the centralized `dollarsToCents` helper exported from
 * `client-app/src/lib/formatCurrency.ts` and
 * `platform/core/formatCurrency.ts`.
 *
 * The original BL-023 cleanup focused on the cents→dollars direction,
 * but the same off-by-100x risk lives on the input/handler side of the
 * codebase, e.g.
 *
 *     onChange={(e) =>
 *       updateField('priceCents', Math.round(parseFloat(e.target.value || '0') * 100))
 *     }
 *
 * Heuristics — the rule fires on `<x> * 100` (or `100 * <x>`) when ANY
 * of these are true:
 *
 *   A. The non-literal side is an identifier/property whose name looks
 *      monetary (matches /dollars?|usd/i). Examples: `priceDollars * 100`,
 *      `usdAmount * 100`, `form.priceDollars * 100`.
 *
 *   B. The enclosing assignment context targets a name containing
 *      `Cents`. The walk transparently skips common wrappers
 *      (`Math.round(...)`, `Math.floor(...)`, `Number(...)`,
 *      `parseInt(...)`, `parseFloat(...)`, parens, ternaries,
 *      `as`/non-null assertions, `?.` chains) so the rule still fires on
 *      patterns like:
 *
 *          maxCostPerConversationCents: Math.round(parseFloat(value) * 100)
 *          updateField('priceCents', Math.round(parseFloat(value) * 100))
 *          this.priceCents = (form.priceDollars ?? 0) * 100
 *
 * Examples that pass (none of the heuristics match):
 *
 *     const pct = Math.round(rate * 100);            // not assigned to *Cents
 *     style={{ width: `${(count / max) * 100}%` }}   // not *Cents target
 *     score -= Math.min(20, Math.round(ratio * 100)) // function arg, not *Cents
 *     const random = Math.random() * 100;            // identifier name not monetary
 *
 * The rule is automatically skipped inside the canonical
 * `formatCurrency.ts` files via the ESLint config, and individual
 * exceptions can be silenced with a standard `// eslint-disable-next-line`
 * comment paired with a justification.
 */
'use strict';

const DOLLAR_NAME = /dollars?|usd/i;
const CENTS_NAME = /[Cc]ents/;

const MATH_WRAPPERS = new Set([
  'round',
  'floor',
  'ceil',
  'trunc',
  'abs',
  'Number',
  'parseInt',
  'parseFloat',
]);

function isLiteral100(node) {
  if (!node) return false;
  if (node.type === 'Literal' && node.value === 100) return true;
  if (node.type === 'NumericLiteral' && node.value === 100) return true;
  return false;
}

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

function identifierName(node) {
  const c = unwrap(node);
  if (!c) return null;
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' || c.type === 'OptionalMemberExpression') {
    if (c.property && c.property.type === 'Identifier') return c.property.name;
  }
  return null;
}

function calleeName(callee) {
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && callee.property && callee.property.type === 'Identifier') {
    return callee.property.name;
  }
  return null;
}

/**
 * Walk up the parent chain (transparently skipping wrapping nodes that
 * don't change which "slot" the value flows into) and return the name
 * of the surrounding assignment target — property key, declared
 * variable, assignment LHS, or the leading string-literal argument of a
 * setter-style call (e.g. `updateField('priceCents', ...)`).
 *
 * Returns `null` if no such target can be identified.
 */
function getEnclosingTargetName(node) {
  let current = node;
  let parent = node.parent;
  while (parent) {
    switch (parent.type) {
      case 'ChainExpression':
      case 'TSAsExpression':
      case 'TSNonNullExpression':
      case 'TSTypeAssertion':
      case 'TSSatisfiesExpression':
      case 'TSInstantiationExpression':
      case 'ParenthesizedExpression':
        current = parent;
        parent = parent.parent;
        continue;
      case 'ConditionalExpression':
        if (parent.consequent === current || parent.alternate === current) {
          current = parent;
          parent = parent.parent;
          continue;
        }
        return null;
      case 'LogicalExpression':
        current = parent;
        parent = parent.parent;
        continue;
      case 'CallExpression':
      case 'NewExpression': {
        const args = parent.arguments || [];
        const idx = args.indexOf(current);
        if (idx === 0) {
          // `Math.round(<expr>)` / `Number(<expr>)` etc. — transparent
          // wrapper, keep walking outward.
          const name = calleeName(parent.callee);
          if (name && MATH_WRAPPERS.has(name)) {
            current = parent;
            parent = parent.parent;
            continue;
          }
          return null;
        }
        if (idx > 0) {
          // Setter-style call: `updateField('priceCents', <expr>)`.
          const first = args[0];
          if (first && first.type === 'Literal' && typeof first.value === 'string') {
            return first.value;
          }
        }
        return null;
      }
      case 'Property':
      case 'ObjectProperty':
        if (parent.value === current && parent.key) {
          if (parent.key.type === 'Identifier') return parent.key.name;
          if (parent.key.type === 'Literal' && typeof parent.key.value === 'string') {
            return parent.key.value;
          }
        }
        return null;
      case 'VariableDeclarator':
        if (parent.init === current && parent.id && parent.id.type === 'Identifier') {
          return parent.id.name;
        }
        return null;
      case 'AssignmentExpression':
        if (parent.right === current) {
          const left = parent.left;
          if (left.type === 'Identifier') return left.name;
          if (left.type === 'MemberExpression' && left.property && left.property.type === 'Identifier') {
            return left.property.name;
          }
        }
        return null;
      default:
        return null;
    }
  }
  return null;
}

const HELPER_HINT =
  'Use the shared `dollarsToCents` helper from `client-app/src/lib/formatCurrency.ts` or `platform/core/formatCurrency.ts` instead. If you genuinely need inline `* 100` math here, add a `// eslint-disable-next-line local/no-dollars-times-100` comment with a short justification.';

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow inline `<dollars> * 100` conversions; use the shared dollarsToCents helper instead.',
      recommended: true,
    },
    schema: [],
    messages: {
      noInlineDollars:
        'Avoid inline `{{name}} * 100` for dollars→cents. ' + HELPER_HINT,
      noInlineDollarsToCents:
        'Avoid inline `* 100` when assigning to `{{target}}` (dollars→cents). ' + HELPER_HINT,
    },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (node.operator !== '*') return;
        const leftIs100 = isLiteral100(node.left);
        const rightIs100 = isLiteral100(node.right);
        if (!leftIs100 && !rightIs100) return;
        // Both literals — nonsense, skip.
        if (leftIs100 && rightIs100) return;

        const otherSide = leftIs100 ? node.right : node.left;

        // Heuristic A: the non-literal side itself names a dollar/USD value.
        const otherName = identifierName(otherSide);
        if (otherName && DOLLAR_NAME.test(otherName)) {
          context.report({
            node,
            messageId: 'noInlineDollars',
            data: { name: otherName },
          });
          return;
        }

        // Heuristic B: the enclosing assignment target ends in / contains "Cents".
        const target = getEnclosingTargetName(node);
        if (target && CENTS_NAME.test(target)) {
          context.report({
            node,
            messageId: 'noInlineDollarsToCents',
            data: { target },
          });
        }
      },
    };
  },
};
