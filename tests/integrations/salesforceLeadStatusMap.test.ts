import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SALESFORCE_LEAD_STATUS_MAP,
  parseLeadStatusMap,
  resolveLeadStatusMap,
} from '../../platform/integrations/connectors/adapters/salesforce';

describe('Salesforce lead status mapping', () => {
  it('returns undefined when no override is configured', () => {
    expect(parseLeadStatusMap({})).toBeUndefined();
    expect(parseLeadStatusMap({ lead_status_map: '' })).toBeUndefined();
    expect(parseLeadStatusMap({ lead_status_map: '   ' })).toBeUndefined();
  });

  it('parses a valid lead status map and normalizes outcome keys', () => {
    const parsed = parseLeadStatusMap({
      lead_status_map: JSON.stringify({
        qualified: 'Sales Qualified',
        Disqualified: 'Closed - Junk',
        nurture: 'Nurture Sequence',
        'no-answer': 'Open - No Answer',
      }),
    });
    expect(parsed).toEqual({
      qualified: 'Sales Qualified',
      disqualified: 'Closed - Junk',
      nurture: 'Nurture Sequence',
      no_answer: 'Open - No Answer',
    });
  });

  it('ignores unknown outcome keys but keeps known ones', () => {
    const parsed = parseLeadStatusMap({
      lead_status_map: JSON.stringify({
        qualified: 'Qualified',
        bogus: 'Should be ignored',
      }),
    });
    expect(parsed).toEqual({ qualified: 'Qualified' });
  });

  it('throws on malformed JSON', () => {
    expect(() => parseLeadStatusMap({ lead_status_map: '{broken' })).toThrow(/Invalid Salesforce lead_status_map JSON/);
  });

  it('throws when an entry is not a string', () => {
    expect(() =>
      parseLeadStatusMap({
        lead_status_map: JSON.stringify({ qualified: 123 }),
      }),
    ).toThrow(/expected a string LeadStatus/);
  });

  it('falls back to defaults when nothing is configured', () => {
    expect(resolveLeadStatusMap({})).toEqual(DEFAULT_SALESFORCE_LEAD_STATUS_MAP);
  });

  it('merges overrides on top of defaults', () => {
    const merged = resolveLeadStatusMap({
      lead_status_map: JSON.stringify({ qualified: 'Sales Qualified', nurture: 'Nurture' }),
    });
    expect(merged).toEqual({
      qualified: 'Sales Qualified',
      disqualified: DEFAULT_SALESFORCE_LEAD_STATUS_MAP.disqualified,
      nurture: 'Nurture',
      no_answer: DEFAULT_SALESFORCE_LEAD_STATUS_MAP.no_answer,
    });
  });

  it('returns defaults silently when persisted JSON is invalid (resolveLeadStatusMap)', () => {
    expect(resolveLeadStatusMap({ lead_status_map: '{broken' })).toEqual(DEFAULT_SALESFORCE_LEAD_STATUS_MAP);
  });
});
