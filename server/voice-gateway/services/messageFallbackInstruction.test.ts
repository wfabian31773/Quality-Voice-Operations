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

  it('offers a message and waits for a yes instead of creating the ticket (Oct 17 call)', () => {
    const instruction = buildMessageFallbackInstruction('create_ticket');
    expect(instruction).toContain('Offer once to take a message');
    expect(instruction).toContain('Only if the caller says yes, call create_ticket');
    expect(instruction).toContain('If they say no, do not create one');
    expect(instruction).not.toMatch(/within the hour|shortly|as soon as possible/i);
  });
});
