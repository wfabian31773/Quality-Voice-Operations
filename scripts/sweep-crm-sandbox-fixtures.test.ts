/**
 * Unit coverage for the pure namespace-matching helpers in
 * `sweep-crm-sandbox-fixtures.ts`. The HTTP-side per-provider sweepers
 * are exercised by hand against live sandboxes (and by the weekly CI
 * job) — this suite locks in the predicates that decide which records
 * are safe to delete, which is the part most likely to drift if the
 * fixture-naming convention in `appointmentBooked.integration.test.ts`
 * ever changes.
 */

import { describe, expect, test } from 'vitest';
import {
  buildHubspotContactSearchBody,
  buildSalesforceContactQuery,
  buildSalesforceLeadQuery,
  buildZohoContactQuery,
  isFixtureDealName,
  isFixtureEmail,
  isFixtureName,
  isFixturePhone,
  isOldEnough,
} from './sweep-crm-sandbox-fixtures';

describe('isOldEnough', () => {
  const cutoff = 1_000_000;

  test('treats records at or before the cutoff as old enough', () => {
    expect(isOldEnough(cutoff, cutoff)).toBe(true);
    expect(isOldEnough(cutoff - 1, cutoff)).toBe(true);
  });

  test('treats records strictly after the cutoff as too new', () => {
    expect(isOldEnough(cutoff + 1, cutoff)).toBe(false);
  });

  test('treats missing / non-finite timestamps as too new (safe default)', () => {
    expect(isOldEnough(undefined, cutoff)).toBe(false);
    expect(isOldEnough(Number.NaN, cutoff)).toBe(false);
    expect(isOldEnough(Number.POSITIVE_INFINITY, cutoff)).toBe(false);
  });
});

describe('isFixtureName', () => {
  test('matches the company prefix the integration suite emits', () => {
    expect(isFixtureName('Apt Booked Co 1745961600000-abc123')).toBe(true);
    expect(isFixtureName('Apt Booked Co')).toBe(true);
  });

  test('rejects unrelated company names', () => {
    expect(isFixtureName('Acme Inc')).toBe(false);
    expect(isFixtureName(' Apt Booked Co 1234')).toBe(false); // leading space
    expect(isFixtureName('apt booked co 1234')).toBe(false); // wrong case
    expect(isFixtureName('')).toBe(false);
    expect(isFixtureName(undefined)).toBe(false);
    expect(isFixtureName(null)).toBe(false);
  });
});

describe('isFixtureEmail', () => {
  test('matches the synthetic apt-booked-*@example.invalid pattern', () => {
    expect(isFixtureEmail('apt-booked-1745961600000-abc123@example.invalid')).toBe(true);
  });

  test('requires both prefix AND suffix', () => {
    expect(isFixtureEmail('apt-booked-foo@example.com')).toBe(false);
    expect(isFixtureEmail('not-apt-booked-foo@example.invalid')).toBe(false);
    expect(isFixtureEmail('foo@example.invalid')).toBe(false);
    expect(isFixtureEmail('')).toBe(false);
    expect(isFixtureEmail(undefined)).toBe(false);
  });
});

describe('isFixturePhone', () => {
  test('matches the +1555 NANP fictional-block prefix verbatim', () => {
    expect(isFixturePhone('+15551234567')).toBe(true);
    expect(isFixturePhone('+1555000111')).toBe(true);
  });

  test('normalises punctuation/spaces before matching', () => {
    expect(isFixturePhone('+1 (555) 123-4567')).toBe(true);
    expect(isFixturePhone('+1-555-123-4567')).toBe(true);
  });

  test('rejects non-555 numbers in the +1 NANP block', () => {
    expect(isFixturePhone('+12125551234')).toBe(false);
    expect(isFixturePhone('555-1234')).toBe(false);
    expect(isFixturePhone('')).toBe(false);
    expect(isFixturePhone(undefined)).toBe(false);
  });
});

describe('isFixtureDealName', () => {
  test('matches `${company} - QVO Appointment` only when company half is a fixture', () => {
    expect(isFixtureDealName('Apt Booked Co 1745961600000-abc123 - QVO Appointment')).toBe(true);
  });

  test('rejects non-fixture deal names ending in " - QVO Appointment"', () => {
    expect(isFixtureDealName('Acme Inc - QVO Appointment')).toBe(false);
  });

  test('rejects deal names not ending in the suffix', () => {
    expect(isFixtureDealName('Apt Booked Co 1745 - Other suffix')).toBe(false);
    expect(isFixtureDealName('Apt Booked Co 1745')).toBe(false);
    expect(isFixtureDealName('')).toBe(false);
    expect(isFixtureDealName(undefined)).toBe(false);
  });
});

