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

### Currency formatting (`local/no-cents-divided-by-100`)

All monetary values in this codebase are stored as **integer cents**. The
shared helpers `client-app/src/lib/formatCurrency.ts` and
`platform/core/formatCurrency.ts` are the **single allowed place** to
divide by 100. Inline `someThingCents / 100` in product code is the most
common source of off-by-100x bugs (see BL-023), so we enforce it with a
custom ESLint rule.

**Do this:**

```ts
import { formatCurrency } from '@/lib/formatCurrency';

<span>{formatCurrency(invoice.totalCents)}</span>
```

**Not this:**

```ts
// ❌ ESLint will fail CI
<span>${(invoice.totalCents / 100).toFixed(2)}</span>
```

The only legitimate exception today is binding a cents amount into an
HTML `<input type="number">`, which needs a primitive dollar value
rather than a formatted string. In that case, add an inline disable
with a short justification:

```tsx
<input
  type="number"
  step="0.01"
  // eslint-disable-next-line local/no-cents-divided-by-100 -- HTML number input needs a primitive dollar value
  value={(form.priceCents / 100).toFixed(2)}
  onChange={(e) => updateField('priceCents', Math.round(parseFloat(e.target.value || '0') * 100))}
/>
```

The rule lives at `tools/eslint-rules/no-cents-divided-by-100.js` and
is wired up via `eslint.config.mjs`.

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
