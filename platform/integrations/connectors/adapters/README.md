# Connector adapters

This folder holds the per-provider adapters the `ConnectorService` dispatches
standard events to (`call.completed`, `appointment.booked`, `sms.sent`,
`ticket.created`, `call.missed`).

Every adapter implements `ConnectorAdapter` from `../types.ts`:

```ts
execute(tenantId, config, payload): Promise<ConnectorResult>
```

Most of the per-provider details (auth, search-or-create, disposition mapping)
are specific to each upstream API. The one cross-cutting contract that is easy
to get wrong on a new adapter is the **auto-promote pattern** for
`appointment.booked`, documented below.

---

## Auto-promote on `appointment.booked` (first-party CRMs)

When the agent books an appointment, the contact has crossed from "lead" into
the active sales pipeline. To keep pipeline reporting consistent across CRM
providers, every **first-party CRM adapter** that has a pipeline / deal
concept must auto-wire records into the active pipeline as part of handling
`appointment.booked` — without requiring the customer to set up a Zap or write
custom logic on top.

Adapters that follow this contract today:

| Adapter        | Lead-equivalent → Deal-equivalent on `appointment.booked` |
| -------------- | --------------------------------------------------------- |
| `salesforce.ts` | Find/create Lead or Contact → convert Lead to Contact + Account + Opportunity (`convertLead` with `doNotCreateOpportunity: false`) |
| `hubspot.ts`    | Find/create Contact (+ Company) → reuse open Deal or create one in `appointment_pipeline_id` / `appointment_stage_id` |
| `pipedrive.ts`  | Find/create Person (+ Organization) → reuse open Deal or create one, optionally moved to `appointment_stage_id` |
| `zoho.ts`       | Find/create Contact (+ Account) → reuse open Deal or create one, optionally moved to `appointment_stage_id` (Zoho `Stage` name) within the configured `appointment_pipeline_id` (Zoho `Layout`) |

Adapters that **opt out** of this contract (and why):

- `zapier.ts`, generic `webhook.ts` — pass-through delivery; the customer's
  Zap / receiver decides what to do with the event. We never auto-create
  records on the user's behalf in their downstream system.
- `quickbooks.ts` — accounting domain, no pipeline / deal concept.
- `slack.ts`, `sms.ts`, `ticketing.ts`, `google-calendar.ts`,
  `outlook-calendar.ts` — not CRMs; they own their own side effects
  (notification, message, ticket, calendar event).

### What the next CRM adapter (e.g. Zoho, Close, Freshsales) must do

For `payload.type === 'appointment.booked'`:

1. **Resolve / create the person.** Use `payload.contactId` /
   `payload.personId` if present; otherwise look up by `callerPhone` and
   create a Lead/Contact equivalent populated from `callerFirstName`,
   `callerLastName`, `callerEmail`.
2. **Resolve / create the company.** Use `payload.companyId` /
   `payload.accountId` / `payload.orgId` if present; otherwise look up by
   `callerCompany`. Skip blank or `"unknown"` company names.
3. **Auto-promote into the pipeline.** Either:
   - Convert the Lead-equivalent into a Contact + Account +
     Opportunity/Deal (Salesforce-style), or
   - Reuse an open Deal for the contact and move it to the configured
     "appointment booked" stage; if none exists, create one in the configured
     pipeline / stage (HubSpot- and Pipedrive-style).
   Pipeline / stage IDs come from `payload.pipelineId` /
   `payload.appointmentStageId` first, then from the connector's stored
   credentials (e.g. `appointment_pipeline_id`, `appointment_stage_id`,
   `default_pipeline_id`, `default_stage_id`).
4. **Log the appointment.** Create the provider-native activity / note / task
   that captures the appointment and links it to the contact, company, and
   deal records resolved above.
