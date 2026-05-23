# QVO v1 Plan

> **Status:** DRAFT — awaiting Wayne's sign-off.
> **Last updated:** 2026-05-19
> **Owner:** Wayne Fabian (`wfabian31773`)
> **Implementation partner:** Claude
>
> This is a living document. Once signed off, it gets committed to `main` and becomes the source of truth for what we're building. Scope changes update this doc first, then the work follows.

---

## 1. Mission

QVO is a platform for **voice agents that fill operational gaps for businesses**. v1 ships into one vertical (multi-location ophthalmology) with one tenant (Azul Vision) running two proven agents (after-hours, answering service). The platform underneath stays generic so future verticals (optometry, dental, broader specialty medical) layer on without rebuild.

## 2. Core principles (every decision routes through these)

1. **HIPAA compliance** — Patient data flows through QVO. External customers make QVO a Business Associate. Requires: BAA chain, PHI redaction, encryption, audit logs, breach procedure, HIPAA-eligible hosting.
2. **Billing — ironclad** — Every charge defensible. Idempotent Stripe webhooks. Append-only ledger. Reconciliation. Refunds + dunning tested. Currency-cents ESLint rules already enforced.
3. **Stability — ironclad** — Never drop a call. Voice gateway fallback on crash / Realtime outage / process death. Idempotent Twilio handlers. Zero-downtime migrations. Smoke test as deploy gate. Observability with on-call alerting.
4. **Quality of voice** — Natural, low-latency, interruption-aware, graceful failure. The name of the product *is* the principle.
5. **Ease of use** — A novice operates QVO without a training manual. Applies to clients, internal operators, and the v1 setup tool itself.

## 3. Product DNA — what QVO excels at

**Voice quality × tool execution reliability.** Not breadth. Not feature count. Those two things, done at higher quality than competitors, are the entire moat. Tool reliability is enforced by *systems around the model*, not by the model itself. Treat the LLM as unreliable. Engineer reliability into the tool layer.

## 4. Positioning

