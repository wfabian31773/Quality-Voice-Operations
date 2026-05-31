import { describe, it, expect } from 'vitest';
import {
  getFallbackMessage,
  setTenantFallbackConfig,
  buildFallbackResponse,
} from './ConversationFallbackService';

describe('getFallbackMessage', () => {
  it('returns the tool-specific default message', () => {
    expect(getFallbackMessage('tenant-1', 'createServiceTicket')).toContain('service ticket');
  });

  it('falls back to the generic default for an unknown tool', () => {
    expect(getFallbackMessage('tenant-1', 'mysteryTool')).toContain('follow up with you within the hour');
  });

  it('prefers a tenant-specific tool message when configured', () => {
    setTenantFallbackConfig('tenant-custom', {
      toolMessages: { createServiceTicket: 'custom ticket message' },
    });
    expect(getFallbackMessage('tenant-custom', 'createServiceTicket')).toBe('custom ticket message');
  });

  it('uses a tenant-specific default message for unmapped tools', () => {
    setTenantFallbackConfig('tenant-default', { defaultMessage: 'tenant generic message' });
    expect(getFallbackMessage('tenant-default', 'someUnmappedTool')).toBe('tenant generic message');
  });
});

describe('buildFallbackResponse', () => {
  it('flags the interaction for follow-up and echoes the tool context', () => {
    const result = buildFallbackResponse('tenant-1', 'createServiceTicket', 'cs-1', 'boom');
    expect(result.flaggedForFollowUp).toBe(true);
    expect(result.callSessionId).toBe('cs-1');
    expect(result.toolName).toBe('createServiceTicket');
    expect(result.message).toContain('service ticket');
  });
});
