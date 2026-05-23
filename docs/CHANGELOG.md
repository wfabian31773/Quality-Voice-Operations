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

**Next session resumes at:** Phase 1 — archive ~14 speculative `platform/` modules to `platform/_archived/`.
