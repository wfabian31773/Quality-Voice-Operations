import { describe, expect, it } from 'vitest';
import {
  finalizeDraft,
  inferTemplateFromText,
  runVoiceAgentAssistTurn,
  sanitizeLibraryTools,
} from './voiceAgentAssist';
import { MASTER_VOICE_AGENT_DEFAULT_VOICE, MASTER_VOICE_AGENT_MODEL } from './masterVoiceAgent';

describe('voiceAgentAssist', () => {
  it('opens with a use-case question when the interview is empty', () => {
    const result = runVoiceAgentAssistTurn({ messages: [] });
    expect(result.done).toBe(false);
    expect(result.messages[0]?.content).toMatch(/use case/i);
    expect(result.draft.voice).toBe(MASTER_VOICE_AGENT_DEFAULT_VOICE);
    expect(result.draft.model).toBe(MASTER_VOICE_AGENT_MODEL);
  });

  it('asks for the business after a free-text use case', () => {
    const result = runVoiceAgentAssistTurn({
      messages: [{ role: 'user', content: 'I want a customer support agent.' }],
    });
    expect(result.done).toBe(false);
    expect(result.messages.at(-1)?.content).toMatch(/name of your business/i);
    expect(result.draft.templateId).toBe('customer_support');
  });

  it('finalizes a draft from a template plus business details', () => {
    const result = runVoiceAgentAssistTurn({
      templateId: 'appointment_scheduler',
      messages: [{ role: 'user', content: 'Harbor Dental https://harbordental.com' }],
    });
    expect(result.done).toBe(true);
    expect(result.draft.templateId).toBe('appointment_scheduler');
    expect(result.draft.welcomeGreeting).toMatch(/Harbor Dental/);
    expect(result.draft.systemPrompt).toMatch(/Harbor Dental/);
    expect(result.draft.tools).toEqual(expect.arrayContaining(['create_booking', 'send_sms']));
    expect(result.draft.tools).not.toContain('not_a_real_tool');
  });

  it('skips the interview into a blank ready draft', () => {
    const result = runVoiceAgentAssistTurn({ messages: [], skip: true });
    expect(result.done).toBe(true);
    expect(result.draft.templateId).toBe('blank');
    expect(result.draft.name).toBe('Untitled');
  });

  it('drops unknown tools and keeps runtime tools', () => {
    expect(sanitizeLibraryTools(['create_ticket', 'invented', 'send_sms'])).toEqual([
      'get_current_tenant_time',
      'record_language_change',
      'send_sms',
      'create_ticket',
    ]);
  });

  it('infers templates from plain language', () => {
    expect(inferTemplateFromText('book appointments')).toBe('appointment_scheduler');
    expect(inferTemplateFromText('qualify inbound leads')).toBe('lead_qualification');
    expect(inferTemplateFromText('outbound sales quotes')).toBe('sales_associate');
  });

  it('locks the published draft to the master runtime', () => {
    const draft = finalizeDraft({ templateId: 'customer_support', businessName: 'Acme' });
    expect(draft.model).toBe(MASTER_VOICE_AGENT_MODEL);
    expect(draft.voice).toBe(MASTER_VOICE_AGENT_DEFAULT_VOICE);
    expect(draft.type).toBe('general');
  });
});
