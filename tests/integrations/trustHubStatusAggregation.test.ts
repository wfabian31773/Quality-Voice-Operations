import { describe, it, expect } from 'vitest';

import {
  aggregateTrustHubStatus,
  isTrustHubTerminal,
  normalizeTrustHubStatus,
} from '../../client-app/src/pages/TrustedCallers';

describe('normalizeTrustHubStatus', () => {
  it('canonicalizes uppercase brand-native statuses', () => {
    expect(normalizeTrustHubStatus('PENDING')).toBe('pending-review');
    expect(normalizeTrustHubStatus('APPROVED')).toBe('twilio-approved');
    expect(normalizeTrustHubStatus('FAILED')).toBe('twilio-rejected');
    expect(normalizeTrustHubStatus('IN_REVIEW')).toBe('in-review');
    expect(normalizeTrustHubStatus('REJECTED')).toBe('twilio-rejected');
  });

  it('passes Twilio Trust Hub statuses through unchanged', () => {
    expect(normalizeTrustHubStatus('twilio-approved')).toBe('twilio-approved');
    expect(normalizeTrustHubStatus('twilio-rejected')).toBe('twilio-rejected');
    expect(normalizeTrustHubStatus('pending-review')).toBe('pending-review');
    expect(normalizeTrustHubStatus('in-review')).toBe('in-review');
    expect(normalizeTrustHubStatus('draft')).toBe('draft');
  });

  it('returns empty string for null/undefined', () => {
    expect(normalizeTrustHubStatus(null)).toBe('');
    expect(normalizeTrustHubStatus(undefined)).toBe('');
  });
});

describe('isTrustHubTerminal', () => {
  it('treats approved and rejected variants as terminal', () => {
    expect(isTrustHubTerminal('twilio-approved')).toBe(true);
    expect(isTrustHubTerminal('APPROVED')).toBe(true);
    expect(isTrustHubTerminal('twilio-rejected')).toBe(true);
    expect(isTrustHubTerminal('FAILED')).toBe(true);
  });

  it('treats pending/in-review/draft as non-terminal', () => {
    expect(isTrustHubTerminal('pending-review')).toBe(false);
    expect(isTrustHubTerminal('PENDING')).toBe(false);
    expect(isTrustHubTerminal('in-review')).toBe(false);
    expect(isTrustHubTerminal('IN_REVIEW')).toBe(false);
    expect(isTrustHubTerminal('draft')).toBe(false);
  });

  it('treats null/empty as non-terminal', () => {
    expect(isTrustHubTerminal(null)).toBe(false);
    expect(isTrustHubTerminal('')).toBe(false);
  });
});

describe('aggregateTrustHubStatus', () => {
  it('returns rejected when customer profile is rejected and trust product is pending', () => {
    expect(aggregateTrustHubStatus(['twilio-rejected', 'pending-review', null])).toBe('twilio-rejected');
  });

  it('returns rejected when customer profile is rejected and trust product is approved', () => {
    expect(aggregateTrustHubStatus(['twilio-rejected', 'twilio-approved', null])).toBe('twilio-rejected');
  });

  it('returns rejected when only the brand is rejected (uppercase)', () => {
    expect(aggregateTrustHubStatus(['twilio-approved', 'twilio-approved', 'FAILED'])).toBe('twilio-rejected');
  });

  it('returns approved only when every present resource is approved', () => {
    expect(aggregateTrustHubStatus(['twilio-approved', 'twilio-approved', null])).toBe('twilio-approved');
  });

  it('returns pending-review when CP+TP approved but brand is uppercase PENDING', () => {
    expect(aggregateTrustHubStatus(['twilio-approved', 'twilio-approved', 'PENDING'])).toBe('pending-review');
  });

  it('returns in-review when any resource is in-review and none rejected', () => {
    expect(aggregateTrustHubStatus(['twilio-approved', 'in-review', null])).toBe('in-review');
    expect(aggregateTrustHubStatus(['twilio-approved', 'twilio-approved', 'IN_REVIEW'])).toBe('in-review');
  });

  it('returns pending-review when any resource is pending and none rejected/in-review', () => {
    expect(aggregateTrustHubStatus(['twilio-approved', 'pending-review', null])).toBe('pending-review');
  });

  it('returns draft when all statuses are missing', () => {
    expect(aggregateTrustHubStatus([null, null, null])).toBe('draft');
  });

  it('treats failed/rejected synonyms as rejected', () => {
    expect(aggregateTrustHubStatus(['failed', 'pending-review', null])).toBe('twilio-rejected');
    expect(aggregateTrustHubStatus(['rejected', 'pending-review', null])).toBe('twilio-rejected');
  });
});

describe('polling eligibility (brand-only non-terminal)', () => {
  it('treats a caller with terminal CP+TP but non-terminal brand as needing polling', () => {
    const snap = {
      customerProfile: { status: 'twilio-approved' },
      trustProduct: { status: 'twilio-approved' },
      brand: { status: 'PENDING' },
    };
    const statuses = [
      snap.customerProfile?.status,
      snap.trustProduct?.status,
      snap.brand?.status,
    ].filter((s): s is string => typeof s === 'string');
    const needsPoll = statuses.length > 0 && statuses.some((s) => !isTrustHubTerminal(s));
    expect(needsPoll).toBe(true);
  });

  it('does not poll a caller whose CP+TP+brand are all terminal', () => {
    const snap = {
      customerProfile: { status: 'twilio-approved' },
      trustProduct: { status: 'twilio-approved' },
      brand: { status: 'APPROVED' },
    };
    const statuses = [
      snap.customerProfile?.status,
      snap.trustProduct?.status,
      snap.brand?.status,
    ].filter((s): s is string => typeof s === 'string');
    const needsPoll = statuses.length > 0 && statuses.some((s) => !isTrustHubTerminal(s));
    expect(needsPoll).toBe(false);
  });
});
