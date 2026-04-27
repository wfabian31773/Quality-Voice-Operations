import { marked } from 'marked';
import DOMPurify, { type Config } from 'dompurify';

marked.setOptions({
  gfm: true,
  breaks: true,
});

const SANITIZE_CONFIG: Config = {
  USE_PROFILES: { html: true },
  ALLOWED_TAGS: [
    'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'span', 'strong',
    'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
  ],
  ALLOWED_ATTR: ['href', 'title', 'alt', 'src', 'class', 'rel', 'target'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur'],
};

if (typeof window !== 'undefined') {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  });
}

export function renderMarkdownToSafeHtml(source: string): string {
  if (!source) return '';
  const rawHtml = marked.parse(source, { async: false }) as string;
  return DOMPurify.sanitize(rawHtml, SANITIZE_CONFIG);
}

export function sanitizeHtml(html: string): string {
  if (!html) return '';
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}
