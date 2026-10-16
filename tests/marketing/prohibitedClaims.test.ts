import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const LOCALES = ['en', 'es', 'fr', 'de', 'pt-BR'] as const;

/**
 * Phrases Decision D6 stripped from the public site. Case-insensitive.
 * Keep this list in lockstep with PR-04: if copy grows a new unverifiable
 * scale/trial/logo claim, add the phrase here so CI fails closed.
 */
export const BANNED_PHRASES: Array<{ id: string; pattern: RegExp }> = [
  { id: '40000-calls', pattern: /40[.,\s]?000\s*\+?/i },
  { id: 'hundreds-en', pattern: /hundreds of (?:businesses|\{\{vertical)/i },
  { id: 'hundreds-es', pattern: /cientos de (?:negocios|empresas)/i },
  { id: 'hundreds-fr', pattern: /centaines d['’]entreprises|des centaines/i },
  { id: 'hundreds-pt', pattern: /centenas de (?:neg[oó]cios|empresas)/i },
  { id: 'hundreds-de', pattern: /hunderte(?:n)? (?:von )?|Hunderten von/i },
  { id: '14-day-en', pattern: /14-day|\b14 day\b/i },
  { id: '14-day-es', pattern: /14 d[ií]as/i },
  { id: '14-day-fr', pattern: /14 jours/i },
  { id: '14-day-de', pattern: /14 Tage|14-t[aä]gige/i },
  { id: '14-day-pt', pattern: /14 dias/i },
  { id: '7-day-trial', pattern: /7-day free trial|free for 7 days/i },
  { id: '7-day-es', pattern: /prueba gratis de 7 d[ií]as|gratis por 7 d[ií]as/i },
  { id: '7-day-fr', pattern: /essai gratuit de 7 jours|gratuit pendant 7 jours/i },
  { id: '7-day-de', pattern: /7 Tage kostenlos(?:e Testversion)?/i },
  { id: '7-day-pt', pattern: /teste gr[aá]tis de 7 dias|gr[aá]tis por 7 dias/i },
  { id: 'self-service', pattern: /self-service|self service|self-serve|autoservicio/i },
  { id: 'setup-fee-en', pattern: /setup fees?|no setup fee/i },
  { id: 'setup-fee-es', pattern: /costos? de configuraci[oó]n/i },
  { id: 'setup-fee-fr', pattern: /frais de mise en service/i },
  { id: 'setup-fee-de', pattern: /Einrichtungsgeb[uü]hr/i },
  { id: 'setup-fee-pt', pattern: /taxa de setup/i },
  { id: 'uptime-metric', pattern: /99\.9/ },
  { id: 'voice-uptime', pattern: /voice uptime/i },
  { id: 'fake-counter', pattern: /2400000/ },
  { id: 'lakewood', pattern: /Lakewood Family Medicine/i },
  { id: 'bright-smile', pattern: /Bright Smiles? Dental/i },
  { id: 'comfort-first', pattern: /Comfort First HVAC/i },
  { id: 'park-associates', pattern: /Park & Associates/i },
  { id: 'pinnacle-realty', pattern: /Pinnacle Realty/i },
  { id: 'marcus-rivera', pattern: /Marcus Rivera/i },
  { id: 'sarah-chen', pattern: /Sarah Chen/i },
  { id: 'james-whitfield', pattern: /James Whitfield/i },
  { id: 'sarah-mitchell', pattern: /Sarah Mitchell/i },
  { id: 'maya-reyes', pattern: /Maya Reyes/i },
  { id: 'priya-shah', pattern: /Priya Shah/i },
  { id: 'daniel-vega', pattern: /Daniel Vega/i },
  { id: 'summit-realty', pattern: /Summit Realty/i },
  { id: 'summit-legal', pattern: /Summit Legal/i },
  { id: 'cypress-hill', pattern: /Cypress Hill Realty/i },
  { id: 'bayside-eye', pattern: /Bayside Eye/i },
  { id: 'parkview-apartments', pattern: /Parkview Apartments/i },
];

function source(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

function listFiles(dir: string, predicate: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, predicate));
    } else if (predicate(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function publicSources(): Array<{ relativePath: string; text: string }> {
  const files: string[] = [
    join(repoRoot, 'client-app/src/components/PublicLayout.tsx'),
    ...listFiles(join(repoRoot, 'client-app/src/pages/public'), (name) =>
      /\.(tsx|ts|jsx|js)$/.test(name),
    ),
    ...LOCALES.flatMap((locale) => [
      join(repoRoot, `client-app/src/locales/${locale}/marketing.json`),
      join(repoRoot, `client-app/src/locales/${locale}/common.json`),
    ]),
  ];

  return files.map((full) => ({
    relativePath: relative(repoRoot, full),
    text: readFileSync(full, 'utf8'),
  }));
}

describe('PR-04 prohibited public-site claims', () => {
  const sources = publicSources();

  it('scans public pages and all locale marketing/common files', () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.some((s) => s.relativePath.endsWith('pages/public/Landing.tsx'))).toBe(
      true,
    );
    expect(sources.some((s) => s.relativePath.endsWith('locales/en/marketing.json'))).toBe(
      true,
    );
    expect(sources.some((s) => s.relativePath.endsWith('locales/pt-BR/marketing.json'))).toBe(
      true,
    );
  });

  it.each(sources)('$relativePath contains no banned phrase', ({ relativePath, text }) => {
    for (const { id, pattern } of BANNED_PHRASES) {
      expect(text, `${relativePath} matched ${id} (${pattern})`).not.toMatch(pattern);
    }
  });

  it('fails when a banned phrase is reintroduced into a haystack', () => {
    const haystack = 'Built and battle-tested on 40,000+ real healthcare calls';
    const hit = BANNED_PHRASES.find(({ pattern }) => pattern.test(haystack));
    expect(hit?.id).toBe('40000-calls');
  });

  it('still reads the live Landing hero (sanity that the scan target exists)', () => {
    expect(source('client-app/src/pages/public/Landing.tsx')).toMatch(
      /Now onboarding pilot shops/i,
    );
  });
});
