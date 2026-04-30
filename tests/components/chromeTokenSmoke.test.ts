import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');

interface ChromeFile {
  path: string;
  /**
   * BrandLogo intentionally uses third-party brand hex literals
   * (HubSpot orange, Slack red, Twilio red, Google blue, etc.) to
   * preserve recognizability. Skip the hex-literal rule for it; all
   * other rules (raw Tailwind palettes, white/black, sub-AA alpha)
   * still apply.
   */
  allowHex?: boolean;
}

const CHROME_FILES: ChromeFile[] = [
  { path: 'client-app/src/components/PublicLayout.tsx' },
  { path: 'client-app/src/components/TenantLayout.tsx' },
  { path: 'client-app/src/components/AdminLayout.tsx' },
  { path: 'client-app/src/components/OpsLayout.tsx' },
  { path: 'client-app/src/components/PortalSwitcher.tsx' },
  { path: 'client-app/src/components/LanguageSwitcher.tsx' },
  { path: 'client-app/src/components/LogosStrip.tsx' },
  { path: 'client-app/src/components/Modal.tsx' },
  { path: 'client-app/src/components/AppFooter.tsx' },
  { path: 'client-app/src/components/PageSkeleton.tsx' },
  { path: 'client-app/src/components/ComparisonTable.tsx' },
  { path: 'client-app/src/components/TestimonialsCarousel.tsx' },
  { path: 'client-app/src/components/RevealSection.tsx' },
  { path: 'client-app/src/components/state/EmptyState.tsx' },
  { path: 'client-app/src/components/state/ErrorState.tsx' },
  { path: 'client-app/src/components/BrandLogo.tsx', allowHex: true },
];

interface Rule {
  re: RegExp;
  reason: string;
  /** When `true`, this rule is suppressed for files marked `allowHex`. */
  hexRule?: boolean;
}

const FORBIDDEN_CLASS_PATTERNS: Rule[] = [
  { re: /\bbg-white\b/g, reason: 'use bg-surface / bg-sidebar-bg / on-sidebar tokens' },
  { re: /\bbg-black\b/g, reason: 'use bg-surface-inverse' },
  { re: /\btext-white\b/g, reason: 'use text-on-sidebar / text-on-primary / text-on-inverse' },
  { re: /\bborder-white\b/g, reason: 'use border-on-sidebar/<alpha> or border-border tokens' },
  {
    re: /\b(?:bg|text|border|ring|from|to|via)-(?:gray|slate|zinc|neutral|stone)-\d{2,3}\b/g,
    reason: 'use semantic tokens (text-text-primary, bg-surface, etc.)',
  },
  {
    re: /\b(?:bg|text|border|ring|from|to|via)-(?:blue|purple|emerald|red|green|amber|yellow|orange|pink|rose|indigo|violet|fuchsia|sky|cyan|teal|lime)-\d{2,3}\b/g,
    reason: 'use semantic tokens (info, accent, success, danger, warning)',
  },
  {
    re: /#[0-9a-fA-F]{3,8}\b/g,
    reason: 'use CSS variables / token-driven utilities, no inline hex',
    hexRule: true,
  },
  {
    re: /\btext-[a-z][a-z0-9-]*\/(?:5|10|15|20|25|30|35|40|45)\b/g,
    reason:
      'sub-AA text alpha — use /60 or higher, or a stronger token (e.g. text-on-sidebar, text-text-secondary)',
  },
];

describe('Chrome layouts — token discipline smoke', () => {
  it.each(CHROME_FILES)('$path contains no forbidden non-token colour classes', ({ path: rel, allowHex }) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const violations: string[] = [];
    for (const { re, reason, hexRule } of FORBIDDEN_CLASS_PATTERNS) {
      if (allowHex && hexRule) continue;
      const matches = src.match(re);
      if (matches && matches.length > 0) {
        const unique = Array.from(new Set(matches)).sort();
        violations.push(`${reason}: ${unique.join(', ')}`);
      }
    }
    if (violations.length > 0) {
      throw new Error(`Forbidden tokens in ${rel}:\n  ${violations.join('\n  ')}`);
    }
    expect(violations).toHaveLength(0);
  });
});
