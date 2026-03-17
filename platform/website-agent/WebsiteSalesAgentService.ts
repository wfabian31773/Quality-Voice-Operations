import { getPlatformPool } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('WEBSITE_SALES_AGENT');

const SYSTEM_PROMPT = `You are QVO's AI sales assistant on the QVO website. QVO (Quality Voice Operations) is an AI voice agent platform for small businesses.

YOUR ROLE: Help website visitors understand QVO, answer questions, recommend plans, launch demos, and capture leads — all through natural conversation.

BRAND VOICE: Professional, friendly, knowledgeable, concise. Use "we" when referring to QVO. Never be pushy — be genuinely helpful.

PLATFORM OVERVIEW:
QVO deploys intelligent AI voice agents that answer calls, book appointments, dispatch technicians, and handle customer inquiries 24/7. It replaces expensive call centers and missed calls with always-on AI receptionists.

KEY FEATURES:
- AI Voice Agents: Natural-sounding agents for inbound call answering
- Outbound Campaigns: Automated calling campaigns for reminders, follow-ups, lead nurturing
- CRM Integrations: Connects to existing business tools (Salesforce, HubSpot, Calendly, etc.)
- Call Analytics: Real-time dashboards with call outcomes, sentiment, quality scoring
- Agent Builder: Visual tool to customize agent personality, scripts, and escalation rules
- Widget: Embeddable chat/voice widget for websites
- Multi-channel: Phone, SMS, web chat support
- HIPAA Compliant: Enterprise-grade security with audit logging

AGENT TEMPLATES (Pre-built, ready to deploy):
1. Medical Receptionist — Patient intake, appointment scheduling, prescription refills, insurance verification
2. Dental Scheduling — Appointment booking, hygiene recall, cancellation management
3. Legal Intake — Case qualification, conflict checks, consultation scheduling
4. HVAC / Home Services — Service call intake, emergency triage, technician dispatch, SMS ETAs
5. Customer Support — FAQ handling, ticket creation, troubleshooting, satisfaction surveys
6. Outbound Sales — Automated dialing, lead qualification, appointment setting
7. Real Estate — Lead capture, property Q&A, showing scheduler
8. Collections — Payment reminders, plan negotiation, compliance scripts
9. Insurance Verification — Eligibility checks, benefits breakdown, prior auth tracking
10. Restaurant — Reservation booking, takeout orders, menu inquiries
11. Property Management — Maintenance requests, emergency triage, tenant communication
12. Appointment Reminder — Automated reminders, rescheduling, waitlist management

PRICING:
- Starter: $99/month — 500 AI minutes, up to 3 phone numbers, 3 team members, inbound calls, transcripts, analytics. Best for small practices getting started.
- Pro: $399/month — 2,500 AI minutes, up to 10 phone numbers, 10 team members, outbound campaigns, quality scoring, API access, CRM integrations, custom templates, priority support. Best for growing businesses. MOST POPULAR.
- Enterprise: $999/month — 10,000 AI minutes, unlimited phone numbers & team members, audit logs, multi-location support, dedicated onboarding. Best for multi-location organizations.
- All plans include a 14-day free trial, no credit card required.
- Overage rates: Starter $0.15/min, Pro $0.12/min, Enterprise $0.08/min.
- Annual billing saves 20%.

INSTRUCTIONS:
1. When a visitor asks about a product feature, explain it clearly and suggest trying a demo.
2. When asked about pricing, explain the tiers and recommend one based on their stated needs.
3. When a visitor mentions their industry, recommend the relevant agent template.
4. Collect lead information naturally during conversation (name, email, company, industry, business size) — don't ask for all at once.
5. When you have enough context, use the recommend_plan function to suggest a plan.
6. If a visitor wants to see a demo, use launch_demo to navigate them.
7. If a visitor wants to sign up, use navigate_to_page to guide them.
8. Track the current page context to provide relevant information.

IMPORTANT:
- Keep responses concise (2-4 sentences typically).
- Be conversational, not robotic.
- Don't repeat information the visitor already knows.
- If you don't know something specific, say so honestly and offer to connect them with the sales team.`;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'launch_demo',
      description: 'Navigate the visitor to the demo page to try a specific AI agent demo. Use when visitor wants to see a demo or try an agent.',
      parameters: {
        type: 'object',
        properties: {
          vertical: {
            type: 'string',
            description: 'The industry vertical for the demo (e.g., "medical", "dental", "hvac", "legal", "customer-support", "collections", "real-estate", "restaurant")',
          },
        },
        required: ['vertical'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'recommend_plan',
      description: 'Recommend a pricing plan based on the visitor\'s requirements. Use after learning about their business needs.',
      parameters: {
        type: 'object',
        properties: {
          plan: {
            type: 'string',
            enum: ['starter', 'pro', 'enterprise'],
            description: 'The recommended plan',
          },
          reason: {
            type: 'string',
            description: 'Brief reason for the recommendation',
          },
        },
        required: ['plan', 'reason'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'capture_lead',
      description: 'Save lead contact information collected during the conversation. Call this whenever you learn new contact details.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Contact name' },
          email: { type: 'string', description: 'Email address' },
          phone: { type: 'string', description: 'Phone number' },
          company: { type: 'string', description: 'Company name' },
          industry: { type: 'string', description: 'Business industry' },
          business_size: { type: 'string', description: 'Business size (e.g., "1-5 employees", "6-20", "21-100", "100+")' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'navigate_to_page',
      description: 'Navigate the visitor to a specific page on the QVO website.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The page path (e.g., "/signup", "/pricing", "/features", "/agents", "/contact", "/demo")',
          },
          query: {
            type: 'string',
            description: 'Optional query params (e.g., "plan=pro" for signup with plan preselected)',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'schedule_consultation',
      description: 'Offer to schedule a consultation call with the QVO sales team. Use when the visitor wants to talk to a human.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
          preferred_time: { type: 'string', description: 'Preferred time for the call' },
          notes: { type: 'string', description: 'Any notes about what they want to discuss' },
        },
        required: ['name', 'email'],
      },
    },
  },
];