// Contacts/Leads created by the booking adapter carry both a synthetic
// email AND a +1555 phone, but a leaked row that was created at the
// moment one half got persisted (or whose email was scrubbed by the
// provider's PII tooling) must still be picked up by the sweep. Each
// builder is unit-tested to confirm BOTH the email and phone branches
// are present in the search criteria emitted to the provider.

describe('buildHubspotContactSearchBody', () => {
  const body = buildHubspotContactSearchBody(1_700_000_000_000, 200);

  test('emits two filterGroups (OR semantics): one for email, one for phone', () => {
    expect(body.filterGroups).toHaveLength(2);

    const emailGroup = body.filterGroups[0];
    const phoneGroup = body.filterGroups[1];

    expect(emailGroup.filters).toEqual(
      expect.arrayContaining([
        { propertyName: 'email', operator: 'STARTS_WITH', value: 'apt-booked-' },
        { propertyName: 'hs_createdate', operator: 'LT', value: '1700000000000' },
      ]),
    );
    expect(phoneGroup.filters).toEqual(
      expect.arrayContaining([
        { propertyName: 'phone', operator: 'STARTS_WITH', value: '+1555' },
        { propertyName: 'hs_createdate', operator: 'LT', value: '1700000000000' },
      ]),
    );
  });

  test('requests email and phone properties so the post-filter can reverify both', () => {
    expect(body.properties).toEqual(expect.arrayContaining(['email', 'phone', 'hs_createdate']));
  });

  test('passes through the row cap as the page-size limit', () => {
    expect(body.limit).toBe(200);
  });
});

describe('buildSalesforceContactQuery', () => {
  const q = buildSalesforceContactQuery('2026-04-30T00:00:00.000Z', 200);

  test('matches Email OR Phone OR MobilePhone (covers a +1555-only contact)', () => {
    expect(q).toContain("Email LIKE 'apt-booked-%@example.invalid'");
    expect(q).toContain("Phone LIKE '+1555%'");
    expect(q).toContain("MobilePhone LIKE '+1555%'");
    // The three predicates must be OR'd, not AND'd, or a phone-only
    // fixture would never match.
    const where = q.slice(q.indexOf('WHERE'));
    expect(where).toMatch(/Email LIKE [^)]* OR Phone LIKE [^)]* OR MobilePhone LIKE/);
  });

  test('selects all three identifier fields so the post-filter can reverify them', () => {
    expect(q).toContain('SELECT Id, Email, Phone, MobilePhone, CreatedDate FROM Contact');
  });

  test('pins on CreatedDate < cutoff and the row cap', () => {
    expect(q).toContain('CreatedDate < 2026-04-30T00:00:00.000Z');
    expect(q).toContain('LIMIT 200');
  });
});

describe('buildSalesforceLeadQuery', () => {
  const q = buildSalesforceLeadQuery('2026-04-30T00:00:00.000Z', 200);

  test('matches Email OR Phone OR MobilePhone (covers a +1555-only lead)', () => {
    expect(q).toContain("Email LIKE 'apt-booked-%@example.invalid'");
    expect(q).toContain("Phone LIKE '+1555%'");
    expect(q).toContain("MobilePhone LIKE '+1555%'");
    const where = q.slice(q.indexOf('WHERE'));
    expect(where).toMatch(/Email LIKE [^)]* OR Phone LIKE [^)]* OR MobilePhone LIKE/);
  });

  test('only sweeps unconverted leads (converted ones become Contacts/Accounts)', () => {
    expect(q).toContain('IsConverted = false');
  });
});

describe('buildZohoContactQuery', () => {
  const q = buildZohoContactQuery('2026-04-30T00:00:00.000Z', 200);

  test('matches Email OR Phone OR Mobile (covers a +1555-only contact)', () => {
    expect(q).toContain("Email like 'apt-booked-%@example.invalid'");
    expect(q).toContain("Phone like '+1555%'");
    expect(q).toContain("Mobile like '+1555%'");
    const where = q.slice(q.indexOf('where'));
    expect(where).toMatch(/Email like [^)]* or Phone like [^)]* or Mobile like/);
  });

  test('selects all three identifier fields so the post-filter can reverify them', () => {
    expect(q).toContain('select id, Email, Phone, Mobile, Created_Time from Contacts');
  });
});
