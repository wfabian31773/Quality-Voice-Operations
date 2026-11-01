// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';

// DOMPurify caches the Node.prototype.nodeName getter when it is imported, and
// happy-dom's base getter returns '' (only subclasses override it), so every
// tag reads as disallowed: allowed tags get unwrapped and the walk stops early.
// Browsers resolve nodeName per node type, so make the base getter do the same
// by dispatching to the subclass getter. Hoisted to run before the imports.
vi.hoisted(() => {
  // The <iframe> payload must not trigger a real fetch while it is being parsed.
  window.happyDOM.settings.disableIframePageLoading = true;
  const nodeProto = window.Node.prototype;
  Object.defineProperty(nodeProto, 'nodeName', {
    configurable: true,
    get(this: Node) {
      let proto = Object.getPrototypeOf(this);
      while (proto && proto !== nodeProto) {
        const getter = Object.getOwnPropertyDescriptor(proto, 'nodeName')?.get;
        if (getter) return getter.call(this);
        proto = Object.getPrototypeOf(proto);
      }
      return '';
    },
  });
});

import DOMPurify from 'dompurify';
import { renderMarkdownToSafeHtml, sanitizeHtml } from '../../client-app/src/lib/markdown';

describe('DOMPurify test environment', () => {
  it('runs the real sanitizer (an unsupported DOM makes sanitize a pass-through)', () => {
    expect(DOMPurify.isSupported).toBe(true);
  });
});

describe('renderMarkdownToSafeHtml', () => {
  it('renders basic markdown to HTML', () => {
    const out = renderMarkdownToSafeHtml('# Hello\n\nThis is **bold**.');
    expect(out).toContain('<h1');
    expect(out).toContain('Hello');
    expect(out).toContain('<strong>bold</strong>');
  });

  it('strips inline <script> tags from markdown HTML output', () => {
    const malicious = 'Hi\n\n<script>alert("xss")</script>\n\nBye';
    const out = renderMarkdownToSafeHtml(malicious);
    expect(out).toContain('Hi');
    expect(out).toContain('Bye');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(');
  });

  it('removes javascript: URLs from anchor hrefs', () => {
    const malicious = '[click me](javascript:alert(1))';
    const out = renderMarkdownToSafeHtml(malicious);
    expect(out).not.toMatch(/href="javascript:/i);
  });

  it('strips inline event-handler attributes', () => {
    const malicious = '<img src="x" onerror="alert(1)" />';
    const out = renderMarkdownToSafeHtml(malicious);
    expect(out).toContain('<img');
    expect(out).not.toMatch(/onerror=/i);
  });

  it('forces external links to open with safe rel + target', () => {
    const out = renderMarkdownToSafeHtml('[QVO](https://example.com)');
    expect(out).toContain('href="https://example.com"');
    expect(out).toMatch(/target="_blank"/);
    expect(out).toMatch(/rel="[^"]*noopener[^"]*"/);
  });

  it('returns empty string for empty input', () => {
    expect(renderMarkdownToSafeHtml('')).toBe('');
  });
});

describe('sanitizeHtml', () => {
  it('strips script tags from raw HTML', () => {
    const out = sanitizeHtml('<p>safe</p><script>bad()</script>');
    expect(out).toContain('<p>safe</p>');
    expect(out).not.toContain('<script');
  });

  it('strips iframes', () => {
    const out = sanitizeHtml('<p>ok</p><iframe src="https://evil.example/"></iframe>');
    expect(out).toContain('<p>ok</p>');
    expect(out).not.toContain('<iframe');
  });

  it.each([
    ['style', '<style>body { display: none }</style>'],
    ['object', '<object data="https://evil.example/x.swf"></object>'],
    ['embed', '<embed src="https://evil.example/x.swf">'],
    ['form', '<form action="https://evil.example/"><button>go</button></form>'],
    ['input', '<input name="password">'],
  ])('strips <%s>', (tag, html) => {
    const out = sanitizeHtml(`<p>ok</p>${html}`);
    expect(out).toContain('<p>ok</p>');
    expect(out).not.toContain(`<${tag}`);
  });

  it('forces target + rel on links and overrides author-supplied values', () => {
    const out = sanitizeHtml('<a href="https://example.com" target="_self" rel="opener">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).not.toContain('_self');
  });
});
