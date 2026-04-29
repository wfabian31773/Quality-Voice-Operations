/**
 * Unit tests for the PDF security scanner — covers both the static analyzer
 * and the optional ClamAV INSTREAM client (using an in-process TCP fake).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'node:net';

const ORIGINAL_ENV = { ...process.env };

async function loadScanner() {
  return import('./pdfSecurityScanner');
}

function startFakeClamd(handler: (chunks: Buffer, socket: net.Socket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk) => {
        chunks.push(chunk);
        handler(Buffer.concat(chunks), socket);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

beforeEach(() => {
  delete process.env.CLAMAV_HOST;
  delete process.env.CLAMAV_PORT;
  delete process.env.CLAMAV_TIMEOUT_MS;
  delete process.env.GOOGLE_SAFE_BROWSING_API_KEY;
  delete process.env.GOOGLE_SAFE_BROWSING_TIMEOUT_MS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('pdfSecurityScanner — static analyzer', () => {
  it('returns clean for a benign PDF body', async () => {
    const { scanPdfBuffer } = await loadScanner();
    const buf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
    const result = await scanPdfBuffer(buf);
    expect(result.verdict).toBe('clean');
    expect(result.detector).toBe('pdf-static-analyzer');
    expect(result.findings).toEqual([]);
  });

  it('flags PDFs containing /JavaScript as suspicious', async () => {
    const { scanPdfBuffer, buildRejectionMessage } = await loadScanner();
    const buf = Buffer.from('%PDF-1.4\n2 0 obj << /S /JavaScript /JS (alert(1);) >> endobj\n%%EOF\n');
    const result = await scanPdfBuffer(buf);
    expect(result.verdict).toBe('suspicious');
    expect(result.findings.some((f) => f.startsWith('/JavaScript'))).toBe(true);
    expect(buildRejectionMessage(result)).toMatch(/active or unsafe content/);
  });

  it('flags PDFs containing /Launch and /EmbeddedFile', async () => {
    const { scanPdfBuffer } = await loadScanner();
    const buf = Buffer.from(
      '%PDF-1.4\n2 0 obj << /S /Launch /F (cmd.exe) >> endobj\n5 0 obj << /Type /EmbeddedFile >> endobj\n%%EOF\n',
    );
    const result = await scanPdfBuffer(buf);
    expect(result.verdict).toBe('suspicious');
    expect(result.findings.some((f) => f.startsWith('/Launch'))).toBe(true);
    expect(result.findings.some((f) => f.startsWith('/EmbeddedFile'))).toBe(true);
  });
});

describe('pdfSecurityScanner — ClamAV integration', () => {
  it('returns infected when ClamAV reports FOUND', async () => {
    const fake = await startFakeClamd((chunks, socket) => {
      // After client sends INSTREAM header + data + zero-terminator we have
      // observed at least 14 bytes. Reply with a FOUND verdict and close.
      if (chunks.length >= 14 && !(socket as net.Socket & { _replied?: boolean })._replied) {
        (socket as net.Socket & { _replied?: boolean })._replied = true;
        socket.write(Buffer.from('stream: Eicar-Test-Signature FOUND\0'));
        socket.end();
      }
    });
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = String(fake.port);

    const { scanPdfBuffer } = await loadScanner();
    const buf = Buffer.from('%PDF-1.4\n%%EOF\n');
    const result = await scanPdfBuffer(buf);

    expect(result.verdict).toBe('infected');
    expect(result.detector).toBe('clamav');
    expect(result.reason).toMatch(/Eicar-Test-Signature/);
    await fake.close();
  });

  it('returns clean when ClamAV reports OK and the static scan is clean', async () => {
    const fake = await startFakeClamd((chunks, socket) => {
      if (chunks.length >= 14 && !(socket as net.Socket & { _replied?: boolean })._replied) {
        (socket as net.Socket & { _replied?: boolean })._replied = true;
        socket.write(Buffer.from('stream: OK\0'));
        socket.end();
      }
    });
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = String(fake.port);

    const { scanPdfBuffer } = await loadScanner();
    const buf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
    const result = await scanPdfBuffer(buf);

    expect(result.verdict).toBe('clean');
    expect(result.detector).toBe('clamav');
    await fake.close();
  });

  it('fails closed (suspicious) when ClamAV is configured but unreachable', async () => {
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = '1';

    const { scanPdfBuffer } = await loadScanner();
    const buf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
    const result = await scanPdfBuffer(buf);

    expect(result.verdict).toBe('suspicious');
    expect(result.detector).toBe('clamav');
    expect(result.findings).toContain('clamav-unreachable');
  });

  it('fails closed (suspicious) when ClamAV times out before responding', async () => {
    const fake = await startFakeClamd(() => {
      // Never reply — let the client time out.
    });
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = String(fake.port);
    process.env.CLAMAV_TIMEOUT_MS = '100';

    const { scanPdfBuffer } = await loadScanner();
    const buf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');
    const result = await scanPdfBuffer(buf);

    expect(result.verdict).toBe('suspicious');
    expect(result.detector).toBe('clamav');
    expect(result.findings).toContain('clamav-timeout');
    await fake.close();
  });

  it('escalates to infected if ClamAV says FOUND even when static scan is clean', async () => {
    const fake = await startFakeClamd((chunks, socket) => {
      if (chunks.length >= 14 && !(socket as net.Socket & { _replied?: boolean })._replied) {
        (socket as net.Socket & { _replied?: boolean })._replied = true;
        socket.write(Buffer.from('stream: Custom.Sig FOUND\0'));
        socket.end();
      }
    });
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = String(fake.port);

    const { scanPdfBuffer, buildRejectionMessage } = await loadScanner();
    const buf = Buffer.from('%PDF-1.4\n%%EOF\n');
    const result = await scanPdfBuffer(buf);

    expect(result.verdict).toBe('infected');
    expect(buildRejectionMessage(result)).toMatch(/flagged as malicious/);
    await fake.close();
  });
});

describe('pdfSecurityScanner — URL extraction', () => {
  it('extracts /URI literal links and ignores benign ones', async () => {
    const { extractPdfUrls, scanPdfBuffer } = await loadScanner();
    const buf = Buffer.from(
      '%PDF-1.4\n3 0 obj << /Type /Action /S /URI /URI (https://example.com/landing) >> endobj\n%%EOF\n',
    );
    expect(extractPdfUrls(buf)).toContain('https://example.com/landing');
    const result = await scanPdfBuffer(buf);
    expect(result.verdict).toBe('clean');
    expect(result.links).toEqual([{ url: 'https://example.com/landing', verdict: 'clean' }]);
  });

  it('extracts /URI hex-encoded links', async () => {
    const { extractPdfUrls } = await loadScanner();
    // "https://hex.test" hex-encoded
    const hex = Buffer.from('https://hex.test', 'utf8').toString('hex');
    const buf = Buffer.from(`%PDF-1.4\n4 0 obj << /S /URI /URI <${hex}> >> endobj\n%%EOF\n`);
    expect(extractPdfUrls(buf)).toContain('https://hex.test');
  });

  it('rejects PDFs whose links target private/internal addresses', async () => {
    const { scanPdfBuffer, buildRejectionMessage } = await loadScanner();
    const buf = Buffer.from(
      '%PDF-1.4\n3 0 obj << /S /URI /URI (http://169.254.169.254/latest/meta-data/) >> endobj\n%%EOF\n',
    );
    const result = await scanPdfBuffer(buf);
    expect(result.verdict).toBe('suspicious');
    expect(result.detector).toBe('pdf-link-scanner');
    expect(result.findings.some((f) => f.includes('169.254.169.254'))).toBe(true);
    expect(buildRejectionMessage(result)).toMatch(/active or unsafe content/);
    expect(result.links?.find((l) => l.url.includes('169.254'))?.verdict).toBe('private-network');
  });

  it('blocks GoToR remote actions that point at internal hosts', async () => {
    const { scanPdfBuffer } = await loadScanner();
    const buf = Buffer.from(
      '%PDF-1.4\n5 0 obj << /S /GoToR /F (http://localhost:8080/secret) /D [0 /Fit] >> endobj\n%%EOF\n',
    );
    const result = await scanPdfBuffer(buf);
    // /GoToR itself triggers the static analyzer, but the link should also be flagged.
    expect(result.verdict).toBe('suspicious');
    expect(result.links?.some((l) => l.url.includes('localhost') && l.verdict === 'private-network')).toBe(true);
  });

  it('blocks non-http(s) URI schemes such as file://', async () => {
    const { scanPdfBuffer } = await loadScanner();
    const buf = Buffer.from(
      '%PDF-1.4\n3 0 obj << /S /URI /URI (file:///etc/passwd) >> endobj\n%%EOF\n',
    );
    const result = await scanPdfBuffer(buf);
    expect(result.verdict).toBe('suspicious');
    expect(result.links?.[0]?.verdict).toBe('private-network');
  });

  it('marks unparseable URI strings as suspicious', async () => {
    const { scanPdfBuffer } = await loadScanner();
    const buf = Buffer.from(
      '%PDF-1.4\n3 0 obj << /S /URI /URI (not a url at all) >> endobj\n%%EOF\n',
    );
    const result = await scanPdfBuffer(buf);
    expect(result.verdict).toBe('suspicious');
    expect(result.links?.[0]?.verdict).toBe('unparseable');
  });
});

describe('pdfSecurityScanner — Safe Browsing reputation', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('flags PDFs whose links match a Safe Browsing threat as infected', async () => {
    process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'fake-key';
    let receivedBody: unknown = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      receivedBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({
          matches: [
            {
              threatType: 'SOCIAL_ENGINEERING',
              threat: { url: 'https://phish.example.com/fakelogin' },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const { scanPdfBuffer } = await loadScanner();
    const buf = Buffer.from(
      '%PDF-1.4\n3 0 obj << /S /URI /URI (https://phish.example.com/fakelogin) >> endobj\n%%EOF\n',
    );
    const result = await scanPdfBuffer(buf);
    expect(result.verdict).toBe('infected');
    expect(result.detector).toBe('google-safe-browsing');
    expect(result.reputation?.bad).toBe(1);
    expect(result.links?.[0]?.threatType).toBe('SOCIAL_ENGINEERING');
    expect(receivedBody).toBeTruthy();
  });

  it('does not mark a clean PDF as infected when Safe Browsing returns no matches', async () => {
    process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'fake-key';
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const { scanPdfBuffer } = await loadScanner();
    const buf = Buffer.from(
      '%PDF-1.4\n3 0 obj << /S /URI /URI (https://example.com) >> endobj\n%%EOF\n',
    );
    const result = await scanPdfBuffer(buf);
    expect(result.verdict).toBe('clean');
    expect(result.reputation?.checked).toBe(true);
    expect(result.reputation?.bad).toBe(0);
  });

  it('does not block uploads when Safe Browsing is unreachable', async () => {
    process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'fake-key';
    globalThis.fetch = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch;

    const { scanPdfBuffer } = await loadScanner();
    const buf = Buffer.from(
      '%PDF-1.4\n3 0 obj << /S /URI /URI (https://example.com) >> endobj\n%%EOF\n',
    );
    const result = await scanPdfBuffer(buf);
    expect(result.verdict).toBe('clean');
    expect(result.reputation?.checked).toBe(false);
    expect(result.reputation?.error).toMatch(/ECONNREFUSED/);
  });

  it('matches Safe Browsing responses even when the provider canonicalizes the URL differently', async () => {
    process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'fake-key';
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          matches: [
            {
              threatType: 'MALWARE',
              // Provider returns trailing-slash + lowercased host that differ from what we sent.
              threat: { url: 'https://phish.example.com:443/path/' },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const { scanPdfBuffer } = await loadScanner();
    // PDF contains the link in a slightly different form (uppercased host, no trailing slash).
    const buf = Buffer.from(
      '%PDF-1.4\n3 0 obj << /S /URI /URI (https://Phish.Example.com/path/) >> endobj\n%%EOF\n',
    );
    const result = await scanPdfBuffer(buf);
    expect(result.verdict).toBe('infected');
    expect(result.detector).toBe('google-safe-browsing');
    expect(result.links?.[0]?.threatType).toBe('MALWARE');
    expect(result.links?.[0]?.url).toBe('https://Phish.Example.com/path/');
  });

  it('skips Safe Browsing when no API key is configured', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}');
    }) as typeof fetch;

    const { scanPdfBuffer } = await loadScanner();
    const buf = Buffer.from(
      '%PDF-1.4\n3 0 obj << /S /URI /URI (https://example.com) >> endobj\n%%EOF\n',
    );
    const result = await scanPdfBuffer(buf);
    expect(called).toBe(false);
    expect(result.verdict).toBe('clean');
    expect(result.reputation).toBeUndefined();
  });
});
