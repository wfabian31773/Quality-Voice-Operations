import * as net from 'node:net';
import { createLogger } from '../core/logger';
import { isPrivateOrInternalHost } from '../security/privateHostBlocklist';

const logger = createLogger('PDF_SECURITY_SCANNER');

export type ScanVerdict = 'clean' | 'suspicious' | 'infected';

export type LinkVerdict = 'clean' | 'private-network' | 'reputation-bad' | 'unparseable';

export interface PdfLinkFinding {
  url: string;
  verdict: LinkVerdict;
  reason?: string;
  threatType?: string;
}

export interface PdfScanResult {
  verdict: ScanVerdict;
  detector: string;
  reason?: string;
  findings: string[];
  links?: PdfLinkFinding[];
  reputation?: {
    provider: string;
    checked: boolean;
    bad: number;
    error?: string;
  };
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

function decodePdfLiteralString(raw: string): string {
  // PDF literal string escape sequences (subset that matters for URLs)
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\b/g, '\b')
    .replace(/\\f/g, '\f')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function decodePdfHexString(raw: string): string {
  const cleaned = raw.replace(/\s+/g, '');
  const padded = cleaned.length % 2 === 0 ? cleaned : cleaned + '0';
  if (!/^[0-9a-fA-F]*$/.test(padded)) return '';
  let out = '';
  for (let i = 0; i < padded.length; i += 2) {
    out += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  }
  return out;
}

/**
 * Extract URLs from /URI actions and /GoToR remote-file specifications.
 * Best-effort regex-based extraction over the raw PDF bytes — this catches
 * the common, uncompressed cases (which is what scanners typically care
 * about because attackers want the link to actually fire when the PDF is
 * opened with a default reader). Compressed object streams may hide more
 * URLs; those are rare in user-uploaded PDFs.
 */
export function extractPdfUrls(buffer: Buffer): string[] {
  const text = buffer.toString('latin1');
  const urls = new Set<string>();

  const literalUriRe = /\/URI\s*\(((?:\\.|[^\\)])*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = literalUriRe.exec(text)) !== null) {
    const decoded = decodePdfLiteralString(m[1]).trim();
    if (decoded) urls.add(decoded);
  }

  const hexUriRe = /\/URI\s*<([0-9A-Fa-f\s]+)>/g;
  while ((m = hexUriRe.exec(text)) !== null) {
    const decoded = decodePdfHexString(m[1]).trim();
    if (decoded) urls.add(decoded);
  }

  // /GoToR with a /F (filespec) — the filespec may be a URL or a path.
  // We extract anything that parses as an http(s) URL.
  const gotorRe = /\/GoToR\b[\s\S]{0,200}?\/F\s*\(((?:\\.|[^\\)])*)\)/g;
  while ((m = gotorRe.exec(text)) !== null) {
    const decoded = decodePdfLiteralString(m[1]).trim();
    if (decoded) urls.add(decoded);
  }

  return Array.from(urls);
}

const SAFE_BROWSING_PROVIDER = 'google-safe-browsing';

interface SafeBrowsingResult {
  provider: string;
  checked: boolean;
  matches: Map<string, string>;
  error?: string;
}

/**
 * Normalize a URL for comparison purposes only — lowercase the scheme &
 * host, strip the fragment, drop the default port. Safe Browsing's
 * response often canonicalizes URLs differently than the form we send
 * (trailing slash, encoded host, etc.) so we have to match on a
 * normalized representation rather than raw string equality.
 */
function normalizeUrlForComparison(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    if (
      (u.protocol === 'http:' && u.port === '80') ||
      (u.protocol === 'https:' && u.port === '443')
    ) {
      u.port = '';
    }
    if (!u.pathname) u.pathname = '/';
    return u.toString();
  } catch {
    return raw;
  }
}

