import { getPlatformPool } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('PLATFORM_ASSISTANT');

export interface AssistantMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  actions?: AssistantActionResult[];
  timestamp?: string;
}

export interface AssistantActionResult {
  action: string;
  status: 'success' | 'error';
  result?: unknown;
  message?: string;
}

interface ChatCompletionMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}

const PAGE_CONTEXT_PROMPTS: Array<[string, string]> = [
  ['/onboarding', 'The user is on the Onboarding page, setting up their account for the first time. Guide them through template selection, phone number setup, and getting their first agent running.'],
  ['/agents/*/builder', 'The user is in the Agent Builder. Help them configure their agent workflow, write effective prompts, select voices, attach tools, and deploy their agent.'],
  ['/dashboard', 'The user is on the Dashboard page. They can see their activation progress, recent calls, and key metrics. Suggest completing any remaining setup steps.'],
  ['/agents', 'The user is on the Agents page. Help them create, configure, or improve their AI voice agents. Offer prompt suggestions and template recommendations.'],
  ['/phone-numbers', 'The user is on the Phone Numbers page. Help them connect a phone number to their agent or explain how phone routing works.'],
  ['/calls', 'The user is on the Call History page. Help them understand call analytics, review transcripts, or troubleshoot call quality issues.'],
  ['/connectors', 'The user is on the Connectors/Integrations page. Help them connect tools like CRM, scheduling, ticketing, or SMS systems.'],
  ['/billing', 'The user is on the Billing page. Help them understand plan differences, usage, and when to upgrade.'],
  ['/knowledge-base', 'The user is on the Knowledge Base page. Help them add articles, FAQs, or documents that their agents can reference during calls.'],
  ['/widget', 'The user is on the Widget page. Help them configure and embed the web chat/voice widget on their website.'],
  ['/campaigns', 'The user is on the Campaigns page. Help them set up outbound calling campaigns.'],
  ['/analytics', 'The user is on the Analytics page. Help them understand their metrics and performance data.'],
  ['/quality', 'The user is on the Quality page. Help them review call quality scores and set up evaluation criteria.'],
  ['/settings', 'The user is on the Settings page. Help them configure their account settings.'],
  ['/marketplace', 'The user is on the Marketplace page. Help them discover and install agent templates and integrations.'],
  ['/operations', 'The user is on the Operations page. Help them monitor real-time system status and alerts.'],
  ['/global-intelligence', 'The user is on the Global Intelligence Network page. Help them understand industry benchmarks, best practices from the platform network, and network-sourced recommendations. They can also manage their GIN participation settings here.'],
];

function matchPageContext(path: string): string | null {
  for (const [pattern, context] of PAGE_CONTEXT_PROMPTS) {
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '[^/]+') + '$');
      if (regex.test(path)) return context;
    } else if (path === pattern || path.startsWith(pattern + '/') || path === pattern) {
      return context;
    }
  }
  return null;
}

const SYSTEM_PROMPT = `You are the QVO Platform Assistant — a helpful, knowledgeable guide built into the QVO AI voice agent platform. Your role is to help users set up and configure their AI agents, connect integrations, and get the most out of the platform.

Key capabilities you can help with:
- Creating and configuring AI voice agents (choosing templates, writing prompts, selecting voices)
- Connecting phone numbers
- Setting up integrations (CRM, scheduling, ticketing, SMS)
- Configuring the web widget for website embedding
- Understanding billing plans and usage
- Managing the knowledge base
- Setting up outbound campaigns
- Reviewing call quality and analytics
- Troubleshooting common issues

When helping users:
1. Be concise and actionable — provide step-by-step guidance
2. Reference specific platform features and pages by name
3. When suggesting actions, explain what each action will do
4. If you can execute an action for them (like creating an agent), offer to do so
5. If you cannot resolve their issue, offer to create a support ticket

You have access to the following tools to execute actions on behalf of the user:
- list_agents: List the user's configured agents
- create_agent: Create a new agent from a template (admin only)
- deploy_agent: Deploy/publish an agent (admin only)
- list_connectors: List connected integrations
- connect_integration: Connect a new integration like CRM, scheduling, ticketing, SMS (admin only)
- get_widget_config: Get current widget configuration
- enable_widget: Enable or configure the web chat widget (admin only)
- generate_prompt: Generate or improve a system prompt for an agent
- get_billing_info: Get current plan and usage information
- search_knowledge: Search the knowledge base
- assign_phone_number: List phone numbers and their agent assignments
- create_support_ticket: Escalate to human support

Some actions require admin privileges. If the user doesn't have the right role, suggest they contact their team admin.

For guided agent setup, walk the user through: 1) Choose a template type, 2) Create the agent, 3) Generate/customize the prompt, 4) Check phone number assignment, 5) Connect relevant integrations, 6) Enable the widget if needed, 7) Deploy the agent.

Always be friendly, professional, and proactive. If the user seems stuck, suggest next steps based on their current page and setup progress.`;

