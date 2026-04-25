import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  isPrivateAddress,
  performPinnedFetch,
  preflightUrl,
  safeFetch,
  SsrfBlockedError,
} from '../../platform/integrations/connectors/ssrfGuard';

describe('isPrivateAddress', () => {
  describe('IPv4 private/reserved ranges', () => {
    const privateIPs = [
      '0.0.0.0',
      '10.0.0.1',
      '10.255.255.255',
      '100.64.0.1',
      '100.127.255.255',
      '127.0.0.1',
      '127.255.255.255',
      '169.254.1.2',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.0',
      '192.0.2.5',
      '192.168.1.1',
      '192.168.0.0',
      '198.18.5.10',
      '198.19.0.0',
      '198.51.100.7',
      '203.0.113.42',
      '224.0.0.1',
      '239.255.255.255',
      '240.0.0.1',
      '255.255.255.255',
    ];
    it.each(privateIPs)('blocks %s', (ip) => {
      expect(isPrivateAddress(ip)).toBe(true);
    });
  });

  describe('IPv4 public addresses', () => {
    const publicIPs = [
      '8.8.8.8',
      '1.1.1.1',
      '52.84.1.1',
      '142.250.190.78',
      '13.107.42.14',
      '93.184.216.34',
    ];
    it.each(publicIPs)('allows %s', (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    });
  });

  describe('IPv6 private/reserved ranges', () => {
    const privateIPv6 = [
      '::',
      '::1',
      'fe80::1',
      'fe80::abcd:1234',
      'febf:ffff::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      'ff00::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:169.254.169.254',
      '::ffff:192.168.0.1',
      '2001:db8::1',
    ];
    it.each(privateIPv6)('blocks %s', (ip) => {
      expect(isPrivateAddress(ip)).toBe(true);
    });
  });

  describe('IPv6 public addresses', () => {
    const publicIPv6 = [
      '2606:4700:4700::1111',
      '2001:4860:4860::8888',
      '::ffff:8.8.8.8',
    ];
    it.each(publicIPv6)('allows %s', (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    });
  });

  it('blocks malformed addresses defensively', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
    expect(isPrivateAddress('999.999.999.999')).toBe(true);
  });
});

