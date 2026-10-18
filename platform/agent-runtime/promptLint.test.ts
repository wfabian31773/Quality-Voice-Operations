import { describe, expect, it } from 'vitest';
import {
  MASTER_VOICE_CONVERSATION_POLICY,
  MASTER_VOICE_MEMORY_POLICY,
  MASTER_VOICE_MULTILINGUAL_POLICY,
  MASTER_VOICE_TOOL_POLICY,
  buildMasterVoiceAgentInstructions,
  compileRolePackage,
  type RolePackageDefinition,
} from './masterVoiceAgent';
import { findStageDirections, stripStageDirections } from './promptLint';
import { createCoreReceptionistRolePackage } from '../agent-templates/core-receptionist/rolePackage';
import { appendSalonCallRules, createSalonRolePackage } from '../agent-templates/salon/rolePackage';

const SHOP_ROLE_PACKAGES: Array<[string, RolePackageDefinition]> = [
  ['core-receptionist', createCoreReceptionistRolePackage({ businessName: 'Harbor Locksmith' })],
  ['core-receptionist (defaults)', createCoreReceptionistRolePackage({})],
  ['salon', createSalonRolePackage({ businessName: 'Sharp Line Barbers', callerPhone: '+15555550142' })],
  ['salon (defaults)', createSalonRolePackage({})],
];

describe('findStageDirections on real prompts', () => {
  it.each([
    ['conversation policy', MASTER_VOICE_CONVERSATION_POLICY],
    ['multilingual policy', MASTER_VOICE_MULTILINGUAL_POLICY],
    ['memory policy', MASTER_VOICE_MEMORY_POLICY],
    ['tool policy', MASTER_VOICE_TOOL_POLICY],
    ['master instructions', buildMasterVoiceAgentInstructions({
      rolePrompt: 'Role.',
      guardrails: ['Rule.'],
      callerMemory: 'Verified: none.',
      knowledgeAvailable: true,
      now: new Date('2026-10-17T16:00:00.000Z'),
    })],
  ])('master voice %s has no stage directions', (_name, text) => {
    expect(findStageDirections(text)).toEqual([]);
  });

  it.each(SHOP_ROLE_PACKAGES)('%s prompt, greeting, guardrails, and compiled prompt have no stage directions', (_name, role) => {
    expect(findStageDirections(role.prompt)).toEqual([]);
    expect(findStageDirections(role.greeting)).toEqual([]);
    for (const rule of role.guardrails) expect(findStageDirections(rule)).toEqual([]);
    expect(findStageDirections(compileRolePackage(role).systemPrompt)).toEqual([]);
  });

  it('salon call rules appended to a tenant prompt have no stage directions', () => {
    expect(findStageDirections(appendSalonCallRules('Tenant prompt.', '+1 (555) 555-0142'))).toEqual([]);
  });
});

describe('findStageDirections fixtures', () => {
  it('catches "(file the ticket quietly)"', () => {
    const fixture = 'After the caller agrees, call create_ticket (file the ticket quietly) and confirm.';
    expect(findStageDirections(fixture)).toEqual([
      { rule: 'bracketed-narration', match: '(file the ticket quietly)', index: fixture.indexOf('(') },
    ]);
  });

  it.each([
    ['(pause)', 'bracketed-narration'],
    ['[pause]', 'bracketed-narration'],
    ['[whispers]', 'bracketed-narration'],
    ['(checking the calendar)', 'bracketed-narration'],
    ['(one moment, checking the calendar)', 'bracketed-narration'],
    ['(still typing)', 'bracketed-narration'],
    ['(now filing the ticket)', 'bracketed-narration'],
    ['(aside from holidays)', 'bracketed-narration'],
    ['*sighs*', 'asterisk-action'],
    ['*files the ticket*', 'asterisk-action'],
    ['Hours 9–7. *Closed Sundays.*', 'asterisk-action'],
    ['Call create_ticket silently.', 'narration-word'],
    ['Then quietly record the outcome.', 'narration-word'],
    ['Say the total sotto voce.', 'narration-word'],
    ['Whisper the confirmation number.', 'narration-word'],
  ])('flags %s', (text, rule) => {
    expect(findStageDirections(text).map((hit) => hit.rule)).toContain(rule);
  });

  it('flags a bracketed direction even inside a quoted line, since it would be read out', () => {
    expect(findStageDirections('Say "One moment (pause) you are booked."')).toHaveLength(1);
  });

  it.each([
    'Say "I\'ll whisper it to your barber." if they ask for discretion.',
    'templateKey confirmation (vars businessName, summary) once a booking is stored',
    'leave contactPhone empty (or pass "caller_id") so the server fills in the caller ID',
    'If the caller is silent, check in once.',
    'Use **only** the permitted tools.',
    '- first item\n* second item',
    'Do not announce this tool call.',
    '- Imminent court deadlines (hearing or filing within 24-48 hours)',
  ])('does not flag plain instructions: %s', (text) => {
    expect(findStageDirections(text)).toEqual([]);
  });
});

