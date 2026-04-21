import {
  Rocket, Bot, Network, Plug, Boxes, Key, AlertTriangle, CreditCard,
  type LucideIcon,
} from 'lucide-react';

export type DocCategorySlug =
  | 'getting-started'
  | 'agent-builder'
  | 'workflows'
  | 'integrations'
  | 'mini-systems'
  | 'api-reference'
  | 'troubleshooting'
  | 'billing';

export interface DocCategory {
  slug: DocCategorySlug;
  title: string;
  description: string;
  icon: LucideIcon;
}

export interface DocArticle {
  slug: string;
  category: DocCategorySlug;
  title: string;
  description: string;
  readTime: string;
  updated: string;
  body: DocBlock[];
}

export type DocBlock =
  | { type: 'p'; text: string }
  | { type: 'h2'; text: string }
  | { type: 'h3'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'code'; lang?: string; text: string }
  | { type: 'callout'; tone: 'info' | 'warn' | 'tip'; text: string }
  | { type: 'image'; src: string; alt: string; caption?: string }
  | { type: 'video'; provider: 'mp4' | 'youtube'; src: string; poster?: string; caption?: string; title?: string }
  | { type: 'common-issues'; items: { problem: string; fix: string }[] };

export const docCategories: DocCategory[] = [
  { slug: 'getting-started', title: 'Getting Started', description: 'Sign up, configure your tenant, and answer your first call.', icon: Rocket },
  { slug: 'agent-builder', title: 'Agent Builder', description: 'Design system prompts, voices, tools, and routing rules.', icon: Bot },
  { slug: 'workflows', title: 'Workflows', description: 'Compose multi-step call flows, escalations, and post-call automations.', icon: Network },
  { slug: 'integrations', title: 'Integrations', description: 'Connect QVO to HubSpot, Calendar, Slack, helpdesks, and webhooks.', icon: Plug },
  { slug: 'mini-systems', title: 'Mini Systems', description: 'SMS Inbox, Scheduling, Tickets, and Dispatch — the back-office tools.', icon: Boxes },
  { slug: 'api-reference', title: 'API Reference', description: 'Authenticate, hit endpoints, and subscribe to webhooks.', icon: Key },
  { slug: 'troubleshooting', title: 'Troubleshooting', description: 'Diagnose call quality, integration sync, and provisioning issues.', icon: AlertTriangle },
  { slug: 'billing', title: 'Billing & Plans', description: 'Plan tiers, usage, invoices, and budget controls.', icon: CreditCard },
];

const p = (text: string): DocBlock => ({ type: 'p', text });
const h2 = (text: string): DocBlock => ({ type: 'h2', text });
const h3 = (text: string): DocBlock => ({ type: 'h3', text });
const ul = (items: string[]): DocBlock => ({ type: 'ul', items });
const ol = (items: string[]): DocBlock => ({ type: 'ol', items });
const code = (text: string, lang = 'bash'): DocBlock => ({ type: 'code', text, lang });
const tip = (text: string): DocBlock => ({ type: 'callout', tone: 'tip', text });
const info = (text: string): DocBlock => ({ type: 'callout', tone: 'info', text });
const warn = (text: string): DocBlock => ({ type: 'callout', tone: 'warn', text });
const issues = (items: { problem: string; fix: string }[]): DocBlock => ({ type: 'common-issues', items });

