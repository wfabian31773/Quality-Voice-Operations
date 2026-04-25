import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export class SsrfBlockedError extends Error {
  reason: string;
  constructor(reason: string) {
    super(`URL blocked by SSRF policy: ${reason}`);
    this.name = 'SsrfBlockedError';
    this.reason = reason;
  }
}

const BLOCKED_HOSTNAMES = new Set<string>([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
]);

const BLOCKED_HOSTNAME_SUFFIXES = ['.local', '.internal', '.localhost', '.lan'];

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b, c] = parts;

  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a === 255 && b === 255 && c === 255 && parts[3] === 255) return true;
  if (a >= 224) return true;

  return false;
}

function expandIPv6(ip: string): bigint | null {
  if (!net.isIPv6(ip)) return null;

  const lowered = ip.toLowerCase();
  let head: string[] = [];
  let tail: string[] = [];

  if (lowered.includes('::')) {
    const [h, t] = lowered.split('::');
    head = h ? h.split(':') : [];
    tail = t ? t.split(':') : [];
  } else {
    head = lowered.split(':');
  }

  const lastList = tail.length ? tail : head;
  const last = lastList[lastList.length - 1] ?? '';
  if (last.includes('.')) {
    const v4 = lastList.pop() as string;
    const v4Parts = v4.split('.').map((n) => parseInt(n, 10));
    if (v4Parts.length !== 4 || v4Parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((v4Parts[0] << 8) | v4Parts[1]).toString(16);
    const lo = ((v4Parts[2] << 8) | v4Parts[3]).toString(16);
    lastList.push(hi, lo);
  }

  const total = head.length + tail.length;
  const missing = 8 - total;
  if (missing < 0) return null;
  if (missing > 0 && !lowered.includes('::')) return null;

  const full = [...head, ...new Array(missing).fill('0'), ...tail];
  if (full.length !== 8) return null;

  let result = 0n;
  for (const part of full) {
    const n = parseInt(part || '0', 16);
    if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
    result = (result << 16n) | BigInt(n);
  }
  return result;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const tail = lower.replace(/^::(ffff:)?/, '');
    if (tail.includes('.')) {
      return isPrivateIPv4(tail);
    }
  }

  const num = expandIPv6(ip);
  if (num === null) return true;

  if (num === 0n) return true;
  if (num === 1n) return true;

  const high16 = Number((num >> 112n) & 0xffffn);

  if ((high16 & 0xffc0) === 0xfe80) return true;
  if ((high16 & 0xfe00) === 0xfc00) return true;
  if ((high16 & 0xff00) === 0xff00) return true;

  if (high16 === 0x2001) {
    const next16 = Number((num >> 96n) & 0xffffn);
    if (next16 === 0x0db8) return true;
  }

  return false;
}

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

export interface PreflightOptions {
  allowHttp?: boolean;
  resolver?: (hostname: string) => Promise<string[]>;
}

export interface PreflightResult {
  ok: boolean;
  reason?: string;
  hostname: string;
  resolvedIps: string[];
}

async function defaultResolver(hostname: string): Promise<string[]> {
  const lookups = await dns.lookup(hostname, { all: true, verbatim: true });
  return lookups.map((l) => l.address);
}

export async function preflightUrl(
  rawUrl: string,
  opts: PreflightOptions = {},
): Promise<PreflightResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid URL', hostname: '', resolvedIps: [] };
  }

  const allowedProtocols = new Set<string>(opts.allowHttp ? ['https:', 'http:'] : ['https:']);
  if (!allowedProtocols.has(parsed.protocol)) {
    return {
      ok: false,
      reason: `protocol ${parsed.protocol} not allowed`,
      hostname: parsed.hostname,
      resolvedIps: [],
    };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      reason: 'embedded credentials are not allowed',
      hostname: parsed.hostname,
      resolvedIps: [],
    };
  }

  const rawHost = parsed.hostname.toLowerCase();
  const hostname = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost;

  if (!hostname) {
    return { ok: false, reason: 'missing hostname', hostname: '', resolvedIps: [] };
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: `hostname "${hostname}" is blocked`, hostname, resolvedIps: [] };
  }

  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return {
        ok: false,
        reason: `hostname suffix "${suffix}" is blocked`,
        hostname,
        resolvedIps: [],
      };
    }
  }

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      return {
        ok: false,
        reason: `IP literal ${hostname} is private/reserved`,
        hostname,
        resolvedIps: [hostname],
      };
    }
    return { ok: true, hostname, resolvedIps: [hostname] };
  }

  const resolver = opts.resolver ?? defaultResolver;
  let resolvedIps: string[] = [];
  try {
    resolvedIps = await resolver(hostname);
  } catch {
    return { ok: false, reason: `DNS lookup failed for ${hostname}`, hostname, resolvedIps: [] };
  }

  if (resolvedIps.length === 0) {
    return {
      ok: false,
      reason: `no addresses resolved for ${hostname}`,
      hostname,
      resolvedIps: [],
    };
  }

  for (const ip of resolvedIps) {
    if (isPrivateAddress(ip)) {
      return {
        ok: false,
        reason: `${hostname} resolves to private/reserved IP ${ip}`,
        hostname,
        resolvedIps,
      };
    }
  }

  return { ok: true, hostname, resolvedIps };
}

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  allowHttp?: boolean;
  resolver?: PreflightOptions['resolver'];
}

