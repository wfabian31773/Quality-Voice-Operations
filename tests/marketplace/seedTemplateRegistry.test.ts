/**
 * scripts/seed-template-registry.ts: every plan includes every template
 * (docs/shop/tools-spec.md, "Plans and entitlements"). The seed must write
 * min_plan = 'starter' and an enabled entitlement row for every tier, whatever
 * a manifest's minPlan says.
 */
import fs from 'fs';
import { describe, expect, it, vi } from 'vitest';

interface Call { sql: string; params: unknown[] }
const calls: Call[] = [];
let nextTemplateId = 0;

const client = {
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const trimmed = sql.trim();
    if (trimmed.startsWith('INSERT INTO template_categories')) {
      return { rows: [{ id: `cat-${String(params[0])}` }] };
    }
    if (trimmed.startsWith('INSERT INTO template_registry')) {
      nextTemplateId += 1;
      return { rows: [{ id: `tpl-${nextTemplateId}` }] };
    }
    return { rows: [] };
  }),
  release: vi.fn(),
};

vi.mock('../../platform/db', () => ({
  getPrivilegedPool: () => ({ connect: async () => client }),
}));

import { seedTemplateRegistry } from '../../scripts/seed-template-registry';

describe('seed-template-registry: every template on every plan', () => {
  it('writes min_plan starter and enabled entitlements for starter, pro and enterprise, even for an enterprise manifest', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Pretend every manifest still says enterprise: the seed must ignore it.
    const realRead = fs.readFileSync.bind(fs);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      const out = realRead(file, options as BufferEncoding);
      return String(file).endsWith('manifest.json')
        ? String(out).replace(/"minPlan":\s*"\w+"/, '"minPlan": "enterprise"')
        : out;
    }) as unknown as typeof fs.readFileSync);

    await seedTemplateRegistry();

    const templateInserts = calls.filter((c) => c.sql.trim().startsWith('INSERT INTO template_registry'));
    // The ten manifests in TEMPLATE_DIRS, including collections (was enterprise)
    // and legal / medical-after-hours / outbound-sales / technical-support (were pro).
    expect(templateInserts).toHaveLength(10);
    const slugs = templateInserts.map((c) => c.params[0]);
    expect(slugs).toEqual(expect.arrayContaining(['collections', 'legal']));
    for (const insert of templateInserts) {
      expect(insert.params[7], `min_plan for ${String(insert.params[0])}`).toBe('starter');
    }

    const entitlementWrites = calls.filter((c) => c.sql.includes('INSERT INTO template_entitlements'));
    expect(entitlementWrites).toHaveLength(templateInserts.length * 3);
    for (const write of entitlementWrites) {
      expect(write.sql).toMatch(/VALUES \(\$1, \$2, TRUE\)/);
      expect(write.sql).toMatch(/DO UPDATE SET enabled = TRUE/);
      expect(write.params).not.toContain(false);
    }
    for (let i = 1; i <= templateInserts.length; i += 1) {
      const tiers = entitlementWrites.filter((w) => w.params[0] === `tpl-${i}`).map((w) => w.params[1]);
      expect(tiers).toEqual(['starter', 'pro', 'enterprise']);
    }

    expect(calls.at(-1)?.sql).toBe('COMMIT');
  });
});