function getPageContext(page: string): string {
  const contexts: Record<string, string> = {
    '/': 'The visitor is on the landing page. They may be new to QVO. Give a brief overview and suggest exploring demos or features.',
    '/pricing': 'The visitor is looking at pricing. They\'re likely evaluating costs. Help them choose the right plan based on their needs.',
    '/demo': 'The visitor is on the demo page. They want to see QVO in action. Help them choose an agent to try and explain what they\'ll experience.',
    '/features': 'The visitor is exploring features. Provide deep-dives on specific capabilities they ask about.',
    '/agents': 'The visitor is browsing agent templates. Help them find the right agent for their industry.',
    '/product': 'The visitor is learning about the platform. Explain how QVO works end-to-end.',
    '/use-cases': 'The visitor is looking at industry use cases. Ask about their industry to provide relevant information.',
    '/integrations': 'The visitor is checking integrations. Explain CRM and tool connections available.',
    '/contact': 'The visitor wants to get in touch. Offer to help directly or capture their info for a callback.',
    '/signup': 'The visitor is signing up! Help them through the process and answer any last-minute questions.',
    '/resources': 'The visitor is looking at resources. Help them find relevant guides and documentation.',
  };

  for (const [path, ctx] of Object.entries(contexts)) {
    if (page === path || page.startsWith(path + '/')) {
      return ctx;
    }
  }
  return 'The visitor is browsing the QVO website.';
}

export interface WebsiteAgentResponse {
  message: string;
  actions: WebsiteAgentAction[];
  conversationId: string;
}

export interface WebsiteAgentAction {
  type: 'launch_demo' | 'navigate' | 'recommend_plan' | 'capture_lead' | 'schedule_consultation';
  data: Record<string, unknown>;
}

