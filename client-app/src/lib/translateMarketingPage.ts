import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { marketingPages, type MarketingPage } from '../data/marketingPages';

type I18nLike = {
  exists: (key: string, opts?: { ns?: string }) => boolean;
  language: string;
};

export type TranslatedMarketingPage = MarketingPage & {
  /** Localized label for the category (e.g. "Industrias" in Spanish). The
   *  underlying `category` field still holds the original English enum value
   *  so callers can group/filter by it. */
  categoryLabel: string;
};

export function translateMarketingPageMeta(
  page: MarketingPage,
  i18n: I18nLike,
  t: (key: string) => string,
): {
  title: string;
  description: string;
  categoryLabel: string;
  keywords: string[];
} {
  const titleKey = `catalog.${page.slug}.title`;
  const descKey = `catalog.${page.slug}.description`;
  const keywordsKey = `catalog.${page.slug}.keywords`;
  const categoryKey = `catalog_categories.${page.category}`;

  const translatedKeywords = i18n.exists(keywordsKey, { ns: 'marketing' })
    ? t(keywordsKey).split(/\s+/).filter(Boolean)
    : page.keywords;

  return {
    title: i18n.exists(titleKey, { ns: 'marketing' }) ? t(titleKey) : page.title,
    description: i18n.exists(descKey, { ns: 'marketing' })
      ? t(descKey)
      : page.description,
    categoryLabel: i18n.exists(categoryKey, { ns: 'marketing' })
      ? t(categoryKey)
      : page.category,
    keywords: translatedKeywords,
  };
}

function pageHaystack(
  page: MarketingPage,
  meta: ReturnType<typeof translateMarketingPageMeta>,
): string {
  return [
    meta.title,
    meta.description,
    meta.categoryLabel,
    page.category, // keep English category so e.g. "Industries" still finds matches in any locale
    ...meta.keywords,
    ...page.keywords, // keep English keywords as a fallback so English queries keep working
  ]
    .join(' ')
    .toLowerCase();
}

function applyMeta(
  page: MarketingPage,
  meta: ReturnType<typeof translateMarketingPageMeta>,
): TranslatedMarketingPage {
  return {
    ...page,
    title: meta.title,
    description: meta.description,
    categoryLabel: meta.categoryLabel,
  };
}

/**
 * Locale-aware marketing page search. Builds the haystack from the page's
 * strings as they appear in the active locale (with English fallback for any
 * string that has no translation), then returns pages whose translated content
 * matches the query. The returned pages carry pre-translated `title`,
 * `description`, and `categoryLabel` fields so callers can render them
 * directly without re-translating.
 *
 * In English mode the translated text is identical to the source, so the
 * behavior matches the previous English-only `searchMarketingPages`.
 */
export function searchMarketingPagesLocalized(
  query: string,
  i18n: I18nLike,
  t: (key: string) => string,
): TranslatedMarketingPage[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: TranslatedMarketingPage[] = [];
  for (const page of marketingPages) {
    const meta = translateMarketingPageMeta(page, i18n, t);
    if (pageHaystack(page, meta).includes(q)) {
      out.push(applyMeta(page, meta));
    }
  }
  return out;
}

export function useSearchMarketingPages(): (
  query: string,
) => TranslatedMarketingPage[] {
  const { t, i18n } = useTranslation('marketing');
  return useCallback(
    (query: string) => searchMarketingPagesLocalized(query, i18n, t),
    [i18n, t, i18n.language],
  );
}
