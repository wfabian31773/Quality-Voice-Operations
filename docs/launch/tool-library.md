# Tool library

Agents do not grow their own side-effect code. They pull named tools from this library.

## Rules

1. One name, one schema, one handler.
2. A role package may enable a subset. It may not rename a tool or bypass validation.
3. Execution always goes through authorization, schema validation, rate limits, retry, audit, and tenant isolation.
4. Demo tenants may still receive synthetic results. Production tenants must hit the real handler.
5. If a handler cannot complete the side effect, it returns `success: false`. The agent must say so.

## Adding a tool

1. Add the catalog entry in `platform/tools/library/catalog.ts`.
2. Add an executable handler under `platform/tools/library/handlers/`.
3. Register it in `registerToolLibrary.ts`.
4. Allow it on the role packages that should see it in `toolPermissions.ts`.
5. Add a unit test that proves success and a validation failure.

Do not add a new switch case in the voice session constructor unless the tool is an internal orchestration primitive (`transfer_to_agent`, tenant time, language change).
