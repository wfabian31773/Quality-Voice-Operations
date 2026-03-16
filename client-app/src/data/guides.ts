import {
  Rocket, Bot, Plug, Megaphone,
  BookOpen, Settings, Zap, BarChart3,
  Shield, Phone, Key, FileText,
} from 'lucide-react';

export type GuideCategory =
  | 'Getting Started'
  | 'Platform Guides'
  | 'Integration Tutorials'
  | 'API Reference'
  | 'Best Practices';

export interface Guide {
  slug: string;
  title: string;
  description: string;
  category: GuideCategory;
  icon: React.ElementType;
  readTime: string;
  content: GuideSection[];
}

export interface GuideSection {
  title: string;
  body: string;
  code?: string;
}

export const categories: { name: GuideCategory; icon: React.ElementType; description: string }[] = [
  { name: 'Getting Started', icon: Rocket, description: 'Set up your account, configure your first agent, and start handling calls.' },
  { name: 'Platform Guides', icon: Settings, description: 'Deep dives into platform features like campaigns, analytics, and team management.' },
  { name: 'Integration Tutorials', icon: Plug, description: 'Connect QVO to your CRM, calendar, helpdesk, and custom systems.' },
  { name: 'API Reference', icon: Key, description: 'Programmatic access to agents, calls, numbers, and analytics.' },
  { name: 'Best Practices', icon: Shield, description: 'Optimize agent performance, call quality, and operational efficiency.' },
];

