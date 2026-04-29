# Voice AI Operations Hub

Multi-tenant SaaS platform for managing AI-powered voice operations at enterprise scale.

## Tech Stack

- **Frontend:** React 19 + Vite + Tailwind CSS 4 + Zustand
- **Backend:** Express 5 + TypeScript (Admin API on port 3002, Voice Gateway on port 3001)
- **Database:** PostgreSQL (Replit local for dev, Supabase for production)
- **Auth:** JWT-based authentication with bcrypt password hashing
- **Voice:** OpenAI Realtime API + Twilio SIP Trunking
- **Billing:** Stripe integration

## Development

```bash
npm run dev
```

This starts all three services:
- Vite dev server (port 5000)
- Admin API (port 3002)
- Voice Gateway (port 3001)

## Database

```bash
npm run db:migrate    # Run migrations
npm run db:seed       # Seed demo data
```

## Linting

```bash
npm run lint          # Lint client-app/src and platform/
npm run lint:rules    # Self-test for the custom ESLint rules
```

### Currency formatting (`local/no-cents-divided-by-100`, `local/no-dollars-times-100`)

All monetary values in this codebase are stored as **integer cents**. The
shared helpers `client-app/src/lib/formatCurrency.ts` and
`platform/core/formatCurrency.ts` are the **single allowed place** for
the `* 100` / `/ 100` math that converts between cents and dollars.
Inline conversions in product code are the most common source of
off-by-100x bugs (see BL-023), so we enforce both directions with two
custom ESLint rules.

#### cents → dollars (display)

**Do this:**

```ts
import { formatCurrency } from '@/lib/formatCurrency';

<span>{formatCurrency(invoice.totalCents)}</span>
```

**Not this:**

```ts
// ❌ ESLint will fail CI (local/no-cents-divided-by-100)
<span>${(invoice.totalCents / 100).toFixed(2)}</span>
```

#### dollars → cents (input / persistence)

**Do this:**

```ts
import { dollarsToCents } from '@/lib/formatCurrency';

onChange={(e) => updateField('priceCents', dollarsToCents(e.target.value))}
```

**Not this:**

```ts
// ❌ ESLint will fail CI (local/no-dollars-times-100)
onChange={(e) =>
  updateField('priceCents', Math.round(parseFloat(e.target.value || '0') * 100))
}
```

`dollarsToCents` accepts a `number`, `bigint`, or string (including
empty/invalid input, which it normalizes to `0`), runs `Math.round`,
and returns integer cents.

#### Legitimate exceptions

The only common exception today is binding a cents amount into an HTML
`<input type="number">`, which needs a primitive dollar value rather
than a formatted string. In that case, add an inline disable with a
short justification:

```tsx
<input
  type="number"
  step="0.01"
  // eslint-disable-next-line local/no-cents-divided-by-100 -- HTML number input needs a primitive dollar value
  value={(form.priceCents / 100).toFixed(2)}
  onChange={(e) => updateField('priceCents', dollarsToCents(e.target.value))}
/>
```

If you genuinely need inline `<x> * 100` math (e.g. building a fixture
in a test that this lint config doesn't cover anyway), pair it with:

```ts
// eslint-disable-next-line local/no-dollars-times-100 -- <reason>
```

The rules live at `tools/eslint-rules/no-cents-divided-by-100.js` and
`tools/eslint-rules/no-dollars-times-100.js` and are wired up via
`eslint.config.mjs`. Their self-tests run via `npm run lint:rules`.

## Project Structure

```
client-app/     # React frontend (Vite)
server/         # Express servers
  admin-api/    # Admin API (port 3002)
  voice-gateway/# Voice Gateway (port 3001)
platform/       # Core platform modules
  audit/        # Audit logging
  billing/      # Stripe billing
  core/         # Environment config, RBAC
  db/           # Database connection pool
  tenant/       # Tenant management
migrations/     # SQL migration files (001-027)
scripts/        # Migration runner, seed scripts
```
