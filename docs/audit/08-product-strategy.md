# 08 — Product Strategy & Recommendations

Where to invest engineering effort over the next two quarters. Each item has **rationale**, **effort (S/M/L)**, **risk if skipped**, and a pointer to the backlog item that operationalises it.

---

## North-star recommendation

QVO has built more product than any competitor in the segment but is leaking value at three layers:
1. **Trust & discoverability** — the crown jewels (Autopilot, Digital Twin, Evolution, GIN) are invisible or broken.
2. **Operational reliability** — RBAC and SSRF gaps will be flagged by enterprise buyers' security review.
3. **Front-office completeness** — mini-systems are functional but uneven (empty states, no mobile app for dispatchers).

The strategy is: **ship reliability first**, **then expose the differentiators**, **then close one front-office gap (mobile)**. In that order. The matrix below operationalises this.

---

## R-01 — "Trust quarter": ship the security/reliability fixes (S-Q1)
- Rationale: every enterprise deal asks the same five questions. Today QVO answers four. Closing SSRF (B-03), Twilio webhook signature (I-03), `requireTenantContext` URL-param coverage (B-06), the open redirect (B-20), and the audit-log gap (S-06) makes it five-of-five.
- Effort: M (about 2–3 weeks of focused work).
- Risk if skipped: a single enterprise security review failure stalls a $X00k contract.
- Backlog: BL-001 through BL-005, BL-013.

## R-02 — Restore Autopilot UI to navigable status (S)
- Rationale: paying customers should reach a feature called "AI Business Autopilot" without typing the URL.
- Effort: S (a route + sidebar entry + smoke test). 2 days.
- Risk: customer churn anxiety on missing features.
- Backlog: BL-006.

## R-03 — Per-vertical pre-built analytics dashboards (M)
- Rationale: competitors win on first-paint dashboards. QVO's `/analytics` page is generic.
- Suggested verticals: medical/dental, field-service, real-estate, legal, restaurant. Five dashboards.
- Effort: M (each dashboard ~3 days; reuse one chart library across all).
- Risk: parity loss vs HubSpot Service Hub & Zendesk Explore.
- Backlog: BL-014.

## R-04 — Compliance badges + posture page on the marketing site (S)
- Rationale: free conversion lift. The underlying compliance is real (RLS, audit log, encryption rotation routes).
- Effort: S (a marketing page + minor public-API endpoint exposing the SOC 2 / HIPAA / GDPR posture).
- Risk: lose enterprise buyers at the trust signal phase.
- Backlog: BL-015.

## R-05 — Mobile app for dispatch + scheduling (L)
- Rationale: field-service is a stated vertical; dispatchers and technicians need a phone app.
- Effort: L (Expo project; reuse `expo` skill; ~6 weeks).
- Risk: ServiceTitan/Workiz win the field-service slice.
- Backlog: BL-016.

## R-06 — In-product walkthrough for Autopilot, Digital Twin, Evolution Engine, GIN (M)
- Rationale: these are differentiators today but invisible.
- Effort: M (use the existing ProductTour component; one tour per surface; 2 weeks).
- Risk: differentiation invisible → marketing claims feel hollow.
- Backlog: BL-017.

## R-07 — Per-minute pricing transparency on `/pricing` (S)
- Rationale: buyers shop on per-minute economics.
- Effort: S (a calculator widget).
- Risk: deal qualification slow-down.
- Backlog: BL-018.

## R-08 — Multi-language preference per agent (M)
- Rationale: OpenAI Realtime supports it; QVO's UI does not. Cuts off a meaningful international segment.
- Effort: M (UI + persisted setting + agent loader change; 2 weeks).
- Risk: lost international deals.
- Backlog: BL-019.

## R-09 — Outbound dialer hardening (STIR/SHAKEN, brand spoofing protection) (L)
- Rationale: regulated outbound is a future requirement; carriers are tightening attestation.
- Effort: L (Twilio Trusted Caller flow; data architecture for "verified caller IDs"; ~6 weeks including legal).
- Risk: outbound calls dropped by carriers; reputational damage.
- Backlog: BL-020.

## R-10 — Real-time human-agent coaching (Copilot for humans) (L — possibly defer)
- Rationale: hybrid teams want a human-in-the-loop mode.
- Effort: L (a new persona on top of existing transcript pipeline; 8 weeks).
- Risk: defer is acceptable; QVO's bet is "AI is the agent". Mention in roadmap to avoid losing deals where buyer wants both.
- Backlog: BL-021 (deferred).

## R-11 — Reliability quarter for the schedulers and N+1 hot-spots (M)
- Rationale: operations console is the QVO operator's daily tool. N+1 in dispatch and scheduling list endpoints are felt at every page load.
- Effort: M (rewrite the three N+1 list handlers, add the auth-cache, lazy-load 78 pages).
- Risk: latency complaints from operators with > 200 active jobs.
- Backlog: BL-007, BL-008, BL-009.

## R-12 — Empty-state design system pass (S)
- Rationale: seven mini-system pages have inconsistent empty states. New-tenant churn signal.
- Effort: S (a single shared component; 1 week).
- Risk: new tenants confused → onboarding drop-off.
- Backlog: BL-022.

## R-13 — Account deletion purge worker + notifications (M)
- Rationale: GDPR commitment that today is manual.
- Effort: M (worker + audit + smoke tests; 2 weeks).
- Risk: regulator inquiry.
- Backlog: BL-010 (also overlaps existing #210).

## R-14 — SSE per-tenant rate limiting (S)
- Rationale: a runaway client can hold dozens of SSE connections.
- Effort: S (reuse `createRateLimiter`).
- Risk: connection exhaustion under load.
- Backlog: BL-011.

## R-15 — Discoverability sweep on the public marketing site (M)
- Rationale: federated ingest, three-console isolation, native vertical agents — none of these are marketed.
- Effort: M (4 marketing-site sections + copy).
- Risk: ongoing — competitors with weaker products outsell QVO on story.
- Backlog: BL-023.

---

## Sequencing

**Q3 2026** (next 90 days)
- R-01 (Trust quarter): BL-001…005, 013
- R-02 (Autopilot orphan): BL-006
- R-04 (Compliance badges): BL-015
- R-11 (N+1 + lazy load): BL-007, 008, 009
- R-12 (Empty states): BL-022
- R-14 (SSE rate limit): BL-011

**Q4 2026** (next 90 days after that)
- R-03 (Per-vertical dashboards): BL-014
- R-06 (In-product walkthroughs): BL-017
- R-07 (Pricing): BL-018
- R-13 (Deletion purge): BL-010
- R-15 (Marketing discoverability): BL-023

**Q1 2027**
- R-05 (Mobile app): BL-016
- R-08 (Multi-language): BL-019
- R-09 (Outbound hardening): BL-020

**Deferred**
- R-10 (Human-agent copilot): BL-021

Each backlog id is defined and prioritised in `09-prioritized-backlog.md`.
