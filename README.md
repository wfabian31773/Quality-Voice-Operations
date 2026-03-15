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
