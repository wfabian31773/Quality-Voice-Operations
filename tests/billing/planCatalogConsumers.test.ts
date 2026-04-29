import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PLAN_CATALOG,
  getPlanMonthlyPriceWholeDollars,
} from '../../shared/billing/planCatalog';
import { blogArticles } from '../../client-app/src/data/blogArticles';
import { buildSystemPrompt } from '../../platform/website-agent/WebsiteSalesAgentService';

describe('plan-price drift guards (consumers of shared/billing/planCatalog)', () => {
  it('website sales agent prompt is generated from the catalog (no hardcoded plan dollar amounts)', () => {
    const starterPrice = getPlanMonthlyPriceWholeDollars('starter');
    const proPrice = getPlanMonthlyPriceWholeDollars('pro');
    const enterprisePrice = getPlanMonthlyPriceWholeDollars('enterprise');

    const prompt = buildSystemPrompt();
    expect(prompt).toContain(`Starter: $${starterPrice}/month`);
    expect(prompt).toContain(`Pro: $${proPrice}/month`);
    expect(prompt).toContain(`Enterprise: $${enterprisePrice}/month`);
    expect(prompt).toContain(`${PLAN_CATALOG.starter.includedMinutes.toLocaleString()} AI minutes`);
    expect(prompt).toContain(`${PLAN_CATALOG.pro.includedMinutes.toLocaleString()} AI minutes`);
    expect(prompt).toContain(`${PLAN_CATALOG.enterprise.includedMinutes.toLocaleString()} AI minutes`);

    const source = readFileSync(
      join(__dirname, '../../platform/website-agent/WebsiteSalesAgentService.ts'),
      'utf8',
    );
    expect(source).toMatch(/from\s+['"]\.\.\/\.\.\/shared\/billing\/planCatalog['"]/);
    expect(source).not.toMatch(/Starter:\s*\$\d+\/month/);
    expect(source).not.toMatch(/Pro:\s*\$\d+\/month/);
    expect(source).not.toMatch(/Enterprise:\s*\$\d+\/month/);
  });

  it('the AI receptionist blog comparison reflects the catalog Starter and Enterprise prices', () => {
    const article = blogArticles.find(
      (a) => a.slug === 'how-ai-receptionists-reduce-missed-calls',
    );
    expect(article).toBeDefined();

    const starterPrice = getPlanMonthlyPriceWholeDollars('starter');
    const enterprisePrice = getPlanMonthlyPriceWholeDollars('enterprise');

    expect(article!.content).toContain(`$${starterPrice}-$${enterprisePrice}`);

    const source = readFileSync(
      join(__dirname, '../../client-app/src/data/blogArticles.ts'),
      'utf8',
    );
    expect(source).toMatch(/from\s+['"]\.\.\/\.\.\/\.\.\/shared\/billing\/planCatalog['"]/);
    expect(source).not.toContain('$99-$499');
  });
});
