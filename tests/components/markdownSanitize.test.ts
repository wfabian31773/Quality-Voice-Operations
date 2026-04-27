// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { renderMarkdownToSafeHtml, sanitizeHtml } from '../../client-app/src/lib/markdown';

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
    expect(out).not.toMatch(/onerror=/i);
  });

  it('forces external links to open with safe rel + target', () => {
    const out = renderMarkdownToSafeHtml('[QVO](https://example.com)');
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
    expect(out).not.toContain('<iframe');
  });
});
