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
    slug: 'connecting-calendar',
    category: 'integrations',
    title: 'Connecting a calendar',
    description: 'Let the agent check availability and book appointments mid-call.',
    readTime: '6 min',
    updated: '2026-04-21',
    body: [
      ol([
        'Integrations → Google Calendar (or Outlook) → Connect.',
        'Approve calendar read/write scopes.',
        'Pick the calendar(s) the agent may book on.',
        'Configure availability windows, buffer times, and appointment types.',
      ]),
      tip('Keep buffer times realistic — 5-10 minutes prevents back-to-back overruns.'),
      h2('Confirmations'),
      p('Toggle automatic SMS or email confirmation. Reminders can be sent N hours before the appointment.'),
    ],
  },
  {
    slug: 'connecting-slack',
    category: 'integrations',
    title: 'Connecting Slack',
    description: 'Pipe call summaries, escalations, and missed-call alerts into Slack channels.',
    readTime: '4 min',
    updated: '2026-04-21',
    body: [
      ol([
        'Integrations → Slack → Connect.',
        'Authorize the QVO Slack app to post in your workspace.',
        'Map event types to channels (call.escalated → #front-desk, call.missed → #ops).',
      ]),
      info('Each message includes a link back to the full transcript and recording in QVO.'),
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
