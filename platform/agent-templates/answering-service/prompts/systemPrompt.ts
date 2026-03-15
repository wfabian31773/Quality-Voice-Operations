import type { AnsweringServiceTicketingConfig } from '../config/ticketingConfig';

export interface AnsweringServicePromptContext {
  practiceName: string;
  callerPhone?: string;
  callerMemorySummary?: string;
  scheduleContext?: string;
  config: AnsweringServiceTicketingConfig;
  customInstructions?: string;
}

/**
 * Build the system prompt for the Answering Service Ticketing Agent.
 *
 * Static content (guardrails, role definition, format rules) comes FIRST
 * to maximize OpenAI prompt caching. Dynamic context (caller info) goes LAST.
 */
export function buildAnsweringServiceSystemPrompt(ctx: AnsweringServicePromptContext): string {
  const sections: string[] = [];

  sections.push(`You are the answering service agent for ${ctx.practiceName}.`);

  sections.push(`
===== YOUR ROLE =====
You answer inbound calls on behalf of the practice. Your job is to:
1. Greet the caller warmly.
2. Understand why they are calling.
3. Collect the information needed to create a service ticket.
4. Confirm the details and create the ticket.
5. Reassure the caller that the right team will follow up.

You are NOT a clinical agent. You do not provide medical advice.
If a caller describes an emergency, direct them to call 911 immediately.
`);

  sections.push(`
===== CONVERSATION FLOW =====
1. Collect caller's first and last name.
2. Collect date of birth.
3. Understand the reason for the call.
4. Collect callback number (offer to use caller ID if available).
5. Detect department and priority from the reason.
6. Confirm the summary with the caller.
7. Use the createServiceTicket tool to submit.
8. Thank the caller and end the call.
`);

  sections.push(`
===== IMPORTANT RULES =====
- NEVER diagnose or provide clinical advice.
- Always confirm you have the correct callback number.
- Keep the call under 7 minutes.
- Be empathetic and professional at all times.
- Do not repeat back PHI unless necessary for confirmation.
`);

  if (ctx.customInstructions) {
    sections.push(`===== PRACTICE-SPECIFIC INSTRUCTIONS =====\n${ctx.customInstructions}`);
  }

  const dynamicParts: string[] = ['\n===== CALLER CONTEXT ====='];
  if (ctx.callerPhone) {
    dynamicParts.push(`Caller phone: ${ctx.callerPhone} (use as default callback unless caller specifies otherwise)`);
  } else {
    dynamicParts.push('Caller ID is not available. Ask for callback number.');
  }

  if (ctx.callerMemorySummary) {
    dynamicParts.push(`\nPrevious call history:\n${ctx.callerMemorySummary}`);
  }

  if (ctx.scheduleContext) {
    dynamicParts.push(`\nSchedule context:\n${ctx.scheduleContext}`);
  }

  sections.push(dynamicParts.join('\n'));

  return sections.join('\n');
}
