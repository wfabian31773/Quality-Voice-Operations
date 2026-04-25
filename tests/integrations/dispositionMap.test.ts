import { describe, it, expect } from 'vitest';
import {
  parseDispositionMap,
  mapDisposition,
  DEFAULT_SALESFORCE_DISPOSITION_MAP,
  DEFAULT_HUBSPOT_DISPOSITION_MAP,
  DEFAULT_PIPEDRIVE_DISPOSITION_MAP,
  normalizeDispositionKey,
  getDefaultDispositionMap,
} from '../../platform/integrations/connectors/dispositionMap';

describe('dispositionMap', () => {
  describe('parseDispositionMap', () => {
    it('returns undefined when no disposition_map is set', () => {
      expect(parseDispositionMap({}, 'salesforce')).toBeUndefined();
      expect(parseDispositionMap({ disposition_map: '' }, 'hubspot')).toBeUndefined();
      expect(parseDispositionMap({ disposition_map: '   ' }, 'pipedrive')).toBeUndefined();
    });

    it('parses valid maps for each provider', () => {
      const raw = JSON.stringify({
        booked: { status: 'X', callDisposition: 'Y' },
      });
      expect(parseDispositionMap({ disposition_map: raw }, 'salesforce')).toEqual({
        booked: { status: 'X', callDisposition: 'Y' },
      });
      expect(parseDispositionMap({ disposition_map: raw }, 'hubspot')).toEqual({
        booked: { status: 'X', callDisposition: 'Y' },
      });
      expect(parseDispositionMap({ disposition_map: raw }, 'pipedrive')).toEqual({
        booked: { status: 'X', callDisposition: 'Y' },
      });
    });

    it('throws provider-labeled errors for invalid JSON', () => {
      expect(() => parseDispositionMap({ disposition_map: 'not json' }, 'hubspot')).toThrow(
        /Invalid HubSpot disposition_map JSON/,
      );
      expect(() => parseDispositionMap({ disposition_map: 'not json' }, 'pipedrive')).toThrow(
        /Invalid Pipedrive disposition_map JSON/,
      );
      expect(() => parseDispositionMap({ disposition_map: 'not json' }, 'salesforce')).toThrow(
        /Invalid Salesforce disposition_map JSON/,
      );
    });

    it('throws when entry is missing status', () => {
      const raw = JSON.stringify({ booked: { callDisposition: 'Y' } });
      expect(() => parseDispositionMap({ disposition_map: raw }, 'hubspot')).toThrow(
        /HubSpot disposition_map entry for "booked": "status" is required/,
      );
    });

    it('throws when entry is not an object', () => {
      const raw = JSON.stringify({ booked: 'oops' });
      expect(() => parseDispositionMap({ disposition_map: raw }, 'pipedrive')).toThrow(
        /Pipedrive disposition_map entry for "booked"/,
      );
    });

    it('throws when top-level is not an object', () => {
      const raw = JSON.stringify(['booked']);
      expect(() => parseDispositionMap({ disposition_map: raw }, 'hubspot')).toThrow(
        /Invalid HubSpot disposition_map: expected an object/,
      );
    });

    it('normalizes keys via aliases', () => {
      const raw = JSON.stringify({
        appointment_booked: { status: 'A' },
        voicemail: { status: 'B' },
      });
      const map = parseDispositionMap({ disposition_map: raw }, 'salesforce');
      expect(map?.booked).toEqual({ status: 'A', callDisposition: undefined });
      expect(map?.no_answer).toEqual({ status: 'B', callDisposition: undefined });
    });
  });

  describe('mapDisposition', () => {
    it('falls back to provider defaults when no custom map is provided', () => {
      expect(mapDisposition('salesforce', 'booked')).toEqual(
        DEFAULT_SALESFORCE_DISPOSITION_MAP.booked,
      );
      expect(mapDisposition('hubspot', 'no_answer')).toEqual(
        DEFAULT_HUBSPOT_DISPOSITION_MAP.no_answer,
      );
      expect(mapDisposition('pipedrive', 'booked')).toEqual(
        DEFAULT_PIPEDRIVE_DISPOSITION_MAP.booked,
      );
    });

    it('honours custom overrides', () => {
      const custom = { booked: { status: 'CustomStatus', callDisposition: 'CustomCD' } };
      expect(mapDisposition('hubspot', 'booked', custom)).toEqual({
        status: 'CustomStatus',
        callDisposition: 'CustomCD',
      });
    });

    it('uses appropriate fallback for unknown dispositions per provider', () => {
      expect(mapDisposition('salesforce', 'unknown_disposition')).toEqual({
        status: 'Completed',
        callDisposition: 'unknown_disposition',
      });
      expect(mapDisposition('hubspot', 'unknown_disposition')).toEqual({
        status: 'COMPLETED',
        callDisposition: 'unknown_disposition',
      });
      expect(mapDisposition('pipedrive', 'unknown_disposition')).toEqual({
        status: 'call',
        callDisposition: 'unknown_disposition',
      });
    });

    it('normalizes input dispositions', () => {
      expect(mapDisposition('hubspot', 'No-Answer')).toEqual(
        DEFAULT_HUBSPOT_DISPOSITION_MAP.no_answer,
      );
      expect(mapDisposition('pipedrive', 'APPOINTMENT_BOOKED')).toEqual(
        DEFAULT_PIPEDRIVE_DISPOSITION_MAP.booked,
      );
    });
  });

  describe('helpers', () => {
    it('normalizeDispositionKey collapses whitespace and aliases', () => {
      expect(normalizeDispositionKey('No Answer')).toBe('no_answer');
      expect(normalizeDispositionKey('voicemail')).toBe('no_answer');
      expect(normalizeDispositionKey(undefined)).toBe('completed');
      expect(normalizeDispositionKey('')).toBe('completed');
    });

    it('getDefaultDispositionMap returns the provider defaults', () => {
      expect(getDefaultDispositionMap('hubspot').booked.status).toBe('COMPLETED');
      expect(getDefaultDispositionMap('pipedrive').booked.status).toBe('meeting');
      expect(getDefaultDispositionMap('salesforce').booked.status).toBe('Completed');
    });
  });
});
