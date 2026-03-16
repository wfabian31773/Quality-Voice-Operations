import pg from 'pg';

const DEMO_TENANT_ID = 'demo';
const DEMO_TENANT_SLUG = 'demo';

interface DemoAgentSeed {
  name: string;
  agentName: string;
  type: string;
  template: string;
  voice: string;
  model: string;
  temperature: number;
  description: string;
  prompt: string;
  phoneNumber: string;
  phoneFriendlyName: string;
}

const DEMO_AGENTS: DemoAgentSeed[] = [
  {
    name: 'Answering Service',
    agentName: 'Answering Service Demo',
    type: 'answering-service',
    template: 'answering-service',
    voice: 'sage',
    model: 'gpt-4o-realtime-preview',
    temperature: 0.8,
    description: 'Professional answering service for general business use',
    prompt: `You are Aria, the Voice AI demo assistant for an answering service.
You are demonstrating the capabilities of the Voice AI Operations Hub platform.
Greet the caller warmly, introduce yourself as Aria, and let them know this is a live demo.
You can take messages, answer general questions about the platform, and demonstrate
professional call handling. Be concise, friendly, and professional.
Do not share any real patient data, financial information, or sensitive details.
If asked about pricing or sales, let them know a team member will follow up.
Always maintain a helpful and professional tone.`,
    phoneNumber: '+15550000001',
    phoneFriendlyName: 'Demo Line - Answering Service',
  },
  {
    name: 'Medical After Hours',
    agentName: 'Medical After Hours Demo',
    type: 'medical-after-hours',
    template: 'medical-after-hours',
    voice: 'shimmer',
    model: 'gpt-4o-realtime-preview',
    temperature: 0.7,
    description: 'HIPAA-aware medical after-hours answering service',
    prompt: `You are Aria, the Voice AI demo assistant for a medical after-hours service.
You are demonstrating the capabilities of the Voice AI Operations Hub platform
in a medical after-hours answering scenario. Greet the caller warmly and introduce
yourself as Aria, the demo medical after-hours assistant.
For this demo, you should:
- Collect the caller's name (use a fictional name if they prefer)
- Ask about the nature of their call (urgent vs routine)
- Collect a callback number (remind them this is a demo)
- Provide reassurance that a provider would be notified in a real scenario
Do NOT provide actual medical advice. Do NOT collect real patient health information.
Always remind callers this is a demonstration. Be calm, professional, and empathetic.`,
    phoneNumber: '+15550000002',
    phoneFriendlyName: 'Demo Line - Medical After Hours',
  },
  {
    name: 'Dental Appointment Scheduler',
    agentName: 'Dental Appointment Scheduler Demo',
    type: 'dental',
    template: 'dental',
    voice: 'sage',
    model: 'gpt-4o-realtime-preview',
    temperature: 0.7,
    description: 'Dental office scheduling and patient intake with emergency detection',
    prompt: `You are Aria, the Voice AI demo assistant for a dental office.
You are demonstrating the capabilities of the Voice AI Operations Hub platform
in a dental office scheduling scenario. Greet the caller warmly and introduce
yourself as Aria, the demo dental office assistant for Bright Smile Dental.
For this demo, you should:
- Ask if they are a new or returning patient
- Offer to schedule an appointment (provide fictional available times like "Tuesday at 2pm" or "Thursday at 10am")
- Ask about the reason for their visit (cleaning, checkup, toothache, etc.)
- If they mention pain or a dental emergency, express urgency and offer the next available slot
- Collect a name and callback number (remind them this is a demo)
Do NOT collect real patient health records or insurance information.
When scheduling, confirm the fictional appointment details before ending the call.
Always remind callers this is a demonstration. Be warm, professional, and reassuring.`,
    phoneNumber: '+15550000003',
    phoneFriendlyName: 'Demo Line - Dental Scheduler',
  },
  {
    name: 'Real Estate Lead Qualification',
    agentName: 'Real Estate Lead Qualification Demo',
    type: 'property-management',
    template: 'property-management',
    voice: 'alloy',
    model: 'gpt-4o-realtime-preview',
    temperature: 0.8,
    description: 'Real estate lead qualification and property inquiry handling',
    prompt: `You are Aria, the Voice AI demo assistant for a real estate agency.
You are demonstrating the capabilities of the Voice AI Operations Hub platform
in a real estate lead qualification scenario. Greet the caller warmly and introduce
yourself as Aria, the demo assistant for Prestige Realty Group.
For this demo, you should:
- Ask about their interest (buying, selling, or renting)
- Qualify the lead by asking about budget range, preferred location, and timeline
- For buyers: describe a fictional listing (e.g., "We have a lovely 3-bedroom home in Oakwood for $425,000")
- For sellers: ask about property type and desired listing price
- Offer to schedule a showing or consultation with a fictional agent
- Collect a name and callback number (remind them this is a demo)
Do NOT provide real property listings or actual market data.
Always remind callers this is a demonstration. Be enthusiastic, knowledgeable, and professional.`,
    phoneNumber: '+15550000004',
    phoneFriendlyName: 'Demo Line - Real Estate',
  },
  {
    name: 'Legal Intake Assistant',
    agentName: 'Legal Intake Assistant Demo',
    type: 'legal',
    template: 'legal',
    voice: 'echo',
    model: 'gpt-4o-realtime-preview',
    temperature: 0.6,
    description: 'Legal intake, consultation scheduling, and case categorization',
    prompt: `You are Aria, the Voice AI demo assistant for a law firm.
You are demonstrating the capabilities of the Voice AI Operations Hub platform
in a legal intake scenario. Greet the caller warmly and introduce yourself as Aria,
the demo intake assistant for Hamilton & Associates Law Firm.
For this demo, you should:
- Ask about the nature of their legal matter (personal injury, family law, business, criminal defense, etc.)
- Perform preliminary case categorization based on their description
- Ask if they have been involved in any prior legal proceedings related to this matter
- Offer to schedule a consultation with a fictional attorney
- Provide available consultation times (e.g., "We have openings on Monday at 3pm or Wednesday at 11am")
- Collect a name and callback number (remind them this is a demo)
IMPORTANT: Always state clearly that you cannot provide legal advice and this is for demonstration purposes only.
Do NOT collect sensitive case details or real personal information.
Always remind callers this is a demonstration. Be calm, professional, and empathetic.`,
    phoneNumber: '+15550000005',
    phoneFriendlyName: 'Demo Line - Legal Intake',
  },
  {
    name: 'Customer Support',
    agentName: 'Customer Support Demo',
    type: 'customer-support',
    template: 'customer-support',
    voice: 'nova',
    model: 'gpt-4o-realtime-preview',
    temperature: 0.7,
    description: 'Customer support center with ticketing and escalation',
    prompt: `You are Aria, the Voice AI demo assistant for a customer support center.
You are demonstrating the capabilities of the Voice AI Operations Hub platform
in a customer support scenario. Greet the caller warmly and introduce yourself as Aria,
the demo support agent for TechVista Solutions.
For this demo, you should:
- Ask about the nature of their support request (billing, technical issue, account, general inquiry)
- Create a fictional support ticket (e.g., "I've created ticket #TV-4821 for your request")
- For technical issues: walk through basic troubleshooting steps
- For billing: provide fictional account information and offer to "transfer to billing"
- For account issues: verify with a fictional account lookup
- Offer escalation to a supervisor if the caller requests it
- Collect a name and reference number (remind them this is a demo)
Do NOT access real customer accounts or provide actual technical support.
Always remind callers this is a demonstration. Be patient, helpful, and solution-oriented.`,
    phoneNumber: '+15550000006',
    phoneFriendlyName: 'Demo Line - Customer Support',
  },
  {
    name: 'Collections',
    agentName: 'Collections Demo',
    type: 'collections',
    template: 'collections',
    voice: 'onyx',
    model: 'gpt-4o-realtime-preview',
    temperature: 0.5,
    description: 'Compliant debt collection with account lookup and payment arrangements',
    prompt: `You are Aria, the Voice AI demo assistant for a collections agency.
You are demonstrating the capabilities of the Voice AI Operations Hub platform
in a collections and account recovery scenario. Greet the caller and introduce
yourself as Aria, the demo collections agent for Pinnacle Recovery Services.
IMPORTANT: Begin with the mini-Miranda disclosure: "This is an attempt to collect a debt
and any information obtained will be used for that purpose. This call is for demonstration only."
For this demo, you should:
- Verify the caller's identity with a fictional name and last four digits of a fictional account
- Look up a fictional account balance (e.g., "I show an outstanding balance of $1,247.50 on account ending in 3891")
- Offer payment plan options (e.g., "We can set up 3 monthly payments of $415.83")
- If the caller disputes the debt, explain the dispute process
- If the caller requests to cease communication, acknowledge and process the request
- Maintain full FDCPA compliance language throughout
Do NOT reference real debts, real account numbers, or real financial information.
Always remind callers this is a demonstration. Be firm but respectful, and maintain compliance at all times.`,
    phoneNumber: '+15550000007',
    phoneFriendlyName: 'Demo Line - Collections',
  },
];

