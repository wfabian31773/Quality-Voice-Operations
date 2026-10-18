# Use-case templates

**Status:** Canonical for shop GTM  
**Source:** [Tools spec](./tools-spec.md) §7  
**Related:** [ADR-001](./adr-001-actions-only.md)

Customers do not build agents. QVO configures each business's agent from a **use-case template**. A template is a versioned config in `platform/templates/use-cases/<id>.ts`. It holds:

- **enabled actions** (only these become agent tools);
- **required setup** (what onboarding must collect);
- intake schemas;
- greeting and disclosure;
- policies (transfer hours, urgent keywords, SLA text);
- the scenario-pack IDs that must pass before go-live.

A business can enable one tool or all of them; the template sets the defaults.

**Runtime phrasing templates (RT-08):** the voice side of a vertical lives in `platform/agent-templates/<vertical>/` as a versioned agent template (first: `barbershop@1`). It holds the persona and the EN/ES phrasing for every `askId` the contracts in `platform/callcore/contracts` return. After a booking, move or cancellation it wraps the commit's own server-worded `readback` (one `{{readback}}` placeholder; the template formats no date, time or barber) and, while SMS is off, says a text will follow once texting is enabled. Booking numbers are never spoken. The shared template types live in `platform/agent-templates/shared/`.

**Composer (RT-09):** `platform/agent-runtime/composer` compiles an agent from a template, its contracts and the business's settings: the tools are exactly the platform actions the template's contracts name (plus the runtime's clock and language tools, no library tools), and the prompt is the persona in the call's language, the business's own details and the caller-ID line. It runs on live calls only for an agent of type `barbershop` whose `agents.metadata` has `"runtime": "composer"`; every other agent, and a barbershop agent without that value, loads exactly as before. Contract tool calls run through `server/voice-gateway/services/contractToolBridge.ts` (`runAction` as the agent, inside the invariant checker).

**Before the switch goes on (RT-14 prereq):** only QVO platform staff can set, change or clear `metadata.runtime` (`server/admin-api/services/agentRuntimeFlag.ts`; a tenant edit gets 403, and a tenant metadata edit that leaves it out keeps it). Contract tool calls get the same `tool_invocations` rows, call events and metering as every other tool (`toolBookkeeping.ts`). The model never sees an internal id: bookings, staff and services go out as call-scoped handles (`booking-1`) and come back as the real ids; hold and ticket ids are dropped. A timed-out booking, move or cancellation is never described as failed: she says she can't confirm it yet, that the shop will follow up (and a text will follow once texting is enabled), and offers a message.

**This week:** barbershop and nail salon ship. The other rows are specified only (contract now; build later). Product direction: small businesses of 5–20 people, **no healthcare**.

## Matrix

| Template | Scheduling | SMS | Tickets | Dispatch | Orders | Required setup | Template-specific rules | Ships |
|---|---|---|---|---|---|---|---|---|
| **Barbershop** | ✅ core | ✅ confirmations, reminders, missed-call text-back | ✅ messages/callbacks | — | — | Services (duration/price), barbers + who does what, hours, transfer number | "Anyone" defaults to first available; walk-in questions get the current wait = "call or come by" (no queue v1); cut + beard combos | **This week** |
| **Nail salon** | ✅ core + multi-service | ✅ | ✅ | — | — | As above + service add-ons, processing time (wk 2), group bookings (wk 3) | Gel removal add-on prompts; "can I get two chairs at once" → ticket until group bookings ship; Spanish/Vietnamese language option where supported | **This week** |
| **Home-service dispatch** (HVAC, plumbing, cleaning) | (windows via dispatch) | ✅ on-my-way/ETA | ✅ quotes, complaints | ✅ core | — | Service area (zips), job types + skills, techs, on-call rota, emergency script | Windows only; safety script for gas/flooding; never price unless flat-rate data exists | Specified only (week 2) |
| **Real estate** (small brokerage/team) | ✅ showings (agent = provider, property = resource) | ✅ | ✅ intake: buyer/seller/renter, property, budget, pre-approval yes/no, timeline | — | — | Agents, listings feed or a manual property list, showing rules | Fair-housing-safe language; no opinions on price/value; showing booked only for listed properties; lead routed to the listing agent | Specified only (week 3, after vertical-2 choice) |
| **Restaurant** (takeout) | (optional: reservations later) | ✅ order-ready | ✅ catering/large orders | — | ✅ core | Menu + modifiers, hours/dayparts, prep time, throttle, tax rate | Full readback with total; allergens only from data; catering > threshold → ticket | Specified only (week 2–3) |
| **Law office** (≤ 20 people) | ✅ consultations | ✅ (confirmations only) | ✅ core: intake with matter type, opposing-party names for conflict check, urgency/deadline | — | — | Practice areas, consult types/durations, attorneys, intake questions, conflict-check routing | Never legal advice; "no attorney-client relationship yet" disclosure; deadline keywords → urgent; record-retention settings | Specified only (week 3) |

## MCP surface (Wayne's bots)

From spec §7. All write tools need the `qvo:admin` scope. Phone test runs need Wayne's approval flag, because they place real calls.

- `qvo.list_templates`
- `qvo.provision_business({template, businessInfo})` (dryRun default)
- `qvo.apply_template({tenantId, templateId, overrides})`
- `qvo.validate_setup({tenantId})` (lists missing required fields)
- `qvo.run_test_calls({tenantId, scenarioPack, mode:'text'|'phone'})`
- `qvo.get_call_reviews({tenantId, since})`
- `qvo.get_quality_report({tenantId})`
