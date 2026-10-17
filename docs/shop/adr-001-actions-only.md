# ADR-001: The agent acts only through actions

**Status:** Accepted  
**Date:** 2026-10-17  
**Related:** [Tools spec](./tools-spec.md) §0 · [Templates](./templates.md)

## Context

QVO wins because its in-app tools are better than the ones a small business already pays for, and because the voice agent is one with those tools: it can only act through them, and it gets those actions right. Today that is not true. Business logic sits in route handlers (`server/admin-api/routes/scheduling.ts`, `tickets.ts`, `dispatch.ts`, `smsInbox.ts`), and the voice library handlers (`platform/tools/library/handlers/*`) bypass it. The agent can therefore book a closed day, skip availability, or text an opted-out number.

The UI, the voice/SMS agent, and Wayne's MCP bots all need the same behavior. A second implementation in any of those callers is a defect.

## Decision

1. **One typed action layer per tool** lives in `platform/actions/<tool>/`. Shared contract and runtime live in `platform/actions/core` (`ActionDefinition`, `ActionContext`, `runAction`, two-phase prepare/commit, idempotency).
2. **The UI, the voice agent, and the QVO MCP server are thin adapters** over that layer: HTTP `/api/actions/:name`, generated agent-tool schemas, and MCP tools. They contain no business logic.
3. **The agent acts only through actions.** A shop agent's tool list is generated from the action registry and filtered by the tenant's [use-case template](./templates.md). No action means the agent cannot do it, so it says so and offers a message or a transfer.
4. **Agent writes are two-phase, enforced server-side:** `prepare` (validate, hold, return a spoken `readback` and a `confirmationToken`) → the caller reads the readback back and gives an **explicit yes** → `commit(token)`. "Uh-huh", silence, and "I guess" are not yes. A correction is a new prepare, never an edit to the old token. The UI may commit directly (its own confirm dialog). MCP writes need a write scope and default to `dryRun: true`.
5. **Every write is idempotent.** Agent commits use the confirmation token as the idempotency key. UI and MCP writes send an `Idempotency-Key` header or argument. Same key + same request hash returns the stored response with no second side effect. Same key + different hash returns `IDEMPOTENCY_KEY_REUSED`.
6. **Correctness is enforced in the database**, not the prompt: exclusion constraints, unique keys, RLS (`withTenantContext`), and transactions.
7. **Browser automation only where no API exists** (for example, a POS with no API). It runs as an isolated connector behind an action, never as a code path the agent can call directly.

## Consequences

- Template-configured agents never see legacy library handlers (`createBooking`, `createTicket`, `sendSms`, `createDispatchJob`, and peers) or `registerTemplateTools`. Those handlers are **phased out for template tenants**; they remain only as a migration-era path until each template is cut over.
- New capabilities are actions first. A route, a spoken tool, or an MCP tool that does not call `runAction()` is a defect.
- Prepare/commit, idempotency, and RLS are server-enforced. Prompt instructions are not a control.
- This ADR does not change `platform/actions/**` or `migrations/121*` (PR-01 / PR #97 owns those paths).
