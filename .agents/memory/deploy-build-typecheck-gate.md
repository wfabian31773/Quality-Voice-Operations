---
name: Deploy build is the only root tsc gate
description: Why server/test type errors surface only at deploy time, not in CI
---

The deployment build (`[deployment].build` in `.replit`) is the **only** place that runs
root `npx tsc --noEmit`, which type-checks everything in the root tsconfig's `include`
(`server`, `platform`, `scripts`) — and that pulls in all `*.test.ts` files under them.

GitHub Actions CI only type-checks `client-app` (`npm run typecheck:client`). There is no
CI job running the root `tsc --noEmit`.

**Consequence:** type errors in server/platform/scripts code — especially test files — are
invisible until a publish/deploy attempt, where they fail the build at its very first step
(before client typecheck, env/stripe validation, and vite build). A green local `vitest`
run does NOT catch them, because vitest transpiles via esbuild and does not type-check.

**Why:** the build chain is `tsc --noEmit && client typecheck && validate:env:prod &&
verify:stripe-prices && vite build`. The first `tsc` covers the whole backend incl. tests.

**How to apply:**
- Before publishing, run `npx tsc --noEmit` at repo root to catch server/test type errors early.
- Fix the actual type errors rather than excluding tests from the build — excluding would
  weaken the only deploy-time gate that covers the backend.
- A durable prevention is adding a root `tsc --noEmit` job to CI so it matches the deploy gate.
- Common trap under vitest 4 types: a `vi.fn(async (sql: string) => ...)` mock makes
  `mock.calls` entries a 1-tuple, so destructuring `[sql, values]` fails TS2493 —
  declare the extra parameter (e.g. `_values?: unknown[]`) on the mock signature.