async function checkGoogleSafeBrowsing(urls: string[]): Promise<SafeBrowsingResult | null> {
  const apiKey = process.env.GOOGLE_SAFE_BROWSING_API_KEY;
  if (!apiKey || urls.length === 0) return null;

  const clientId = process.env.GOOGLE_SAFE_BROWSING_CLIENT_ID || 'voice-ai-ops-hub';
  const clientVersion = process.env.GOOGLE_SAFE_BROWSING_CLIENT_VERSION || '1.0.0';
  const timeoutMs = parseInt(process.env.GOOGLE_SAFE_BROWSING_TIMEOUT_MS || '5000', 10);

  const endpoint = `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(apiKey)}`;

  const body = {
    client: { clientId, clientVersion },
    threatInfo: {
      threatTypes: [
        'MALWARE',
        'SOCIAL_ENGINEERING',
        'UNWANTED_SOFTWARE',
        'POTENTIALLY_HARMFUL_APPLICATION',
      ],
      platformTypes: ['ANY_PLATFORM'],
      threatEntryTypes: ['URL'],
      threatEntries: urls.map((u) => ({ url: u })),
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      logger.warn('Safe Browsing lookup returned a non-OK status', {
        status: res.status,
        body: errText.slice(0, 500),
      });
      return {
        provider: SAFE_BROWSING_PROVIDER,
        checked: false,
        matches: new Map(),
        error: `safe-browsing-status-${res.status}`,
      };
    }

    const data = (await res.json()) as { matches?: Array<{ threat: { url: string }; threatType: string }> };

    // Build a lookup from normalized -> original submitted URL so we can
    // map provider responses (which may be canonicalized) back to the
    // exact string that appeared in the PDF.
    const normalizedToOriginal = new Map<string, string>();
    for (const u of urls) {
      normalizedToOriginal.set(normalizeUrlForComparison(u), u);
    }

    const matches = new Map<string, string>();
    for (const entry of data.matches ?? []) {
      const threatUrl = entry?.threat?.url;
      if (!threatUrl) continue;
      const normalized = normalizeUrlForComparison(threatUrl);
      const original = normalizedToOriginal.get(normalized) ?? threatUrl;
      matches.set(original, entry.threatType ?? 'UNKNOWN');
    }
    return {
      provider: SAFE_BROWSING_PROVIDER,
      checked: true,
      matches,
    };
  } catch (err) {
    clearTimeout(timer);
    logger.warn('Safe Browsing lookup failed', { error: String(err) });
    return {
      provider: SAFE_BROWSING_PROVIDER,
      checked: false,
      matches: new Map(),
      error: `safe-browsing-error: ${(err as Error).message}`,
    };
  }
}

interface UrlScanContext {
  tenantId?: string;
  filename?: string;
  documentId?: string | number;
}

export interface PdfUrlScanReport {
  links: PdfLinkFinding[];
  privateNetworkCount: number;
  reputationBadCount: number;
  unparseableCount: number;
  reputation?: { provider: string; checked: boolean; bad: number; error?: string };
}

export async function scanPdfUrls(buffer: Buffer, ctx: UrlScanContext = {}): Promise<PdfUrlScanReport> {
  const rawUrls = extractPdfUrls(buffer);
  const links: PdfLinkFinding[] = [];

  const eligibleForReputation: string[] = [];
  for (const url of rawUrls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      links.push({ url, verdict: 'unparseable', reason: 'Could not parse URL' });
      logger.warn('Suspicious PDF link (unparseable)', {
        tenantId: ctx.tenantId,
        documentId: ctx.documentId,
        filename: ctx.filename,
        url,
      });
      continue;
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      // Non-http schemes (file:, ftp:, javascript:, etc.) are treated like
      // private/internal — we don't want PDFs reaching off-protocol either.
      links.push({
        url,
        verdict: 'private-network',
        reason: `Disallowed URL scheme "${parsed.protocol}"`,
      });
      logger.warn('Suspicious PDF link (disallowed scheme)', {
        tenantId: ctx.tenantId,
        documentId: ctx.documentId,
        filename: ctx.filename,
        url,
      });
      continue;
    }

    if (isPrivateOrInternalHost(parsed.hostname)) {
      links.push({
        url,
        verdict: 'private-network',
        reason: 'Link points at a private or internal-network address',
      });
      logger.warn('Suspicious PDF link (private/internal network)', {
        tenantId: ctx.tenantId,
        documentId: ctx.documentId,
        filename: ctx.filename,
        url,
      });
      continue;
    }

    eligibleForReputation.push(url);
  }

  let reputation: SafeBrowsingResult | null = null;
  try {
    reputation = await checkGoogleSafeBrowsing(eligibleForReputation);
  } catch (err) {
    logger.warn('Safe Browsing check threw unexpectedly', { error: String(err) });
  }

  for (const url of eligibleForReputation) {
    if (reputation && reputation.matches.has(url)) {
      const threatType = reputation.matches.get(url)!;
      links.push({
        url,
        verdict: 'reputation-bad',
        reason: `Reputation provider flagged URL (${threatType})`,
        threatType,
      });
      logger.warn('Suspicious PDF link (reputation hit)', {
        tenantId: ctx.tenantId,
        documentId: ctx.documentId,
        filename: ctx.filename,
        url,
        threatType,
        provider: reputation.provider,
      });
    } else {
      links.push({ url, verdict: 'clean' });
    }
  }

  const privateNetworkCount = links.filter((l) => l.verdict === 'private-network').length;
  const reputationBadCount = links.filter((l) => l.verdict === 'reputation-bad').length;
  const unparseableCount = links.filter((l) => l.verdict === 'unparseable').length;

  return {
    links,
    privateNetworkCount,
    reputationBadCount,
    unparseableCount,
    reputation: reputation
      ? {
          provider: reputation.provider,
          checked: reputation.checked,
          bad: reputation.matches.size,
          error: reputation.error,
        }
      : undefined,
  };
}

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

