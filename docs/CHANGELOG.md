# QVO Changelog

Human-readable log of significant changes, per session. Newest at the top. Each entry has a date heading + bullets for what shipped, ending with where the next session resumes.

---

## 2026-05-23 — Phase 0 launched (Memorial Day weekend sprint, day 1)

Workflow foundation committed. Repo now has a written plan + workflow contract on `main`.

- `CLAUDE.md` committed — project context that loads automatically for any Claude session on this repo
- `PLAN.md` committed — v1 plan signed off by Wayne 2026-05-23, source of truth for what we're building
- `docs/COLLABORATION.md` added — workflow contract between Wayne and Claude
- `docs/CHANGELOG.md` initialized — this file
- `.github/pull_request_template.md` added — forces what / why / Replit-test / principle / phase / rollback
- `.github/workflows/lint.yml` added — runs `lint` + `lint:rules` on every PR (typecheck already covered by existing `typecheck.yml`)
- GitHub labels created: `phase:0`-`phase:6`, `phase:ongoing`, `scope:voice`, `scope:billing`, `scope:tickets`, `scope:tenant`, `scope:ui`, `scope:infra`, `scope:docs`, `gate:hipaa`, `gate:billing`, `gate:stability`, `gate:voice-quality`, `principle:ease-of-use`
- **Protocol correction (mid-session):** `docs/COLLABORATION.md` updated — Claude does all the git work including merges; Wayne's only repo-side step is pulling `main` and republishing in Replit. Pre-merge GitHub review is optional, post-merge Replit verification is the real safety gate.
- **Package manager confirmed: npm.** `CLAUDE.md` updated from "pnpm workspaces" to "npm" to match what CI actually uses. Cleanup of `pnpm-lock.yaml` + `pnpm-workspace.yaml` tracked in issue #3.

### Phase 1.F — Root scratch cleanup ([PR #5](https://github.com/wfabian31773/Quality-Voice-Operations/pull/5), commit `732b486`)
- Deleted 14 leftover scratch files from repo root: `block_*.txt`, `block_1_v2.txt`, `conflict_block_*.txt`, `final_cta.txt`, `final_lines.txt`, `mid_block.txt`, `problem_section_start.txt`, `replit.md.bak`, `replit.new`, `fix_replit.py`
- −1,548 lines

### Phase 1.A — Archive demo + assistant + website-agent ([PR #6](https://github.com/wfabian31773/Quality-Voice-Operations/pull/6), commit `004b00c`)
- Moved `platform/demo`, `platform/assistant`, `platform/website-agent` → `platform/_archived/`
- Deleted `server/admin-api/routes/assistant.ts`, `routes/websiteAgent.ts`, and 3 orphan tests
- Archived `client-app/src/components/PlatformAssistant.tsx` (the floating in-app chat bubble)
- Removed PlatformAssistant mounts from `App.tsx` (2 sites), `AdminLayout`, `OpsLayout`, `TenantLayout`
- Removed `assistantRoutes` + `websiteAgentRoutes` from `server/admin-api/app.ts`
- Added `_archived/**` exclude to both `tsconfig.json` files so dead code doesn't fail typecheck
- −561 lines net

### Fix #4 — Migration 063 backfill on fresh DB ([PR #7](https://github.com/wfabian31773/Quality-Voice-Operations/pull/7), commit `b511e2d`)
- Two migrations share the `063_` prefix; alphabetic sort runs `_call_saved_view_pins` (which reads `pin_order`) before `_call_saved_views_pin_order` (which adds the column). On fresh DBs the backfill SELECT failed
- Fix: defensive `ALTER TABLE call_saved_views ADD COLUMN IF NOT EXISTS pin_order` in the pins migration before the INSERT. Idempotent — sibling migration's own `ADD COLUMN IF NOT EXISTS` becomes a no-op
- Closed issue #4
- Filed issue #8 — Admin pages e2e Platform Dev startup + missing npm script (pre-existing, unmasked by the migration fix)

### Phase 1.E — Strip AI-slop CSS ([PR #9](https://github.com/wfabian31773/Quality-Voice-Operations/pull/9), commit `0034d7c`)
- Removed `.hero-gradient-text` (4s animated teal gradient on landing hero) — replaced with static `text-primary` on the highlight word
- Removed `.glass-card` (white-rgba glassmorphism) — was dead CSS
- Kept `.glass-card-light`, `.demo-glass-card`, `.demo-celebration-overlay`, `.scroll-reveal` (legitimate uses)
- −26 lines

### Phase 1.C.1 — Archive autopilot + evolution + digital-twin ([PR #10](https://github.com/wfabian31773/Quality-Voice-Operations/pull/10), commit `c9138f1`)
- Moved `platform/autopilot` (6 files), `platform/evolution` (5 files), `platform/digital-twin` (5 files) → `platform/_archived/`
- Deleted `server/admin-api/routes/{autopilot,evolution,digitalTwin}.ts` and `tests/integrations/autopilotHighRiskNotifications.test.ts`
- Removed 3 imports + 3 mounts from `server/admin-api/app.ts`
- Removed `/ops/digital-twin` nav entry from `OpsLayout.tsx` + the now-unused `Cpu` icon
- −1,204 lines

### Phase 1.C.2.a — Archive platform/gin ([PR #11](https://github.com/wfabian31773/Quality-Voice-Operations/pull/11), commit `b740597`)
- Moved `platform/gin` (8 files, ~1,400 LOC) → `platform/_archived/`
- Deleted `server/admin-api/routes/gin.ts`, `routes/publicGin.ts`, `tests/admin-api/publicGin.test.ts`
- Removed `ginRoutes` + `publicGinRoutes` imports + mounts from `app.ts`
- Removed `startGinScheduler` / `stopGinScheduler` from `server/admin-api/start.ts`
- −951 lines

### Day 1 totals
- **7 PRs merged**
- **~6,000 LOC** archived or deleted from the active surface
- **6 platform modules** moved out of active code: demo, assistant, website-agent, autopilot, evolution, digital-twin, gin (technically 7)
- Floating PlatformAssistant chat removed from the in-app dashboard
- Landing hero is editorial-static teal instead of animated gradient
- 4 follow-up issues filed (#3 pnpm cleanup, #8 admin-e2e flake, plus tracking tasks for deferred modules: widget+activation, sms, messaging, audit)

**Next session resumes at:** Phase 1.C.2.b — archive `platform/marketplace` (72KB route file + AdminMarketplace.tsx page). Then Phase 1.D — the big ~60-page frontend archive pass that will also wholesale-archive dispatch, autopilot's client page, digital-twin's client page, evolution's client page, gin's client pages (GlobalIntelligence + GlobalIntelligenceNetwork), and the Marketplace admin page.
