# QVO Comprehensive Platform Audit — 2026-04-25

This directory is the deliverable for **Task #224 — Comprehensive QVO platform audit**. It is a snapshot of the entire platform (tenant portal, platform admin, operations console, public marketing, voice gateway, federated ingest, marketplace, dispatch, scheduling, ticketing, SMS, connector hub, billing, GIN, autopilot, digital twin, evolution engine), surfaced findings, prioritised them, and cross-referenced every backlog item against the existing 99 project tasks.

No code outside this directory was changed.

---

## How to read these documents

Read in order. Each later document depends on context established earlier. The whole bundle is ~3,000 lines; budget about 90 minutes for a first pass.

| # | File | What you'll get |
|---|------|----------------|
| 00 | [`00-system-audit-report.md`](./00-system-audit-report.md) | Executive summary, methodology, coverage matrices for 78 frontend pages, 54 admin-api routers, 4 voice-gateway routers, 9 connector adapters, 13 background workers. |
| 01 | [`01-bug-list.md`](./01-bug-list.md) | 40 bugs B-01 through B-40 across P0–P3. Each has repro, expected, actual, suspected fix, and a related-task pointer. |
| 02 | [`02-data-validation.md`](./02-data-validation.md) | 21 findings D-01 through D-21 — places where the UI value, the API response, and the DB row don't agree, plus the cross-tenant exposure spot-check. |
| 03 | [`03-ux-ui-report.md`](./03-ux-ui-report.md) | UX/UI consistency, dark-mode parity, a11y findings (A-01..A-08), per-page friction (one block per page). |
| 04 | [`04-workflow-logic.md`](./04-workflow-logic.md) | 15 end-to-end workflows W-01..W-15 (call lifecycle, ticket lifecycle, dispatch, scheduling, marketplace install, billing guardrails, federated ingest, OAuth, maintenance mode, account deletion, notifications). |
| 05 | [`05-integration-and-performance.md`](./05-integration-and-performance.md) | 24 findings I-01..I-24 — connector reliability, retries, webhook integrity, latency hot spots, N+1 patterns, SSE, bundle size, indexes. |
| 06 | [`06-security-compliance.md`](./06-security-compliance.md) | 25 findings S-01..S-25 — RBAC, RLS, SSRF, JWT/secret handling, PHI redaction, audit-log gaps, HIPAA-adjacent risks. |
| 07 | [`07-competitive-analysis.md`](./07-competitive-analysis.md) | Findings C-01..C-22 — where QVO is differentiated, where at parity, where behind. Reference set spans voice-AI agents, AI BPOs, field-service incumbents, front-office automation. |
| 08 | [`08-product-strategy.md`](./08-product-strategy.md) | 15 strategic recommendations R-01..R-15 with effort, risk, and pointers to backlog items. Includes Q3/Q4 2026 + Q1 2027 sequencing. |
| 09 | [`09-prioritized-backlog.md`](./09-prioritized-backlog.md) | **The actionable output.** 44 new backlog items BL-001..BL-044 (5 P0, 10 P1, 14 P2, 15 P3). Every item carries `Related task: #N` or `Related task: none`. |

---

## What's in scope and what isn't

**In scope (the audit):**
- Static code analysis of every page, route, adapter, worker, and migration on `main`.
- Cross-reference of every finding against `listProjectTasks()` (99 tasks at audit time).
- Recommendation memo and a deduped backlog.

**Not in scope:**
- Implementation of any fix.
- Live penetration testing or active exploitation of the SSRF / Twilio findings.
- Load testing.
- Marketing copy.
- Production data inspection (read-only DB inspection happened in dev only).

---

## Headline findings

These five items are P0 and should pull into the next sprint:

1. **BL-001** — SSRF allow-list in the Zapier adapter is string-based; an attacker-controlled hostname that resolves to RFC1918 bypasses it. Real risk; fix now.
2. **BL-002** — Twilio voice webhook does not verify `X-Twilio-Signature`; a spoofed POST drains OpenAI minutes.
3. **BL-003** — `Autopilot` is a 952-LOC working page that has no route in `App.tsx`; users pay for a feature called "AI Business Autopilot" they cannot reach.
4. **BL-004** — `app.get('*', …)` is no longer valid in Express 5; the production-mode admin API exits at boot once the SPA fallback is hit.
5. **BL-005** — Auth middleware swallows DB errors as 403 + runs two DB roundtrips per authenticated request; both are easy fixes with high blast-radius reduction.

The full prioritised list lives in `09-prioritized-backlog.md`.

---

## Cross-reference appendix (existing tasks acknowledged)

The audit explicitly avoided creating duplicates of:
- **#20** (in-progress placeholder)
- **#64, #65, #66** (demo SSE, tenant portal polish)
- **#200..#223** (24 PROPOSED tasks covering BookDemo calendar, public logos, orphan endpoints, account purge, legal review, maintenance toggle UI, changelog authoring, notifications pipeline, doc screenshots, demo + marketing dark mode, GIN marketing story, etc.)

The five backlog items that intentionally pair with existing PROPOSED tasks (BL-008/#64, BL-013/#214, BL-015/#210, BL-019/#211/#212/#213, BL-025/#221) are called out in their entries; all carry distinct scope.

---

## Appendix: snapshot data

A snapshot of the project tasks at audit time was saved to `/tmp/tasks.json` during execution; that file is ephemeral and not included here. All cross-references inline in the backlog use the IDs visible in that snapshot.