interface ConversationState {
  messages: ChatMessage[];
  leadData: Record<string, string>;
  conversationId: string;
  lastActivityAt: number;
  lastPage: string;
}

const conversations = new Map<string, ConversationState>();

const CONVERSATION_TTL = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, state] of conversations) {
    if (now - state.lastActivityAt > CONVERSATION_TTL) {
      conversations.delete(id);
    }
  }
}, 5 * 60 * 1000);

export async function chat(
  conversationId: string,
  userMessage: string,
  sourcePage: string,
): Promise<WebsiteAgentResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set');
    return {
      message: 'I\'m currently unavailable. Please try again later or contact us at our contact page.',
      actions: [],
      conversationId,
    };
  }

  let state = conversations.get(conversationId);
  if (!state) {
    const pageContext = getPageContext(sourcePage);
    state = {
      messages: [
        {
          role: 'system',
          content: `${SYSTEM_PROMPT}\n\nCURRENT PAGE CONTEXT: ${pageContext}\nVisitor is currently on: ${sourcePage}`,
        },
      ],
      leadData: {},
      conversationId,
      lastActivityAt: Date.now(),
      lastPage: sourcePage,
    };
    conversations.set(conversationId, state);

    trackAnalytics('conversation_started', conversationId, sourcePage).catch(() => {});
  } else {
    if (state.lastPage !== sourcePage) {
      const newContext = getPageContext(sourcePage);
      state.messages[0] = {
        role: 'system',
        content: `${SYSTEM_PROMPT}\n\nCURRENT PAGE CONTEXT: ${newContext}\nVisitor is currently on: ${sourcePage} (previously on: ${state.lastPage})`,
      };
      trackAnalytics('page_changed', conversationId, sourcePage, { from: state.lastPage }).catch(() => {});
      state.lastPage = sourcePage;
    }
  }

  state.messages.push({ role: 'user', content: userMessage });
  state.lastActivityAt = Date.now();

  const actions: WebsiteAgentAction[] = [];
  let assistantMessage = '';

  try {
    let response = await callOpenAI(apiKey, state.messages);

    let iterations = 0;
    while (response.tool_calls && response.tool_calls.length > 0 && iterations < 5) {
      iterations++;

      state.messages.push({
        role: 'assistant',
        content: response.content ?? '',
        tool_calls: response.tool_calls,
      });

      for (const toolCall of response.tool_calls) {
        const fn = toolCall.function;
        const args = JSON.parse(fn.arguments);
        let result = '';

        switch (fn.name) {
          case 'launch_demo': {
            actions.push({ type: 'launch_demo', data: { vertical: args.vertical } });
            result = `Demo launched for ${args.vertical}. The visitor is being navigated to the demo page.`;
            trackAnalytics('demo_launched', conversationId, sourcePage, { vertical: args.vertical }).catch(() => {});
            break;
          }
          case 'recommend_plan': {
            actions.push({ type: 'recommend_plan', data: { plan: args.plan, reason: args.reason } });
            result = `Plan "${args.plan}" recommended. Reason: ${args.reason}`;
            trackAnalytics('plan_recommended', conversationId, sourcePage, { plan: args.plan }).catch(() => {});
            break;
          }
          case 'capture_lead': {
            Object.assign(state.leadData, args);
            actions.push({ type: 'capture_lead', data: args });
            await saveLead(conversationId, sourcePage, { ...state.leadData, ...args });
            result = 'Lead information captured successfully.';
            trackAnalytics('lead_captured', conversationId, sourcePage, args).catch(() => {});
            break;
          }
          case 'navigate_to_page': {
            const fullPath = args.query ? `${args.path}?${args.query}` : args.path;
            actions.push({ type: 'navigate', data: { path: fullPath } });
            result = `Navigating visitor to ${fullPath}.`;
            trackAnalytics('page_navigated', conversationId, sourcePage, { path: fullPath }).catch(() => {});
            break;
          }
          case 'schedule_consultation': {
            actions.push({ type: 'schedule_consultation', data: args });
            if (args.name || args.email) {
              Object.assign(state.leadData, { name: args.name, email: args.email });
              await saveLead(conversationId, sourcePage, { ...state.leadData, notes: `Consultation requested: ${args.notes || ''}. Preferred time: ${args.preferred_time || 'not specified'}` });
            }
            result = 'Consultation request noted. The sales team will follow up.';
            trackAnalytics('consultation_scheduled', conversationId, sourcePage, args).catch(() => {});
            break;
          }
          default:
            result = 'Function not recognized.';
        }

        state.messages.push({
          role: 'tool',
          content: result,
          tool_call_id: toolCall.id,
        });
      }

      response = await callOpenAI(apiKey, state.messages);
    }

    assistantMessage = response.content ?? 'I\'m here to help! What would you like to know about QVO?';
    state.messages.push({ role: 'assistant', content: assistantMessage });

    trackAnalytics('message_sent', conversationId, sourcePage).catch(() => {});

  } catch (err) {
    logger.error('Chat completion failed', { error: String(err), conversationId });
    assistantMessage = 'I apologize, but I\'m having trouble right now. You can reach our team directly at the contact page, or try again in a moment.';
  }

  return {
    message: assistantMessage,
    actions,
    conversationId,
  };
}

