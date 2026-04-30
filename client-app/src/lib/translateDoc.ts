import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { docArticles, type DocArticle, type DocBlock } from '../data/docs';

type TranslatableBlock = Extract<
  DocBlock,
  { type: 'p' | 'h2' | 'h3' | 'ul' | 'ol' | 'callout' | 'video' | 'common-issues' }
>;

function isTranslatableBlock(b: DocBlock): b is TranslatableBlock {
  return (
    b.type === 'p' ||
    b.type === 'h2' ||
    b.type === 'h3' ||
    b.type === 'ul' ||
    b.type === 'ol' ||
    b.type === 'callout' ||
    b.type === 'video' ||
    b.type === 'common-issues'
  );
}

type I18nLike = {
  exists: (key: string, opts?: { ns?: string }) => boolean;
  language: string;
};

function translateBlock(
  block: DocBlock,
  baseKey: string,
  i18n: I18nLike,
  t: (key: string) => string,
): DocBlock {
  if (!isTranslatableBlock(block)) return block;

  if (
    block.type === 'p' ||
    block.type === 'h2' ||
    block.type === 'h3' ||
    block.type === 'callout'
  ) {
    if (i18n.exists(baseKey, { ns: 'docs' })) {
      return { ...block, text: t(baseKey) };
    }
    return block;
  }

  if (block.type === 'ul' || block.type === 'ol') {
    const items = block.items.map((item, j) => {
      const k = `${baseKey}.${j}`;
      return i18n.exists(k, { ns: 'docs' }) ? t(k) : item;
    });
    return { ...block, items };
  }

  if (block.type === 'video') {
    if (block.caption && i18n.exists(`${baseKey}.caption`, { ns: 'docs' })) {
      return { ...block, caption: t(`${baseKey}.caption`) };
    }
    return block;
  }

  // common-issues
  const items = block.items.map((it, j) => {
    const probKey = `${baseKey}.${j}.problem`;
    const fixKey = `${baseKey}.${j}.fix`;
    return {
      problem: i18n.exists(probKey, { ns: 'docs' }) ? t(probKey) : it.problem,
      fix: i18n.exists(fixKey, { ns: 'docs' }) ? t(fixKey) : it.fix,
    };
  });
  return { ...block, items };
}

export function translateBlocks(
  blocks: DocBlock[],
  articleSlug: string | undefined,
  i18n: I18nLike,
  t: (key: string) => string,
): DocBlock[] {
  if (!articleSlug) return blocks;
  return blocks.map((b, i) =>
    translateBlock(b, `articles.${articleSlug}.body.${i}`, i18n, t),
  );
}

export function translateArticleMeta(
  article: DocArticle,
  i18n: I18nLike,
  t: (key: string) => string,
): { title: string; description: string } {
  const titleKey = `articles.${article.slug}.title`;
  const descKey = `articles.${article.slug}.description`;
  return {
    title: i18n.exists(titleKey, { ns: 'docs' }) ? t(titleKey) : article.title,
    description: i18n.exists(descKey, { ns: 'docs' })
      ? t(descKey)
      : article.description,
  };
}

export function useTranslatedArticle(article: DocArticle | undefined): DocArticle | undefined {
  const { t, i18n } = useTranslation('docs');
  if (!article) return article;
  const meta = translateArticleMeta(article, i18n, t);
  const body = translateBlocks(article.body, article.slug, i18n, t);
  return { ...article, ...meta, body };
}

export function useTranslatedArticles(articles: DocArticle[]): DocArticle[] {
  const { t, i18n } = useTranslation('docs');
  return articles.map((a) => {
    const meta = translateArticleMeta(a, i18n, t);
    const body = translateBlocks(a.body, a.slug, i18n, t);
    return { ...a, ...meta, body };
  });
}

export function useArticleMetaTranslator(): (article: DocArticle) => {
  title: string;
  description: string;
} {
  const { t, i18n } = useTranslation('docs');
  return (article: DocArticle) => translateArticleMeta(article, i18n, t);
}

export function useDocCategoryTranslator(): (
  category: { slug: string; title: string; description: string },
) => { title: string; description: string } {
  const { t, i18n } = useTranslation('docs');
  return (category) => {
    const titleKey = `categories.${category.slug}.title`;
    const descKey = `categories.${category.slug}.description`;
    return {
      title: i18n.exists(titleKey, { ns: 'docs' }) ? t(titleKey) : category.title,
      description: i18n.exists(descKey, { ns: 'docs' })
        ? t(descKey)
        : category.description,
    };
  };
}

function articleHaystack(article: DocArticle): string {
  return [
    article.title,
    article.description,
    article.category,
    ...article.body.flatMap((b) => {
      if (b.type === 'p' || b.type === 'h2' || b.type === 'h3') return [b.text];
      if (b.type === 'ul' || b.type === 'ol') return b.items;
      if (b.type === 'callout') return [b.text];
      if (b.type === 'code') return [b.text];
      if (b.type === 'common-issues') return b.items.flatMap((i) => [i.problem, i.fix]);
      return [];
    }),
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * Locale-aware doc search. Builds the haystack from the article's strings as
 * they appear in the active locale (with English fallback for any string that
 * has no translation), then returns articles whose translated content matches
 * the query. The returned articles are pre-translated so callers can render
 * them directly without re-translating.
 *
 * In English mode the translated text is identical to the source, so the
 * behavior matches the previous English-only `searchDocs`.
 */
export function searchDocsLocalized(
  query: string,
  i18n: I18nLike,
  t: (key: string) => string,
): DocArticle[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: DocArticle[] = [];
  for (const article of docArticles) {
    const meta = translateArticleMeta(article, i18n, t);
    const body = translateBlocks(article.body, article.slug, i18n, t);
    const translated: DocArticle = { ...article, ...meta, body };
    if (articleHaystack(translated).includes(q)) {
      out.push(translated);
    }
  }
  return out;
}

export function useSearchDocs(): (query: string) => DocArticle[] {
  const { t, i18n } = useTranslation('docs');
  // Memoize so consumers' `useMemo([query, searchDocs])` only recomputes when
  // the language actually changes, not on every render of the parent.
  return useCallback(
    (query: string) => searchDocsLocalized(query, i18n, t),
    [i18n, t, i18n.language],
  );
}
