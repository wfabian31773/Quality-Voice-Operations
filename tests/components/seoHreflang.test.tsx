// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import SEO from '../../client-app/src/components/SEO';
import i18n from '../../client-app/src/lib/i18n';

void React;

beforeEach(() => {
  // Pre-seed the page with the same static hreflang fallbacks index.html
  // ships, so we can prove SEO sweeps them away on a non-home route.
  document.head.innerHTML = '';
  const STATIC = [
    ['en', '/'],
    ['es', '/es'],
    ['pt-BR', '/pt-BR'],
    ['fr', '/fr'],
    ['de', '/de'],
    ['x-default', '/'],
  ];
  for (const [hreflang, href] of STATIC) {
    const link = document.createElement('link');
    link.setAttribute('rel', 'alternate');
    link.setAttribute('hreflang', hreflang);
    link.setAttribute('href', href);
    link.setAttribute('data-seo-hreflang-static', 'true');
    document.head.appendChild(link);
  }
});

afterEach(() => {
  cleanup();
  document.head.innerHTML = '';
});

function getAlternates() {
  return Array.from(
    document.querySelectorAll('link[rel="alternate"][hreflang]'),
  ).map((el) => ({
    hreflang: el.getAttribute('hreflang'),
    href: el.getAttribute('href'),
  }));
}

describe('SEO hreflang emission', () => {
  it('replaces static home-page alternates with per-route alternates on a non-home path', async () => {
    await i18n.changeLanguage('en');

    render(
      <MemoryRouter initialEntries={['/pricing']}>
        <SEO title="Pricing" description="QVO pricing" />
      </MemoryRouter>,
    );

    const alternates = getAlternates();

    // Exactly one tag per supported locale + one x-default.
    expect(alternates).toHaveLength(6);

    const byLang = new Map(alternates.map((a) => [a.hreflang, a.href]));
    expect(byLang.size).toBe(6);

    // Every alternate must reflect the current route (`/pricing`), not the
    // home-page `/` from the static fallback set.
    expect(byLang.get('en')).toMatch(/\/pricing$/);
    expect(byLang.get('es')).toMatch(/\/es\/pricing$/);
    expect(byLang.get('pt-BR')).toMatch(/\/pt-BR\/pricing$/);
    expect(byLang.get('fr')).toMatch(/\/fr\/pricing$/);
    expect(byLang.get('de')).toMatch(/\/de\/pricing$/);
    expect(byLang.get('x-default')).toMatch(/\/pricing$/);

    // No static fallback tags should remain — they only described `/`.
    const stragglers = document.querySelectorAll('link[data-seo-hreflang-static]');
    expect(stragglers.length).toBe(0);
  });

  it('emits the right canonical for the current locale', async () => {
    await i18n.changeLanguage('pt-BR');

    render(
      <MemoryRouter initialEntries={['/pricing']}>
        <SEO title="Preços" description="Planos QVO" />
      </MemoryRouter>,
    );

    const canonical = document.querySelector(
      'link[rel="canonical"]',
    ) as HTMLLinkElement | null;
    expect(canonical).not.toBeNull();
    // pt-BR is non-default, so canonical must be the prefixed form.
    expect(canonical!.href).toMatch(/\/pt-BR\/pricing$/);
  });

  it('canonical is un-prefixed for the default locale', async () => {
    await i18n.changeLanguage('en');

    render(
      <MemoryRouter initialEntries={['/features']}>
        <SEO title="Features" description="QVO features" />
      </MemoryRouter>,
    );

    const canonical = document.querySelector(
      'link[rel="canonical"]',
    ) as HTMLLinkElement | null;
    expect(canonical).not.toBeNull();
    expect(canonical!.href).toMatch(/\/features$/);
    expect(canonical!.href).not.toMatch(/\/en\/features$/);
  });
});
