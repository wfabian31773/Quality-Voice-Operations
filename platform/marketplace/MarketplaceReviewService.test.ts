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
  a.privClientQuery.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM tenant_agent_installations')) return { rows: [{ id: 'inst-1' }] };
    if (sql.includes('INSERT INTO marketplace_reviews')) {
      return { rows: [{ id: 'r1', template_id: 'tpl-1', rating: 5, review_text: null, status: 'active' }] };
    }
    if (sql.includes('UPDATE marketplace_reviews') || sql.includes('DELETE FROM marketplace_reviews')) {
      return { rows: [{ template_id: 'tpl-1' }] };
    }
    return { rows: [] };
  });
});

describe('MarketplaceReviewService cross-tenant paths', () => {
  it('lists every tenant\'s reviews of a template on the privileged pool', async () => {
    const result = await getReviewsForTemplate('tpl-1');
    expect(a.privPoolQuery).toHaveBeenCalledTimes(2);
    expect(result.reviews).toHaveLength(2);
    expect(result.summary).toMatchObject({ avgRating: 4.5, reviewCount: 2 });
  });

  it('creates a review and recomputes the shared rating in one privileged transaction', async () => {
    const result = await createReview({ tenantId: 't1', userId: 'u1', templateId: 'tpl-1', rating: 5 } as never);
    expect(result.success).toBe(true);
    expect(sqls(a.privClientQuery)).toEqual(['SELECT id', 'INSERT INTO', 'UPDATE template_registry']);
    expect(a.privClientQuery.mock.calls[1][1]).toEqual(['t1', 'u1', 'tpl-1', 5, null]);
    expect(a.tenantQuery).not.toHaveBeenCalled();
  });

  it('refuses a review for a template the tenant has not installed', async () => {
    a.privClientQuery.mockResolvedValueOnce({ rows: [] });
    const result = await createReview({ tenantId: 't1', userId: 'u1', templateId: 'tpl-1', rating: 5 } as never);
    expect(result.success).toBe(false);
    expect(a.privClientQuery).toHaveBeenCalledTimes(1);
  });

  it('deletes only the caller\'s review and recomputes the rating atomically', async () => {
    expect(await deleteReview('t1' as never, 'u1', 'r1')).toEqual({ success: true });
    expect(sqls(a.privClientQuery)).toEqual(['DELETE FROM', 'UPDATE template_registry']);
    expect(a.privClientQuery.mock.calls[0][1]).toEqual(['r1', 't1', 'u1']);
  });

  it('fails the whole operation when the rating recompute fails (rolled back together)', async () => {
    a.privClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE template_registry')) throw new Error('db down');
      return sql.includes('DELETE') ? { rows: [{ template_id: 'tpl-1' }] } : { rows: [] };
    });
    expect(await deleteReview('t1' as never, 'u1', 'r1')).toEqual({ success: false, error: 'Failed to delete review' });
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
