import { describe, expect, it } from 'vitest';
import { buildMessageFallbackInstruction } from './messageFallbackInstruction';

describe('buildMessageFallbackInstruction', () => {
  it('uses the resolved ticket tool instead of hardcoding create_ticket', () => {
    expect(buildMessageFallbackInstruction('createServiceTicket')).toContain('createServiceTicket');
    expect(buildMessageFallbackInstruction('createServiceTicket')).not.toMatch(/call create_ticket/);
    expect(buildMessageFallbackInstruction('create_ticket')).toContain('create_ticket');
  });

  it('falls back to create_ticket only when no tool was resolved', () => {
    expect(buildMessageFallbackInstruction('   ')).toContain('create_ticket');
  });
});
