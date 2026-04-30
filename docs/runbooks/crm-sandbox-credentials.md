# Runbook — Provisioning & rotating CRM sandbox credentials for the cached-identity validator suite

Audience: Platform / integrations on-call
Surface: GitHub Actions workflow `CRM cached-identity validators (live sandbox drift)` (`.github/workflows/crm-cached-identity-validators.yml`)
Code under test: `platform/integrations/connectors/adapters/validateCachedIdentity.integration.test.ts`
Per-provider env-var matrix: [`platform/integrations/connectors/adapters/README.md`](../../platform/integrations/connectors/adapters/README.md#per-provider-env-vars)

## TL;DR

The CI job `CRM cached-identity validators (live sandbox drift)` runs the
opt-in `validateCachedIdentity.integration.test.ts` suite against the real
HubSpot, Salesforce, Pipedrive, and Zoho sandboxes daily (and on every push
to `main` that touches the validators). Each provider's block is
`describe.skipIf`-gated on a sandbox token + at least one **hard-deleted**
fixture record ID. This runbook is the operations playbook for:

- Standing up the per-provider sandbox the first time.
- Producing the hard-deleted fixture record(s) the validator probes against.
- Storing the resulting secrets in GitHub Actions.
- Rotating each token before it expires (so the daily drift check doesn't
  start failing on a stale 401 instead of a real upstream change).

> **Why it matters.** The `CrmCallerIdentityRevalidationScheduler` uses these
> validators to scrub cached CRM IDs whose upstream record has been deleted.
> If a provider silently changes the way it reports a missing record (HubSpot
> moving the 404 body shape, Zoho returning a 200 wrapper around a missing
> record, Salesforce key-prefix changes) and our parser stops recognising
> "deleted" as deleted, the scheduler stops cleaning up — and tenants start
> seeing reactivated stale contact links in their pipelines. The unit suite
> in `validateCachedIdentity.test.ts` catches *our* parsing bugs against
> mocked responses; this live suite catches *upstream's* shape changes.

## Required GitHub Actions secrets (at a glance)

Add these in **Settings → Secrets and variables → Actions → Repository
secrets**. Each block in the test file is independent — you can ship one
provider at a time as sandboxes get provisioned without breaking the build
for the others.

HubSpot and Pipedrive issue tokens that don't auto-expire, so we store the
access token directly as a CI secret. **Salesforce and Zoho tokens do
expire**, so the workflow stores their long-lived credentials (refresh
token / client + integration user) as secrets and **mints a fresh access
token at the start of every CI run**. The vitest step then sees a token
that is at most a few seconds old, regardless of how long ago the secret
was last rotated.

| Provider     | Required CI secrets                                                                                                                                                                                                                                          | At least one of                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HubSpot      | `HUBSPOT_SANDBOX_ACCESS_TOKEN` (private-app token; no expiry)                                                                                                                                                                                                | `HUBSPOT_SANDBOX_DELETED_CONTACT_ID`, `HUBSPOT_SANDBOX_DELETED_COMPANY_ID`, `HUBSPOT_SANDBOX_DELETED_DEAL_ID`                                            |
| Salesforce   | `SALESFORCE_SANDBOX_CLIENT_ID`, `SALESFORCE_SANDBOX_CLIENT_SECRET`, `SALESFORCE_SANDBOX_USERNAME`, `SALESFORCE_SANDBOX_PASSWORD`, `SALESFORCE_SANDBOX_SECURITY_TOKEN` (optional `SALESFORCE_SANDBOX_LOGIN_URL`, defaults to `https://test.salesforce.com`)    | `SALESFORCE_SANDBOX_DELETED_CONTACT_ID` (`003…`), `SALESFORCE_SANDBOX_DELETED_ACCOUNT_ID` (`001…`), `SALESFORCE_SANDBOX_DELETED_OPPORTUNITY_ID` (`006…`) |
| Pipedrive    | `PIPEDRIVE_SANDBOX_ACCESS_TOKEN` *or* `PIPEDRIVE_SANDBOX_API_TOKEN` (optional `PIPEDRIVE_SANDBOX_COMPANY_DOMAIN`)                                                                                                                                            | `PIPEDRIVE_SANDBOX_DELETED_PERSON_ID`, `PIPEDRIVE_SANDBOX_DELETED_ORG_ID`, `PIPEDRIVE_SANDBOX_DELETED_DEAL_ID`                                           |
| Zoho         | `ZOHO_SANDBOX_REFRESH_TOKEN`, `ZOHO_SANDBOX_CLIENT_ID`, `ZOHO_SANDBOX_CLIENT_SECRET` (optional `ZOHO_SANDBOX_ACCOUNTS_URL`, defaults to `https://accounts.zoho.com`)                                                                                         | `ZOHO_SANDBOX_DELETED_CONTACT_ID`, `ZOHO_SANDBOX_DELETED_ACCOUNT_ID`, `ZOHO_SANDBOX_DELETED_DEAL_ID`                                                     |

The integration suite **intentionally does not perform OAuth refresh
inside the validator** (no `token_expires_at` is set on the synthetic
config), so a stale token surfaces as a non-stale 401 and the test fails
loudly rather than silently rotating credentials. The workflow's
per-run mint steps are what keep the Salesforce and Zoho tokens fresh —
when those mint steps fail, that itself is a clear signal in the run log
that the long-lived credentials need attention. Rotation cadence per
provider is in [Rotation cadence](#rotation-cadence) below.

---

## HubSpot

### 1. Provision the sandbox

Use HubSpot's **Standard CRM Sandbox** under your team's developer/Sales Hub
account: **Settings → Account Setup → Sandboxes → Create sandbox**. A
sandbox automatically inherits the parent account's pipelines and property
schema, which keeps the validator's read shape identical to production.

If your org has previously stood one up, re-use it — there's no benefit to a
fresh sandbox per CI rotation.

### 2. Mint a long-lived access token

Sandboxes support **private apps**, which issue non-expiring tokens (the
right primitive for unattended CI):

1. In the sandbox: **Settings → Integrations → Private Apps → Create a
   private app**. Name it `voice-ai-hub – cached-identity validator (CI)`.
2. On the **Scopes** tab grant **read-only** access to:
   - `crm.objects.contacts.read`
   - `crm.objects.companies.read`
   - `crm.objects.deals.read`
3. Click **Create app**, then **Continue creating**. Copy the access token —
   this is `HUBSPOT_SANDBOX_ACCESS_TOKEN`. **HubSpot only shows the token
   once.** If you lose it, click **Rotate** on the same private app to mint
   a replacement.

### 3. Produce the hard-deleted fixture record(s)

For each slot you want to cover (contact / company / deal):

1. Create a fixture record in the sandbox UI. Use a name that makes its
   purpose obvious to the next on-call (e.g. contact
   `validator-fixture@example.invalid`, company `Validator Fixture Co`,
   deal `Validator Fixture Deal`).
2. Note the numeric ID from the record's URL
   (`/contacts/<portalId>/contact/<id>` etc.). That's what you'll store as
   the env var.
3. Delete the record from the UI. HubSpot's REST API starts returning
   `404 Not Found` immediately — there is no recycle bin to purge.
4. Confirm with `curl`:
   ```sh
   curl -sS -o /dev/null -w "%{http_code}\n" \
     -H "Authorization: Bearer $HUBSPOT_SANDBOX_ACCESS_TOKEN" \
     https://api.hubapi.com/crm/v3/objects/contacts/<id>
   # expect: 404
   ```

### 4. Store secrets

Add `HUBSPOT_SANDBOX_ACCESS_TOKEN` and at least one of
`HUBSPOT_SANDBOX_DELETED_CONTACT_ID` / `..._DELETED_COMPANY_ID` /
`..._DELETED_DEAL_ID` in repo Actions secrets.

### 5. Rotation

Private-app tokens do not expire automatically, but rotate annually anyway
(see [Rotation cadence](#rotation-cadence)). HubSpot's **Rotate** button
on the private-app page issues a new token with the same scopes — paste it
into the GitHub secret and trigger the workflow manually to confirm green.

---

## Salesforce

### 1. Provision the sandbox

Use a **Developer Edition** org or a **Developer Sandbox** off your team's
production org. Either works for the validator (the test only needs
read-and-confirm-deleted access). For Developer Sandboxes:

- **Setup → Environments → Sandboxes → New Sandbox**, type: Developer.
- Activation typically takes minutes. Note the **My Domain URL** of the new
  org (`https://<mydomain>--<sandbox>.sandbox.my.salesforce.com`) — that's
  what you'll store as `SALESFORCE_SANDBOX_INSTANCE_URL`.

### 2. Set up the OAuth username–password flow (CI mints per run)

Salesforce access tokens follow the connected-app session policy of the
issuing user — typically a few hours, well shorter than the daily cron
cadence. To keep the validator green without any manual rotation, the CI
workflow stores the OAuth **app credentials + integration user** as
secrets and re-mints a fresh access token at the start of every run via
the **OAuth 2.0 username–password flow**.

1. **Setup → App Manager → New Connected App**. Name it
   `voice-ai-hub Cached Identity Validator (CI)`. Enable OAuth, callback
   `http://localhost/callback`, scopes:
   `Manage user data via APIs (api)` + `Perform requests at any time
   (refresh_token, offline_access)`.
2. Save, wait ~10 minutes for OAuth keys to propagate, then copy the
   Consumer Key → `SALESFORCE_SANDBOX_CLIENT_ID` and Consumer Secret →
   `SALESFORCE_SANDBOX_CLIENT_SECRET`.
3. Create a dedicated integration user in the sandbox (e.g.
   `cachedid-ci@example.com.<sandbox>`), reset their password, and capture
   the security token from **Settings → My Personal Information → Reset My
   Security Token** (delivered by email to the user). Store as
   `SALESFORCE_SANDBOX_USERNAME`, `SALESFORCE_SANDBOX_PASSWORD`,
   `SALESFORCE_SANDBOX_SECURITY_TOKEN`.
4. If the sandbox isn't on the default `https://test.salesforce.com`
   login endpoint (e.g. an enhanced-domain sandbox), set
   `SALESFORCE_SANDBOX_LOGIN_URL` to the correct login URL.

The workflow's "Mint Salesforce sandbox access token" step then runs:

```sh
curl -sS -X POST "$LOGIN_URL/services/oauth2/token" \
  --data-urlencode "grant_type=password" \
  --data-urlencode "client_id=$SALESFORCE_SANDBOX_CLIENT_ID" \
  --data-urlencode "client_secret=$SALESFORCE_SANDBOX_CLIENT_SECRET" \
  --data-urlencode "username=$SALESFORCE_SANDBOX_USERNAME" \
  --data-urlencode "password=${SALESFORCE_SANDBOX_PASSWORD}${SALESFORCE_SANDBOX_SECURITY_TOKEN}"
# response: { "access_token": "...", "instance_url": "https://...", ... }
```

…and exports `SALESFORCE_SANDBOX_ACCESS_TOKEN` + `SALESFORCE_SANDBOX_INSTANCE_URL`
into `$GITHUB_ENV` for the vitest step. Run the same `curl` locally to
sanity-check your secret values before pushing them.

### 3. Produce the hard-deleted fixture record(s)

Salesforce is the only provider here that maintains a Recycle Bin — a
soft-deleted record still returns `200 OK` from the REST API for ~15 days
unless purged. The validator only treats `ENTITY_IS_DELETED` as deletion
evidence, so **the Recycle Bin must be emptied for that fixture** before
the secret is wired up.

For each of Contact / Account / Opportunity you want to cover:

1. Create a fixture in the sandbox (Contact `Validator Fixture`, Account
   `Validator Fixture Co`, Opportunity `Validator Fixture Deal`).
2. Note the 15- or 18-character ID. **Verify the key prefix matches the
   slot:** Contact = `003…`, Account = `001…`, Opportunity = `006…`. The
   validator's slot dispatcher uses the prefix; the test will fail loudly
   on mismatch.
3. Delete the record (UI: Delete) — it goes to the Recycle Bin.
4. **Empty the Recycle Bin for that record:** in the App Launcher search
   for **Recycle Bin → Org Recycle Bin**, select the fixture, and click
   **Delete** (or run, as the integration user, the SOQL
   `DELETE [SELECT Id FROM Contact WHERE IsDeleted = TRUE AND Id =
   '<id>'] ALL ROWS` via Workbench → "Hard Delete" toolbox option). Now the
   API returns `ENTITY_IS_DELETED` instead of a soft-deleted body.
5. Confirm with `curl`:
   ```sh
   curl -sS \
     -H "Authorization: Bearer $SALESFORCE_SANDBOX_ACCESS_TOKEN" \
     "$SALESFORCE_SANDBOX_INSTANCE_URL/services/data/v60.0/sobjects/Contact/<id>"
   # expect: HTTP 404 with body containing "errorCode":"ENTITY_IS_DELETED"
   ```

### 4. Store secrets

Add the five required app/user secrets from step 2 above, optionally
`SALESFORCE_SANDBOX_LOGIN_URL`, and at least one of
`SALESFORCE_SANDBOX_DELETED_CONTACT_ID` / `..._DELETED_ACCOUNT_ID` /
`..._DELETED_OPPORTUNITY_ID`. The IDs you store must match their slot's
key prefix or the suite throws before running.

### 5. Rotation

Because the workflow mints a fresh access token at the start of every
run, there's nothing to rotate on a schedule — the long-lived inputs
only need attention when one of them is invalidated upstream:

- **Integration user's password resets** (Salesforce forces a reset every
  90 days unless you've set the profile's `PasswordPolicies.expiration` to
  "Never"): update `SALESFORCE_SANDBOX_PASSWORD` and (because the security
  token also rotates on every password reset) `SALESFORCE_SANDBOX_SECURITY_TOKEN`.
- **Connected app gets revoked** (admin action, or org-wide rotation):
  update `SALESFORCE_SANDBOX_CLIENT_ID` + `SALESFORCE_SANDBOX_CLIENT_SECRET`.
- **Sandbox is refreshed from production** (which can change the My Domain
  / login URL): update `SALESFORCE_SANDBOX_LOGIN_URL` if you set it.

If the daily run starts failing on the "Mint Salesforce sandbox access
token" step, that's the signal one of the above happened.

---

## Pipedrive

### 1. Provision the sandbox

Pipedrive offers free **Sandbox accounts** to registered developers. From
your developer account, **Tools and apps → App development → Sandbox →
Create sandbox**. The sandbox's URL is
`https://<company>.pipedrive.com` — note the `<company>` slug, that's
`PIPEDRIVE_SANDBOX_COMPANY_DOMAIN` if you want to scope the API base.

### 2. Mint a long-lived access token

Two options — pick whichever is easier for your team:

**(a) Personal API token** (simplest, never expires until revoked):

1. Sign in to the sandbox as a fixture user (e.g. `cachedid-ci@example.invalid`).
2. **Settings → Personal preferences → API**, copy the API token. Store as
   `PIPEDRIVE_SANDBOX_API_TOKEN`.

**(b) OAuth access token** (matches what the production adapter holds):

1. Register the OAuth app under your developer account, run the
   authorisation flow against the sandbox user, exchange the code for an
   access + refresh token. Store the access token as
   `PIPEDRIVE_SANDBOX_ACCESS_TOKEN`.

Either token alone is enough — the test wires whichever is set into the
synthetic `ConnectorConfig.credentials`.

### 3. Produce the hard-deleted fixture record(s)

Pipedrive supports **hard delete** through the API
(`DELETE /v1/persons/{id}`, `…/organizations/{id}`, `…/deals/{id}`) — there
is no recycle bin. For each slot:

1. Create a fixture in the UI (Person `Validator Fixture`, Organization
   `Validator Fixture Co`, Deal `Validator Fixture Deal`).
2. Note the numeric ID.
3. Delete with the API or UI:
   ```sh
   curl -sS -X DELETE \
     "https://api.pipedrive.com/v1/persons/<id>?api_token=$PIPEDRIVE_SANDBOX_API_TOKEN"
   ```
4. Confirm:
   ```sh
   curl -sS -o /dev/null -w "%{http_code}\n" \
     "https://api.pipedrive.com/v1/persons/<id>?api_token=$PIPEDRIVE_SANDBOX_API_TOKEN"
   # expect: 404 (or success=false body, which the validator also recognises)
   ```

### 4. Store secrets

Add `PIPEDRIVE_SANDBOX_ACCESS_TOKEN` *or* `PIPEDRIVE_SANDBOX_API_TOKEN`
(at least one), optionally `PIPEDRIVE_SANDBOX_COMPANY_DOMAIN`, and at least
one of `PIPEDRIVE_SANDBOX_DELETED_PERSON_ID` / `..._DELETED_ORG_ID` /
`..._DELETED_DEAL_ID`.

### 5. Rotation

Personal API tokens do not auto-expire; rotate annually. To rotate, click
**Reset API token** in the sandbox user's Personal Preferences → API panel
and paste the new value into the GitHub secret. For OAuth, mint a fresh
access token via the standard refresh-token flow and update the secret.

---

## Zoho

### 1. Provision the sandbox

Zoho CRM **Sandbox** is part of the Enterprise/Ultimate tier. From the
parent CRM org: **Setup → Developer Hub → Sandbox → Create**. After the
sandbox finishes provisioning, log in to it and identify the data centre
the org lives in (US `https://www.zohoapis.com`, EU
`https://www.zohoapis.eu`, IN `https://www.zohoapis.in`, AU
`https://www.zohoapis.com.au`, JP `https://www.zohoapis.jp`). That URL is
`ZOHO_SANDBOX_API_DOMAIN`.

### 2. Mint a refresh token (CI mints the access token per run)

Zoho access tokens expire after ~1 hour, so a static `ACCESS_TOKEN`
secret cannot survive a daily cron. Instead, mint a long-lived refresh
token once, store it (along with the OAuth app credentials) as CI
secrets, and let the workflow re-mint a fresh access token at the start
of every run.

1. Visit https://api-console.zoho.com (matching the data centre) → **Self
   Client → Create**. Scopes:
   `ZohoCRM.modules.contacts.READ,ZohoCRM.modules.accounts.READ,ZohoCRM.modules.deals.READ`.
2. **Generate Code** for the sandbox user, copy the resulting authorisation
   code (10-minute expiry).
3. Exchange the code for a refresh + access token:
   ```sh
   curl -sS https://accounts.zoho.com/oauth/v2/token \
     -d grant_type=authorization_code \
     -d client_id=$CLIENT_ID \
     -d client_secret=$CLIENT_SECRET \
     -d code=$AUTH_CODE
   # response: { "access_token": "...", "refresh_token": "...", "api_domain": "https://www.zohoapis.com", ... }
   ```
4. Store the **refresh token** as `ZOHO_SANDBOX_REFRESH_TOKEN`, and the
   OAuth app credentials as `ZOHO_SANDBOX_CLIENT_ID` /
   `ZOHO_SANDBOX_CLIENT_SECRET`. If your sandbox is not on the default
   `accounts.zoho.com` data centre (e.g. EU / IN / AU / JP), also set
   `ZOHO_SANDBOX_ACCOUNTS_URL` (e.g. `https://accounts.zoho.eu`).

The workflow's "Mint Zoho sandbox access token" step then runs:

```sh
curl -sS -X POST "$ZOHO_SANDBOX_ACCOUNTS_URL/oauth/v2/token" \
  --data-urlencode "grant_type=refresh_token" \
  --data-urlencode "client_id=$ZOHO_SANDBOX_CLIENT_ID" \
  --data-urlencode "client_secret=$ZOHO_SANDBOX_CLIENT_SECRET" \
  --data-urlencode "refresh_token=$ZOHO_SANDBOX_REFRESH_TOKEN"
```

…and exports `ZOHO_SANDBOX_ACCESS_TOKEN` + `ZOHO_SANDBOX_API_DOMAIN`
(read out of the response payload) into `$GITHUB_ENV` for the vitest
step. The validator never sees a token older than the run that minted
it.

### 3. Produce the hard-deleted fixture record(s)

Zoho records soft-delete first (the API returns a 200 wrapper around the
deleted record for a window) and then transition to true 404 once purged
from the Recycle Bin. The validator parser already handles both shapes,
but to lock in the **hard-deleted** path:

1. Create a fixture in the sandbox UI (Contact `Validator Fixture`,
   Account `Validator Fixture Co`, Deal `Validator Fixture Deal`).
2. Note the record ID (long numeric string from the record URL).
3. Delete via UI → **Recycle Bin → Empty Recycle Bin** (or the API
   `DELETE /crm/v6/Contacts/<id>?wf_trigger=true` followed by
   `DELETE /crm/v6/Contacts/<id>/recyclebin`).
4. Confirm:
   ```sh
   curl -sS \
     -H "Authorization: Zoho-oauthtoken $ZOHO_SANDBOX_ACCESS_TOKEN" \
     "$ZOHO_SANDBOX_API_DOMAIN/crm/v6/Contacts/<id>"
   # expect: HTTP 404 with body { "code": "INVALID_DATA"|"RESOURCE_NOT_FOUND", ... }
   ```

### 4. Store secrets

Add `ZOHO_SANDBOX_REFRESH_TOKEN`, `ZOHO_SANDBOX_CLIENT_ID`,
`ZOHO_SANDBOX_CLIENT_SECRET`, optionally `ZOHO_SANDBOX_ACCOUNTS_URL`,
and at least one of `ZOHO_SANDBOX_DELETED_CONTACT_ID` /
`..._DELETED_ACCOUNT_ID` / `..._DELETED_DEAL_ID`.

### 5. Rotation

Because the workflow mints a fresh access token at the start of every
run, the 1-hour expiry never reaches CI. The long-lived inputs only
need attention when one of them is invalidated upstream:

- **Refresh token revoked** (Zoho admin action, or org-wide rotation):
  re-run the self-client authorisation flow in step 2 to mint a new
  refresh token and update `ZOHO_SANDBOX_REFRESH_TOKEN`. Refresh tokens
  in Zoho do not expire on their own; they only become invalid if
  explicitly revoked.
- **Self-client app deleted / re-created**: update
  `ZOHO_SANDBOX_CLIENT_ID` + `ZOHO_SANDBOX_CLIENT_SECRET`.

If the daily run starts failing on the "Mint Zoho sandbox access token"
step, that's the signal one of the above happened.

---

## Rotation cadence

| Provider     | What's stored in CI                                                     | Recommended proactive rotation                                                | Reactive triggers                                                                     |
| ------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| HubSpot      | Private-app token (no auto-expiry)                                      | Annually, plus immediately on staff turnover                                  | "Mint" step doesn't apply; vitest-side 401 → rotate per HubSpot §5                    |
| Salesforce   | App credentials + integration user (CI mints access token per run)      | Annually rotate the connected app's consumer secret                           | Integration-user password reset (every ~90d unless disabled), or revoked connected app |
| Pipedrive    | Personal API token (no auto-expiry)                                     | Annually, plus on fixture-user turnover                                       | "Mint" step doesn't apply; vitest-side 401 → rotate per Pipedrive §5                  |
| Zoho         | Refresh token + OAuth app (CI mints access token per run)               | None required — refresh tokens don't auto-expire                              | Refresh token revoked, or self-client app re-created                                  |

For the proactive rotations, set the recurring calendar invites against
the **platform on-call rota** calendar (not a single named owner) so
coverage doesn't break when someone goes on PTO. The invite description
should link to this runbook.

---

## CI failure triage

When the daily run reports a failure, work top-to-bottom — most failures
are a stale token, not a real upstream change.

### 1. Read the workflow's "Report which provider blocks will run" summary

The first step of the job posts a per-provider table to the run summary
showing which secrets it sees. If the failing provider's row says
`Will run? = no`, the secret is missing or empty — re-add it.

### 2. Reproduce locally

For HubSpot / Pipedrive (static tokens), export the same env vars the
workflow consumes from secrets:

```sh
export HUBSPOT_SANDBOX_ACCESS_TOKEN=...
export HUBSPOT_SANDBOX_DELETED_CONTACT_ID=...
npx vitest run \
  platform/integrations/connectors/adapters/validateCachedIdentity.integration.test.ts
```

For Salesforce / Zoho, run the same `curl` recipes the workflow's mint
steps run (in their respective §2 sections above) to get a fresh
`ACCESS_TOKEN` + `INSTANCE_URL` / `API_DOMAIN`, then export those into
your shell before running vitest. That keeps the local repro identical to
the CI flow.

### 3. Classify the failure

- **The "Mint Salesforce/Zoho sandbox access token" step itself failed**
  → the long-lived inputs are stale. See the provider's §5 for which
  secret to rotate.
- **HTTP 401 from the provider** in the vitest transcript → for HubSpot
  / Pipedrive, the static token was revoked; rotate per the provider's
  §5. (For Salesforce / Zoho this should be impossible because the mint
  step just succeeded; if it does happen, the connected app's session
  policy is shorter than the run duration — investigate and widen.)
- **The fixture record came back as alive** (`stale` does not contain
  the ID you supplied) → the fixture was reseeded or undeleted. Re-delete
  it per step 3 of the provider's section, or pick a different
  known-deleted ID and update the secret.
- **The validator returned a different shape than expected** (e.g. the
  test asserts `expected.contactId = ...` but `out.stale` is empty even
  though the API really did return 404) → this is the case the suite
  exists for. The provider has changed its missing-record response shape;
  open a ticket against `platform/integrations/connectors/adapters/<provider>.ts`
  and update the parser to match the new shape, then add a unit-test case
  in `validateCachedIdentity.test.ts` that locks in the new response.

### 4. Re-run

After fixing, **Run workflow** from the GitHub Actions UI to confirm the
job goes green without waiting for the next cron tick.

---

## Appendix — Why we don't share fixture sandboxes across other test suites

The validator suite is read-only and idempotent: it asks "is this ID
deleted?" against records we have explicitly hard-deleted. Other
integration tests we add later may want to write into the same sandbox
(e.g. exercising the `appointment.booked` auto-promote path). That's fine,
but **do not** reuse this suite's deleted-fixture IDs for write tests —
re-creating a record with the same ID is impossible in every CRM here, and
re-creating it with a *different* ID will silently invalidate the secret
without the suite noticing until the next cron tick. Use a separate
fixture-record namespace per test suite.