export async function scanPdfBuffer(
  buffer: Buffer,
  ctx: UrlScanContext = {},
): Promise<PdfScanResult> {
  const staticResult = staticPdfScan(buffer);

  let avResult: PdfScanResult | null = null;
  try {
    avResult = await clamavScan(buffer);
  } catch (err) {
    logger.warn('ClamAV scan threw unexpectedly', { error: String(err) });
  }

  let urlReport: PdfUrlScanReport;
  try {
    urlReport = await scanPdfUrls(buffer, ctx);
  } catch (err) {
    logger.warn('PDF URL scan threw unexpectedly', { error: String(err) });
    urlReport = {
      links: [],
      privateNetworkCount: 0,
      reputationBadCount: 0,
      unparseableCount: 0,
    };
  }

  const urlFindings: string[] = [];
  for (const link of urlReport.links) {
    if (link.verdict === 'private-network') {
      urlFindings.push(`/URI: link to private/internal address blocked (${link.url})`);
    } else if (link.verdict === 'reputation-bad') {
      urlFindings.push(`/URI: link flagged by ${link.threatType ?? 'reputation provider'} (${link.url})`);
    } else if (link.verdict === 'unparseable') {
      urlFindings.push(`/URI: malformed link (${link.url})`);
    }
  }

  const merge = (base: PdfScanResult): PdfScanResult => ({
    ...base,
    findings: [...base.findings, ...urlFindings],
    links: urlReport.links.length > 0 ? urlReport.links : base.links,
    reputation: urlReport.reputation ?? base.reputation,
  });

  // Decide combined verdict.
  // 1. ClamAV / reputation hits → infected.
  // 2. Static suspicious content OR private-network links → suspicious.
  // 3. Otherwise → clean.
  const reputationBad = urlReport.reputationBadCount > 0;
  const privateNetworkBad = urlReport.privateNetworkCount + urlReport.unparseableCount > 0;

  if (avResult?.verdict === 'infected') return merge(avResult);
  if (reputationBad) {
    const firstBad = urlReport.links.find((l) => l.verdict === 'reputation-bad')!;
    return merge({
      verdict: 'infected',
      detector: SAFE_BROWSING_PROVIDER,
      reason: firstBad.reason,
      findings: [],
    });
  }
  if (staticResult.verdict !== 'clean') return merge(staticResult);
  if (privateNetworkBad) {
    const firstBad = urlReport.links.find(
      (l) => l.verdict === 'private-network' || l.verdict === 'unparseable',
    )!;
    return merge({
      verdict: 'suspicious',
      detector: 'pdf-link-scanner',
      reason: firstBad.reason,
      findings: [],
    });
  }
  if (avResult) return merge(avResult);
  return merge(staticResult);
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