async function callOpenAI(
  apiKey: string,
  messages: ChatMessage[],
): Promise<{ content: string | null; tool_calls?: ToolCall[] }> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: messages.map(m => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        if (m.name) msg.name = m.name;
        return msg;
      }),
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.7,
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} — ${errText}`);
  }

  const data = await response.json() as {
    choices: Array<{
      message: {
        content: string | null;
        tool_calls?: ToolCall[];
      };
    }>;
  };

  const choice = data.choices?.[0]?.message;
  return {
    content: choice?.content ?? null,
    tool_calls: choice?.tool_calls,
  };
}

export async function saveLead(
  conversationId: string,
  sourcePage: string,
  data: Record<string, string>,
): Promise<string | null> {
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `INSERT INTO website_leads (name, email, phone, company, industry, business_size, recommended_plan, source_page, conversation_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (conversation_id) WHERE conversation_id IS NOT NULL
       DO UPDATE SET
         name = COALESCE(EXCLUDED.name, website_leads.name),
         email = COALESCE(EXCLUDED.email, website_leads.email),
         phone = COALESCE(EXCLUDED.phone, website_leads.phone),
         company = COALESCE(EXCLUDED.company, website_leads.company),
         industry = COALESCE(EXCLUDED.industry, website_leads.industry),
         business_size = COALESCE(EXCLUDED.business_size, website_leads.business_size),
         recommended_plan = COALESCE(EXCLUDED.recommended_plan, website_leads.recommended_plan),
         notes = COALESCE(EXCLUDED.notes, website_leads.notes),
         updated_at = NOW()
       RETURNING id`,
      [
        data.name || null,
        data.email || null,
        data.phone || null,
        data.company || null,
        data.industry || null,
        data.business_size || null,
        data.recommended_plan || null,
        sourcePage,
        conversationId,
        data.notes || null,
      ],
    );
    logger.info('Lead saved', { conversationId, leadId: rows[0]?.id });
    return rows[0]?.id ?? null;
  } catch (err) {
    logger.error('Failed to save lead', { error: String(err), conversationId });
    return null;
  }
}

export async function trackAnalytics(
  eventType: string,
  conversationId: string,
  sourcePage: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const pool = getPlatformPool();
  try {
    await pool.query(
      `INSERT INTO website_agent_analytics (event_type, conversation_id, source_page, metadata)
       VALUES ($1, $2, $3, $4)`,
      [eventType, conversationId, sourcePage, JSON.stringify(metadata)],
    );
  } catch (err) {
    logger.error('Failed to track analytics', { error: String(err), eventType });
  }
}

export async function getLeads(
  status?: string,
  limit: number = 50,
  offset: number = 0,
): Promise<{ leads: Record<string, unknown>[]; total: number }> {
  const pool = getPlatformPool();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await pool.query(
    `SELECT COUNT(*)::int as total FROM website_leads ${where}`,
    params,
  );

  params.push(limit);
  params.push(offset);
  const { rows } = await pool.query(
    `SELECT * FROM website_leads ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return {
    leads: rows,
    total: countResult.rows[0]?.total ?? 0,
  };
}