| Dimension | v1 stance |
|---|---|
| Vertical | Multi-location ophthalmology |
| Beachhead customer | Azul Vision (Tenant #1) |
| Brand name | Quality Voice Operations (QVO) — generic, expandable |
| Public messaging | Explicitly ophthalmology in v1 |
| Sales motion | Bespoke / founder-led for the first 5-10 customers |
| Expansion path | Optometry → dental → broader specialty medical |

## 5. v1 Scope

### What ships in v1

| Agent | Trigger | Behavior |
|---|---|---|
| **After-hours agent** | Inbound call outside business hours | Identify urgency → urgent: page on-call provider via SMS/call + create urgent-flagged ticket. Non-urgent: take a message + create after-hours-message ticket. |
| **Answering service agent** | Inbound call during business hours when staff unavailable | Identify caller intent / department → create a ticket in QVO |

### Tools per agent (the surface that has to be ironclad)

**Shared:**
- `create_ticket(department, summary, urgency, caller_phone, audio_recording_ref)` — side-effecting, must be idempotent
- `lookup_office_hours(location_id)` — read-only
- `lookup_caller(phone)` — read-only, may return cached caller history for context

**After-hours only:**
- `triage_urgency(symptoms_description)` — read-only, classifies caller's stated reason into urgent / non-urgent
- `page_on_call(department, urgency_reason, caller_phone)` — side-effecting, idempotent, sends SMS + optionally calls the on-call provider

**Answering service only:**
- `identify_department(caller_intent)` — read-only, returns department/intent code

### Tenant model

| Entity | v1 |
|---|---|
| Tenant | Azul Vision (only tenant in v1) |
| Locations | 30+ Azul locations under one tenant |
| Phone numbers | Per-location, per-agent — provisioned through Twilio |
| RBAC roles | Tenant admin, location admin, operator/staff |

### Explicitly OUT of scope for v1

- NextGen mirrored-schedule appointment booking
- Voice → structured ticket extraction from free-form conversation beyond what `create_ticket` captures
- Live agent warm voice transfer (v1 after-hours uses SMS/call paging instead)
- Outbound campaigns (diabetic retinopathy screening, etc.)
- Phreesia integration
- Patient management system direct API integration
- Marketplace, agent builder visual editor, mobile app, GIN, autopilot, simulation lab, digital twin, evolution engine, workforce, dispatch, demo, assistant, website-agent, widget, activation
- Public self-serve signup

## 6. Architecture decisions

| Decision | Choice | Rationale |
|---|---|---|
| Voice transport | **WebSocket** (QVO's existing pattern) | Wayne's production finding: WebSocket more stable than SIP for QVO's quality bar |
| Source of truth for agent patterns | **Remix repo** (`wfabian31773/openai-realtime-api-voice-assistant-Remix`) | 40K calls of production validation |
| Destination | **QVO** at this repo | Multi-tenant, SaaS chassis |
| Deploy | **Replit via GitHub** | Push to GitHub → pull in Replit → publish. Replit handles WebSocket-friendly hosting. |
| External-tier host (later) | **TBD — Supabase + HIPAA-friendly compute likely** | Replit's HIPAA posture may be insufficient for external launch; bifurcation may be required |
| LLM | OpenAI Realtime API | Already in production at Azul |
| Database | PostgreSQL (Supabase prod, Replit dev) | Existing |
| ORM | Drizzle | Matches Remix and 5Star — same stack |
| Frontend | React 19 + Vite 6 + Tailwind 4 + Refined Harbor design system | Keep — design system is well-architected; problem is enforcement, not design |

## 7. Phases

> Effort estimates assume focused work and may compress or expand based on Wayne's pace.

### Phase 0 — Workflow foundation (do first; small)

- Commit `CLAUDE.md` (drafted, currently untracked)
- Commit this `PLAN.md`
- Write & commit `docs/COLLABORATION.md` (the workflow doc)
- Create `docs/CHANGELOG.md`
- Create GitHub labels: `scope:voice`, `scope:billing`, `scope:tickets`, `scope:tenant`, `gate:hipaa`, `gate:billing`, `gate:stability`, `gate:voice-quality`, `principle:ease-of-use`, `phase:0` through `phase:6`
- Add `.github/pull_request_template.md`
- Add pre-commit hook (lint + typecheck)
- GitHub Actions workflow: lint + typecheck + `lint:rules` on every PR
- Create GitHub Issues for each phase task

### Phase 1 — Cut surface (estimated: 1-2 weeks)

- **Archive ~14 speculative platform modules** to `platform/_archived/`: `gin`, `autopilot`, `digital-twin`, `workforce`, `evolution`, `marketplace`, `help`, `dispatch`, `sms`, `messaging`, `audit` (stub — will rebuild later), `demo`, `assistant`, `website-agent`, `widget`, `activation`, `simulation`
- **Archive ~60 frontend pages** to `client-app/src/pages/_archived/`. Keep only:
  - **Public:** Landing, Pricing, BookDemo, Login, Signup, ForgotPassword, VerifyEmail, AcceptInvite, Terms, Privacy, NotFound
  - **In-app:** Dashboard, Agents, AgentBuilder, Calls, Settings, Onboarding, ApiKeys, Tickets, TicketDetail, TicketReporting
  - **Admin:** PlatformAdmin
- **Strip AI-slop CSS** from `client-app/src/styles/tw-public.css`: `.glass-card`, `.hero-gradient-text`, `blur-[Npx]` hero blobs, `backdrop-blur-sm` on CTAs
- **Squash root scratch files:** `block_*.txt`, `block_1_v2.txt`, `conflict_block_*.txt`, `final_cta.txt`, `final_lines.txt`, `mid_block.txt`, `problem_section_start.txt`, `replit.md.bak`, `replit.new`, `fix_replit.py`
- Each archive happens as its own PR with the label `phase:1` so review stays bite-sized

### Phase 2 — Port the two agents from Remix → QVO (estimated: 2-3 weeks)

- Read and document the Remix repo's `AgentRegistry` + factory pattern; compare against QVO's existing `platform/agent-templates/`. Align names, port the production pattern verbatim where QVO's is weaker.
- Port the **after-hours agent**: config, system prompt, tool definitions (`triage_urgency`, `page_on_call`, `create_ticket`, `lookup_office_hours`, `lookup_caller`), voice settings (TTS voice, speed, interruption thresholds)
- Port the **answering service agent**: config, system prompt, tool definitions (`identify_department`, `create_ticket`, `lookup_office_hours`, `lookup_caller`), voice settings
- Wire `server/voice-gateway/` to route inbound calls to the correct agent based on time-of-day (per-location business hours)
- **Harden the tool registry — the 8 reliability requirements:**
  1. Tool registry as first-class artifact (name + JSON schema + description + handler + tests, versioned)
  2. Every tool call logged (agent, session, args in/out, latency, retries, outcome)
  3. Argument validation before execution (LLM hallucinates args; schema-reject with structured error)
  4. Idempotency keys on side-effecting tools (`create_ticket`, `page_on_call`)
  5. Tool call success rate as a primary metric (per agent, per tool, per day)
  6. Tool call latency budgets + circuit-break on overrun
  7. Tool failure → defined agent behavior (retry / refuse + escalate / alternative) — never silent
  8. Replay-able tool call traces per session (debugging + regression suite)

### Phase 3 — Tenancy + setup tool for Azul (estimated: 2 weeks)

- Audit `platform/tenant/` + `platform/rbac/` + RLS policies for correctness with Azul as Tenant #1
- Build the **bespoke onboarding/setup tool** — operator-facing UI Wayne (or future ops staff) uses to configure a new tenant. Ease-of-use applies. This tool becomes self-serve later.
- Onboard Azul: phone numbers, per-location business hours, departments, on-call paging targets, voice/tone preferences
- Build the **post-onboarding tenant dashboard** — what an Azul office manager sees: calls today, missed calls, recent tickets, agent status. Big buttons, outcome-verb labels, no platform jargon.
- **Cutover plan:** how Azul's production traffic moves from Remix → QVO without dropping calls (per-number cutover, fallback to Remix if QVO fails health check)

### Phase 4 — Production gates (runs in parallel with Phase 3)

- **HIPAA gate:**
  - BAA chain audit (Twilio, OpenAI, Anthropic-if-used, hosting)
  - PHI redaction verification via unit tests (`platform/core/phi/`)
  - Encryption audit (at rest + in transit, including voice recordings)
  - Audit log of PHI access (who accessed which patient record when)
  - Breach notification procedure documented
  - Hosting decision: Replit OK for internal Azul; document external-tier alternative (Supabase + HIPAA-friendly compute)
- **Billing gate:**
  - Idempotent Stripe webhook handlers (keyed by `event.id`)
  - Append-only billing ledger reconciled to Stripe
  - Extend `StripePriceVerificationScheduler` to subscription/invoice drift, not just price
  - Refund flow tested end-to-end (test-mode Stripe refund → ledger entry → customer portal view all agree)
  - Dunning flow tested
  - No hardcoded prices in marketing pages (Stripe is the truth)
- **Stability gate:**
  - **Voice-path smoke test** (deploy gate): inbound call → voice gateway → agent answers → outcome captured. Becomes a required CI check.
  - Voice gateway fallback: if Realtime API / process dies mid-call, Twilio routes to configured fallback number (warm transfer or recorded message). Tested.
  - Twilio handler idempotency tests
  - Zero-downtime migration checklist
  - Observability dashboard: calls/min, completion rate, error rate, p95 latency to first audio
  - On-call alerting threshold (page-out within 5 min when above threshold)
  - DR procedure documented (Postgres restore, Twilio outage, OpenAI outage)
  - Deploy rollback under 60 seconds documented
- **Quality of voice gate:**
  - 8 tool-reliability requirements (per Phase 2) measurably green
  - Voice-quality eval framework defined (rubric per workflow)
  - Recorded edge-case regression suite from real Azul calls
  - Target: **0 dropped tool calls over a 7-day measurement window** before Phase 5 cutover

### Phase 5 — Internal launch (Azul fully on QVO) (estimated: 1 week + 30 days observation)

- Cutover all Azul phone numbers from Remix → QVO
- Both agents live in QVO production
- Daily eval review for 30 days
- Remix repo paused but not deleted (rollback path preserved)

### Phase 6 — External launch prep (deferred until Phase 5 is solid)

- Public marketing site rebuild: vertical-targeted, ophthalmology, using design system + new component library
- Pricing model defined off Azul's real usage
- HIPAA-host evaluation if Replit is insufficient for external
- BAA template for external customers
- Second customer (Wayne's ophthalmology lead) onboarded as design partner using the Phase 3 setup tool

## 8. Production gate pass criteria

| Principle | Pass criteria (must all be green to proceed to next phase or external launch) |
|---|---|
| **HIPAA** | Signed BAAs with Twilio, OpenAI, Anthropic (if used), hosting. PHI redaction unit-tested. Encryption at rest + in transit verified. Audit log of PHI access. Breach notification procedure. Hosting is HIPAA-eligible OR explicitly internal-only. |
| **Billing** | Idempotent webhooks tested. Ledger reconciled to Stripe. Refunds tested end-to-end. Currency-cents enforced (already done). No hardcoded prices in UI. Dunning flow tested. |
| **Stability** | Voice-path smoke test passing. Voice gateway fallback tested. Idempotent Twilio handlers tested. Zero-downtime migration checklist documented. Observability dashboard live. On-call alerting configured. DR procedure documented. Deploy rollback under 60s. |
| **Quality of voice** | 8 tool-reliability requirements met. Voice-quality eval framework defined and scored. Recorded regression suite from real Azul calls runs in CI. 0 dropped tool calls over 7-day measurement window. |
| **Ease of use** | A novice user (e.g. an Azul office manager) operates the post-onboarding dashboard without help. Setup tool used by Wayne to onboard the 2nd customer without writing a manual. |

## 9. Workflow conventions

| Convention | Detail |
|---|---|
| Plan-before-code | No source edits on non-trivial work without an approved plan or issue. Trivial fixes (typos) don't need a plan. |
| Branches | `claude/<task-slug>` per task |
| PRs | One per task, template-driven (what / why / how to test in Replit / which gate this serves) |
| Issues | GitHub Issues as the tracker. Labels: `phase:N`, `scope:*`, `gate:*`, `principle:*` |
| Commits | Small, frequent, descriptive |
| Session sign-off | Update memory's `project_current_state.md` + `docs/CHANGELOG.md` |
| Deploy | Wayne pulls main in Replit + republishes. Claude never publishes. |

## 10. Open questions (not blocking the plan, but must be resolved during execution)

| # | Question | Affects | Owner |
|---|---|---|---|
| 1 | Replit project name / ID + dev/staging environment topology | Deploy workflow, env vars, secrets runbook | Wayne |
| 2 | Supabase access — project credentials for Claude's schema introspection / migration proposals? | Phases 2, 4 | Wayne |
| 3 | Demo phone number for testing — Wayne-only or shareable in PRs? | Phase 4 smoke test | Wayne |
| 4 | Working pace — daily, weekly, weekends? | Task sizing | Wayne |
| 5 | The ophthalmology lead — name + practice size + warmth | Phase 6 | Wayne |
| 6 | Patient management system identity — exact product (NextGen Enterprise PM?) | Future integration, not v1 | Wayne |
| 7 | Confirm Remix repo's transport (WebSocket per Wayne, README says SIP) | Phase 2 port | Claude (verify via gh) |
| 8 | Commit `CLAUDE.md` now? Still untracked. | Phase 0 | Wayne |

## 11. Sign-off

- [ ] Wayne reviews and signs off on this plan (or proposes edits)
- [ ] Phase 0 begins — `CLAUDE.md` commit, this `PLAN.md` commit, workflow scaffolding (`COLLABORATION.md`, labels, PR template, pre-commit, CI gate, initial GitHub Issues)
- [ ] Phase 1 begins
