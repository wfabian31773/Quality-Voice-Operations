import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

function source(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

const activeClaimSources = [
  'client-app/src/pages/public/Landing.tsx',
  'client-app/src/pages/public/Security.tsx',
  'client-app/src/pages/public/SecurityPosture.tsx',
  'client-app/src/pages/public/Pricing.tsx',
  'client-app/src/pages/public/Privacy.tsx',
  'client-app/src/components/ComparisonTable.tsx',
];

const forbiddenClaims = [
  /HIPAA[- ](?:ready|grade|aware by default)/i,
  /HIPAA available with BAA/i,
  /BAA is countersigned on request/i,
  /SOC 2 (?:Type II )?(?:in progress|compliant)/i,
  /GDPR[- ]compliant/i,
  /CCPA[^\n]{0,20}compliant/i,
  /HSTS enforced on all production endpoints/i,
  /backups[^.]{0,80}encrypted with AES-256/i,
  /24\/7 on-call rotation/i,
  /background checks for personnel/i,
  /annual penetration testing/i,
  /bug bounty program in pilot/i,
];

describe('active public compliance claims', () => {
  it.each(activeClaimSources)('%s contains no unverified positive claim', (relativePath) => {
    const text = source(relativePath);
    for (const forbidden of forbiddenClaims) {
      expect(text, `${relativePath} matched ${forbidden}`).not.toMatch(forbidden);
    }
  });

  const localeEvidenceLanguage = {
    en: /review|pending|not verified|disabled/i,
    es: /revisi[oó]n|pendiente|no verificad|desactivad/i,
    fr: /examen|en attente|non v[ée]rifi[ée]|d[ée]sactiv[ée]/i,
    de: /pr[üu]fung|ausstehend|nicht verifiziert|deaktiviert/i,
    'pt-BR': /revis[aã]o|pendente|n[aã]o verificad|desativad/i,
  } as const;

  it.each(Object.keys(localeEvidenceLanguage))('%s active trust badges are evidence-state labels', (locale) => {
    const marketing = JSON.parse(
      source(`client-app/src/locales/${locale}/marketing.json`),
    ) as {
      landing: { stats: Record<string, string> };
      pricing: { compliance: Record<string, string> };
    };

    const badgeValues = [
      marketing.landing.stats.hipaa_ready,
      marketing.landing.stats.soc2_in_progress,
      marketing.landing.stats.gdpr_compliant,
      marketing.landing.stats.aes_encryption,
      ...Object.entries(marketing.pricing.compliance)
        .filter(([key]) => key !== 'eyebrow')
        .map(([, value]) => value),
    ];

    expect(badgeValues).toHaveLength(10);
    for (const value of badgeValues) {
      expect(value).toMatch(localeEvidenceLanguage[locale as keyof typeof localeEvidenceLanguage]);
    }
  });

  it('keeps the public boundary explicit', () => {
    const combined = activeClaimSources.map(source).join('\n');
    expect(combined).toMatch(/recording disabled by default/i);
    expect(combined).toMatch(/not verified/i);
    expect(combined).toMatch(/approval pending/i);
    expect(combined).toContain('/contact');
  });
});
