import * as net from 'node:net';
import { createLogger } from '../core/logger';

const logger = createLogger('PDF_SECURITY_SCANNER');

export type ScanVerdict = 'clean' | 'suspicious' | 'infected';

export interface PdfScanResult {
  verdict: ScanVerdict;
  detector: string;
  reason?: string;
  findings: string[];
}

const STATIC_DETECTOR = 'pdf-static-analyzer';

const RISKY_PATTERNS: { name: string; pattern: RegExp; description: string }[] = [
  { name: '/JavaScript', pattern: /\/JavaScript\b/, description: 'PDF contains embedded JavaScript' },
  { name: '/JS', pattern: /\/JS\b/, description: 'PDF contains embedded JavaScript (/JS action)' },
  { name: '/Launch', pattern: /\/Launch\b/, description: 'PDF contains a launch action that runs external programs' },
  { name: '/EmbeddedFile', pattern: /\/EmbeddedFile\b/, description: 'PDF contains an embedded file payload' },
  { name: '/EmbeddedFiles', pattern: /\/EmbeddedFiles\b/, description: 'PDF contains an embedded file collection' },
  { name: '/RichMedia', pattern: /\/RichMedia\b/, description: 'PDF contains embedded rich media (Flash/3D/video) which is a known exploit vector' },
  { name: '/XFA', pattern: /\/XFA\b/, description: 'PDF contains an XFA form (historic Adobe Reader exploit vector)' },
  { name: '/SubmitForm', pattern: /\/SubmitForm\b/, description: 'PDF contains a form submission action that may exfiltrate data' },
  { name: '/GoToE', pattern: /\/GoToE\b/, description: 'PDF contains an embedded-file go-to action' },
  { name: '/GoToR', pattern: /\/GoToR\b/, description: 'PDF contains a remote go-to action' },
];

function staticPdfScan(buffer: Buffer): PdfScanResult {
  const text = buffer.toString('latin1');
  const findings: string[] = [];
  for (const { name, pattern, description } of RISKY_PATTERNS) {
    if (pattern.test(text)) {
      findings.push(`${name}: ${description}`);
    }
  }
  if (findings.length > 0) {
    return {
      verdict: 'suspicious',
      detector: STATIC_DETECTOR,
      reason: findings[0],
      findings,
    };
  }
  return { verdict: 'clean', detector: STATIC_DETECTOR, findings: [] };
}

async function clamavScan(buffer: Buffer): Promise<PdfScanResult | null> {
  const host = process.env.CLAMAV_HOST;
  if (!host) return null;
  const port = parseInt(process.env.CLAMAV_PORT || '3310', 10);
  const timeoutMs = parseInt(process.env.CLAMAV_TIMEOUT_MS || '15000', 10);

  return new Promise<PdfScanResult>((resolve) => {
    const socket = new net.Socket();
    let response = '';
    let settled = false;

    const finish = (result: PdfScanResult) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* noop */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      logger.warn('ClamAV scan timed out, treating as suspicious', { host, port, timeoutMs });
      finish({
        verdict: 'suspicious',
        detector: 'clamav',
        reason: 'ClamAV scan timed out',
        findings: ['clamav-timeout'],
      });
    }, timeoutMs);

    socket.on('error', (err) => {
      clearTimeout(timer);
      logger.error('ClamAV connection error', { host, port, error: String(err) });
      finish({
        verdict: 'suspicious',
        detector: 'clamav',
        reason: `ClamAV unreachable: ${err.message}`,
        findings: ['clamav-unreachable'],
      });
    });

    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
    });

    socket.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      const trimmed = response.trim().replace(/\u0000$/, '');
      if (/\bOK\s*$/.test(trimmed)) {
        finish({ verdict: 'clean', detector: 'clamav', findings: [] });
      } else if (/\bFOUND\b/.test(trimmed)) {
        const match = trimmed.match(/:\s*(.*?)\s+FOUND/);
        const sig = match ? match[1].trim() : 'malware-detected';
        finish({
          verdict: 'infected',
          detector: 'clamav',
          reason: `ClamAV signature: ${sig}`,
          findings: [sig],
        });
      } else if (/ERROR/.test(trimmed)) {
        finish({
          verdict: 'suspicious',
          detector: 'clamav',
          reason: trimmed,
          findings: ['clamav-error'],
        });
      } else {
        finish({
          verdict: 'suspicious',
          detector: 'clamav',
          reason: `Unrecognized ClamAV response: ${trimmed || '(empty)'}`,
          findings: ['clamav-unknown'],
        });
      }
    });

    socket.connect(port, host, () => {
      socket.write(Buffer.from('zINSTREAM\0'));
      const len = Buffer.alloc(4);
      len.writeUInt32BE(buffer.length, 0);
      socket.write(len);
      socket.write(buffer);
      const terminator = Buffer.alloc(4);
      terminator.writeUInt32BE(0, 0);
      socket.write(terminator);
    });
  });
}

export async function scanPdfBuffer(buffer: Buffer): Promise<PdfScanResult> {
  const staticResult = staticPdfScan(buffer);

  let avResult: PdfScanResult | null = null;
  try {
    avResult = await clamavScan(buffer);
  } catch (err) {
    logger.warn('ClamAV scan threw unexpectedly', { error: String(err) });
  }

  if (avResult) {
    if (avResult.verdict === 'infected') return avResult;
    if (staticResult.verdict !== 'clean') return staticResult;
    return avResult;
  }
  return staticResult;
}

export function buildRejectionMessage(scan: PdfScanResult): string {
  if (scan.verdict === 'infected') {
    return `This PDF was flagged as malicious${scan.reason ? ` (${scan.reason})` : ''} and cannot be uploaded.`;
  }
  if (scan.findings.length > 0) {
    return `This PDF contains active or unsafe content and cannot be uploaded: ${scan.findings.join('; ')}.`;
  }
  return scan.reason
    ? `This PDF was flagged by the security scanner: ${scan.reason}.`
    : 'This PDF was flagged by the security scanner and cannot be uploaded.';
}
