import { describe, expect, it } from 'vitest';
import { bodyStats, isAgentSmsTemplate, listSmsTemplates, renderSmsTemplate } from './templates';

describe('SMS template registry', () => {
  it('has the shop templates, and the agent may only use confirmation, directions and link', () => {
    expect(listSmsTemplates().map((t) => t.key)).toEqual([
      'confirmation',
      'directions',
      'link',
      'reminder_24h',
      'reminder_2h',
      'csat_survey',
      'ops_alert',
      'escalation_alert',
      'autopilot_alert',
    ]);
    expect(listSmsTemplates().filter((t) => t.agent).map((t) => t.key)).toEqual(['confirmation', 'directions', 'link']);
    expect(isAgentSmsTemplate('ops_alert')).toBe(false);
    expect(isAgentSmsTemplate('escalation_alert')).toBe(false);
    expect(isAgentSmsTemplate('autopilot_alert')).toBe(false);
    expect(isAgentSmsTemplate('nope')).toBe(false);
  });

  it('keeps the exact wording of the escalation and autopilot staff alerts', () => {
    expect(
      renderSmsTemplate('escalation_alert', { session: 'cs-1', reason: 'caller upset', time: '2026-10-14T15:00:00.000Z' }),
    ).toEqual({
      ok: true,
      body: '[ESCALATION ALERT]\nSession: cs-1\nReason: caller upset\nTime: 2026-10-14T15:00:00.000Z',
    });
    expect(
      renderSmsTemplate('autopilot_alert', { riskTier: 'HIGH', title: 'Missed calls spiking', summary: '12 missed today' }),
    ).toEqual({ ok: true, body: '[QVO Autopilot] HIGH RISK: Missed calls spiking. 12 missed today. Log in to review.' });
  });

  it('renders variables', () => {
    expect(renderSmsTemplate('reminder_2h', { businessName: 'Polish Bar', summary: 'gel mani', time: '4:00 PM' })).toEqual({
      ok: true,
      body: 'Polish Bar: reminder, gel mani is today at 4:00 PM.',
    });
    expect(renderSmsTemplate('directions', { businessName: 'Fade Lab', address: '12 Main St' })).toEqual({
      ok: true,
      body: 'Fade Lab is at 12 Main St.',
    });
  });

  it('rejects missing, unknown, overlong and non-https variables', () => {
    expect(renderSmsTemplate('directions', { businessName: 'Fade Lab' })).toMatchObject({ ok: false, field: 'vars.address' });
    expect(renderSmsTemplate('directions', { businessName: 'A', address: 'B', extra: 'C' })).toMatchObject({
      ok: false,
      field: 'vars.extra',
    });
    expect(renderSmsTemplate('directions', { businessName: 'A', address: 'x'.repeat(201) })).toMatchObject({
      ok: false,
      field: 'vars.address',
    });
    expect(renderSmsTemplate('link', { businessName: 'A', url: 'javascript:alert(1)' })).toMatchObject({ ok: false });
    expect(renderSmsTemplate('link', { businessName: 'A', url: 'https://book.example.com/fade' })).toMatchObject({ ok: true });
  });

  it('counts GSM-7 and UCS-2 segments', () => {
    expect(bodyStats('x'.repeat(160))).toMatchObject({ segments: 1, encoding: 'GSM-7' });
    expect(bodyStats('x'.repeat(161))).toMatchObject({ segments: 2, encoding: 'GSM-7' });
    expect(bodyStats('Su cita está confirmada.')).toMatchObject({ segments: 1, encoding: 'UCS-2' });
  });
});
