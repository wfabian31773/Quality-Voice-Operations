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
import { findStageDirections } from './promptLint';
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
    ['*sighs*', 'asterisk-action'],
    ['*files the ticket*', 'asterisk-action'],
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
  ])('does not flag plain instructions: %s', (text) => {
    expect(findStageDirections(text)).toEqual([]);
  });
});
