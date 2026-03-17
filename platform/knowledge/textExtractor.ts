import dns from 'dns';
import { promisify } from 'util';
import { createLogger } from '../core/logger';

const logger = createLogger('TEXT_EXTRACTOR');
const dnsResolve4 = promisify(dns.resolve4);
const dnsResolve6 = promisify(dns.resolve6);

export async function extractTextFromPDF(buffer: Buffer): Promise<string> {
  try {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(buffer);
    const text = data.text?.trim();
    if (!text) {
      throw new Error('No text content found in PDF');
    }
    logger.info('PDF text extracted', { pages: data.numpages, chars: text.length });
    return text;
  } catch (err) {
    logger.error('PDF extraction failed', { error: String(err) });
    throw new Error(`PDF text extraction failed: ${(err as Error).message}`);
  }
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d+$/.test(p))) return false;
  const octets = parts.map(Number);
  if (octets[0] === 10) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  if (octets[0] === 169 && octets[1] === 254) return true;
  if (octets[0] === 127) return true;
  if (octets[0] === 0) return true;
  if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true;
  if (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) return true;
  if (octets[0] >= 224) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized === '::') return true;
  if (normalized.startsWith('fe80:')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('::ffff:')) {
    const v4Part = normalized.slice(7);
    if (isPrivateIPv4(v4Part)) return true;
  }
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower === 'metadata.google.internal' ||
    lower === 'instance-data'
  ) {
    return true;
  }
  if (lower.endsWith('.amazonaws.com') && lower.includes('metadata')) return true;
  if (lower === 'metadata' || lower === 'metadata.') return true;
  return false;
}

async function validateHostSafety(hostname: string): Promise<void> {
  if (isBlockedHostname(hostname)) {
    throw new Error('URLs pointing to private or internal networks are not allowed');
  }

  const parts = hostname.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    if (isPrivateIPv4(hostname)) {
      throw new Error('URLs pointing to private IP addresses are not allowed');
    }
    return;
  }

  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const ipv6 = hostname.slice(1, -1);
    if (isPrivateIPv6(ipv6)) {
      throw new Error('URLs pointing to private IPv6 addresses are not allowed');
    }
    return;
  }

  const resolvedIPs: string[] = [];
  try {
    const ipv4s = await dnsResolve4(hostname);
    resolvedIPs.push(...ipv4s);
  } catch {}
  try {
    const ipv6s = await dnsResolve6(hostname);
    resolvedIPs.push(...ipv6s);
  } catch {}

  if (resolvedIPs.length === 0) {
    throw new Error('Could not resolve hostname');
  }

  for (const ip of resolvedIPs) {
    if (isPrivateIPv4(ip) || isPrivateIPv6(ip)) {
      logger.warn('DNS resolution blocked: hostname resolves to private IP', { hostname, ip });
      throw new Error('URL hostname resolves to a private/reserved IP address');
    }
  }
}

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;

export async function extractTextFromURL(url: string): Promise<string> {
  try {
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Only HTTP and HTTPS URLs are supported');
    }

    if (parsedUrl.pathname.startsWith('/latest/meta-data')) {
      throw new Error('Access to cloud metadata endpoints is not allowed');
    }

    await validateHostSafety(parsedUrl.hostname);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        'User-Agent': 'VoiceAI-KnowledgeBot/1.0',
        'Accept': 'text/html,application/xhtml+xml,text/plain',
      },
    });
    clearTimeout(timeout);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location) {
        const redirectUrl = new URL(location, url);
        await validateHostSafety(redirectUrl.hostname);
      }
      throw new Error(`URL redirected (${res.status}), please provide the final URL directly`);
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
      throw new Error(`Response too large (${contentLength} bytes, max ${MAX_RESPONSE_SIZE})`);
    }

    const contentType = res.headers.get('content-type') || '';
    const html = await res.text();

    if (contentType.includes('text/plain')) {
      return html.trim();
    }

    const text = stripHTML(html);
    if (!text || text.length < 20) {
      throw new Error('Could not extract meaningful text from URL');
    }

    logger.info('URL text extracted', { url, chars: text.length });
    return text;
  } catch (err) {
    logger.error('URL extraction failed', { url, error: String(err) });
    throw new Error(`URL text extraction failed: ${(err as Error).message}`);
  }
}

function stripHTML(html: string): string {
  let text = html;

  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  text = text.replace(/<(h[1-6])[^>]*>/gi, '\n\n');
  text = text.replace(/<\/(h[1-6])>/gi, '\n\n');
  text = text.replace(/<(p|div|br|li|tr)[^>]*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|tr)>/gi, '\n');

  text = text.replace(/<[^>]+>/g, ' ');

  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&[a-z]+;/gi, ' ');

  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n/g, '\n\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

export function normalizeText(text: string): string {
  let normalized = text.trim();
  normalized = normalized.replace(/\r\n/g, '\n');
  normalized = normalized.replace(/\r/g, '\n');
  normalized = normalized.replace(/[ \t]+/g, ' ');
  normalized = normalized.replace(/\n{3,}/g, '\n\n');
  return normalized;
}
