/**
 * Shared blocklist for hostnames that point at private / link-local /
 * loopback / cloud-metadata endpoints. Used both by the URL ingest
 * endpoint (preventing tenants from feeding us SSRF targets) and by the
 * PDF security scanner (preventing uploaded PDFs from smuggling those
 * targets in via /URI actions).
 */

const BLOCKED_LITERAL_HOSTS = new Set<string>([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  'metadata.google.internal',
  'instance-data',
]);

const BLOCKED_HOSTNAME_SUFFIXES = ['.local', '.internal'];

const PRIVATE_IPV4_PATTERN =
  /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|127\.)/;

function stripBrackets(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isLoopbackOrLinkLocalIPv6(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // Link-local: fe80::/10
  if (/^fe[89ab][0-9a-f]?:/i.test(lower)) return true;
  // Unique local: fc00::/7
  if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true;
  // IPv4-mapped loopback (::ffff:127.0.0.1)
  if (/^::ffff:127\./i.test(lower)) return true;
  return false;
}

/**
 * Returns true if the given hostname (already lowercased by URL parsing)
 * should be blocked from outbound resolution. Mirrors the rules used by
 * the URL ingest endpoint.
 */
export function isPrivateOrInternalHost(hostname: string): boolean {
  if (!hostname) return true;
  const host = stripBrackets(hostname);

  if (BLOCKED_LITERAL_HOSTS.has(host)) return true;
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (host.endsWith(suffix)) return true;
  }
  if (PRIVATE_IPV4_PATTERN.test(host)) return true;
  if (host.includes(':') && isLoopbackOrLinkLocalIPv6(host)) return true;

  return false;
}

/**
 * Convenience wrapper: parses a URL and returns true if it should be
 * blocked. Returns true for malformed URLs and non-http(s) schemes —
 * callers should treat those as "do not allow".
 */
export function isBlockedUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return true;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return true;
  return isPrivateOrInternalHost(parsed.hostname);
}
