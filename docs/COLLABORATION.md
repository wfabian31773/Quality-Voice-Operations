# QVO Collaboration Workflow

> The contract between Wayne Fabian (`wfabian31773`) and Claude on how we work together on this repo.

## Roles

| Role | Responsibility |
|---|---|
| **Wayne** | Product decisions, scope sign-off, PR review, Replit publish (production gate) |
| **Claude** | Plan drafting, source-code changes, GitHub Issues, PRs, CI hygiene, memory + CHANGELOG upkeep |

## The flow

```
Wayne decides what to do (in chat)
   ↓
Claude writes plan / opens issue
   ↓
Wayne approves direction (in chat — "yes" / "go" / etc.)
   ↓
Claude writes code on a claude/<task-slug> branch
   ↓
Claude pushes + opens PR (uses the PR template, applies labels)
   ↓
GitHub Actions runs CI (lint + typecheck + voice-path smoke when wired)
   ↓
Claude merges PR to main once CI is green
   ↓
Wayne pulls main in Replit + republishes
   ↓
Wayne (or Azul staff) verifies via real phone number
   ↓
If broken: Wayne tells Claude in chat → Claude reverts or fixes via a new PR
   ↓
Claude updates CHANGELOG + memory
```

**Claude does all the git work** — opens PRs, monitors CI, merges to `main`. Wayne never touches GitHub's merge button. The production gate is the **Replit publish step** — Wayne owns that exclusively.

**Wayne can ask Claude to "wait on merge"** for any PR in chat. Default behavior is: CI green → Claude merges immediately.

**Pre-merge review is optional**; post-merge verification (Wayne pulling in Replit before republishing) is the real safety gate.

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
| Read & write files in this repo | Push commits directly to `main` (PRs only, even when merging) |
| Open, push, **merge** PRs once CI is green | Publish to Replit |
| Read both production repos via `gh` (Remix, 5Star) | Call demo phone numbers |
| Run lint/test/build commands locally | Use Phreesia / NextGen / EHR sandboxes |
| Create issues, manage labels | Modify Azul's production data directly |
| Use Supabase MCP for schema introspection + migration proposals | Sign legal documents (BAAs, contracts) |
| Dispatch background research subagents | Echo secret values back to chat |
| Read `.env` files Wayne points to (e.g. Twilio creds in `Developer Tools/`) | |
