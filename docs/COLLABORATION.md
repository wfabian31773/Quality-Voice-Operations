# QVO Collaboration Workflow

> The contract between Wayne Fabian (`wfabian31773`) and Claude on how we work together on this repo.

## Roles

| Role | Responsibility |
|---|---|
| **Wayne** | Product decisions, scope sign-off, PR review, Replit publish (production gate) |
| **Claude** | Plan drafting, source-code changes, GitHub Issues, PRs, CI hygiene, memory + CHANGELOG upkeep |

## The flow

```
Wayne decides what to do
   ↓
Claude writes plan / opens issue
   ↓
Wayne approves
   ↓
Claude writes code on a claude/<task-slug> branch
   ↓
Claude pushes + opens PR (uses the PR template)
   ↓
GitHub Actions runs lint + typecheck + (eventually) voice-path smoke test
   ↓
Wayne reviews PR
   ↓
Wayne merges to main
   ↓
Wayne pulls main in Replit + republishes
   ↓
Wayne (or Azul staff) verifies via real phone number
   ↓
Claude updates CHANGELOG + memory
```

**Claude never publishes to Replit. Wayne is the production gate.**

## Rules

1. **Plan-before-code.** Non-trivial work always has a written plan or issue first. Trivial fixes skip this. When in doubt, write the plan.
2. **One task per PR.** PRs are atomic and reviewable. Mega-PRs are not allowed.
3. **Branches:** `claude/<task-slug>` — e.g. `claude/phase-1-archive-modules`.
4. **No surprise scope.** If Claude finds something out-of-scope while doing a task, file a follow-up issue. Don't fix in-flight.
5. **Every PR must:** state what changed, why, how to test in Replit, and which of the five principles (HIPAA / billing / stability / quality of voice / ease of use) it serves.
6. **Memory + CHANGELOG.** Updated by Claude at the end of each session. Memory lives in `~/.claude/projects/.../memory/`. CHANGELOG is `docs/CHANGELOG.md`.
7. **No live patching of production from this repo.** All production fixes go through PR → merge → Replit pull.

## GitHub Issues — labels

Every issue + PR gets:

- One **phase** label: `phase:0` through `phase:6` (or `phase:ongoing` for ops work)
- One or more **scope** labels: `scope:voice`, `scope:billing`, `scope:tickets`, `scope:tenant`, `scope:ui`, `scope:infra`, `scope:docs`
- One or more **gate** labels: `gate:hipaa`, `gate:billing`, `gate:stability`, `gate:voice-quality`
- Optionally: `principle:ease-of-use` when the task is design-quality-driven

## Session ritual

1. Claude reads memory at session start — especially `project_current_state.md`.
2. Work happens.
3. Before sign-off: Claude updates `project_current_state.md` + appends a section to `docs/CHANGELOG.md`.
4. Next session resumes cleanly from that state.

## What Claude can and cannot do

| Can | Cannot |
|---|---|
| Read & write files in this repo | Push to `main` directly (PRs only) |
| Read both production repos via `gh` (Remix, 5Star) | Publish to Replit |
| Run lint/test/build commands locally | Call demo phone numbers |
| Open PRs, create issues, manage labels | Use Phreesia / NextGen / EHR sandboxes |
| Use Supabase MCP for schema introspection + migration proposals | Modify Azul's production data directly |
| Dispatch background research subagents | Sign legal documents (BAAs, contracts) |
| Read `.env` files Wayne points to (e.g. Twilio creds in `Developer Tools/`) | Echo secret values back to chat |
