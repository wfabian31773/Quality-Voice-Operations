import { getPrivilegedPool, withPrivilegedClient } from '../db';
import { createLogger } from '../core/logger';
import type { TenantId } from '../core/types';

const logger = createLogger('MARKETPLACE_REVIEWS');

export interface ReviewInput {
  tenantId: TenantId;
  userId: string;
  templateId: string;
  rating: number;
  reviewText?: string;
}

export interface Review {
  id: string;
  templateId: string;
  rating: number;
  reviewText: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewSummary {
  avgRating: number;
  reviewCount: number;
  distribution: Record<number, number>;
}

/**
 * Create or update the caller's review and recompute the shared template
 * rating in one privileged transaction: the rating aggregates every
 * tenant's reviews, so a tenant-bound (RLS) read would see only this
 * tenant's rows. The review rows themselves stay scoped by the explicit
 * tenant_id / user_id predicates.
 */
export async function createReview(input: ReviewInput): Promise<{ success: boolean; error?: string; review?: Review }> {
  const { tenantId, userId, templateId, rating, reviewText } = input;

  if (rating < 1 || rating > 5 || !Number.isInteger(rating)) {
    return { success: false, error: 'Rating must be an integer between 1 and 5' };
  }

  try {
    return await withPrivilegedClient(async (client) => {
      const { rows: installed } = await client.query(
        `SELECT id FROM tenant_agent_installations
         WHERE tenant_id = $1 AND template_id = $2 AND status = 'active'`,
        [tenantId, templateId],
      );

      if (installed.length === 0) {
        return { success: false, error: 'You must install this template before leaving a review' };
      }

      const { rows } = await client.query(
        `INSERT INTO marketplace_reviews (tenant_id, user_id, template_id, rating, review_text)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, user_id, template_id) DO UPDATE SET
           rating = EXCLUDED.rating,
           review_text = EXCLUDED.review_text,
           updated_at = NOW()
         RETURNING *`,
        [tenantId, userId, templateId, rating, reviewText ?? null],
      );

      await updateAggregateRating(client, templateId);

      const review = rows[0];
      logger.info('Review created/updated', { tenantId, userId, templateId, rating });

      return {
        success: true,
        review: {
          id: review.id as string,
          templateId: review.template_id as string,
          rating: review.rating as number,
          reviewText: review.review_text as string | null,
          status: review.status as Review['status'],
          createdAt: review.created_at as string,
          updatedAt: review.updated_at as string,
        },
      };
    });
  } catch (err) {
    logger.error('Failed to create review', { tenantId, templateId, error: String(err) });
    return { success: false, error: 'Failed to create review' };
  }
}

export async function getReviewsForTemplate(
  templateId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ reviews: Review[]; summary: ReviewSummary }> {
  // Every tenant's active reviews of a shared template (no tenant ids are
  // returned): privileged pool, or RLS would show only the caller's own.
  const pool = getPrivilegedPool();
  const limit = Math.min(options.limit ?? 20, 100);
  const offset = options.offset ?? 0;

  const [reviewsResult, summaryResult] = await Promise.all([
    pool.query(
      `SELECT id, template_id, rating, review_text, status, created_at, updated_at
       FROM marketplace_reviews
       WHERE template_id = $1 AND status = 'active'
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [templateId, limit, offset],
    ),
    pool.query(
      `SELECT
         COUNT(*)::int AS review_count,
         COALESCE(AVG(rating), 0)::numeric(3,2) AS avg_rating,
         COUNT(*) FILTER (WHERE rating = 1)::int AS r1,
         COUNT(*) FILTER (WHERE rating = 2)::int AS r2,
         COUNT(*) FILTER (WHERE rating = 3)::int AS r3,
         COUNT(*) FILTER (WHERE rating = 4)::int AS r4,
         COUNT(*) FILTER (WHERE rating = 5)::int AS r5
       FROM marketplace_reviews
       WHERE template_id = $1 AND status = 'active'`,
      [templateId],
    ),
  ]);

  const s = summaryResult.rows[0];

  return {
    reviews: reviewsResult.rows.map((r) => ({
      id: r.id,
      templateId: r.template_id,
      rating: r.rating,
      reviewText: r.review_text,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    summary: {
      avgRating: parseFloat(s.avg_rating),
      reviewCount: s.review_count,
      distribution: { 1: s.r1, 2: s.r2, 3: s.r3, 4: s.r4, 5: s.r5 },
    },
  };
}

/** Delete the caller's review and recompute the shared rating atomically (see createReview). */
export async function deleteReview(
  tenantId: TenantId,
  userId: string,
  reviewId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    return await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(
        `DELETE FROM marketplace_reviews
         WHERE id = $1 AND tenant_id = $2 AND user_id = $3
         RETURNING template_id`,
        [reviewId, tenantId, userId],
      );

      if (rows.length === 0) {
        return { success: false, error: 'Review not found' };
      }

      await updateAggregateRating(client, rows[0].template_id as string);
      return { success: true };
    });
  } catch (err) {
    logger.error('Failed to delete review', { tenantId, reviewId, error: String(err) });
    return { success: false, error: 'Failed to delete review' };
  }
}

/** Platform moderation acts on any tenant's review: privileged pool. */
export async function moderateReview(
  reviewId: string,
  status: 'active' | 'flagged' | 'removed',
): Promise<{ success: boolean; error?: string }> {
  try {
    return await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(
        `UPDATE marketplace_reviews SET status = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING template_id`,
        [status, reviewId],
      );

      if (rows.length === 0) {
        return { success: false, error: 'Review not found' };
      }

      await updateAggregateRating(client, rows[0].template_id as string);
      return { success: true };
    });
  } catch (err) {
    logger.error('Failed to moderate review', { reviewId, error: String(err) });
    return { success: false, error: 'Failed to moderate review' };
  }
}

async function updateAggregateRating(
  client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  templateId: string,
): Promise<void> {
  await client.query(
    `UPDATE template_registry SET
       avg_rating = COALESCE((
         SELECT AVG(rating)::numeric(3,2) FROM marketplace_reviews
         WHERE template_id = $1 AND status = 'active'
       ), 0),
       review_count = COALESCE((
         SELECT COUNT(*)::int FROM marketplace_reviews
         WHERE template_id = $1 AND status = 'active'
       ), 0)
     WHERE id = $1`,
    [templateId],
  );
}