export const guides: Guide[] = [
  {
    slug: 'getting-started-with-qvo',
    title: 'Getting Started with QVO',
    description: 'Create your account, navigate the dashboard, and understand the core concepts behind QVO\'s voice operations platform.',
    category: 'Getting Started',
    icon: Rocket,
    readTime: '8 min read',
    content: [
      {
        title: 'Create your account',
        body: 'Visit the QVO signup page and enter your business details. You\'ll need your company name, email address, and a phone number for verification. Once you confirm your email, your tenant environment is provisioned automatically with a sandbox agent ready to test.',
      },
      {
        title: 'Navigate the dashboard',
        body: 'After logging in, you\'ll land on the Dashboard. The sidebar gives you access to Agents, Phone Numbers, Calls, Campaigns, Analytics, and Settings. The dashboard shows your call volume, active agents, and recent activity at a glance. Use the top bar to switch between tenants if you manage multiple locations.',
      },
      {
        title: 'Understand key concepts',
        body: 'QVO is built around a few core concepts:\n\n- **Agents**: AI-powered voice agents that handle phone calls. Each agent has a system prompt, voice configuration, and routing rules.\n- **Phone Numbers**: Local or toll-free numbers provisioned through the platform and assigned to agents.\n- **Campaigns**: Outbound calling sequences with contact lists, retry logic, and outcome tracking.\n- **Connectors**: Integrations with your existing tools (CRM, calendar, helpdesk).\n- **Quality Scoring**: Automated analysis of call transcripts for compliance and performance.',
      },
      {
        title: 'Make your first test call',
        body: 'Navigate to the Agents page and click into the sandbox agent. Use the "Test Call" button to initiate a call to your verified phone number. Speak with the agent to see how it handles the conversation, then review the transcript and recording in the Calls section.',
      },
      {
        title: 'Next steps',
        body: 'Now that you\'ve made your first call, you\'re ready to configure a production agent. Follow the "Setting Up Your First Agent" guide to customize your agent\'s voice, personality, and routing rules for your specific business needs.',
      },
    ],
  },
  {
    slug: 'setting-up-your-first-agent',
    title: 'Setting Up Your First Agent',
    description: 'Configure an AI voice agent with the right personality, voice, and routing rules for your business.',
    category: 'Getting Started',
    icon: Bot,
    readTime: '10 min read',
    content: [
      {
        title: 'Choose an industry template',
        body: 'QVO provides pre-built templates for common industries: Medical, Dental, Legal, Property Management, Customer Support, and General Business. Each template includes an optimized system prompt, appropriate escalation rules, and industry-specific conversation flows. Select the template closest to your use case — you can customize everything afterward.',
      },
      {
        title: 'Configure the system prompt',
        body: 'The system prompt defines your agent\'s personality, knowledge, and behavior. Write it in natural language describing how the agent should greet callers, what information to collect, when to escalate, and how to handle common scenarios.',
        code: `Example system prompt:

You are the after-hours receptionist for Riverside
Medical Clinic. Your role is to:

1. Greet callers warmly and identify yourself as the
   after-hours assistant
2. Ask for their name and date of birth for
   identification
3. Determine the reason for their call
4. For urgent symptoms (chest pain, difficulty
   breathing, severe bleeding), advise calling 911
   and notify the on-call provider
5. For non-urgent matters, offer to schedule a
   callback for the next business day
6. Always confirm the caller's preferred callback
   number`,
      },
      {
        title: 'Select a voice',
        body: 'Choose from multiple voice options that vary by gender, accent, tone, and speaking pace. Preview each voice with a sample sentence before selecting. For healthcare settings, we recommend a calm, measured voice. For sales, a more energetic tone works well. You can always change the voice later without affecting your routing rules or system prompt.',
      },
      {
        title: 'Set up routing rules',
        body: 'Routing rules determine what happens after the agent completes a conversation. Configure rules for:\n\n- **Escalation**: Transfer to a live person based on caller intent or urgency keywords.\n- **Scheduling**: Connect to your calendar system to book appointments during the call.\n- **Notifications**: Send SMS or email alerts to staff when specific call outcomes occur.\n- **Tagging**: Automatically categorize calls by topic for reporting.',
      },
      {
        title: 'Assign a phone number',
        body: 'Go to the Phone Numbers section and provision a new local or toll-free number, or port an existing number. Assign it to your agent. Once assigned, any call to that number is answered by your AI agent. You can assign multiple numbers to one agent or different agents to different numbers.',
      },
      {
        title: 'Test and iterate',
        body: 'Use the built-in test call feature to call your agent and evaluate the conversation. Review transcripts in the Calls section. Adjust the system prompt based on how the agent handles edge cases. Most teams refine their prompt 3-5 times before going live.',
      },
    ],
  },
  {
    slug: 'connecting-integrations',
    title: 'Connecting Integrations',
    description: 'Link QVO to your CRM, calendar, helpdesk, and other business tools for seamless workflows.',
    category: 'Integration Tutorials',
    icon: Plug,
    readTime: '12 min read',
    content: [
      {
        title: 'Why integrate?',
        body: 'Integrations let your AI agent read and write data in your existing systems during calls. When a patient calls, the agent can check their upcoming appointments in your calendar, create a follow-up task in your CRM, or log a ticket in your helpdesk — all without manual data entry by your staff.',
      },
      {
        title: 'Browse the Marketplace',
        body: 'Navigate to the Marketplace from the sidebar. You\'ll see available integrations organized by category: CRM, Scheduling, Ticketing, Communication, EHR, and more. Each integration card shows what it connects to and what data flows are supported.',
      },
      {
        title: 'Install a CRM integration',
        body: 'Let\'s walk through connecting a CRM. Click the integration card, then "Install". You\'ll be prompted to authenticate with your CRM provider using OAuth. Once authenticated, configure the data mapping:\n\n- **Contact lookup**: Match incoming callers by phone number to CRM contacts.\n- **Call logging**: Automatically create a call activity record after each call.\n- **Task creation**: Generate follow-up tasks based on call outcomes.\n- **Field mapping**: Map QVO call data fields to your CRM custom fields.',
      },
      {
        title: 'Connect a calendar',
        body: 'Calendar integrations allow your agent to check availability and book appointments during calls. After installing, configure:\n\n- **Calendar selection**: Choose which calendars the agent can access.\n- **Availability windows**: Define bookable hours and buffer times between appointments.\n- **Appointment types**: Map conversation intents to specific appointment types and durations.\n- **Confirmation**: Enable automatic SMS or email confirmations to the caller.',
      },
      {
        title: 'Set up webhooks for custom systems',
        body: 'For systems without a pre-built integration, use webhooks. Navigate to Settings > Webhooks and create a new endpoint. Choose which events to subscribe to (call.started, call.completed, call.escalated, etc.) and specify your endpoint URL.',
        code: `POST https://your-api.example.com/webhooks/qvo

Headers:
  X-QVO-Signature: sha256=abc123...
  Content-Type: application/json

Body:
{
  "event": "call.completed",
  "call_id": "call_abc123",
  "agent_id": "agent_xyz",
  "duration_seconds": 180,
  "outcome": "appointment_scheduled",
  "transcript_url": "https://api.qvo.ai/v1/calls/
    call_abc123/transcript",
  "caller_phone": "+15551234567",
  "timestamp": "2025-01-15T14:30:00Z"
}`,
      },
      {
        title: 'Test the integration',
        body: 'After connecting, make a test call and verify that data flows correctly to your external system. Check the Connectors page for sync status and any error logs. Common issues include expired OAuth tokens (re-authenticate) and field mapping mismatches (update your mapping configuration).',
      },
    ],
  },
  {
    slug: 'running-your-first-campaign',
    title: 'Running Your First Campaign',
    description: 'Set up an outbound calling campaign with contact lists, scheduling, retry logic, and outcome tracking.',
    category: 'Platform Guides',
    icon: Megaphone,
    readTime: '10 min read',
    content: [
      {
        title: 'What are campaigns?',
        body: 'Campaigns are outbound calling sequences where your AI agent proactively calls a list of contacts. Use campaigns for appointment reminders, patient recall, satisfaction surveys, payment follow-ups, lead outreach, and more. Each campaign has its own agent configuration, schedule, and contact list.',
      },
      {
        title: 'Create a new campaign',
        body: 'Go to Campaigns and click "New Campaign". Give it a name and description, then select or create the agent that will handle the calls. Campaign agents typically need a different system prompt than inbound agents — they\'re initiating the conversation rather than responding to one.',
        code: `Example outbound system prompt:

You are calling on behalf of Riverside Dental to
remind patients about their upcoming appointments.

1. Introduce yourself: "Hi, this is the appointment
   reminder service for Riverside Dental."
2. Confirm you're speaking with the right person
3. Share the appointment details (date, time,
   provider)
4. Ask if they'd like to confirm, reschedule, or
   cancel
5. If rescheduling, offer the next 3 available slots
6. Thank them and end the call`,
      },
      {
        title: 'Upload your contact list',
        body: 'Prepare a CSV file with your contacts. Required columns: phone_number. Optional columns: first_name, last_name, email, and any custom fields your agent prompt references (like appointment_date). Upload the CSV on the campaign page. QVO validates phone numbers and removes duplicates automatically.\n\nThe system also checks against your Do-Not-Call (DNC) list and removes any matching numbers before dialing begins.',
      },
      {
        title: 'Configure the schedule',
        body: 'Set the calling window for your campaign:\n\n- **Start and end dates**: When the campaign should run.\n- **Daily calling hours**: Respect your contacts\' timezone (e.g., 9 AM - 6 PM local time).\n- **Calls per hour**: Throttle the dialing rate based on your needs.\n- **Retry logic**: How many times to retry unanswered calls, and the delay between attempts.\n- **Answering machine detection**: Choose whether to leave a voicemail or retry later when a machine answers.',
      },
      {
        title: 'Launch and monitor',
        body: 'Review your campaign summary — contact count, estimated duration, agent assignment — then click "Launch". Monitor progress in real time from the campaign dashboard:\n\n- **Connected**: Calls where the contact answered and the agent had a conversation.\n- **No answer**: Calls that weren\'t picked up (queued for retry if configured).\n- **Voicemail**: Calls that reached an answering machine.\n- **Completed**: Calls where the agent achieved the campaign objective.\n- **Failed**: Calls that couldn\'t be placed (invalid number, carrier rejection).',
      },
      {
        title: 'Review results',
        body: 'After the campaign completes, review the results in the Analytics section. You can see outcome breakdowns, average call duration, and individual call transcripts. Export the results as a CSV for your records. Use the insights to refine your agent prompt and contact list targeting for future campaigns.',
      },
    ],
  },
];

export function getGuideBySlug(slug: string): Guide | undefined {
  return guides.find((g) => g.slug === slug);
}

export function getGuidesByCategory(category: GuideCategory): Guide[] {
  return guides.filter((g) => g.category === category);
}

export function getAdjacentGuides(slug: string): { prev?: Guide; next?: Guide } {
  const idx = guides.findIndex((g) => g.slug === slug);
  return {
    prev: idx > 0 ? guides[idx - 1] : undefined,
    next: idx < guides.length - 1 ? guides[idx + 1] : undefined,
  };
}