describe('preflightUrl', () => {
  it('rejects non-HTTPS URLs by default', async () => {
    const result = await preflightUrl('http://example.com/hook');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/protocol/);
  });

  it('rejects URLs with embedded credentials', async () => {
    const result = await preflightUrl('https://user:pass@example.com/hook', {
      resolver: async () => ['8.8.8.8'],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/credentials/);
  });

  it('rejects malformed URLs', async () => {
    const result = await preflightUrl('not a url');
    expect(result.ok).toBe(false);
  });

  it('blocks the localhost hostname', async () => {
    const result = await preflightUrl('https://localhost/hook');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/localhost/);
  });

  it('blocks AWS metadata IP literal', async () => {
    const result = await preflightUrl('https://169.254.169.254/latest/meta-data');
    expect(result.ok).toBe(false);
  });

  it('blocks GCP metadata hostname', async () => {
    const result = await preflightUrl('https://metadata.google.internal/computeMetadata/v1/');
    expect(result.ok).toBe(false);
  });

  it('blocks .internal suffix hostnames', async () => {
    const result = await preflightUrl('https://my-service.internal/hook');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/\.internal/);
  });

  it('blocks .local suffix hostnames', async () => {
    const result = await preflightUrl('https://printer.local/hook');
    expect(result.ok).toBe(false);
  });

  it('blocks IPv6 link-local literal', async () => {
    const result = await preflightUrl('https://[fe80::1]/hook');
    expect(result.ok).toBe(false);
  });

  it('blocks IPv6 ULA literal', async () => {
    const result = await preflightUrl('https://[fc00::1]/hook');
    expect(result.ok).toBe(false);
  });

  it('blocks public hostname that resolves to private IPv4 (DNS rebinding scenario)', async () => {
    const result = await preflightUrl('https://attacker.example.com/hook', {
      resolver: async () => ['10.0.0.5'],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/private/);
    expect(result.resolvedIps).toEqual(['10.0.0.5']);
  });

  it('blocks public hostname that resolves to AWS metadata IP', async () => {
    const result = await preflightUrl('https://attacker.example.com/hook', {
      resolver: async () => ['169.254.169.254'],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/169\.254\.169\.254/);
  });

  it('blocks public hostname that resolves to GCP metadata IP', async () => {
    const result = await preflightUrl('https://attacker.example.com/hook', {
      resolver: async () => ['169.254.169.254'],
    });
    expect(result.ok).toBe(false);
  });

  it('blocks if any DNS answer is private (mixed answers)', async () => {
    const result = await preflightUrl('https://attacker.example.com/hook', {
      resolver: async () => ['8.8.8.8', '127.0.0.1'],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/127\.0\.0\.1/);
  });

  it('blocks public hostname that resolves to private IPv6 ULA', async () => {
    const result = await preflightUrl('https://attacker.example.com/hook', {
      resolver: async () => ['fc00::1234'],
    });
    expect(result.ok).toBe(false);
  });

  it('blocks public hostname that resolves to IPv6 link-local', async () => {
    const result = await preflightUrl('https://attacker.example.com/hook', {
      resolver: async () => ['fe80::abcd'],
    });
    expect(result.ok).toBe(false);
  });

  it('blocks public hostname that resolves to IPv4-mapped IPv6 metadata', async () => {
    const result = await preflightUrl('https://attacker.example.com/hook', {
      resolver: async () => ['::ffff:169.254.169.254'],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects DNS lookup failure', async () => {
    const result = await preflightUrl('https://nonexistent.example.com/hook', {
      resolver: async () => {
        throw new Error('NXDOMAIN');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/DNS/);
  });

  it('rejects when no addresses are returned', async () => {
    const result = await preflightUrl('https://empty.example.com/hook', {
      resolver: async () => [],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no addresses/);
  });

  it('allows public hostname that resolves to public IPv4', async () => {
    const result = await preflightUrl('https://hooks.zapier.com/abc', {
      resolver: async () => ['8.8.8.8'],
    });
    expect(result.ok).toBe(true);
    expect(result.resolvedIps).toEqual(['8.8.8.8']);
  });

  it('allows public hostname that resolves to public IPv6', async () => {
    const result = await preflightUrl('https://hooks.example.com/abc', {
      resolver: async () => ['2606:4700:4700::1111'],
    });
    expect(result.ok).toBe(true);
  });

  it('allows public IPv4 literal', async () => {
    const result = await preflightUrl('https://8.8.8.8/path');
    expect(result.ok).toBe(true);
  });
});

describe('performPinnedFetch (rebinding control)', () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('connects to the pinned IP and forwards the original Host header', async () => {
    const received: { host?: string; path?: string; body?: string } = {};

    server = http.createServer((req, res) => {
      received.host = req.headers.host;
      received.path = req.url;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.body = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sawHost: req.headers.host }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const res = await performPinnedFetch(
      `http://attacker.example.test:${port}/hook`,
      '127.0.0.1',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ping: 1 }),
        allowHttp: true,
      },
    );

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(received.host).toBe(`attacker.example.test:${port}`);
    expect(received.path).toBe('/hook');
    expect(received.body).toBe('{"ping":1}');

    const data = (await res.json()) as { ok: boolean; sawHost: string };
    expect(data.sawHost).toBe(`attacker.example.test:${port}`);
  });

  it('respects an existing Host header passed by the caller', async () => {
    const received: { host?: string } = {};

    server = http.createServer((req, res) => {
      received.host = req.headers.host;
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    await performPinnedFetch(
      `http://example.test:${port}/`,
      '127.0.0.1',
      { allowHttp: true, headers: { Host: 'override.example.test' } },
    );

    expect(received.host).toBe('override.example.test');
  });
});

describe('safeFetch', () => {
  it('throws SsrfBlockedError when preflight fails', async () => {
    await expect(
      safeFetch('https://attacker.example.com/hook', {
        resolver: async () => ['10.0.0.1'],
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('throws SsrfBlockedError for plain HTTP', async () => {
    await expect(safeFetch('http://example.com/hook')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('throws SsrfBlockedError for AWS metadata host', async () => {
    await expect(safeFetch('https://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it('rejects DNS rebinding fixture: hostname looks public but resolves to internal IP', async () => {
    const REBINDING_RESOLVER = async () => ['192.168.1.50'];
    await expect(
      safeFetch('https://internal.attacker.test/hook', {
        method: 'POST',
        body: '{"x":1}',
        resolver: REBINDING_RESOLVER,
      }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});