describe('stripStageDirections', () => {
  it('removes bracketed and asterisk directions but keeps narration words', () => {
    const sample = [
      'Book the cut, then call create_ticket (file the ticket quietly).',
      '[pause] Confirm the time with the caller.',
      'Say the total *pauses* and wait for a yes.',
      'Do not silently hang up.',
    ].join('\n');

    const { text, hits, removed } = stripStageDirections(sample);

    expect(removed).toBe(3);
    expect(text).toBe([
      'Book the cut, then call create_ticket.',
      'Confirm the time with the caller.',
      'Say the total and wait for a yes.',
      'Do not silently hang up.',
    ].join('\n'));
    expect(hits.map((hit) => [hit.rule, hit.match])).toEqual([
      ['bracketed-narration', '(file the ticket quietly)'],
      ['bracketed-narration', '[pause]'],
      ['asterisk-action', '*pauses*'],
      ['narration-word', 'silently'],
    ]);
    expect(findStageDirections(text).map((hit) => hit.rule)).toEqual(['narration-word']);
  });

  it('returns a clean prompt unchanged', () => {
    const clean = createSalonRolePackage({ businessName: 'Sharp Line Barbers' }).prompt;
    expect(stripStageDirections(clean)).toEqual({ text: clean, hits: [], removed: 0 });
  });

  it('keeps asterisk emphasis on a business fact and still reports it', () => {
    const sample = 'Hours 9–7. *Closed Sundays.* Payment: *cash only*.';
    const { text, hits, removed } = stripStageDirections(sample);

    expect(text).toBe(sample);
    expect(removed).toBe(0);
    expect(hits.map((hit) => [hit.rule, hit.match])).toEqual([
      ['asterisk-action', '*Closed Sundays.*'],
      ['asterisk-action', '*cash only*'],
    ]);
  });

  it.each(['*pauses*', '*sighs*'])('still removes the asterisk action %s', (action) => {
    const { text, removed } = stripStageDirections(`Say the total ${action} and wait for a yes.`);
    expect(text).toBe('Say the total and wait for a yes.');
    expect(removed).toBe(1);
  });

  it.each([
    'Open Mon–Sat (aside from holidays).',
    'Price match (we\'ll beat any price).',
  ])('keeps "aside"/"beat" brackets, which are business content: %s', (sample) => {
    const { text, removed } = stripStageDirections(sample);
    expect(text).toBe(sample);
    expect(removed).toBe(0);
  });

  it.each([
    '(one moment, checking the calendar)',
    '(still typing)',
    '(now filing the ticket)',
  ])('removes the mid-bracket activity direction %s', (direction) => {
    const { text, hits, removed } = stripStageDirections(`Book it ${direction} and confirm.`);
    expect(hits.map((hit) => [hit.rule, hit.match])).toEqual([['bracketed-narration', direction]]);
    expect(text).toBe('Book it and confirm.');
    expect(removed).toBe(1);
  });

  it('leaves the legal deadline line unflagged and unchanged', () => {
    const legal = '- Imminent court deadlines (hearing or filing within 24-48 hours)';
    expect(stripStageDirections(legal)).toEqual({ text: legal, hits: [], removed: 0 });
  });
});