export async function getAnalyticsSummary(): Promise<Record<string, unknown>> {
  const pool = getPlatformPool();
  try {
    const [conversations, demos, leads, navigations] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int as count FROM website_agent_analytics WHERE event_type = 'conversation_started' AND created_at >= NOW() - INTERVAL '30 days'`),
      pool.query(`SELECT COUNT(*)::int as count FROM website_agent_analytics WHERE event_type = 'demo_launched' AND created_at >= NOW() - INTERVAL '30 days'`),
      pool.query(`SELECT COUNT(*)::int as count FROM website_agent_analytics WHERE event_type = 'lead_captured' AND created_at >= NOW() - INTERVAL '30 days'`),
      pool.query(`SELECT COUNT(*)::int as count FROM website_agent_analytics WHERE event_type = 'page_navigated' AND created_at >= NOW() - INTERVAL '30 days'`),
    ]);

    const dailyBreakdown = await pool.query(
      `SELECT DATE(created_at) as date, event_type, COUNT(*)::int as count
       FROM website_agent_analytics
       WHERE created_at >= NOW() - INTERVAL '30 days'
       GROUP BY DATE(created_at), event_type
       ORDER BY date DESC`,
    );

    return {
      last30Days: {
        conversationsStarted: conversations.rows[0]?.count ?? 0,
        demosLaunched: demos.rows[0]?.count ?? 0,
        leadsCaptured: leads.rows[0]?.count ?? 0,
        pagesNavigated: navigations.rows[0]?.count ?? 0,
      },
      dailyBreakdown: dailyBreakdown.rows,
    };
  } catch (err) {
    logger.error('Failed to get analytics summary', { error: String(err) });
    return { last30Days: {}, dailyBreakdown: [] };
  }
}

export function getGreeting(page: string): string {
  const greetings: Record<string, string> = {
    '/': 'Hi there! I\'m QVO\'s AI assistant. I can help you learn about our voice agent platform, see demos, or find the right plan for your business. What brings you here today?',
    '/pricing': 'Hey! Looking at our plans? I can help you figure out which tier is the best fit based on your business needs. What kind of business are you running?',
    '/demo': 'Welcome to the demo page! Want me to walk you through how our agents work, or help you pick the best one to try? What industry are you in?',
    '/features': 'Exploring our features? I\'d love to help you understand how QVO can work for your business. Any specific capability you\'re curious about?',
    '/agents': 'Browsing our agent templates? We have pre-built agents for many industries. Tell me about your business and I\'ll recommend the best fit!',
    '/product': 'Want to learn how QVO works? I can give you a quick overview or dive deep into any part of the platform. What would you like to know?',
    '/use-cases': 'Checking out our use cases? Tell me your industry and I\'ll show you exactly how QVO can help your business.',
    '/integrations': 'Looking at integrations? We connect with 50+ tools. What systems does your business currently use?',
    '/contact': 'Want to get in touch? I can help answer questions right now, or I can connect you with our sales team. What do you need?',
    '/signup': 'Great to see you\'re ready to get started! Need help choosing a plan or have any last questions before signing up?',
  };

  return greetings[page] || 'Hi! I\'m QVO\'s AI assistant. How can I help you today?';
}
