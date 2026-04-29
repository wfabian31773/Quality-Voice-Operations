import { describe, it, expect } from 'vitest';
import { isPrivateOrInternalHost, isBlockedUrl } from './privateHostBlocklist';

describe('privateHostBlocklist', () => {
  it('blocks the canonical private/loopback hostnames', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', '0.0.0.0', 'metadata.google.internal', 'instance-data']) {
      expect(isPrivateOrInternalHost(h)).toBe(true);
    }
  });

  it('blocks RFC1918 ranges and link-local addresses', () => {
    for (const h of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.5', '192.168.1.10', '169.254.169.254']) {
      expect(isPrivateOrInternalHost(h)).toBe(true);
    }
  });

  it('blocks .local and .internal suffixes', () => {
    expect(isPrivateOrInternalHost('printer.local')).toBe(true);
    expect(isPrivateOrInternalHost('admin.internal')).toBe(true);
  });

  it('blocks IPv6 loopback / link-local / unique-local addresses (with brackets)', () => {
    expect(isPrivateOrInternalHost('[::1]')).toBe(true);
    expect(isPrivateOrInternalHost('[fe80::1]')).toBe(true);
    expect(isPrivateOrInternalHost('[fd00::1]')).toBe(true);
  });

  it('allows ordinary public hostnames', () => {
    expect(isPrivateOrInternalHost('example.com')).toBe(false);
    expect(isPrivateOrInternalHost('docs.example.org')).toBe(false);
    expect(isPrivateOrInternalHost('8.8.8.8')).toBe(false);
  });

  it('isBlockedUrl rejects unparseable URLs and non-http(s) schemes', () => {
    expect(isBlockedUrl('not a url')).toBe(true);
    expect(isBlockedUrl('file:///etc/passwd')).toBe(true);
    expect(isBlockedUrl('javascript:alert(1)')).toBe(true);
  });

  it('isBlockedUrl mirrors host check for http(s) URLs', () => {
    expect(isBlockedUrl('https://example.com')).toBe(false);
    expect(isBlockedUrl('http://localhost/admin')).toBe(true);
    expect(isBlockedUrl('http://10.0.0.1')).toBe(true);
  });
});
