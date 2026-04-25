import { describe, expect, it } from 'vitest';
import {
  resolveZohoAccountsServer,
  resolveZohoApiDomain,
  ZOHO_ACCOUNTS_HOST_ALLOWLIST,
  ZOHO_API_HOST_ALLOWLIST,
} from './zohoRegion';

describe('resolveZohoAccountsServer', () => {
  it('accepts every allowlisted Zoho data-center host with https://', () => {
    for (const host of ZOHO_ACCOUNTS_HOST_ALLOWLIST) {
      expect(resolveZohoAccountsServer(`https://${host}`)).toBe(`https://${host}`);
    }
  });

  it('accepts hostnames without scheme and normalizes to https://<host>', () => {
    expect(resolveZohoAccountsServer('accounts.zoho.eu')).toBe('https://accounts.zoho.eu');
  });

  it('strips trailing path/query and returns the canonical origin', () => {
    expect(resolveZohoAccountsServer('https://accounts.zoho.in/oauth/v2/token?foo=bar'))
      .toBe('https://accounts.zoho.in');
  });

  it('is case-insensitive on hostname', () => {
    expect(resolveZohoAccountsServer('HTTPS://Accounts.Zoho.COM')).toBe('https://accounts.zoho.com');
  });

  it.each([
    undefined,
    null,
    '',
    '   ',
  ])('returns null for empty/missing input %p', (input) => {
    expect(resolveZohoAccountsServer(input as string | undefined | null)).toBeNull();
  });

  it.each([
    'http://accounts.zoho.com',                 // plain HTTP
    'https://accounts.zoho.com:8443',           // non-default port
    'https://attacker.example.com',             // arbitrary host
    'https://accounts.zoho.com.attacker.com',   // suffix-attack
    'https://accounts.zohoattacker.com',        // homograph-ish
    'https://accounts-zoho.com',                // dash variant
    'https://accounts.zoho.com@evil.com',       // userinfo trick → host=evil.com
    'javascript:alert(1)',                      // non-HTTP scheme
    'ftp://accounts.zoho.com',                  // wrong scheme
    'not a url',
  ])('rejects non-allowlisted / malformed input %p', (input) => {
    expect(resolveZohoAccountsServer(input)).toBeNull();
  });
});

describe('resolveZohoApiDomain', () => {
  it('accepts every allowlisted Zoho API host with https://', () => {
    for (const host of ZOHO_API_HOST_ALLOWLIST) {
      expect(resolveZohoApiDomain(`https://${host}`)).toBe(`https://${host}`);
    }
  });

  it('strips trailing path/query and returns the canonical origin', () => {
    expect(resolveZohoApiDomain('https://www.zohoapis.eu/crm/v2/Contacts?ids=1'))
      .toBe('https://www.zohoapis.eu');
  });

  it.each([
    undefined,
    null,
    '',
    '   ',
  ])('returns null for empty/missing input %p', (input) => {
    expect(resolveZohoApiDomain(input as string | undefined | null)).toBeNull();
  });

  it.each([
    'http://www.zohoapis.com',                  // plain HTTP
    'https://www.zohoapis.com:8443',            // non-default port
    'https://internal.local',                   // internal host (SSRF)
    'https://169.254.169.254',                  // cloud metadata IP
    'https://www.zohoapis.com.attacker.com',    // suffix-attack
    'https://www.zohoapis.attacker.com',        // sibling-attack
    'https://www.zoho-apis.com',                // dash variant
    'https://www.zohoapis.com@evil.com',        // userinfo trick → host=evil.com
    'https://accounts.zoho.com',                // accounts host, not API
    'javascript:alert(1)',
    'ftp://www.zohoapis.com',
  ])('rejects non-allowlisted / malformed api_domain %p', (input) => {
    expect(resolveZohoApiDomain(input)).toBeNull();
  });
});
