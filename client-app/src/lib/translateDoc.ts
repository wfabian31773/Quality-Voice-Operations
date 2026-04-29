import { useTranslation } from 'react-i18next';
import type { DocArticle, DocBlock } from '../data/docs';

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
