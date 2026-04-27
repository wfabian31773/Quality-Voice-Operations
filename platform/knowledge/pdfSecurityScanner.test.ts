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