const ADMIN_ROLES = new Set(['tenant_owner', 'operations_manager', 'billing_admin', 'agent_developer']);

const ASSISTANT_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'list_agents',
      description: 'List all agents configured for this tenant',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_agent',
      description: 'Create a new AI voice agent (requires admin role)',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name for the agent' },
          type: {
            type: 'string',
            enum: ['general', 'answering-service', 'medical-after-hours', 'outbound-scheduling', 'appointment-confirmation', 'dental', 'property-management', 'home-services', 'legal', 'customer-support', 'outbound-sales', 'technical-support'],
            description: 'Agent template type',
          },
          system_prompt: { type: 'string', description: 'Custom system prompt for the agent' },
        },
        required: ['name', 'type'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'deploy_agent',
      description: 'Deploy/publish an agent (requires admin role)',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The ID of the agent to deploy' },
        },
        required: ['agent_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_connectors',
      description: 'List all connected integrations for this tenant',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_widget_config',
      description: 'Get the current widget configuration for this tenant',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'enable_widget',
      description: 'Enable or configure the web chat widget (requires admin role)',
      parameters: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', description: 'Whether to enable the widget' },
          agent_id: { type: 'string', description: 'Agent ID to associate with the widget' },
          greeting: { type: 'string', description: 'Widget greeting message' },
        },
        required: ['enabled'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'generate_prompt',
      description: 'Generate or improve a system prompt for an agent based on description',
      parameters: {
        type: 'object',
        properties: {
          agent_type: { type: 'string', description: 'Type of agent (e.g., answering-service, dental, legal)' },
          business_description: { type: 'string', description: 'Description of the business and what the agent should do' },
          existing_prompt: { type: 'string', description: 'Existing prompt to improve (optional)' },
        },
        required: ['agent_type', 'business_description'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_billing_info',
      description: 'Get current billing plan and usage information',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_knowledge',
      description: 'Search the knowledge base for relevant articles and documentation',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'connect_integration',
      description: 'Connect a new integration/connector (requires admin role). Sets up CRM, scheduling, ticketing, SMS, or other integrations.',
      parameters: {
        type: 'object',
        properties: {
          connector_type: { type: 'string', enum: ['ticketing', 'sms', 'crm', 'scheduling', 'ehr', 'email', 'webhook', 'custom'], description: 'Type of integration' },
          provider: { type: 'string', description: 'Provider name (e.g., servicetitan, housecall-pro, jira, zendesk)' },
          name: { type: 'string', description: 'Display name for the integration' },
        },
        required: ['connector_type', 'provider', 'name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'assign_phone_number',
      description: 'List available phone numbers and their agent assignments, or get guidance on connecting a phone number to an agent',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Agent ID to check or assign (optional)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_support_ticket',
      description: 'Create a support ticket for issues the assistant cannot resolve',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Brief summary of the issue' },
          description: { type: 'string', description: 'Detailed description of the problem' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Priority level' },
        },
        required: ['subject', 'description'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_network_recommendations',
      description: 'Get actionable recommendations from the Global Intelligence Network based on anonymized cross-tenant insights and industry best practices',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

const PRIVILEGED_TOOLS = new Set(['create_agent', 'deploy_agent', 'enable_widget', 'connect_integration']);

async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  tenantId: string,
  userRole: string,
  sessionId?: string,
): Promise<AssistantActionResult> {
  if (PRIVILEGED_TOOLS.has(toolName) && !ADMIN_ROLES.has(userRole)) {
    return {
      action: toolName,
      status: 'error',
      message: `You don't have permission to perform this action. Please contact an admin user on your team.`,
    };
  }

  const pool = getPlatformPool();

  try {
    switch (toolName) {
      case 'list_agents': {
        const { rows } = await pool.query(
          `SELECT id, name, type, status, voice, created_at FROM agents WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20`,
          [tenantId],
        );
        return { action: 'list_agents', status: 'success', result: { agents: rows, count: rows.length } };
      }

      case 'create_agent': {
        const name = args.name as string;
        const type = args.type as string || 'general';
        const systemPrompt = args.system_prompt as string || null;

        const { checkTrialAgentLimit } = await import('../billing/guardrails/TrialGuard');
        const limitCheck = await checkTrialAgentLimit(tenantId);
        if (!limitCheck.allowed) {
          return { action: 'create_agent', status: 'error', message: limitCheck.reason || 'Agent limit reached for your plan' };
        }

        const { rows } = await pool.query(
          `INSERT INTO agents (tenant_id, name, type, system_prompt, voice, model, temperature, tools, escalation_config, metadata)
           VALUES ($1, $2, $3, $4, 'alloy', 'gpt-4o-realtime-preview', 0.8, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb)
           RETURNING id, name, type, status`,
          [tenantId, name, type, systemPrompt],
        );

        try {
          const { recordActivationEvent } = await import('../activation/ActivationService');
          await recordActivationEvent(tenantId, 'tenant_agent_created', { agentId: rows[0].id, source: 'assistant' });
        } catch {}

        return { action: 'create_agent', status: 'success', result: { agent: rows[0] }, message: `Agent "${name}" created successfully` };
      }

      case 'deploy_agent': {
        const agentId = args.agent_id as string;
        if (!agentId) {
          return { action: 'deploy_agent', status: 'error', message: 'agent_id is required' };
        }

        const { rows: agentRows } = await pool.query(
          `SELECT id, name, status FROM agents WHERE id = $1 AND tenant_id = $2`,
          [agentId, tenantId],
        );
        if (agentRows.length === 0) {
          return { action: 'deploy_agent', status: 'error', message: 'Agent not found' };
        }

        const { rows } = await pool.query(
          `UPDATE agents SET status = 'deployed', updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING id, name, status`,
          [agentId, tenantId],
        );

        try {
          const { recordActivationEvent } = await import('../activation/ActivationService');
          await recordActivationEvent(tenantId, 'tenant_agent_deployed', { agentId, source: 'assistant' });
        } catch {}

        return { action: 'deploy_agent', status: 'success', result: { agent: rows[0] }, message: `Agent "${rows[0].name}" deployed successfully` };
      }

      case 'list_connectors': {
        const { rows } = await pool.query(
          `SELECT id, integration_type, provider, name, is_enabled, created_at FROM integrations WHERE tenant_id = $1 ORDER BY created_at DESC`,
          [tenantId],
        );
        return { action: 'list_connectors', status: 'success', result: { connectors: rows, count: rows.length } };
      }

      case 'get_widget_config': {
        const { rows } = await pool.query(
          `SELECT agent_id, enabled, greeting, primary_color, text_chat_enabled, voice_enabled FROM widget_configs WHERE tenant_id = $1 LIMIT 1`,
          [tenantId],
        );
        const config = rows[0] || null;
        return { action: 'get_widget_config', status: 'success', result: { config } };
      }

      case 'enable_widget': {
        const enabled = args.enabled as boolean;
        const agentId = (args.agent_id as string) || null;
        const greeting = (args.greeting as string) || null;

        const { upsertWidgetConfig } = await import('../widget/WidgetTokenService');
        const update: Record<string, unknown> = { enabled };
        if (agentId) update.agent_id = agentId;
        if (greeting) update.greeting = greeting;

        const config = await upsertWidgetConfig(tenantId, update);
        return {
          action: 'enable_widget',
          status: 'success',
          result: { config },
          message: enabled ? 'Widget enabled successfully' : 'Widget disabled',
        };
      }

      case 'generate_prompt': {
        const agentType = args.agent_type as string;
        const businessDesc = args.business_description as string;
        const existingPrompt = args.existing_prompt as string | undefined;

        const promptTemplates: Record<string, string> = {
          'answering-service': `You are a professional virtual receptionist for ${businessDesc}. Answer calls warmly, take messages accurately, and route urgent calls appropriately. Always confirm caller details before ending the call.`,
          'medical-after-hours': `You are an after-hours medical answering service for ${businessDesc}. Triage calls by urgency, collect patient information, and escalate emergencies immediately. Never provide medical advice or diagnoses.`,
          'dental': `You are a dental office assistant for ${businessDesc}. Help callers schedule appointments, answer questions about services, handle insurance inquiries, and manage cancellations professionally.`,
          'property-management': `You are a property management assistant for ${businessDesc}. Handle tenant maintenance requests, emergency calls, leasing inquiries, and rent-related questions. Prioritize emergency maintenance issues.`,
          'home-services': `You are a scheduling assistant for ${businessDesc}. Book service appointments, provide estimates, handle emergency service calls, and manage technician availability.`,
          'legal': `You are a legal intake specialist for ${businessDesc}. Conduct initial client screening, gather case details, schedule consultations, and handle general inquiries about services. Never provide legal advice.`,
          'customer-support': `You are a customer support agent for ${businessDesc}. Help customers with their questions, troubleshoot common issues, escalate complex problems, and ensure customer satisfaction.`,
          'outbound-sales': `You are an outbound sales representative for ${businessDesc}. Engage prospects professionally, present value propositions, handle objections, qualify leads, and schedule follow-ups.`,
          'technical-support': `You are a technical support specialist for ${businessDesc}. Diagnose technical issues, walk users through solutions, escalate complex problems, and document interactions.`,
        };

        let generatedPrompt: string;
        if (existingPrompt) {
          generatedPrompt = `${existingPrompt}\n\nAdditional context: ${businessDesc}`;
        } else {
          generatedPrompt = promptTemplates[agentType] || `You are a professional AI assistant for ${businessDesc}. Handle calls efficiently, be courteous and helpful, and ensure callers get the information or assistance they need.`;
        }

        return {
          action: 'generate_prompt',
          status: 'success',
          result: { prompt: generatedPrompt, agentType },
          message: 'Prompt generated. You can copy this to your agent configuration.',
        };
      }

      case 'get_billing_info': {
        const { rows: tenantRows } = await pool.query(
          `SELECT plan, status FROM tenants WHERE id = $1`,
          [tenantId],
        );
        const tenant = tenantRows[0] || { plan: 'starter', status: 'active' };

        const { rows: subRows } = await pool.query(
          `SELECT plan, status, monthly_call_limit, monthly_ai_minute_limit FROM subscriptions WHERE tenant_id = $1 AND status IN ('active', 'trialing') LIMIT 1`,
          [tenantId],
        );
        const subscription = subRows[0] || null;

        return {
          action: 'get_billing_info',
          status: 'success',
          result: { plan: tenant.plan, tenantStatus: tenant.status, subscription },
        };
      }

      case 'search_knowledge': {
        const query = args.query as string;
        const { rows } = await pool.query(
          `SELECT id, title, content, category FROM knowledge_articles WHERE tenant_id = $1 AND status = 'active' LIMIT 10`,
          [tenantId],
        );

        const queryLower = query.toLowerCase();
        const filtered = rows.filter((r: Record<string, unknown>) => {
          const title = (r.title as string || '').toLowerCase();
          const content = (r.content as string || '').toLowerCase();
          return title.includes(queryLower) || content.includes(queryLower);
        }).slice(0, 5);

        return {
          action: 'search_knowledge',
          status: 'success',
          result: { articles: filtered, count: filtered.length },
        };
      }

      case 'connect_integration': {
        const connectorType = args.connector_type as string;
        const provider = args.provider as string;
        const name = args.name as string;

        const { upsertConnector } = await import('../integrations/connectors');
        const integrationId = await upsertConnector(tenantId, {
          connectorType: connectorType as 'ticketing' | 'sms' | 'crm' | 'scheduling' | 'ehr' | 'email' | 'webhook' | 'custom',
          provider,
          name,
          credentials: {},
          isEnabled: true,
        });

        try {
          const { recordActivationEvent } = await import('../activation/ActivationService');
          await recordActivationEvent(tenantId, 'tenant_tools_connected', { connectorType, provider, source: 'assistant' });
        } catch {}

        return {
          action: 'connect_integration',
          status: 'success',
          result: { integrationId, connectorType, provider },
          message: `Integration "${name}" (${provider}) created. You can configure credentials on the Connectors page.`,
        };
      }

      case 'assign_phone_number': {
        const agentId = args.agent_id as string | undefined;

        const { rows: phoneRows } = await pool.query(
          `SELECT pn.id, pn.phone_number, pn.friendly_name, nr.agent_id
           FROM phone_numbers pn
           LEFT JOIN number_routing nr ON nr.phone_number_id = pn.id
           WHERE pn.tenant_id = $1
           ORDER BY pn.created_at DESC LIMIT 20`,
          [tenantId],
        );

        if (agentId) {
          const assigned = phoneRows.filter((r: Record<string, unknown>) => r.agent_id === agentId);
          const unassigned = phoneRows.filter((r: Record<string, unknown>) => !r.agent_id);
          return {
            action: 'assign_phone_number',
            status: 'success',
            result: {
              assignedToAgent: assigned,
              availableNumbers: unassigned,
              totalNumbers: phoneRows.length,
            },
            message: assigned.length > 0
              ? `This agent has ${assigned.length} phone number(s) assigned.`
              : `No phone numbers assigned to this agent. ${unassigned.length} number(s) available. Go to Phone Numbers page to assign one.`,
          };
        }

        return {
          action: 'assign_phone_number',
          status: 'success',
          result: {
            phoneNumbers: phoneRows,
            totalNumbers: phoneRows.length,
          },
          message: phoneRows.length > 0
            ? `You have ${phoneRows.length} phone number(s). Go to the Phone Numbers page to manage assignments.`
            : 'No phone numbers provisioned yet. Go to the Phone Numbers page to add one.',
        };
      }

      case 'create_support_ticket': {
        const subject = args.subject as string;
        const description = args.description as string;
        const priority = (args.priority as string) || 'medium';

        const ticketSessionId = sessionId || null;
        const { rows: ticketRows } = await pool.query(
          `INSERT INTO assistant_actions (session_id, tenant_id, action_type, parameters, result, status)
           VALUES ($1, $2, 'support_ticket', $3, $4, 'success')
           RETURNING id`,
          [ticketSessionId, tenantId, JSON.stringify({ subject, description, priority }), JSON.stringify({ subject, priority, created: new Date().toISOString() })],
        );

        const ticketId = ticketRows[0]?.id || `TICKET-${Date.now()}`;
        logger.info('Support ticket created via assistant', { tenantId, ticketId, subject, priority });

        return {
          action: 'create_support_ticket',
          status: 'success',
          result: { ticketId, subject, priority, created: new Date().toISOString() },
          message: `Support ticket created (ref: ${ticketId}). Subject: "${subject}". Our team will review it shortly.`,
        };
      }

      case 'get_network_recommendations': {
        const { getNetworkRecommendationsForAssistant } = await import('../gin/RecommendationDistributor');
        const recs = await getNetworkRecommendationsForAssistant(tenantId, 5);
        if (recs.length === 0) {
          return {
            action: 'get_network_recommendations',
            status: 'success',
            result: { recommendations: [] },
            message: 'No new network recommendations available at this time. Check back later or visit the Global Intelligence page for industry benchmarks.',
          };
        }
        return {
          action: 'get_network_recommendations',
          status: 'success',
          result: { recommendations: recs.map(r => ({ title: r.title, description: r.description, type: r.recommendationType, confidence: r.confidenceScore, industry: r.industryVertical })) },
          message: `Found ${recs.length} network recommendation(s) based on anonymized insights from the platform network.`,
        };
      }

      default:
        return { action: toolName, status: 'error', message: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error('Tool execution failed', { toolName, tenantId, error: String(err) });
    return { action: toolName, status: 'error', message: `Failed to execute ${toolName}: ${String(err)}` };
  }
}

export async function chat(
  tenantId: string,
  userId: string,
  userRole: string,
  sessionId: string | null,
  userMessage: string,
  pageContext?: string,
): Promise<{ sessionId: string; response: string; actions: AssistantActionResult[] }> {
  const pool = getPlatformPool();
  const apiKey = process.env.OPENAI_API_KEY;

  let currentSessionId = sessionId;
  let messages: AssistantMessage[] = [];

  if (currentSessionId) {
    const { rows } = await pool.query(
      `SELECT messages FROM assistant_sessions WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [currentSessionId, tenantId, userId],
    );
    if (rows.length > 0) {
      messages = (rows[0].messages as AssistantMessage[]) || [];
    } else {
      currentSessionId = null;
    }
  }

  if (!currentSessionId) {
    const { rows } = await pool.query(
      `INSERT INTO assistant_sessions (tenant_id, user_id, page_context, messages) VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId, userId, pageContext || null, JSON.stringify([])],
    );
    currentSessionId = rows[0].id as string;
  }

  messages.push({ role: 'user', content: userMessage, timestamp: new Date().toISOString() });

  let contextAddition = '';
  if (pageContext) {
    const matched = matchPageContext(pageContext);
    if (matched) {
      contextAddition = `\n\nCurrent page context: ${matched}`;
    }
  }

  const systemMessage = SYSTEM_PROMPT + contextAddition;

  if (!apiKey) {
    const fallbackResponse = generateFallbackResponse(userMessage, pageContext);
    messages.push({ role: 'assistant', content: fallbackResponse, timestamp: new Date().toISOString() });

    await pool.query(
      `UPDATE assistant_sessions SET messages = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(messages), currentSessionId],
    );

    return { sessionId: currentSessionId, response: fallbackResponse, actions: [] };
  }

  const openaiMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemMessage },
    ...messages.slice(-20).map((m) => ({ role: m.role, content: m.content })),
  ];

  const allActions: AssistantActionResult[] = [];
  let finalResponse = '';

  try {
    let iteration = 0;
    const maxIterations = 5;

    while (iteration < maxIterations) {
      iteration++;

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: openaiMessages,
          tools: ASSISTANT_TOOLS,
          tool_choice: 'auto',
          temperature: 0.7,
          max_tokens: 1024,
        }),
      });

      if (!res.ok) {
        const errBody = await res.text();
        logger.error('OpenAI API error', { status: res.status, body: errBody });
        throw new Error(`OpenAI API error: ${res.status}`);
      }

      const data = await res.json() as {
        choices: Array<{ message: ChatCompletionMessage; finish_reason: string }>;
      };

      const choice = data.choices[0];
      const assistantMsg = choice.message;

      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        openaiMessages.push({
          role: 'assistant',
          content: assistantMsg.content || null,
          tool_calls: assistantMsg.tool_calls,
        });

        for (const toolCall of assistantMsg.tool_calls) {
          const toolName = toolCall.function.name;
          let toolArgs: Record<string, unknown> = {};
          try {
            toolArgs = JSON.parse(toolCall.function.arguments);
          } catch {}

          const actionResult = await executeToolCall(toolName, toolArgs, tenantId, userRole, currentSessionId);
          allActions.push(actionResult);

          await pool.query(
            `INSERT INTO assistant_actions (session_id, tenant_id, action_type, parameters, result, status) VALUES ($1, $2, $3, $4, $5, $6)`,
            [currentSessionId, tenantId, toolName, JSON.stringify(toolArgs), JSON.stringify(actionResult), actionResult.status],
          );

          openaiMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(actionResult.result || actionResult.message),
          });
        }

        continue;
      }

      finalResponse = assistantMsg.content || 'I apologize, but I was unable to generate a response. Please try again.';
      break;
    }
  } catch (err) {
    logger.error('Chat completion failed', { tenantId, error: String(err) });
    finalResponse = generateFallbackResponse(userMessage, pageContext);
  }

  messages.push({
    role: 'assistant',
    content: finalResponse,
    actions: allActions.length > 0 ? allActions : undefined,
    timestamp: new Date().toISOString(),
  });

  await pool.query(
    `UPDATE assistant_sessions SET messages = $1, page_context = $2, updated_at = NOW() WHERE id = $3 AND tenant_id = $4 AND user_id = $5`,
    [JSON.stringify(messages), pageContext || null, currentSessionId, tenantId, userId],
  );

  return { sessionId: currentSessionId, response: finalResponse, actions: allActions };
}

function generateFallbackResponse(userMessage: string, pageContext?: string): string {
  const msg = userMessage.toLowerCase();

  if (msg.includes('create') && msg.includes('agent')) {
    return 'To create a new agent, go to the **Agents** page and click "Create Agent." Choose a template that matches your use case — for example, "Answering Service" for general call handling or "Medical After-Hours" for healthcare. You can customize the voice, greeting, and system prompt after creation.';
  }
  if (msg.includes('phone') || msg.includes('number')) {
    return 'To connect a phone number, go to the **Phone Numbers** page. You can provision a new number or port an existing one. Once connected, assign it to an agent to start receiving calls.';
  }
  if (msg.includes('integration') || msg.includes('connect') || msg.includes('connector')) {
    return 'To set up integrations, go to the **Connectors** page. We support CRM systems, scheduling tools, ticketing systems, SMS, and more. Click "Add Connector" and follow the setup guide for your specific tool.';
  }
  if (msg.includes('billing') || msg.includes('plan') || msg.includes('upgrade') || msg.includes('pricing')) {
    return 'You can manage your subscription on the **Billing** page. The Starter plan includes basic features, while the Pro plan unlocks advanced analytics, more agents, higher call volumes, and priority support. Visit the Billing page to compare plans.';
  }
  if (msg.includes('widget') || msg.includes('embed') || msg.includes('website')) {
    return 'To add the chat widget to your website, go to the **Widget** page. Configure the widget appearance and generate an embed code. Simply paste the code snippet into your website\'s HTML to enable web chat and voice capabilities.';
  }
  if (msg.includes('knowledge') || msg.includes('faq') || msg.includes('document')) {
    return 'To build your knowledge base, go to the **Knowledge Base** page. You can add FAQ articles, upload documents (PDF), or import content from URLs. Your agents will use this information to answer caller questions accurately.';
  }
  if (msg.includes('campaign') || msg.includes('outbound')) {
    return 'To set up an outbound campaign, go to the **Campaigns** page. Create a campaign with your contact list, choose an agent, and schedule the calling times. Monitor progress and results from the campaign dashboard.';
  }
  if (msg.includes('help') || msg.includes('support') || msg.includes('issue') || msg.includes('problem')) {
    return 'I\'m here to help! You can describe your issue and I\'ll do my best to guide you. If I can\'t resolve it, I can create a support ticket for our team to follow up.';
  }

  if (pageContext) {
    const matched = matchPageContext(pageContext);
    if (matched) {
      return `I can help you with this section of the platform. ${matched.replace('The user is on', 'You\'re currently on').replace('Help them', 'I can help you')} What would you like to do?`;
    }
  }

  return 'I\'m the QVO Platform Assistant! I can help you set up agents, connect integrations, configure your phone numbers, manage your knowledge base, and more. What would you like help with?';
}

export async function getSessions(
  tenantId: string,
  userId: string,
  limit = 20,
  offset = 0,
): Promise<{ sessions: Array<Record<string, unknown>>; total: number }> {
  const pool = getPlatformPool();

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) AS total FROM assistant_sessions WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );
  const total = parseInt(countRows[0].total as string, 10);

  const { rows } = await pool.query(
    `SELECT id, page_context, messages, created_at, updated_at
     FROM assistant_sessions WHERE tenant_id = $1 AND user_id = $2
     ORDER BY updated_at DESC LIMIT $3 OFFSET $4`,
    [tenantId, userId, limit, offset],
  );

  return { sessions: rows, total };
}

export async function getAnalytics(tenantId: string): Promise<Record<string, unknown>> {
  const pool = getPlatformPool();

  const { rows: sessionStats } = await pool.query(
    `SELECT
       COUNT(*) AS total_sessions,
       COUNT(DISTINCT user_id) AS unique_users,
       MIN(created_at) AS first_session,
       MAX(created_at) AS last_session
     FROM assistant_sessions WHERE tenant_id = $1`,
    [tenantId],
  );

  const { rows: actionStats } = await pool.query(
    `SELECT
       action_type,
       COUNT(*) AS count,
       COUNT(CASE WHEN status = 'success' THEN 1 END) AS success_count,
       COUNT(CASE WHEN status = 'error' THEN 1 END) AS error_count
     FROM assistant_actions WHERE tenant_id = $1
     GROUP BY action_type ORDER BY count DESC`,
    [tenantId],
  );

  const { rows: dailyStats } = await pool.query(
    `SELECT
       DATE(created_at) AS date,
       COUNT(*) AS sessions
     FROM assistant_sessions WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '30 days'
     GROUP BY DATE(created_at) ORDER BY date DESC`,
    [tenantId],
  );

  const stats = sessionStats[0] || {};
  const totalActions = actionStats.reduce((sum: number, r: Record<string, unknown>) => sum + parseInt(r.count as string, 10), 0);
  const successActions = actionStats.reduce((sum: number, r: Record<string, unknown>) => sum + parseInt(r.success_count as string, 10), 0);

  return {
    totalSessions: parseInt(stats.total_sessions as string, 10) || 0,
    uniqueUsers: parseInt(stats.unique_users as string, 10) || 0,
    firstSession: stats.first_session || null,
    lastSession: stats.last_session || null,
    totalActions,
    resolutionRate: totalActions > 0 ? Math.round((successActions / totalActions) * 100) : 0,
    actionBreakdown: actionStats,
    dailyActivity: dailyStats,
  };
}