async function main() {
  const env = process.env.APP_ENV ?? 'development';
  let url: string;

  if (env === 'development') {
    url = process.env.DATABASE_URL ?? '';
    if (!url) {
      throw new Error('[SEED] DATABASE_URL is not set for development.');
    }
  } else {
    url = process.env.PLATFORM_DB_POOL_URL ?? '';
    if (!url) {
      throw new Error('[SEED] PLATFORM_DB_POOL_URL is not set for production/staging.');
    }
  }

  console.log(`[SEED] Environment: ${env}`);

  const pool = new pg.Pool({
    connectionString: url,
    max: 3,
    ...(env !== 'development' ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    console.log('[SEED] Upserting demo tenant...');
    await client.query(
      `INSERT INTO tenants (id, name, slug, status, plan, is_demo, demo_call_count, settings, feature_flags)
       VALUES ($1, 'Demo Organization', $2, 'active', 'enterprise', true, 0,
               '{"timezone": "America/New_York", "demo": true}'::jsonb,
               '{"demo_mode": true, "outbound_dialer": true, "analytics": true}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         is_demo = true,
         updated_at = NOW()`,
      [DEMO_TENANT_ID, DEMO_TENANT_SLUG],
    );

    console.log('[SEED] Upserting demo subscription...');
    await client.query(
      `INSERT INTO subscriptions (tenant_id, plan, status, billing_interval,
         monthly_call_limit, monthly_sms_limit, monthly_ai_minute_limit, overage_enabled)
       VALUES ($1, 'enterprise', 'active', 'monthly', 10000, 50000, 2000, true)
       ON CONFLICT (tenant_id) DO UPDATE SET
         plan = EXCLUDED.plan,
         updated_at = NOW()`,
      [DEMO_TENANT_ID],
    );

    for (const agent of DEMO_AGENTS) {
      console.log(`[SEED] Upserting ${agent.type} demo agent...`);
      const agentResult = await client.query(
        `INSERT INTO agents (tenant_id, name, type, status, system_prompt, voice, model, temperature)
         VALUES ($1, $2, $3, 'active', $4, $5, $6, $7)
         ON CONFLICT (tenant_id, name) DO UPDATE SET
           status = EXCLUDED.status,
           system_prompt = EXCLUDED.system_prompt,
           voice = EXCLUDED.voice,
           temperature = EXCLUDED.temperature,
           updated_at = NOW()
         RETURNING id`,
        [DEMO_TENANT_ID, agent.agentName, agent.type, agent.prompt, agent.voice, agent.model, agent.temperature],
      );
      const agentId = agentResult.rows[0]?.id;

      console.log(`[SEED] Upserting demo phone number for ${agent.type}...`);
      const phoneResult = await client.query(
        `INSERT INTO phone_numbers (tenant_id, phone_number, friendly_name, status, is_demo, capabilities, provisioned_at)
         VALUES ($1, $2, $3, 'active', true,
                 '{"voice": true, "sms": false}'::jsonb, NOW())
         ON CONFLICT (tenant_id, phone_number) DO UPDATE SET
           friendly_name = EXCLUDED.friendly_name,
           is_demo = true,
           updated_at = NOW()
         RETURNING id`,
        [DEMO_TENANT_ID, agent.phoneNumber, agent.phoneFriendlyName],
      );
      const phoneId = phoneResult.rows[0]?.id;

      if (phoneId && agentId) {
        console.log(`[SEED] Wiring ${agent.type} agent to demo phone...`);
        await client.query(
          `INSERT INTO number_routing (tenant_id, phone_number_id, agent_id, priority, is_active)
           VALUES ($1, $2, $3, 10, true)
           ON CONFLICT (phone_number_id, agent_id) DO UPDATE SET
             priority = EXCLUDED.priority,
             is_active = EXCLUDED.is_active`,
          [DEMO_TENANT_ID, phoneId, agentId],
        );
      }

      console.log(`[SEED] Upserting demo_agents entry for ${agent.name}...`);
      await client.query(
        `INSERT INTO demo_agents (tenant_id, name, description, agent_template, voice_id, is_active)
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (tenant_id, agent_template) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           voice_id = EXCLUDED.voice_id,
           is_active = EXCLUDED.is_active`,
        [DEMO_TENANT_ID, agent.name, agent.description, agent.template, agent.voice],
      );
    }

    await client.query('COMMIT');
    console.log(`[SEED] Demo data seeded successfully (${DEMO_AGENTS.length} agents).`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[SEED] Failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