export const docArticles: DocArticle[] = [
  // ---------------- GETTING STARTED ----------------
  {
    slug: 'quickstart',
    category: 'getting-started',
    title: 'Quickstart: signup to first call',
    description: 'Create your account, provision a phone number, and answer your first inbound call in under 10 minutes.',
    readTime: '6 min',
    updated: '2026-04-21',
    body: [
      p('This quickstart walks you through everything you need to take your first live call on QVO. By the end you will have a tenant, an agent, a phone number, and a recorded test conversation.'),
      { type: 'video', provider: 'mp4', src: '/docs/videos/quickstart-walkthrough.mp4', poster: '/docs/screenshots/quickstart-signup.jpg', caption: 'A short walkthrough of the steps below — signup, templates, demo, and live call panels.' },
      h2('1. Create your account'),
      ol([
        'Visit the signup page and enter your business email, company name, and a password.',
        'Confirm your email by clicking the link we send you.',
        'Choose your plan (Free Trial works for everything in this guide).',
      ]),
      { type: 'image', src: '/docs/screenshots/quickstart-signup.jpg', alt: 'QVO signup form with organization name, email, password, and plan selection', caption: 'The signup form auto-provisions your tenant.' },
      tip('Your tenant environment is provisioned automatically — no waiting for sales or onboarding calls.'),
      h2('2. Pick an industry template'),
      p('On first login the onboarding wizard offers pre-tuned agent templates. Pick the one closest to your business; you can change it later.'),
      ul(['Medical / Dental — patient intake, appointment booking, urgent triage', 'Legal — new matter intake, conflict checks, callback scheduling', 'Home services — dispatch, quote requests, after-hours emergencies', 'General business — receptionist, call routing, voicemail capture']),
      { type: 'image', src: '/docs/screenshots/demo-templates.jpg', alt: 'Industry agent templates: Answering Service, Collections, Customer Support, Dental, HVAC, Legal, Medical, Real Estate', caption: 'Pre-tuned templates for the most common industries.' },
      h2('3. Provision a phone number'),
      ol([
        'Go to Phone Numbers → Add Number.',
        'Choose a local or toll-free number.',
        'Assign it to the agent you just created.',
      ]),
      { type: 'image', src: '/docs/screenshots/product-section-2.jpg', alt: 'Three-step flow: Configure Agent, Connect Number, Go Live', caption: 'Provisioning a number is step 2 of the three-step go-live flow.' },
      info('Number provisioning typically completes in under 30 seconds. Your number is immediately routable.'),
      h2('4. Make a test call'),
      p('Call the number from your phone. The agent will greet you using the template prompt. Speak naturally — interruptions, pauses, and "uhms" are handled.'),
      { type: 'image', src: '/docs/screenshots/demo-active-call.jpg', alt: 'Live demo agent card with a Call to try it phone number and Live Transcript / Tool Executions panels', caption: 'Dial the displayed number and watch the live transcript and tool activity panels populate.' },
      h2('5. Review the transcript'),
      p('Open the Conversations page. You will see your call with a full transcript, the recording, the tools the agent invoked, and a quality score.'),
      { type: 'image', src: '/docs/screenshots/demo-transcript-panels.jpg', alt: 'Live Transcript, Tool Executions, Demo Stats, and System Activity panels', caption: 'Each call gets a transcript, tool traces, and stats — the same UI used in production.' },
      h3('Common issues'),
      issues([
        { problem: 'Number does not ring.', fix: 'Check that the agent is published (not draft). Drafts are not assigned to live numbers.' },
        { problem: 'Agent answers but is silent.', fix: 'Verify your account has voice credits. New trial accounts get 30 minutes free.' },
        { problem: 'Call fails with "no agent assigned".', fix: 'Open the number, scroll to Routing, and select an agent.' },
      ]),
    ],
  },
  {
    slug: 'core-concepts',
    category: 'getting-started',
    title: 'Core concepts',
    description: 'Tenants, agents, numbers, workflows, and tools — the building blocks of QVO.',
    readTime: '5 min',
    updated: '2026-04-21',
    body: [
      h2('Tenant'),
      p('A tenant is your isolated workspace. All calls, agents, numbers, contacts, and integrations belong to exactly one tenant. Row-level security guarantees no data crosses tenant boundaries.'),
      h2('Agent'),
      p('An agent is the AI that answers (or places) a call. It has a system prompt, a voice, a set of allowed tools, and routing rules. Agents are versioned — every published change creates a new version you can roll back to.'),
      h2('Phone number'),
      p('A SIP/PSTN number we provision on your behalf. Numbers are assigned to agents. One agent can hold many numbers; one number maps to exactly one agent at a time.'),
      h2('Workflow'),
      p('A workflow is a deterministic, multi-step state machine that runs around the agent — for example: identify caller → check calendar → book appointment → send SMS confirmation.'),
      h2('Tool'),
      p('Tools are the typed function calls an agent can make during a conversation. Examples: lookup_contact, create_ticket, schedule_appointment, transfer_to_human.'),
      h2('Knowledge base'),
      p('Per-tenant document store the agent can search at runtime. Upload PDFs, URLs, or paste text. Documents are chunked, embedded, and surfaced when the agent needs them.'),
    ],
  },
  {
    slug: 'glossary',
    category: 'getting-started',
    title: 'Glossary',
    description: 'Definitions for terms you will see across the product and these docs.',
    readTime: '3 min',
    updated: '2026-04-21',
    body: [
      ul([
        'AMD — Answering Machine Detection. Used in outbound campaigns to skip or leave voicemail.',
        'BYOC — Bring Your Own Carrier. Use your own SIP trunk instead of QVO-provisioned numbers.',
        'DNC — Do Not Call. Suppressions enforced before any outbound dial.',
        'DTMF — Touch-tone digits. Captured as tool input during a call.',
        'PHI — Protected Health Information. Auto-redacted from transcripts when the HIPAA add-on is enabled.',
        'RBAC — Role-Based Access Control. Owner, Manager, Member, Viewer.',
        'RLS — Row-Level Security. Database-enforced tenant isolation.',
        'TTFB — Time To First Byte. The latency from caller stops talking to agent starts speaking.',
      ]),
    ],
  },

  // ---------------- AGENT BUILDER ----------------
  {
    slug: 'building-your-first-agent',
    category: 'agent-builder',
    title: 'Building your first agent',
    description: 'Write a system prompt, pick a voice, and configure tools and escalations.',
    readTime: '10 min',
    updated: '2026-04-21',
    body: [
      h2('Open the builder'),
      p('From the Agents page click an agent (or "New Agent"). The builder splits into Identity, Behavior, Tools, Routing, and Test panels.'),
      { type: 'image', src: '/docs/screenshots/features-detail.jpg', alt: 'Agent Builder feature card listing industry templates, drag-and-drop prompt editor, voice personality tuning, conditional routing, and version-controlled prompts', caption: 'The Agent Builder bundles templates, prompt editing, voice tuning, and routing.' },
      { type: 'image', src: '/docs/screenshots/agents-showcase.jpg', alt: 'Agent showcase cards: Medical Intake Agent and Dental Scheduling Agent', caption: 'Pre-built agent showcases you can deploy as a starting point.' },
      h2('Write the system prompt'),
      p('The prompt is plain English. Be specific about tone, what to collect, what to refuse, and when to escalate.'),
      code(`You are the after-hours receptionist for Riverside Clinic.
1. Greet warmly and identify yourself as the AI assistant.
2. Confirm caller name and date of birth.
3. Triage: chest pain, breathing trouble, severe bleeding → tell them to hang up and call 911.
4. For non-urgent matters, offer a callback for the next business day.
5. Always confirm the callback phone number before ending.`, 'text'),
      tip('Keep prompts under ~600 words. Longer prompts increase latency and reduce instruction-following.'),
      h2('Pick a voice'),
      p('Preview voices with a sample sentence. Match the voice to the audience — calm/measured for healthcare, warm for hospitality, energetic for sales.'),
      { type: 'image', src: '/docs/agent-voice-picker.svg', alt: 'Voice picker showing three voice options with TTFB latency', caption: 'Each voice shows its time-to-first-byte so you can balance feel and latency.' },
      h2('Enable tools'),
      p('Toggle the tools your agent is allowed to call. Each tool has a JSON schema; the agent only sees tools you enable.'),
      { type: 'image', src: '/docs/agent-tools-toggle.svg', alt: 'Tools panel with toggles for lookup_contact, schedule_appointment, create_ticket, and transfer_to_human', caption: 'Only enabled tools are visible to the agent at runtime.' },
      h2('Routing rules'),
      ul([
        'Escalation — keywords or intents that transfer the call to a human.',
        'Voicemail — what to do when no human is available.',
        'Post-call — webhooks, SMS confirmations, ticket creation.',
      ]),
      h2('Test'),
      p('Use the "Test Call" button in the builder to call yourself. Iterate on the prompt until edge cases behave correctly. Most teams ship after 3–5 iterations.'),
      h3('Common issues'),
      issues([
        { problem: 'Agent ignores parts of the prompt.', fix: 'Number your instructions and put critical ones first. Long unstructured prose is followed less reliably.' },
        { problem: 'Agent invents information.', fix: 'Add a "if you do not know, say so and offer a callback" clause.' },
        { problem: 'Agent talks over the caller.', fix: 'Lower interruption sensitivity in Behavior settings.' },
      ]),
    ],
  },
  {
    slug: 'voice-and-personality',
    category: 'agent-builder',
    title: 'Voice and personality',
    description: 'Tune voice, pacing, fillers, and interruption behavior.',
    readTime: '4 min',
    updated: '2026-04-21',
    body: [
      h2('Voice catalog'),
      p('Voices vary by gender, accent, age, and energy. Each voice has a latency profile — faster voices feel more natural over the phone.'),
      h2('Pacing'),
      ul(['Speed (0.85–1.15) controls words per minute.', 'Pause length controls silence between sentences.', 'Filler words ("um", "let me check") humanize transitions.']),
      h2('Interruption behavior'),
      p('Sensitivity 0 means the agent never yields; 1 means any sound interrupts it. 0.5 is the default and works for most settings.'),
    ],
  },
  {
    slug: 'tools-and-functions',
    category: 'agent-builder',
    title: 'Tools and functions',
    description: 'Give your agent typed actions: lookups, bookings, escalations, and custom HTTP.',
    readTime: '7 min',
    updated: '2026-04-21',
    body: [
      h2('Built-in tools'),
      ul([
        'lookup_contact — search the CRM by phone or email.',
        'schedule_appointment — book a slot on a connected calendar.',
        'create_ticket — open a helpdesk ticket with priority.',
        'send_sms — text the caller during or after the call.',
        'transfer_to_human — warm or cold transfer to a configured destination.',
      ]),
      h2('Custom tools'),
      p('Define a tool with a name, description, JSON schema, and an HTTPS endpoint. Calls are signed and retried on 5xx.'),
      code(`{
  "name": "check_order_status",
  "description": "Look up an order by order number.",
  "parameters": {
    "type": "object",
    "properties": {
      "order_number": { "type": "string" }
    },
    "required": ["order_number"]
  },
  "endpoint": "https://your-api.example.com/orders/check"
}`, 'json'),
    ],
  },

  // ---------------- WORKFLOWS ----------------
  {
    slug: 'workflows-overview',
    category: 'workflows',
    title: 'Workflows overview',
    description: 'How deterministic flows complement the LLM and remove ambiguity from critical steps.',
    readTime: '5 min',
    updated: '2026-04-21',
    body: [
      p('Workflows are deterministic state machines that wrap an agent. Use them when a sequence must happen in a fixed order or when you need explicit branching the LLM should not improvise.'),
      h2('When to use a workflow'),
      ul([
        'Identity verification before disclosing PHI.',
        'Multi-step intake with required fields.',
        'After-call automations (CRM update, SMS confirmation, ticket).',
      ]),
      h2('Components'),
      ul([
        'Triggers — call.started, intent.matched, tool.failed.',
        'Steps — agent_say, tool_call, condition, http_request, wait.',
        'Transitions — guarded by conditions on collected data.',
      ]),
    ],
  },
  {
    slug: 'configuring-workflows',
    category: 'workflows',
    title: 'Configuring workflows',
    description: 'Build, version, and publish a workflow attached to an agent.',
    readTime: '8 min',
    updated: '2026-04-21',
    body: [
      h2('Create a workflow'),
      ol([
        'Workflows → New Workflow.',
        'Pick a starting trigger (most common: call.started).',
        'Drag steps onto the canvas and connect them.',
        'Use the side panel to configure each step.',
      ]),
      { type: 'image', src: '/docs/workflow-canvas.svg', alt: 'Workflow canvas with three connected steps and a side panel of node types', caption: 'Drag steps and connect them on the canvas.' },
      { type: 'image', src: '/docs/screenshots/features-architecture.jpg', alt: 'Platform architecture: Voice AI Runtime, Agent Builder, Tool Engine, Knowledge RAG, Integrations, Security Layer', caption: 'Workflows orchestrate the Tool Engine, Agent Builder, and Integrations subsystems.' },
      h2('Version and publish'),
      p('Save creates a draft. Publish promotes a draft to production. Previous versions remain available — you can roll back at any time.'),
      h2('Test'),
      p('Use the Workflow Simulator to step through with synthetic input before publishing.'),
      { type: 'image', src: '/docs/workflow-simulator.svg', alt: 'Workflow simulator showing trigger, verify_identity, and book_slot steps with sample step output', caption: 'Step through the workflow with synthetic input and inspect each step\u2019s output.' },
      h3('Common issues'),
      issues([
        { problem: 'Workflow never triggers.', fix: 'Confirm the workflow is Published and bound to the right agent.' },
        { problem: 'Step times out.', fix: 'Increase the step timeout, or split a long-running tool into a fire-and-forget step.' },
      ]),
    ],
  },

  // ---------------- INTEGRATIONS ----------------
  {
    slug: 'integrations-overview',
    category: 'integrations',
    title: 'Integrations overview',
    description: 'How QVO connects to your existing CRM, calendar, helpdesk, and messaging tools.',
    readTime: '4 min',
    updated: '2026-04-21',
    body: [
      p('Integrations let your agent read and write data in your existing systems during a call. Open Integrations in the sidebar to browse the catalog.'),
      h2('Authentication'),
      p('Most integrations use OAuth — click Connect, sign in to the provider, and grant the requested scopes. API-key based integrations prompt you for the key inline.'),
      h2('Data flow'),
      ul([
        'Read — agent looks up the caller in your CRM.',
        'Write — agent creates a record (contact, ticket, appointment).',
        'Sync — periodic background sync of mutable data.',
      ]),
      h2('Security'),
      p('All connection credentials are encrypted at rest. Tokens are scoped per tenant and never exposed to the agent prompt.'),
    ],
  },
  {
    slug: 'connecting-hubspot',
    category: 'integrations',
    title: 'Connecting HubSpot',
    description: 'Look up contacts, log calls, and create deals during a conversation.',
    readTime: '6 min',
    updated: '2026-04-21',
    body: [
      ol([
        'Integrations → HubSpot → Connect.',
        'Sign in to HubSpot and approve the requested scopes.',
        'Choose which pipeline and contact owner new records should use.',
        'Map QVO call fields to HubSpot custom properties (optional).',
      ]),
      { type: 'image', src: '/docs/screenshots/integrations-catalog.jpg', alt: 'Integrations catalog showing Google Calendar, Twilio, Stripe, CRM Systems (with HubSpot), Ticketing Systems, and Zapier / Webhooks', caption: 'HubSpot lives under CRM Systems in the integrations catalog.' },
      { type: 'image', src: '/docs/hubspot-mapping.svg', alt: 'HubSpot field mapping screen', caption: 'Map QVO fields to HubSpot properties.' },
      h2('What gets synced'),
      ul([
        'Inbound caller phone → contact lookup.',
        'Call summary → contact timeline activity.',
        'Disposition (interested, not interested, callback) → deal stage or contact property.',
      ]),
      h3('Common issues'),
      issues([
        { problem: 'Contact not found for known caller.', fix: 'Verify the contact has a phone field set, in E.164 format. HubSpot lookups require an exact-format match.' },
        { problem: 'Activity does not appear on timeline.', fix: 'Reconnect the integration to refresh the access token.' },
      ]),
    ],
  },
  {
    slug: 'connecting-salesforce',
    category: 'integrations',
    title: 'Connecting Salesforce',
    description: 'Create a Salesforce Connected App and authorize QVO to log calls against Contacts, Leads, and Opportunities.',
    readTime: '8 min',
    updated: '2026-04-21',
    body: [
      p('QVO uses Salesforce OAuth 2.0 with a refresh token so calls can keep syncing in the background. Before you click Connect, your Salesforce admin needs to create a Connected App in your org so QVO has a Client ID and Client Secret to authorize against.'),
      info('You only need to do this once per Salesforce org. After the Connected App is created, every QVO tenant admin in your org can connect by signing in.'),
      h2('1. Create a Connected App in Salesforce'),
      ol([
        'In Salesforce, open Setup and search for "App Manager", then click New Connected App.',
        'Pick "Create a Connected App" and give it a name like "QVO Voice Agent" with your admin contact email.',
        'Under API (Enable OAuth Settings), check "Enable OAuth Settings".',
        'Set the Callback URL to https://app.qvo.ai/api/connectors/oauth/salesforce/callback (use your tenant\'s app domain if you self-host).',
        'Add the OAuth scopes: api (Manage user data via APIs), refresh_token, offline_access — all three are required.',
        'Leave "Require Secret for Web Server Flow" and "Require Secret for Refresh Token Flow" enabled.',
        'Save the app. Salesforce warns it can take up to 10 minutes to propagate.',
      ]),
      tip('After saving, click Manage Consumer Details to copy the Consumer Key (Client ID) and Consumer Secret (Client Secret). You will paste these into QVO.'),
      h2('2. Choose production vs sandbox'),
      p('QVO points at the standard Salesforce login URL by default (https://login.salesforce.com). For sandbox orgs you must tell us to use the test login host instead by setting the SALESFORCE_LOGIN_URL environment variable on the server.'),
      ul([
        'Production org → leave SALESFORCE_LOGIN_URL unset (defaults to https://login.salesforce.com).',
        'Sandbox org (e.g. mycompany--dev.sandbox.my.salesforce.com) → set SALESFORCE_LOGIN_URL=https://test.salesforce.com so QVO authorizes against the sandbox login host.',
      ]),
      p('If you self-host QVO, set SALESFORCE_LOGIN_URL in your server environment. On Replit Deployments, add it under Secrets. Cloud QVO tenants can request a sandbox toggle by contacting support — include your Salesforce org ID.'),
      warn('A common failure mode is connecting a sandbox org with SALESFORCE_LOGIN_URL unset. The OAuth flow appears to succeed, then refresh tokens fail silently with invalid_grant. Always verify the login host matches the org type.'),
      h2('3. Authorize QVO'),
      ol([
        'In QVO, go to Integrations → Salesforce → Connect.',
        'Sign in with the Salesforce account that should own logged calls (a service user is recommended).',
        'Approve the api, refresh_token, and offline_access scopes when prompted.',
        'You will be redirected back to QVO with the integration marked Connected.',
      ]),
      h2('4. Verify it works'),
      p('Trigger a test call or click "Sync now" on the Salesforce integration card. You should see a Task created on the matching Contact or Lead with the AI call summary in the description.'),
      h3('Common issues'),
      issues([
        { problem: 'invalid_client_id when authorizing.', fix: 'Re-check the Consumer Key was copied without trailing whitespace, and that 10 minutes have passed since you saved the Connected App.' },
        { problem: 'invalid_grant on refresh.', fix: 'Confirm SALESFORCE_LOGIN_URL matches the org type (login.salesforce.com vs test.salesforce.com) and that offline_access is in the scope list.' },
        { problem: 'Calls not appearing on Contact timeline.', fix: 'Check the service user has Edit access on Tasks and on the relevant Contact/Lead record types.' },
        { problem: 'Tokens revoked after IP change.', fix: 'In Salesforce Setup → Manage Connected Apps → QVO, set IP Relaxation to "Relax IP restrictions" so refresh tokens survive infrastructure changes.' },
      ]),
      p('For deeper detail on Connected Apps see the official Salesforce help: https://help.salesforce.com/s/articleView?id=sf.connected_app_create.htm.'),
    ],
  },
  {
    slug: 'connecting-outlook',
    category: 'integrations',
    title: 'Connecting Outlook Calendar',
    description: 'Register a Microsoft Entra app and authorize QVO to read availability and book appointments on your Microsoft 365 calendar.',
    readTime: '8 min',
    updated: '2026-04-21',
    body: [
      p('The Outlook Calendar connector talks to Microsoft Graph using OAuth 2.0 with a refresh token. To get started, an Entra (formerly Azure AD) admin needs to register an app in your tenant so QVO has a Client ID, Client Secret, and tenant ID to authorize against.'),
      info('App registration is a one-time job per Microsoft 365 tenant. Once it is in place, every QVO user in your org can connect their own calendar by signing in.'),
      h2('1. Register an app in Microsoft Entra'),
      ol([
        'Go to https://entra.microsoft.com → Applications → App registrations → New registration.',
        'Name it something like "QVO Voice Agent".',
        'Under Supported account types choose "Accounts in this organizational directory only" for single-tenant, or "Accounts in any organizational directory" for multi-tenant.',
        'Set the Redirect URI to Web → https://app.qvo.ai/api/connectors/oauth/outlook/callback (use your own app domain if you self-host).',
        'Click Register. Copy the Application (client) ID and the Directory (tenant) ID from the Overview page.',
      ]),
      h2('2. Add a client secret'),
      ol([
        'Open the app registration → Certificates & secrets → New client secret.',
        'Give it a description and an expiry (12 or 24 months recommended; calendar a renewal task).',
        'Copy the secret Value immediately — it is hidden after you leave the page. This is your Client Secret.',
      ]),
      warn('If the client secret expires, the integration silently stops refreshing tokens. Track the expiry date and rotate before it hits zero.'),
      h2('3. Configure API permissions'),
      ol([
        'In the app registration → API permissions → Add a permission → Microsoft Graph → Delegated permissions.',
        'Add: Calendars.ReadWrite, offline_access, openid, profile, User.Read.',
        'Click "Grant admin consent for <your tenant>" so users do not have to approve each scope individually.',
      ]),
      ul([
        'Calendars.ReadWrite — required to read availability and create/update events.',
        'offline_access — required so QVO can refresh tokens without re-prompting.',
        'openid, profile, User.Read — required for the sign-in flow and to identify the connecting user.',
      ]),
      h2('4. Set the Microsoft env vars on the QVO server'),
      p('QVO reads three environment variables to talk to Microsoft Graph:'),
      ul([
        'MICROSOFT_CLIENT_ID — the Application (client) ID from step 1.',
        'MICROSOFT_CLIENT_SECRET — the secret value from step 2.',
        'MICROSOFT_TENANT_ID — which Entra tenant to authorize against (see options below).',
      ]),
      p('Paste the Directory (tenant) ID from step 1 into MICROSOFT_TENANT_ID:'),
      ul([
        'Single-tenant app → set MICROSOFT_TENANT_ID to your specific tenant GUID. Authorization endpoints become https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/...',
        'Multi-tenant app (you let users from any org connect) → set MICROSOFT_TENANT_ID=common.',
        'Personal Microsoft accounts only → set MICROSOFT_TENANT_ID=consumers (rare for business use).',
      ]),
      p('If you self-host QVO, set MICROSOFT_TENANT_ID in your server environment. On Replit Deployments add it under Secrets. Cloud QVO tenants can request the value be set by support.'),
      h2('5. Authorize QVO'),
      ol([
        'In QVO go to Integrations → Outlook Calendar → Connect.',
        'Sign in with the Microsoft 365 account whose calendar should be used.',
        'Approve the requested permissions.',
        'You return to QVO with the connector marked Connected; pick which calendar QVO may book on.',
      ]),
      h2('6. Verify it works'),
      p('Click "Sync now" on the Outlook integration card or run a test booking flow. A new event should appear on the chosen calendar within a few seconds.'),
      h3('Common issues'),
      issues([
        { problem: 'AADSTS50011: redirect URI mismatch.', fix: 'The Redirect URI in the Entra app must exactly match the QVO callback URL, including trailing slash and protocol.' },
        { problem: 'AADSTS65001: user or admin has not consented.', fix: 'Have an Entra admin click "Grant admin consent" on the API permissions page.' },
        { problem: 'AADSTS700016: app not found in tenant.', fix: 'MICROSOFT_TENANT_ID is set to the wrong tenant. Use common for multi-tenant apps, or the right GUID for single-tenant.' },
        { problem: 'invalid_grant after a few weeks.', fix: 'The client secret has expired or been rotated. Generate a new one in Certificates & secrets and update the QVO connector.' },
        { problem: 'Events created but not visible to others.', fix: 'Confirm the connecting user has share permissions on the target calendar, or use a shared mailbox the service account owns.' },
      ]),
      p('For deeper detail on Microsoft Graph auth see: https://learn.microsoft.com/en-us/graph/auth-v2-user.'),
    ],
  },
  {
    slug: 'connecting-hubspot',
    category: 'integrations',
    title: 'Connecting HubSpot',
    description: 'Create a HubSpot OAuth app (or private app) and authorize QVO to log calls and update contacts.',
    readTime: '7 min',
    updated: '2026-04-21',
    body: [
      p('QVO connects to HubSpot two ways: an OAuth app (recommended for production multi-user setups) or a private app access token (fastest for a single workspace). Both require a HubSpot admin to create the app first so QVO has credentials to authorize against.'),
      info('OAuth gives you per-user audit trails and refresh tokens that rotate automatically. Private apps are simpler but use one shared token that you must rotate manually.'),
      h2('Option A — OAuth app (recommended)'),
      h3('1. Create a HubSpot developer app'),
      ol([
        'Go to https://developers.hubspot.com → Manage apps → Create app (you may need a free developer account separate from your portal).',
        'Under Auth, copy the Client ID and Client Secret.',
        'Add the Redirect URL: https://app.qvo.ai/api/connectors/oauth/hubspot/callback (use your tenant\'s app domain if you self-host).',
        'Under Scopes, add: crm.objects.contacts.read, crm.objects.contacts.write, crm.objects.deals.read, crm.objects.deals.write, timeline.',
        'Save the app.',
      ]),
      h3('2. Set the HubSpot env vars on the QVO server'),
      ul([
        'HUBSPOT_CLIENT_ID — Client ID from the developer app.',
        'HUBSPOT_CLIENT_SECRET — Client Secret from the developer app.',
      ]),
      p('If you self-host QVO, set these in your server environment. On Replit Deployments add them under Secrets. Cloud QVO tenants can request the values be set by support.'),
      h3('3. Authorize QVO'),
      ol([
        'In QVO go to Integrations → HubSpot → Connect.',
        'Sign in with the HubSpot account that owns the portal QVO should write into.',
        'Approve the requested scopes.',
        'You return to QVO with the connector marked Connected.',
      ]),
      h2('Option B — Private app access token'),
      ol([
        'In HubSpot go to Settings → Integrations → Private apps → Create a private app.',
        'Name it "QVO Voice Agent".',
        'Under Scopes (CRM tab) tick the same five scopes listed above.',
        'Create the app and copy the access token (it begins with pat-).',
        'In QVO go to Integrations → HubSpot → Connect → Use access token, and paste the token.',
      ]),
      warn('Private app tokens do not expire automatically but they also do not refresh. If you regenerate the token in HubSpot, paste the new value in QVO or sync will start failing silently.'),
      h2('What gets synced'),
      ul([
        'Inbound caller phone → contact lookup (E.164 match).',
        'Call summary → contact timeline activity.',
        'Disposition (interested, not interested, callback) → deal stage or contact property.',
      ]),
      h3('Common issues'),
      issues([
        { problem: 'OAUTH_REDIRECT_URI_MISMATCH on Connect.', fix: 'The Redirect URL in your HubSpot developer app must match exactly, including https:// and trailing slash.' },
        { problem: 'Missing required scope error after Connect.', fix: 'Add the missing scope in the developer app, save, then click Connect again so the user re-consents.' },
        { problem: 'Contact not found for known caller.', fix: 'Verify the contact has a phone field set, in E.164 format. HubSpot lookups require an exact-format match.' },
        { problem: 'Activity not appearing on the contact timeline.', fix: 'Reconnect the integration to refresh the access token, then trigger Sync now.' },
        { problem: 'Private app token works locally but fails in production.', fix: 'Tokens are scoped to a single HubSpot account — make sure the token is from the same portal you\'re trying to write to.' },
      ]),
      p('For deeper detail see HubSpot\'s OAuth docs: https://developers.hubspot.com/docs/api/oauth-quickstart-guide.'),
    ],
  },
  {
    slug: 'connecting-calendar',
    category: 'integrations',
    title: 'Connecting Google Calendar',
    description: 'Create a Google Cloud OAuth client and authorize QVO to read availability and book appointments on your Google Calendar.',
    readTime: '8 min',
    updated: '2026-04-21',
    body: [
      p('QVO uses Google\'s OAuth 2.0 with a refresh token so the agent can keep checking availability and booking appointments without re-prompting the user. Before you click Connect, a Google Workspace admin needs to create an OAuth client in Google Cloud so QVO has a Client ID and Client Secret to authorize against.'),
      info('You only need to do this once per Google Cloud project. After the OAuth client is created, every QVO user can connect their own calendar by signing in.'),
      h2('1. Enable the Google Calendar API'),
      ol([
        'Go to https://console.cloud.google.com → pick or create a project.',
        'In the left menu open APIs & Services → Library, search for "Google Calendar API", click it, and press Enable.',
      ]),
      h2('2. Configure the OAuth consent screen'),
      ol([
        'APIs & Services → OAuth consent screen.',
        'Pick Internal if every user is in your Google Workspace, otherwise External.',
        'Fill in app name ("QVO Voice Agent"), support email, and developer contact email.',
        'Add the scopes: https://www.googleapis.com/auth/calendar and https://www.googleapis.com/auth/calendar.events.',
        'If you chose External, add the Google accounts of the QVO users who need to connect under Test users (until you publish the app).',
      ]),
      warn('External apps in Testing mode issue refresh tokens that expire after 7 days. Either keep the app in Testing only for early QA, or publish the app once you finish setup so refresh tokens become long-lived.'),
      h2('3. Create the OAuth client credentials'),
      ol([
        'APIs & Services → Credentials → Create credentials → OAuth client ID.',
        'Application type: Web application.',
        'Name: "QVO".',
        'Authorized redirect URI: https://app.qvo.ai/api/connectors/oauth/google/callback (use your tenant\'s app domain if you self-host).',
        'Click Create and copy the Client ID and Client Secret immediately.',
      ]),
      h2('4. Set the Google env vars on the QVO server'),
      ul([
        'GOOGLE_CLIENT_ID — Client ID from step 3.',
        'GOOGLE_CLIENT_SECRET — Client Secret from step 3.',
      ]),
      p('If you self-host QVO, set these in your server environment. On Replit Deployments add them under Secrets. Cloud QVO tenants can request the values be set by support.'),
      h2('5. Authorize QVO'),
      ol([
        'In QVO go to Integrations → Google Calendar → Connect.',
        'Sign in with the Google account whose calendar should be used.',
        'Approve the calendar read and events scopes.',
        'You return to QVO with the connector marked Connected; pick which calendar QVO may book on and set timezone, buffer times, and appointment types.',
      ]),
      tip('Keep buffer times realistic — 5-10 minutes prevents back-to-back overruns.'),
      h2('6. Verify it works'),
      p('Click Sync now on the Google Calendar card or run a test booking. A new event should appear on the chosen calendar within a few seconds. Toggle SMS or email confirmation under appointment settings to send reminders N hours ahead.'),
      h3('Common issues'),
      issues([
        { problem: 'redirect_uri_mismatch on Connect.', fix: 'The Authorized redirect URI in Google Cloud must match exactly, including https:// and trailing path. No trailing slash.' },
        { problem: 'access_denied — app not verified.', fix: 'External apps in Testing mode only allow listed Test users. Add the connecting Google account under OAuth consent screen → Test users, or publish the app for general use.' },
        { problem: 'invalid_grant after about 7 days.', fix: 'Apps in Testing mode issue 7-day refresh tokens. Publish the app or move to Internal user type to get long-lived refresh tokens.' },
        { problem: 'Calendar API has not been used in project.', fix: 'You missed step 1. Go back to APIs & Services → Library and enable Google Calendar API.' },
        { problem: 'Bookings created on the wrong calendar.', fix: 'In the connector card pick a specific Calendar ID instead of "primary", and make sure the connecting user has write access to that calendar.' },
      ]),
      p('For deeper detail on Google OAuth see: https://developers.google.com/identity/protocols/oauth2/web-server.'),
    ],
  },
  {
    slug: 'connecting-slack',
    category: 'integrations',
    title: 'Connecting Slack',
    description: 'Create a Slack app and authorize QVO to post call summaries, missed-call alerts, and escalations into channels.',
    readTime: '6 min',
    updated: '2026-04-21',
    body: [
      p('QVO uses Slack\'s OAuth v2 flow to install a bot user into your workspace. Before you click Connect, a Slack workspace admin needs to create an app at api.slack.com so QVO has a Client ID and Client Secret to authorize against.'),
      info('You only need to do this once per Slack workspace. After the app is installed, anyone in the workspace can route QVO events to channels they have access to.'),
      h2('1. Create a Slack app'),
      ol([
        'Go to https://api.slack.com/apps → Create New App → From scratch.',
        'Name it "QVO" and pick the workspace it should install into.',
      ]),
      h2('2. Add OAuth scopes'),
      ol([
        'Open the app → Features → OAuth & Permissions.',
        'Under Scopes → Bot Token Scopes add: chat:write, channels:read, groups:read.',
        'chat:write lets QVO post messages, channels:read and groups:read let QVO list public and private channels you can route events to.',
      ]),
      h2('3. Set the redirect URL'),
      ol([
        'On the same OAuth & Permissions page, scroll to Redirect URLs → Add New Redirect URL.',
        'Enter: https://app.qvo.ai/api/connectors/oauth/slack/callback (use your tenant\'s app domain if you self-host).',
        'Click Save URLs.',
      ]),
      h2('4. Grab the Client ID and Client Secret'),
      ol([
        'Open Settings → Basic Information.',
        'Under App Credentials copy the Client ID and Client Secret.',
      ]),
      h2('5. Set the Slack env vars on the QVO server'),
      ul([
        'SLACK_CLIENT_ID — Client ID from step 4.',
        'SLACK_CLIENT_SECRET — Client Secret from step 4.',
      ]),
      p('If you self-host QVO, set these in your server environment. On Replit Deployments add them under Secrets. Cloud QVO tenants can request the values be set by support.'),
      h2('6. Authorize QVO and pick channels'),
      ol([
        'In QVO go to Integrations → Slack → Connect.',
        'You will be sent to Slack to install the QVO app into your workspace.',
        'Approve the requested scopes — Slack returns you to QVO with the connector marked Connected.',
        'In the connector settings, paste the Channel ID for the channel that should receive default events, or map event types to different channels (call.escalated → #front-desk, call.missed → #ops).',
      ]),
      tip('To find a Channel ID, open the channel in Slack, click the channel name at the top, and copy the ID at the bottom of the About panel.'),
      info('Each Slack message includes a link back to the full transcript and recording in QVO.'),
      h2('7. Invite the bot to private channels'),
      p('For private channels, run /invite @QVO once so the bot can post. Public channels work without an invite.'),
      h3('Common issues'),
      issues([
        { problem: 'invalid_redirect_uri on Connect.', fix: 'The Redirect URL in your Slack app settings must match exactly, including https://. Make sure you clicked Save URLs after adding it.' },
        { problem: 'missing_scope when QVO tries to post.', fix: 'Reopen the Slack app → OAuth & Permissions, add the missing scope, click Reinstall to Workspace, and reconnect in QVO.' },
        { problem: 'channel_not_found posting to a private channel.', fix: 'Run /invite @QVO in the private channel so the bot has access.' },
        { problem: 'not_in_channel posting to a public channel.', fix: 'Same fix — invite @QVO, or pick a different channel the bot has been added to.' },
        { problem: 'token_revoked after admin removed the app.', fix: 'A workspace admin must reinstall the QVO app from the Apps directory, then click Reconnect in QVO.' },
      ]),
      p('For deeper detail on Slack OAuth see: https://api.slack.com/authentication/oauth-v2.'),
    ],
  },
  {
    slug: 'connecting-pipedrive',
    category: 'integrations',
    title: 'Connecting Pipedrive',
    description: 'Set up a Pipedrive OAuth app (or use a personal API token) and authorize QVO to sync contacts, deals, and call activities.',
    readTime: '7 min',
    updated: '2026-04-21',
    body: [
      p('QVO connects to Pipedrive two ways: a public OAuth app (recommended for production multi-user setups) or a personal API token (fastest for a single user). Both require a Pipedrive admin to set things up first.'),
      info('OAuth refreshes tokens automatically and gives per-user attribution. Personal API tokens are scoped to one user and never expire, but inherit that user\'s permissions.'),
      h2('Option A — OAuth app (recommended)'),
      h3('1. Create a Pipedrive Marketplace app'),
      ol([
        'Go to https://marketplace.pipedrive.com/ → Developer Hub → Create an app (you need to enable the developer sandbox in your Pipedrive account first).',
        'Pick "Public app" if multiple Pipedrive companies will install it, or "Private app" for your own company only.',
        'Set the Callback URL to: https://app.qvo.ai/api/connectors/oauth/pipedrive/callback (use your tenant\'s app domain if you self-host).',
      ]),
      h3('2. Set scopes'),
      ul([
        'contacts:full — read and write Persons and Organizations.',
        'deals:full — read and write Deals.',
        'activities:full — log calls and meetings as activities.',
        'users:read — identify the connecting user.',
      ]),
      h3('3. Grab the Client ID and Client Secret'),
      p('Copy the Client ID and Client Secret from the app\'s OAuth & access tab.'),
      h3('4. Set the Pipedrive env vars on the QVO server'),
      ul([
        'PIPEDRIVE_CLIENT_ID — Client ID from step 3.',
        'PIPEDRIVE_CLIENT_SECRET — Client Secret from step 3.',
      ]),
      p('If you self-host QVO, set these in your server environment. On Replit Deployments add them under Secrets. Cloud QVO tenants can request the values be set by support.'),
      h3('5. Authorize QVO'),
      ol([
        'In QVO go to Integrations → Pipedrive → Connect.',
        'Sign in with the Pipedrive account that should own logged calls.',
        'Approve the requested scopes.',
        'You return to QVO with the connector marked Connected.',
      ]),
      h2('Option B — Personal API token'),
      ol([
        'In Pipedrive go to Settings → Personal preferences → API.',
        'Copy the personal API token shown.',
        'In QVO go to Integrations → Pipedrive → Connect → Use API token, and paste the token along with your company domain (the subdomain part of yourcompany.pipedrive.com).',
      ]),
      warn('Personal API tokens inherit the permissions of the user who created them. If that user is deactivated, the integration stops working.'),
      h2('What gets synced'),
      ul([
        'Inbound caller phone → Person lookup, with new Persons created when no match exists.',
        'Call summary → Activity (Call type) attached to the matching Person and any open Deal.',
        'Disposition → Deal stage updates (interested moves the deal forward, callback creates a follow-up activity).',
      ]),
      h3('Common issues'),
      issues([
        { problem: 'redirect_uri_mismatch on Connect.', fix: 'The Callback URL in your Pipedrive app must match exactly, including https://.' },
        { problem: 'invalid_scope error.', fix: 'Reopen the Pipedrive app, add the missing scope from the list above, save, and reconnect in QVO.' },
        { problem: 'Person not found for a known caller.', fix: 'Pipedrive matches on Person phone field. Make sure the caller\'s number is on a Person record in E.164 format.' },
        { problem: 'Activity created but not attached to a deal.', fix: 'QVO only attaches to open deals. If all deals for the contact are won/lost, the activity stays attached to the Person only.' },
        { problem: 'Personal token suddenly fails after a user change.', fix: 'Personal API tokens are tied to a single user. Switch to OAuth, or generate a new token under a service account user that won\'t be deactivated.' },
      ]),
      p('For deeper detail on Pipedrive OAuth see: https://pipedrive.readme.io/docs/marketplace-oauth-authorization.'),
    ],
  },
  {
    slug: 'connecting-quickbooks',
    category: 'integrations',
    title: 'Connecting QuickBooks',
    description: 'Create an Intuit Developer app and authorize QVO to sync customers and create invoices when calls complete.',
    readTime: '8 min',
    updated: '2026-04-21',
    body: [
      p('QVO connects to QuickBooks Online via Intuit\'s OAuth 2.0 flow with a refresh token so invoices keep posting in the background. Before you click Connect, a QuickBooks admin needs to register an app on the Intuit Developer portal so QVO has a Client ID and Client Secret to authorize against.'),
      info('You only need to do this once per QuickBooks company. The same app supports both Sandbox (for testing) and Production environments — they use different tokens you connect separately.'),
      h2('1. Create an Intuit Developer app'),
      ol([
        'Go to https://developer.intuit.com → Sign in (or create a free developer account).',
        'My Apps → Create an app → Pick QuickBooks Online and Payments.',
        'Name it "QVO Voice Agent".',
      ]),
      h2('2. Configure the redirect URI and scopes'),
      ol([
        'Open the app → Keys & OAuth tab.',
        'Pick the environment you\'re setting up first (Development for sandbox, Production for live).',
        'Under Redirect URIs add: https://app.qvo.ai/api/connectors/oauth/quickbooks/callback (use your tenant\'s app domain if you self-host).',
        'Confirm the scope com.intuit.quickbooks.accounting is enabled — this is the only scope QVO needs.',
        'Copy the Client ID and Client Secret for that environment.',
      ]),
      warn('Sandbox and Production each have their own Client ID and Client Secret. Don\'t mix them — using sandbox creds against the production endpoint is the most common cause of silent failures.'),
      h2('3. Set the QuickBooks env vars on the QVO server'),
      ul([
        'QUICKBOOKS_CLIENT_ID — Client ID for the environment you\'re connecting.',
        'QUICKBOOKS_CLIENT_SECRET — Client Secret for the same environment.',
        'QUICKBOOKS_ENV — set to production (default) or sandbox to match.',
      ]),
      p('If you self-host QVO, set these in your server environment. On Replit Deployments add them under Secrets. Cloud QVO tenants can request the values be set by support.'),
      h2('4. Authorize QVO'),
      ol([
        'In QVO go to Integrations → QuickBooks → Connect.',
        'Sign in with the Intuit account that owns the QuickBooks company file QVO should write to.',
        'Pick the company (Intuit calls this the realm) and approve the accounting scope.',
        'You return to QVO with the connector marked Connected. The Realm ID is captured automatically from the callback.',
      ]),
      h2('5. Configure auto-invoicing (optional)'),
      p('To bill jobs booked by the agent, set the invoice item and default amount on the QuickBooks connector card:'),
      ul([
        'Invoice Item ID — the Item Ref in QuickBooks for the line item to bill (e.g. "Standard Service Call").',
        'Default Invoice Amount — the dollar amount to bill when no per-call price is set on the workflow.',
      ]),
      tip('To find an Item ID in QuickBooks: Sales → Products and services → click the item → the ID is in the URL.'),
      h2('6. Verify it works'),
      p('Click Sync now on the QuickBooks card, or trigger a test call configured to create an invoice. A new draft invoice should appear in QuickBooks within a few seconds, attached to the matching Customer (matched by phone or email).'),
      h3('Common issues'),
      issues([
        { problem: 'invalid_redirect_uri on Connect.', fix: 'The Redirect URI in the Intuit Developer app must match exactly. Check you set it on the right environment tab (Development vs Production).' },
        { problem: 'invalid_grant when refreshing tokens.', fix: 'QuickBooks refresh tokens last 100 days but rotate on every use. If the token expires, click Reconnect on the QVO connector card. Also confirm QUICKBOOKS_ENV matches the credentials being used.' },
        { problem: 'AuthenticationFailed when calling the API.', fix: 'You\'re probably hitting production with sandbox creds (or vice versa). Set QUICKBOOKS_ENV to match the keys, then reconnect.' },
        { problem: 'Customer not found for a known caller.', fix: 'QVO matches Customers on phone or email. Update the QuickBooks customer record with the caller\'s phone in E.164 format.' },
        { problem: 'Invoice created but blank line items.', fix: 'Invoice Item ID is unset or invalid. Pick a real Item Ref in the connector settings.' },
        { problem: 'Token revoked after 100 days of inactivity.', fix: 'Intuit revokes refresh tokens after 100 days with no API calls. Trigger Sync now at least once a quarter, or run a recurring health check.' },
      ]),
      p('For deeper detail on Intuit OAuth see: https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0.'),
    ],
  },
  {
    slug: 'webhooks',
    category: 'integrations',
    title: 'Webhooks',
    description: 'Subscribe to call events and receive signed HTTP POSTs in real time.',
    readTime: '5 min',
    updated: '2026-04-21',
    body: [
      h2('Subscribe'),
      p('Settings → Webhooks → Add Endpoint. Pick the events you want and provide your URL.'),
      h2('Events'),
      ul(['call.started', 'call.completed', 'call.escalated', 'call.failed', 'tool.executed', 'workflow.completed']),
      h2('Signature'),
      p('Each delivery includes an X-QVO-Signature header. Verify by HMAC-SHA256 of the raw body using your webhook secret.'),
      code(`POST https://your-api.example.com/webhooks/qvo
X-QVO-Signature: sha256=...
Content-Type: application/json

{
  "event": "call.completed",
  "call_id": "call_abc123",
  "agent_id": "agent_xyz",
  "duration_seconds": 180,
  "outcome": "appointment_scheduled"
}`, 'http'),
      h2('Retries'),
      p('Non-2xx responses are retried with exponential backoff for 24 hours.'),
    ],
  },

  // ---------------- MINI SYSTEMS ----------------
  {
    slug: 'sms-inbox',
    category: 'mini-systems',
    title: 'Using the SMS Inbox',
    description: 'Two-way SMS threads tied to your QVO numbers, with agent assist.',
    readTime: '5 min',
    updated: '2026-04-21',
    body: [
      p('The SMS Inbox provides a unified view of inbound and outbound texts on your QVO numbers. Threads are grouped by counterparty.'),
      h2('Sending'),
      ol(['Open SMS Inbox.', 'Pick a thread or click "New Message".', 'Compose; templates and AI suggestions are available in the side panel.']),
      h2('Agent assist'),
      p('Toggle "AI suggest" to have an LLM draft replies based on thread history and your business knowledge base. You always confirm before sending.'),
      warn('SMS to US numbers requires 10DLC registration. Without it, carriers may filter your messages.'),
    ],
  },
  {
    slug: 'managing-tickets',
    category: 'mini-systems',
    title: 'Managing tickets',
    description: 'Create, triage, and resolve tickets opened from calls or manually.',
    readTime: '5 min',
    updated: '2026-04-21',
    body: [
      h2('Creating'),
      p('Tickets can be created automatically from a call (via the create_ticket tool), manually from the Tickets page, or via the public API.'),
      h2('Triage'),
      ul(['Priority — Low, Medium, High, Urgent.', 'Status — Open, In Progress, Waiting, Resolved.', 'Assignee — any team member.', 'Tags — free-form for filtering.']),
      h2('Reporting'),
      p('Tickets → Reporting shows volume, time-to-resolve, SLA breaches, and per-agent performance.'),
    ],
  },
  {
    slug: 'scheduling-appointments',
    category: 'mini-systems',
    title: 'Scheduling appointments',
    description: 'Standalone scheduling that works with or without an external calendar.',
    readTime: '5 min',
    updated: '2026-04-21',
    body: [
      p('Scheduling provides a lightweight calendar inside QVO. If you have not connected an external calendar, the agent will book here directly.'),
      h2('Resources'),
      p('Add resources (people, rooms, equipment). Each resource has its own working hours and appointment types.'),
      h2('Booking'),
      ul(['Find next available — agent picks the soonest matching slot.', 'Offer choices — agent reads three options and lets the caller pick.', 'Confirm — caller is sent SMS or email confirmation automatically.']),
    ],
  },
  {
    slug: 'dispatch',
    category: 'mini-systems',
    title: 'Dispatch',
    description: 'Route field jobs to technicians with priority and zone awareness.',
    readTime: '5 min',
    updated: '2026-04-21',
    body: [
      p('Dispatch is for service businesses that route jobs to a roster of field workers. Jobs come in from calls, the API, or manual entry.'),
      h2('Configuring'),
      ul(['Add technicians with skills and zones.', 'Set business hours and on-call rotations.', 'Define routing rules (priority, skill, distance).']),
      h2('Day view'),
      p('The dispatch board shows jobs in the queue, in-progress, and completed for the current day. Drag to reassign.'),
    ],
  },

  // ---------------- API REFERENCE ----------------
  {
    slug: 'api-overview',
    category: 'api-reference',
    title: 'API overview',
    description: 'Base URL, versioning, content types, and rate limits.',
    readTime: '3 min',
    updated: '2026-04-21',
    body: [
      h2('Base URL'),
      code('https://api.qvo.ai/v1', 'text'),
      h2('Content type'),
      p('All requests and responses are JSON (application/json). Timestamps are ISO 8601 in UTC.'),
      h2('Versioning'),
      p('The version is in the URL (/v1). We will give 12 months notice before deprecating any v1 endpoint.'),
      h2('Rate limits'),
      ul(['Default: 60 requests/min per API key.', 'Bursts up to 120/min are tolerated for short periods.', '429 responses include a Retry-After header (seconds).']),
    ],
  },
  {
    slug: 'api-authentication',
    category: 'api-reference',
    title: 'Authentication',
    description: 'API keys, scopes, and JWTs for the dashboard.',
    readTime: '4 min',
    updated: '2026-04-21',
    body: [
      h2('API keys'),
      p('Create keys in Settings → API Keys. Each key is scoped to one tenant and one or more permissions (calls:read, agents:write, etc.).'),
      h2('Sending the key'),
      code(`curl https://api.qvo.ai/v1/calls \\
  -H "Authorization: Bearer qvo_live_..."`, 'bash'),
      h2('Rotation'),
      p('Rotate by creating a new key, updating clients, then revoking the old. Revoked keys stop authenticating immediately.'),
      warn('Never embed API keys in mobile or browser apps. Use the public widget token instead.'),
    ],
  },
  {
    slug: 'api-agents',
    category: 'api-reference',
    title: 'Agents API',
    description: 'Create, list, and update agents.',
    readTime: '4 min',
    updated: '2026-04-21',
    body: [
      h2('List agents'),
      code(`GET /v1/agents

Response:
{
  "data": [
    {
      "id": "agent_abc",
      "name": "After Hours Receptionist",
      "voice": "luna_warm",
      "status": "published"
    }
  ]
}`, 'http'),
      h2('Create agent'),
      code(`POST /v1/agents
{
  "name": "Outbound Reminder",
  "system_prompt": "...",
  "voice": "atlas_calm",
  "tools": ["schedule_appointment", "send_sms"]
}`, 'http'),
      h2('Update agent'),
      code('PATCH /v1/agents/{id}', 'http'),
    ],
  },
  {
    slug: 'api-calls',
    category: 'api-reference',
    title: 'Calls API',
    description: 'Query call history, transcripts, and recordings.',
    readTime: '4 min',
    updated: '2026-04-21',
    body: [
      h2('List calls'),
      code(`GET /v1/calls?from=2026-04-01&to=2026-04-21&agent_id=agent_abc&limit=50`, 'http'),
      h2('Get call'),
      code(`GET /v1/calls/{id}

Response includes transcript, recording_url, tool_executions, quality_score.`, 'http'),
      h2('Initiate outbound'),
      code(`POST /v1/calls
{
  "agent_id": "agent_abc",
  "to": "+15551234567",
  "from": "+15557654321",
  "context": { "first_name": "Alex" }
}`, 'http'),
    ],
  },
  {
    slug: 'api-webhooks',
    category: 'api-reference',
    title: 'Webhooks API',
    description: 'Programmatically register and manage webhook subscriptions.',
    readTime: '3 min',
    updated: '2026-04-21',
    body: [
      h2('Register'),
      code(`POST /v1/webhooks
{
  "url": "https://your-api.example.com/qvo",
  "events": ["call.completed", "call.escalated"]
}`, 'http'),
      h2('Verify signature'),
      p('HMAC-SHA256 of the raw request body using your webhook secret. Compare with X-QVO-Signature.'),
    ],
  },
  {
    slug: 'api-error-codes',
    category: 'api-reference',
    title: 'Error codes',
    description: 'HTTP status codes and structured error envelopes.',
    readTime: '2 min',
    updated: '2026-04-21',
    body: [
      ul([
        '400 invalid_request — malformed body, missing fields.',
        '401 unauthorized — missing or invalid API key.',
        '403 forbidden — key lacks the required scope.',
        '404 not_found — resource does not exist or is not in your tenant.',
        '409 conflict — duplicate idempotency key.',
        '429 rate_limited — slow down; check Retry-After.',
        '500 server_error — our fault; retry with exponential backoff.',
      ]),
      h2('Envelope'),
      code(`{
  "error": {
    "code": "invalid_request",
    "message": "voice is required",
    "field": "voice"
  }
}`, 'json'),
    ],
  },

  // ---------------- TROUBLESHOOTING ----------------
  {
    slug: 'call-quality',
    category: 'troubleshooting',
    title: 'Call quality issues',
    description: 'Diagnose latency, dropped audio, and choppy speech.',
    readTime: '5 min',
    updated: '2026-04-21',
    body: [
      issues([
        { problem: 'Long delays before the agent speaks.', fix: 'Open the call in Conversations → Diagnostics. If TTFB > 1.5s, switch to a faster voice or shorten the system prompt.' },
        { problem: 'Audio cuts in and out.', fix: 'Almost always a carrier issue on the caller side. Check the codec in Diagnostics; G.711 is most reliable.' },
        { problem: 'Agent talks over the caller.', fix: 'Lower the interruption sensitivity in agent Behavior settings.' },
        { problem: 'Echo or feedback.', fix: 'Usually a one-way issue with the caller hardware. Try with a different phone to confirm.' },
      ]),
    ],
  },
  {
    slug: 'integration-sync',
    category: 'troubleshooting',
    title: 'Integration sync failures',
    description: 'When connectors return errors or stop pushing data.',
    readTime: '4 min',
    updated: '2026-04-21',
    body: [
      issues([
        { problem: 'OAuth token expired.', fix: 'Reconnect the integration. We refresh tokens automatically but expired refresh tokens require re-auth.' },
        { problem: 'Field mapping errors in logs.', fix: 'Open the connector → Field Mapping. Required fields on the destination must be mapped.' },
        { problem: 'Records appear delayed.', fix: 'Most syncs are under 5s. Sustained delay indicates rate limits — check the connector status page.' },
      ]),
    ],
  },
  {
    slug: 'provisioning',
    category: 'troubleshooting',
    title: 'Number provisioning',
    description: 'Stuck phone number requests, port-ins, and 10DLC registration.',
    readTime: '4 min',
    updated: '2026-04-21',
    body: [
      issues([
        { problem: 'Number stuck in "provisioning".', fix: 'Most numbers complete in <30s. If stuck >5 min, contact support — likely a carrier-side delay.' },
        { problem: 'Port-in rejected.', fix: 'Verify CSR (Customer Service Record) matches your losing carrier records exactly, including suite numbers.' },
        { problem: '10DLC registration pending.', fix: 'Brand registration takes 1-3 business days; campaign vetting another 1-2. Plan launches accordingly.' },
      ]),
    ],
  },

  // ---------------- BILLING ----------------
  {
    slug: 'plans-and-pricing',
    category: 'billing',
    title: 'Plans and pricing',
    description: 'What is included in each tier and how usage is metered.',
    readTime: '4 min',
    updated: '2026-04-21',
    body: [
      h2('Plan tiers'),
      ul([
        'Trial — 30 free voice minutes, 1 agent, 1 number.',
        'Starter — for solo operators; included minutes plus per-minute overage.',
        'Growth — for multi-line teams; higher base, lower overage, premium voices.',
        'Enterprise — custom; SSO, BAA, dedicated support, contractual SLA.',
      ]),
      h2('What is metered'),
      ul(['Voice minutes (inbound + outbound).', 'SMS segments.', 'Knowledge-base storage above the included quota.', 'Premium voice surcharges.']),
    ],
  },
  {
    slug: 'invoices-and-payment',
    category: 'billing',
    title: 'Invoices and payment',
    description: 'Where to find invoices, update payment methods, and download receipts.',
    readTime: '3 min',
    updated: '2026-04-21',
    body: [
      ol([
        'Billing → Invoices.',
        'Click an invoice to see line items and download a PDF.',
        'Click "Manage Billing" to open the Stripe portal for cards, addresses, and tax IDs.',
      ]),
    ],
  },
  {
    slug: 'budget-controls',
    category: 'billing',
    title: 'Budget controls',
    description: 'Soft and hard caps to prevent surprise overage.',
    readTime: '3 min',
    updated: '2026-04-21',
    body: [
      h2('Soft cap'),
      p('Email notification when monthly usage crosses N% of your budget. No service interruption.'),
      h2('Hard cap'),
      p('Service is paused (inbound calls go to voicemail; outbound is blocked) when the cap is hit. Resumes at the next billing cycle or when raised.'),
      tip('Set both. Soft caps catch trends; hard caps protect against runaway loops.'),
    ],
  },
];