export interface SafeFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
  headers: Record<string, string>;
}

/**
 * Performs an HTTP/HTTPS request whose TCP destination is pinned to `pinnedIp`
 * while the URL's hostname is still used for the `Host:` header and TLS SNI.
 *
 * This is the DNS-rebinding control: `preflightUrl` resolves the hostname and
 * validates every returned address, then we hand that single validated IP to a
 * dispatcher whose `Agent.lookup` returns it unconditionally. Even if the DNS
 * answer changes between preflight and request-issue (the classic rebinding
 * window), the request can no longer be redirected to a different IP because
 * no further DNS lookup happens. Cert validation still works because TLS SNI
 * keeps the original hostname.
 *
 * Exported separately from `safeFetch` so tests can verify the pinning +
 * Host-header behavior against loopback fixtures (which `preflightUrl` would
 * otherwise — correctly — reject).
 */
export async function performPinnedFetch(
  rawUrl: string,
  pinnedIp: string,
  init: SafeFetchInit = {},
): Promise<SafeFetchResponse> {
  const url = new URL(rawUrl);
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;

  const family = net.isIPv6(pinnedIp) ? 6 : 4;

  // Pinned DNS lookup: returns the validated IP unconditionally regardless of
  // what `options.all` requests. The signature handles both forms because
  // Node's socket layer typically calls with `{all: true}` (expecting an
  // array of {address, family}) but other callers may use the legacy
  // `(err, address, family)` form.
  const pinnedLookup = (
    _hostname: string,
    options: { all?: boolean } | undefined,
    callback: (
      err: NodeJS.ErrnoException | null,
      addressOrList: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ) => {
    if (options && options.all) {
      callback(null, [{ address: pinnedIp, family }]);
    } else {
      callback(null, pinnedIp, family);
    }
  };

  const AgentCtor = isHttps ? https.Agent : http.Agent;
  const agent = new AgentCtor({
    keepAlive: false,
    lookup: pinnedLookup,
  } as unknown as ConstructorParameters<typeof AgentCtor>[0]);

  const headers: Record<string, string> = {};
  if (init.headers) {
    for (const [k, v] of Object.entries(init.headers)) {
      headers[k] = v;
    }
  }
  let hasHostHeader = false;
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'host') {
      hasHostHeader = true;
      break;
    }
  }
  if (!hasHostHeader) {
    headers.Host = url.host;
  }

  return new Promise<SafeFetchResponse>((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        hostname: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers,
        agent,
        servername: net.isIP(url.hostname) ? undefined : url.hostname,
        lookup: pinnedLookup,
      } as https.RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const status = res.statusCode ?? 0;
          const responseHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) responseHeaders[k] = v.join(', ');
            else if (typeof v === 'string') responseHeaders[k] = v;
          }
          resolve({
            ok: status >= 200 && status < 300,
            status,
            statusText: res.statusMessage ?? '',
            headers: responseHeaders,
            text: () => Promise.resolve(buf.toString('utf8')),
            json: () => Promise.resolve(JSON.parse(buf.toString('utf8') || 'null')),
          });
        });
        res.on('error', reject);
      },
    );

    req.on('error', reject);

    if (init.signal) {
      const onAbort = () => req.destroy(new Error('AbortError'));
      if (init.signal.aborted) {
        onAbort();
      } else {
        init.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    if (init.body !== undefined) {
      req.write(init.body);
    }
    req.end();
  });
}

/**
 * SSRF-safe fetch wrapper for any customer-supplied URL.
 *
 * 1. Validates the URL via `preflightUrl` (https-only, no embedded creds,
 *    no blocked hostnames or suffixes, and every resolved IP must be a
 *    public/routable address).
 * 2. Issues the request via `performPinnedFetch` so the TCP connection is
 *    pinned to the validated IP — preventing DNS-rebinding bypasses.
 *
 * Throws `SsrfBlockedError` (with a human-readable `reason`) if the URL is
 * unsafe; otherwise resolves with a fetch-like response object.
 */
export async function safeFetch(
  rawUrl: string,
  init: SafeFetchInit = {},
): Promise<SafeFetchResponse> {
  const preflight = await preflightUrl(rawUrl, {
    allowHttp: init.allowHttp,
    resolver: init.resolver,
  });
  if (!preflight.ok) {
    throw new SsrfBlockedError(preflight.reason ?? 'unknown');
  }
  return performPinnedFetch(rawUrl, preflight.resolvedIps[0], init);
}
