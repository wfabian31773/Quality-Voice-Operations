import { describe, it, expect, vi, beforeEach } from 'vitest';

const a = vi.hoisted(() => ({
  tenantQuery: vi.fn(),
  privPoolQuery: vi.fn(),
  privClientQuery: vi.fn(),
}));

vi.mock('../db', () => ({
  getPlatformPool: () => ({
    query: vi.fn(async () => {
      throw new Error('restricted pool.query must not be used');
    }),
    connect: async () => ({ query: a.tenantQuery, release: vi.fn() }),
  }),
  getPrivilegedPool: () => ({ query: a.privPoolQuery }),
  withPrivilegedClient: async (fn: (c: { query: typeof a.privClientQuery }) => Promise<unknown>) =>
    fn({ query: a.privClientQuery }),
  withTenantContext: async (_c: unknown, _t: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../core/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { createReview, deleteReview, getReviewsForTemplate, moderateReview } from './MarketplaceReviewService';

const sqls = (m: ReturnType<typeof vi.fn>) => m.mock.calls.map((c) => String(c[0]).trim().split(/\s+/).slice(0, 2).join(' '));

beforeEach(() => {
  a.tenantQuery.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM tenant_agent_installations')) return { rows: [{ id: 'inst-1' }] };
    if (sql.includes('INSERT INTO marketplace_reviews')) {
      return { rows: [{ id: 'r1', template_id: 'tpl-1', rating: 5, review_text: null, status: 'active' }] };
    }
    if (sql.includes('DELETE FROM marketplace_reviews')) return { rows: [{ template_id: 'tpl-1' }] };
    return { rows: [] };
  });
  a.privPoolQuery.mockReset().mockImplementation(async (sql: string) =>
    sql.includes('COUNT(*)::int AS review_count')
      ? { rows: [{ review_count: 2, avg_rating: '4.50', r1: 0, r2: 0, r3: 0, r4: 1, r5: 1 }] }
      : { rows: [{ id: 'r1', template_id: 'tpl-1', rating: 5 }, { id: 'r2', template_id: 'tpl-1', rating: 4 }] },
  );
  a.privClientQuery.mockReset().mockImplementation(async (sql: string) =>
    sql.includes('UPDATE marketplace_reviews') ? { rows: [{ template_id: 'tpl-1' }] } : { rows: [] },
  );
});

describe('MarketplaceReviewService cross-tenant paths', () => {
  it('lists every tenant\'s reviews of a template on the privileged pool', async () => {
    const result = await getReviewsForTemplate('tpl-1');
    expect(a.privPoolQuery).toHaveBeenCalledTimes(2);
    expect(result.reviews).toHaveLength(2);
    expect(result.summary).toMatchObject({ avgRating: 4.5, reviewCount: 2 });
  });

  it('creates a review in the tenant transaction, then recomputes the shared rating privileged', async () => {
    const result = await createReview({ tenantId: 't1', userId: 'u1', templateId: 'tpl-1', rating: 5 } as never);
    expect(result.success).toBe(true);
    expect(sqls(a.tenantQuery)).toEqual(['BEGIN', 'SELECT id', 'INSERT INTO', 'COMMIT']);
    expect(a.privClientQuery).toHaveBeenCalledTimes(1);
    expect(String(a.privClientQuery.mock.calls[0][0])).toContain('UPDATE template_registry');
  });

  it('deletes a review tenant-bound and recomputes the rating privileged', async () => {
    expect(await deleteReview('t1' as never, 'u1', 'r1')).toEqual({ success: true });
    expect(sqls(a.tenantQuery)).toEqual(['BEGIN', 'DELETE FROM', 'COMMIT']);
    expect(String(a.privClientQuery.mock.calls[0][0])).toContain('UPDATE template_registry');
  });

  it('keeps the review when the rating refresh fails', async () => {
    a.privClientQuery.mockRejectedValueOnce(new Error('db down'));
    expect(await deleteReview('t1' as never, 'u1', 'r1')).toEqual({ success: true });
  });

  it('moderates any tenant\'s review on the privileged client', async () => {
    expect(await moderateReview('r9', 'removed')).toEqual({ success: true });
    expect(sqls(a.privClientQuery)).toEqual(['UPDATE marketplace_reviews', 'UPDATE template_registry']);
  });

  it('reports a missing review and failures from moderation', async () => {
    a.privClientQuery.mockResolvedValueOnce({ rows: [] });
    expect(await moderateReview('nope', 'flagged')).toEqual({ success: false, error: 'Review not found' });
    a.privClientQuery.mockRejectedValueOnce(new Error('boom'));
    expect(await moderateReview('r9', 'flagged')).toEqual({ success: false, error: 'Failed to moderate review' });
  });
});
