# 07 — Competitive Analysis

QVO positioned against the 2025 voice-AI / front-office automation field. This is **not** a marketing brief; it is an engineering-led look at where the product is differentiated, where it is at parity, and where it is materially behind.

---

## Reference set

- **Voice-AI agent platforms:** Bland AI, Vapi, Synthflow, Retell AI, ElevenLabs Conversational AI, Sindarin / SoundHound Smart Answering.
- **Vertical / enterprise voice:** PolyAI, Cresta, Five9 IVA, Genesys AI, ServiceNow Now Assist, Talkdesk Autopilot.
- **AI BPO / answering services:** Numa, Goodcall, Smith.ai, Ruby Receptionists, Replicant.
- **Field-service-aware competitors (because QVO ships dispatch + scheduling):** Service Fusion, Housecall Pro, ServiceTitan AI Voice, Workiz Genius.
- **Front-office automation incumbents:** HubSpot Service Hub, Zendesk AI, Intercom Fin, Freshworks Freddy.

---

## Where QVO is differentiated

### C-01 — Three-console isolation (tenant / platform admin / operations) is rare in this segment
- Most competitors collapse "operations" and "admin" into one console (or ship admin only to internal staff via a separate app).
- QVO's clean split is enterprise-friendly and lines up with SOC 2 separation of duties — but the user-facing pitch is missing on the marketing site.

### C-02 — Federated ingest (`/ingest/*`) lets external voice agents post into QVO
- Competitors lock you into their voice runtime. QVO accepts third-party calls and still drives downstream tooling (CRM sync, ticket creation, dispatch, billing).
- This is a strong moat for partners (BPOs, white-label resellers, in-house IT teams who already run their own gateway).

### C-03 — Mini-systems shipped together (Tickets + Dispatch + Scheduling + SMS Inbox) inside one tenant
- Most voice-AI competitors push you to integrate with HubSpot/Zendesk/Salesforce. QVO ships the front-office ops surface itself — a smaller customer can live in QVO end-to-end without a separate ticketing license.
- The risk is that any one of those systems is competing with a category leader (Zendesk for tickets, ServiceTitan for dispatch). Today QVO's mini-systems are functional but not best-in-class on any single axis.

### C-04 — Marketplace with paid templates, revenue share, post-install setup, and customization-schema
- This is the most enterprise-feel piece of the platform. Bland and Vapi have starter templates; nobody else offers a true marketplace with revenue share, install lifecycle, and certified-reviewer flow.

### C-05 — Global Intelligence Network (GIN) — federated benchmarks across tenants
- Opt-in cross-tenant analytics (anonymous benchmarks, prompt patterns, recommendations).
- Truly novel; nobody else in the agent-voice space ships this. Marketing site barely mentions it (covered as a follow-up in #221).

### C-06 — Digital Twin + Evolution Engine
- Simulation of a tenant's agent against a population of synthetic callers, plus an "evolution" loop that rewrites prompts.
- Vapi has "test cases"; ElevenLabs has "evals". Neither has a closed-loop evolution that proposes, A/B tests, and promotes a new prompt automatically. Differentiator if the product story is told loudly.

### C-07 — Native multi-vertical agents (Azul Vision)
- Demonstrates that QVO can host third-party verticalised agents — a partner play similar to Salesforce's AppExchange but for voice.
- The story is weak on the marketing site (no public mention of Azul Vision in the audited pages).

---

## Where QVO is at parity

### C-08 — Voice quality, latency, languages
- All major competitors have moved to OpenAI Realtime + ElevenLabs / Cartesia voices. Sub-second latency is table stakes.
- QVO's voice gateway uses OpenAI Realtime; latency is acceptable but not measurably better than peers.

### C-09 — CRM connectors (HubSpot, Salesforce, Pipedrive)
- Parity. Nothing missing; nothing extra.

### C-10 — Stripe billing, usage metering, trial guardrails
- Parity. Most competitors have caught up to Stripe Metered Billing in 2025.

### C-11 — Visual workflow builder (`AgentBuilder`)
- Parity with Vapi's flow editor, ahead of Bland's prompt-only UX, behind Synthflow's polish.

### C-12 — Public marketing site (Landing, Features, Pricing, Use Cases, Industries, Case Studies, Docs, Blog)
- Parity in surface area. Bland AI and Vapi both ship comparable site bundles.

---

## Where QVO is behind

### C-13 — Out-of-the-box analytics dashboards
- HubSpot Service Hub, Zendesk Explore, Intercom — all ship rich pre-built dashboards.
- QVO `/analytics` is functional but generic; pre-built dashboards per vertical (healthcare, dental, field-service, real-estate) would close the gap.

### C-14 — Mobile app
- Smith.ai, Ruby, ServiceTitan all have iOS/Android apps for receptionists and dispatchers.
- QVO has none. The dispatcher persona regularly needs a phone app to accept jobs en-route.

### C-15 — Quality of the empty-state experience
- New tenants land in 70+ pages with no shared empty-state language (B-15, U-03). Best-in-class competitors (Linear, Notion) treat empty states as a guided tour.

### C-16 — Agent prompt library and starter templates
- Vapi and Synthflow have hundreds of prompt patterns indexable from the agent builder.
- QVO has the Marketplace and a `prompt-library` endpoint per template, but no first-party prompt library cross-template.

### C-17 — Discoverability of advanced features (Autopilot, Digital Twin, Evolution Engine, GIN)
- These are crown-jewel differentiators but they are buried, broken, or under-marketed:
  - Autopilot page is an orphan (B-01).
  - Digital Twin and Evolution Engine are lab-only — no in-product walkthrough.
  - GIN benefits are not explained on the public site (#221).

### C-18 — SOC 2 / HIPAA badges on the marketing site
- Competitors prominently display SOC 2 Type II and HIPAA badges. QVO has the underlying compliance posture (RLS, audit log, BAA-relevant logging) but does not display badges and the badges + badge-claim flow is missing.

### C-19 — Pricing page transparency
- Vapi and Bland have per-minute pricing visible. QVO's `Pricing.tsx` is more "starter / pro / enterprise" — buyers comparing per-minute economics cannot do so quickly.

### C-20 — Outbound campaign sophistication
- Five9, Talkdesk, Replicant ship outbound dialers with predictive dialing, brand-spoofing-protection, STIR/SHAKEN attestation. QVO's outbound is straight Twilio dial-out per contact.

### C-21 — Multi-language voice agents
- Vapi, ElevenLabs, PolyAI heavily promote multi-language. QVO's runtime supports it (OpenAI Realtime is multilingual) but the marketing site does not list languages, and the `AgentBuilder` UI does not let you configure language preference.

### C-22 — Real-time call coaching for human agents
- Cresta, Talkdesk Copilot, Salesforce Service Cloud Voice ship "AI assistant for the human rep on the call". QVO assumes the AI **is** the agent. Not ideal for hybrid teams that still want humans on complex calls.

---

## Strategic implications (referenced by 08)

1. **Lean into differentiation:** Federated ingest, three-console isolation, mini-systems package, Marketplace + GIN — marketing-light areas that move enterprise deals.
2. **Close the table-stakes gaps:** Per-vertical pre-built dashboards, visible compliance badges, mobile app for dispatch.
3. **Fix the discoverability of the crown jewels:** Autopilot, Digital Twin, Evolution Engine need an in-product walkthrough.
4. **Pricing clarity:** Add per-minute economics to the pricing page; competitors win deals on this even when more expensive overall.