5. **Return IDs in `ConnectorResult.meta`.** Subsequent events (e.g. the
   `call.completed` for the same caller) pass these back as hints so the
   adapter does not re-search and does not create duplicates. Use the
   shared key vocabulary already in use by the existing adapters:

   - Person: `contactId`, `personId`, `whoId` (+ `whoObject`)
   - Company: `companyId`, `accountId`, `orgId`
   - Deal: `dealId`, `opportunityId`
   - Activity: `taskId`, `activityId`, `engagementId`, `noteId`
   - Pipeline context: `pipelineId`, `stageId`, `dealStageMoved`
   - Conversion bookkeeping: `convertedFromLead`, `convertedFromLeadId`
   - Always include `provider: '<name>'` and any tenant-instance hints
     (e.g. Salesforce's `instanceUrl`).

### Why this matters

`ConnectorService` re-dispatches the same booking and the follow-up
`call.completed` against whichever CRM is active. If a new adapter only
creates an activity but never wires the booking into the pipeline, that
tenant's pipeline reports go silent the moment they switch providers, even
though the agent behavior is identical. The auto-promote pattern keeps
"appointment booked" surfaced in the pipeline regardless of which first-party
CRM is connected.

---

## Other shared conventions worth knowing

- **OAuth refresh.** Token-based providers run `ensureFreshOAuthToken(config)`
  (or a provider-specific equivalent like `ensureSalesforceAccessToken`) at
  the top of `execute` so a stale token transparently refreshes before any
  API call.
- **Disposition mapping.** Use `parseDispositionMap` + `mapDisposition` from
  `../dispositionMap.ts` so per-tenant overrides flow through. Validate the
  map even on code paths that don't otherwise read disposition fields, so a
  bad config surfaces in the connector activity log.
- **SSRF guard.** Any adapter that POSTs to a customer-supplied URL (Zapier,
  generic webhook, external ticketing) must use `safeFetch` from
  `../ssrfGuard.ts` instead of raw `fetch`.
- **Timeouts.** Wrap outbound calls with an `AbortController` /
  `REQUEST_TIMEOUT_MS` (15s is the established default) so a slow upstream
  cannot wedge the dispatcher.

---

## Validating cached CRM identity against live sandboxes

Each first-party CRM adapter exports a `validate*CachedIdentity` function
that the `CrmCallerIdentityRevalidationScheduler` calls periodically to
scrub cached IDs whose upstream record has been deleted. The mocked unit
tests in `validateCachedIdentity.test.ts` lock in our parsing rules; the
opt-in suite in `validateCachedIdentity.integration.test.ts` re-runs the
same validators against real CRM sandboxes to catch upstream drift
(HubSpot moving the 404 body shape, Zoho returning a 200 wrapper around a
missing record, Salesforce key-prefix changes, etc.) before it silently
disables proactive cleanup.

The integration suite is `describe.skipIf`-gated per provider, so each
provider can be enabled independently — `vitest run` skips any block whose
env vars are missing. To enable a provider, set its env vars in the CI job
(or your local shell) before running `npm test` /
`npx vitest run platform/integrations/connectors/adapters/validateCachedIdentity.integration.test.ts`.

### Per-provider env vars

The test reads `*_SANDBOX_ACCESS_TOKEN` (and the provider-specific extras
like `*_INSTANCE_URL` / `*_API_DOMAIN`) directly out of the environment.
For providers whose token expires fast (Salesforce, Zoho), the CI workflow
mints a fresh access token from long-lived credentials at the start of
each run and writes the resulting access token into the environment for
the test step — so the matrix below splits "what runs locally" from "what
CI stores as long-lived secrets".

For each provider you also need at least one record ID that has been
**hard-deleted** (or in Salesforce's case, deleted *and* purged from the
Recycle Bin so the API returns `ENTITY_IS_DELETED`). You can supply any
subset of the per-slot deleted IDs (contact / account / opportunity); the
test asserts on exactly the slots you supplied.

| Provider     | What the test reads at runtime                                                                                                                              | What CI stores as long-lived secrets (mint-per-run for short-lived providers)                                                                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HubSpot      | `HUBSPOT_SANDBOX_ACCESS_TOKEN` + at least one of `HUBSPOT_SANDBOX_DELETED_CONTACT_ID` / `..._DELETED_COMPANY_ID` / `..._DELETED_DEAL_ID`                    | Same — HubSpot private-app tokens never auto-expire.                                                                                                                                                                                       |
| Salesforce   | `SALESFORCE_SANDBOX_ACCESS_TOKEN`, `SALESFORCE_SANDBOX_INSTANCE_URL` + at least one deleted ID (`..._CONTACT_ID` `003…`, `..._ACCOUNT_ID` `001…`, `..._OPPORTUNITY_ID` `006…`) | `SALESFORCE_SANDBOX_CLIENT_ID`, `..._CLIENT_SECRET`, `..._USERNAME`, `..._PASSWORD`, `..._SECURITY_TOKEN` (optional `..._LOGIN_URL`). CI runs the OAuth password flow on every run and writes a fresh `..._ACCESS_TOKEN` + `..._INSTANCE_URL` into `$GITHUB_ENV`. |
| Pipedrive    | `PIPEDRIVE_SANDBOX_ACCESS_TOKEN` *or* `PIPEDRIVE_SANDBOX_API_TOKEN` (optional `PIPEDRIVE_SANDBOX_COMPANY_DOMAIN`) + at least one of `..._DELETED_PERSON_ID` / `..._DELETED_ORG_ID` / `..._DELETED_DEAL_ID` | Same — personal API tokens never auto-expire.                                                                                                                                                                                              |
| Zoho         | `ZOHO_SANDBOX_ACCESS_TOKEN`, `ZOHO_SANDBOX_API_DOMAIN` + at least one of `..._DELETED_CONTACT_ID` / `..._DELETED_ACCOUNT_ID` / `..._DELETED_DEAL_ID`        | `ZOHO_SANDBOX_REFRESH_TOKEN`, `ZOHO_SANDBOX_CLIENT_ID`, `ZOHO_SANDBOX_CLIENT_SECRET` (optional `ZOHO_SANDBOX_ACCOUNTS_URL`). CI runs the refresh-token flow on every run and writes a fresh `..._ACCESS_TOKEN` + `..._API_DOMAIN` into `$GITHUB_ENV`. |

Tokens supplied directly to the test must be long-lived enough for the
run — the integration suite intentionally does not perform OAuth refresh
(no `token_expires_at` is set on the synthetic config), so a stale token
will surface as a non-stale 401 and the test will fail loudly rather than
silently rotating credentials. The CI workflow's per-run mint steps for
Salesforce + Zoho are what keep that contract honest under a daily cron.

By default (only the env vars above set) the suite uses the supplied
sandbox `access_token` directly and does not perform OAuth refresh —
no `token_expires_at` is stamped on the synthetic config. That keeps the
default safe (a stale token surfaces as a hard failure rather than
silently masking a broken validator), but it also means the test starts
failing the moment the sandbox token expires (HubSpot / Salesforce:
~hours, Zoho: ~1h).

### Optional: auto-refresh sandbox access tokens

To keep CI green across token expiry without a human babysitting secret
rotations, additionally set the per-provider refresh token below. When
the suite sees the refresh token *and* the production OAuth client
credentials (the same env vars `tokenRefresh.ts` reads in production),
it stamps a stale `token_expires_at` on the synthetic config so the
validator's internal `ensureFreshOAuthToken` call exchanges the refresh
token for a fresh access token via the production refresh path before
hitting the validator. The persistence side of that refresh is stubbed
out in the test so the rotated credentials are never written back to the
platform DB against the synthetic `tenant-integration-test` row.

| Provider     | Optional refresh-grant env vars                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| HubSpot      | `HUBSPOT_SANDBOX_REFRESH_TOKEN`, `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`                                                                |
| Salesforce   | `SALESFORCE_SANDBOX_REFRESH_TOKEN`, `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET` (and optional `SALESFORCE_LOGIN_URL` for sandbox `https://test.salesforce.com`) |
| Pipedrive    | `PIPEDRIVE_SANDBOX_ACCESS_TOKEN` (must be the OAuth access token, not `..._API_TOKEN`) + `PIPEDRIVE_SANDBOX_REFRESH_TOKEN`, `PIPEDRIVE_CLIENT_ID`, `PIPEDRIVE_CLIENT_SECRET` |
| Zoho         | `ZOHO_SANDBOX_REFRESH_TOKEN`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` (and optional `ZOHO_SANDBOX_ACCOUNTS_SERVER` to pin the regional accounts host, e.g. `https://accounts.zoho.eu`) |

If the refresh-grant env vars are absent, the suite falls back to the
default behaviour and uses the raw sandbox `access_token` as before.
Pipedrive's API-token mode (`PIPEDRIVE_SANDBOX_API_TOKEN`) is not OAuth
and is unaffected by these refresh vars.

### Wiring it into CI

This is automated via the
[`CRM cached-identity validators (live sandbox drift)`](../../../../.github/workflows/crm-cached-identity-validators.yml)
GitHub Actions workflow. It runs the integration suite:

- **Daily** at 04:23 UTC, against whichever providers have their secrets
  configured at the time.
- **On push to `main`** when any of the per-provider adapters, the
  validator file pair, the connector types, or the workflow itself
  changes.
- **On manual `workflow_dispatch`**, for re-checking immediately after a
  token rotation.

The job posts a "which providers will run" table to the run summary so
operators can see at a glance which secrets it picked up. Each provider's
block is independent — you can ship one provider at a time as sandboxes
get provisioned without breaking the build for the others. A post-run
step emits a `::warning::` annotation when zero blocks ran, which keeps
the workflow green during the initial provisioning phase while still
making "no providers wired" visible at a glance on every run; once the
first sandbox is provisioned, vitest itself fails the job on real test
failures or upstream drift.

On failure the workflow opens (or updates) a single deduplicated GitHub
tracking issue labelled `crm-cached-identity-drift`, with a first-responder
checklist, the provider pre-flight table, the vitest JSON summary, and a
link back to the run. The label is the on-call routing key — subscribing
the integrations on-call to issues with that label is what turns a daily
red checkmark into an actual page. When a subsequent run comes back green
the tracking issue is auto-closed (with an audit-trail comment linking to
the run that verified the fix), so on-call isn't left chasing
already-resolved alerts.

Provisioning each sandbox, producing the hard-deleted fixture records,
storing the resulting secrets, and rotating before token expiry is
documented in detail in the runbook
[`docs/runbooks/crm-sandbox-credentials.md`](../../../../docs/runbooks/crm-sandbox-credentials.md).
Run the suite locally the same way the CI step does — export the env
vars listed above into your shell and:

```sh
npx vitest run platform/integrations/connectors/adapters/validateCachedIdentity.integration.test.ts
```
