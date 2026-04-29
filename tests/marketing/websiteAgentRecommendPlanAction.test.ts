import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PLAN_CATALOG, PLAN_TIERS } from '../../shared/billing/planCatalog';
import {
  buildRecommendPlanActionData,
  chat,
} from '../../platform/website-agent/WebsiteSalesAgentService';

describe('website agent recommend_plan action surfaces catalog pricing', () => {
  it('buildRecommendPlanActionData returns catalog-derived monthly price, included minutes, and overage rate for every tier', () => {
    for (const tier of PLAN_TIERS) {
      const data = buildRecommendPlanActionData(tier, 'Best fit for the visitor.');
      const entry = PLAN_CATALOG[tier];
      expect(data.plan).toBe(tier);
      expect(data.reason).toBe('Best fit for the visitor.');
      expect(data.monthlyPriceCents).toBe(entry.monthlyPriceCents);
      expect(data.includedMinutes).toBe(entry.includedMinutes);
      expect(data.overageRatePerMinute).toBe(entry.overageRatePerMinute);
    }
  });

  it('falls back to the starter tier when the LLM passes an unknown plan string', () => {
    const data = buildRecommendPlanActionData('unicorn', undefined);
    expect(data.plan).toBe('starter');
    expect(data.monthlyPriceCents).toBe(PLAN_CATALOG.starter.monthlyPriceCents);
    expect(data.includedMinutes).toBe(PLAN_CATALOG.starter.includedMinutes);
    expect(data.overageRatePerMinute).toBe(PLAN_CATALOG.starter.overageRatePerMinute);
    expect(data.reason).toBe('');
  });

  describe('end-to-end chat flow', () => {
    const ORIGINAL_FETCH = globalThis.fetch;
    const ORIGINAL_KEY = process.env.OPENAI_API_KEY;

    beforeEach(() => {
      process.env.OPENAI_API_KEY = 'sk-test-fake-key-for-unit-tests';
    });

    afterEach(() => {
      globalThis.fetch = ORIGINAL_FETCH;
      if (ORIGINAL_KEY === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = ORIGINAL_KEY;
      }
      vi.restoreAllMocks();
    });

    it('chat() pushes a recommend_plan action whose payload mirrors the plan catalog', async () => {
      let call = 0;
      const fetchMock = vi.fn(async (input: unknown) => {
        const url = typeof input === 'string' ? input : (input as URL | Request).toString();
        if (!url.includes('openai.com')) {
          throw new Error(`unexpected fetch in test: ${url}`);
        }
        call += 1;
        if (call === 1) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_1',
                        type: 'function',
                        function: {
                          name: 'recommend_plan',
                          arguments: JSON.stringify({
                            plan: 'pro',
                            reason: 'Outbound campaigns + 10 numbers',
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'Pro looks like the right fit for you.',
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const conversationId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const response = await chat(conversationId, 'Which plan should I pick?', '/pricing');

      const recommendActions = response.actions.filter((a) => a.type === 'recommend_plan');
      expect(recommendActions).toHaveLength(1);

      const data = recommendActions[0]!.data as Record<string, unknown>;
      const proCatalog = PLAN_CATALOG.pro;
      expect(data.plan).toBe('pro');
      expect(data.reason).toBe('Outbound campaigns + 10 numbers');
      expect(data.monthlyPriceCents).toBe(proCatalog.monthlyPriceCents);
      expect(data.includedMinutes).toBe(proCatalog.includedMinutes);
      expect(data.overageRatePerMinute).toBe(proCatalog.overageRatePerMinute);
    });
  });
});