export function getDocBySlug(slug: string): DocArticle | undefined {
  return docArticles.find((a) => a.slug === slug);
}

export function getDocsByCategory(slug: DocCategorySlug): DocArticle[] {
  return docArticles.filter((a) => a.category === slug);
}

export function getAdjacentDocs(slug: string): { prev?: DocArticle; next?: DocArticle } {
  const idx = docArticles.findIndex((a) => a.slug === slug);
  return {
    prev: idx > 0 ? docArticles[idx - 1] : undefined,
    next: idx >= 0 && idx < docArticles.length - 1 ? docArticles[idx + 1] : undefined,
  };
}

export function searchDocs(query: string): DocArticle[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return docArticles.filter((a) => {
    const haystack = [
      a.title,
      a.description,
      a.category,
      ...a.body.flatMap((b) => {
        if (b.type === 'p' || b.type === 'h2' || b.type === 'h3') return [b.text];
        if (b.type === 'ul' || b.type === 'ol') return b.items;
        if (b.type === 'callout') return [b.text];
        if (b.type === 'code') return [b.text];
        if (b.type === 'common-issues') return b.items.flatMap((i) => [i.problem, i.fix]);
        return [];
      }),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

// Maps tenant page paths → primary doc slug for contextual help.
export const HELP_PAGE_MAP: Record<string, string> = {
  '/dashboard': 'core-concepts',
  '/agents': 'building-your-first-agent',
  '/agents/': 'building-your-first-agent',
  '/workflows': 'workflows-overview',
  '/calls': 'call-quality',
  '/campaigns': 'building-your-first-agent',
  '/connectors': 'integrations-overview',
  '/knowledge-base': 'core-concepts',
  '/analytics': 'core-concepts',
  '/marketplace': 'integrations-overview',
  '/settings': 'api-authentication',
  '/phone-numbers': 'provisioning',
  '/users': 'core-concepts',
  '/billing': 'plans-and-pricing',
  '/quality': 'call-quality',
  '/audit-log': 'core-concepts',
  '/compliance': 'core-concepts',
  '/widget': 'integrations-overview',
  '/developer': 'api-overview',
  '/sms-inbox': 'sms-inbox',
  '/scheduling': 'scheduling-appointments',
  '/tickets': 'managing-tickets',
  '/dispatch': 'dispatch',
};

export function findHelpForPath(path: string): string {
  if (HELP_PAGE_MAP[path]) return HELP_PAGE_MAP[path];
  const matchKey = Object.keys(HELP_PAGE_MAP)
    .filter((k) => k !== '/' && path.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return matchKey ? HELP_PAGE_MAP[matchKey] : 'quickstart';
}
