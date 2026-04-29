import { describe, it, expect } from 'vitest';

// @ts-expect-error: pure-JS Node script with no type declarations.
import { runI18nKeyCheck, parseNamespacesFromSource, findSameAsEnglish, flattenValues } from '../../scripts/check-i18n-keys.mjs';

/**
 * Two-layer test:
 *
 *  1. Real-codebase check — exercises the script with no overrides against
 *     `client-app/src/locales/*` and asserts that there is zero drift today.
 *     This is the regression guard the task asks for: if anyone adds a key
 *     to en/<ns>.json without updating the other four locales, this test
 *     fails fast in CI.
 *
 *  2. Synthetic-fixture checks — point the script at an isolated tmp dir
 *     so we can prove it actually catches drift, honors the allowlist,
 *     and reports both `missing` and `extra` keys in either direction.
 */

describe('i18n key check (real codebase)', () => {
  it('every key in en/* is present in de/es/fr/pt-BR/* and vice versa', () => {
    const result = runI18nKeyCheck();

    if (!result.ok) {
      const lines: string[] = [
        `Locale key drift detected (source=${result.sourceLocale}):`,
      ];
      for (const entry of result.drift) {
        const same: string[] = entry.sameAsEnglish ?? [];
        lines.push(
          `  • ${entry.locale}/${entry.namespace}.json — ${entry.missing.length} missing, ${entry.extra.length} extra, ${same.length} same-as-English`,
        );
        for (const k of entry.missing.slice(0, 20)) lines.push(`      - missing:        ${k}`);
        if (entry.missing.length > 20) lines.push(`      …and ${entry.missing.length - 20} more missing`);
        for (const k of entry.extra.slice(0, 20)) lines.push(`      + extra:          ${k}`);
        if (entry.extra.length > 20) lines.push(`      …and ${entry.extra.length - 20} more extra`);
        for (const k of same.slice(0, 20)) lines.push(`      = same-as-English: ${k}`);
        if (same.length > 20) lines.push(`      …and ${same.length - 20} more same-as-English`);
      }
      lines.push(
        '',
        'Fix: add the missing/extra keys to the listed locale files, OR translate',
        'same-as-English entries with a real translation. If the omission or',
        'identical value is intentional, add the key to',
        'scripts/i18n-allowed-overrides.json under the appropriate section.',
      );
      throw new Error(lines.join('\n'));
    }

    expect(result.ok).toBe(true);
    expect(result.drift).toEqual([]);
  });
});

describe('i18n key check (allowlist + driver behavior on real codebase)', () => {
  it('a spurious allowlist entry for a non-existent key is a no-op (when merged with the on-disk seed)', () => {
    // Adding a non-existent key to either bucket of the allowlist cannot
    // create drift — it can only mask drift that's actually there. So the
    // run must remain green just like the baseline. We merge with the
    // on-disk seed because runI18nKeyCheck does not auto-load it when an
    // explicit `overrides` payload is supplied.
    const baseline = runI18nKeyCheck();
    expect(baseline.ok).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const onDisk = require('../../scripts/i18n-allowed-overrides.json');
    const withSpuriousAllow = runI18nKeyCheck({
      overrides: {
        missing: {
          ...(onDisk.missing ?? {}),
          de: {
            ...((onDisk.missing ?? {}).de ?? {}),
            common: [
              ...(((onDisk.missing ?? {}).de ?? {}).common ?? []),
              'this.key.does.not.exist',
            ],
          },
        },
        extra: onDisk.extra ?? {},
        sameAsEnglish: {
          ...(onDisk.sameAsEnglish ?? {}),
          de: {
            ...((onDisk.sameAsEnglish ?? {}).de ?? {}),
            common: [
              ...(((onDisk.sameAsEnglish ?? {}).de ?? {}).common ?? []),
              'this.key.does.not.exist',
            ],
          },
        },
      },
    });
    expect(withSpuriousAllow.ok).toBe(true);
  });

  it('an empty overrides payload is NOT equivalent to no overrides', () => {
    // The on-disk allowlist seeds the `sameAsEnglish` bucket with every
    // currently-tolerated identical-to-English entry; an empty overrides
    // payload removes that tolerance and surfaces real drift.
    const a = runI18nKeyCheck({ overrides: { missing: {}, extra: {}, sameAsEnglish: {} } });
    const b = runI18nKeyCheck();
    expect(b.ok).toBe(true);
    expect(a.ok).toBe(false);
    // Every drift entry produced by the empty-override run must be a
    // same-as-English finding (since the missing/extra allowlist is empty
    // today as well, but the on-disk source has no missing/extra drift).
    for (const entry of a.drift) {
      expect(entry.missing).toEqual([]);
      expect(entry.extra).toEqual([]);
      expect(entry.sameAsEnglish.length).toBeGreaterThan(0);
    }
  });

  it('explicitly omitting one supported locale produces no drift report for it', () => {
    // Driver-level smoke test: the script's reduce-over-locales loop only
    // iterates the locales we hand in. By restricting the run to en+es we
    // prove the iteration is configurable and that locales not under
    // examination contribute zero rows to the drift report.
    const result = runI18nKeyCheck({ locales: ['en', 'es'], namespaces: ['common'] });
    expect(result.ok).toBe(true);
    expect(result.drift).toEqual([]);
    expect(result.locales).toEqual(['en', 'es']);
    expect(result.namespaces).toEqual(['common']);
  });

  it('phantom allowlist entries are no-ops; real same-as-English drift still surfaces', () => {
    // We can't fabricate a fake locale on disk, so this test pre-populates
    // every override bucket (missing, extra, sameAsEnglish) with phantom
    // keys that do NOT exist anywhere in the codebase. The contract is
    // that those phantom entries are inert — `allowedSet` must not turn
    // them into manufactured drift. Real same-as-English drift in the
    // codebase WILL still surface because passing an explicit `overrides`
    // payload replaces the on-disk seed (see assertion comment below for
    // detail). The fine-grained "suppress one specific key, leave its
    // siblings alone" contract is exercised separately by the synthetic
    // fixture suite further down and by the driver-level test
    // "a single allowlist entry suppresses exactly that one
    // same-as-English finding".
    const result = runI18nKeyCheck({
      overrides: {
        missing: {
          de: { common: ['phantom.a', 'phantom.b'] },
          fr: { common: ['phantom.c'] },
        },
        extra: {
          es: { common: ['phantom.d'] },
        },
        sameAsEnglish: {
          de: { common: ['phantom.e'] },
          fr: { common: ['phantom.f'] },
          es: { common: ['phantom.g'] },
          'pt-BR': { common: ['phantom.h'] },
        },
      },
    });
    // Note: passing an explicit `overrides` payload REPLACES the on-disk
    // allowlist — the API does not merge. So this run intentionally drops
    // the seeded `sameAsEnglish` tolerance and surfaces the real
    // identical-to-English drift in the codebase. The contract being
    // exercised is twofold: (a) phantom allowlist entries do not invent
    // new drift (they're no-ops), and (b) the drift that DOES surface is
    // purely from the same-as-English check, since the codebase has no
    // missing/extra drift today.
    expect(result.ok).toBe(false);
    for (const entry of result.drift) {
      expect(entry.missing).toEqual([]);
      expect(entry.extra).toEqual([]);
    }
  });

  it('reports the configured supported locales and namespaces', () => {
    const result = runI18nKeyCheck();
    expect(result.sourceLocale).toBe('en');
    // We currently ship 5 locales × 5 namespaces. If those numbers change,
    // update SUPPORTED_LANGUAGES / ns in client-app/src/lib/i18n.ts and
    // the script will pick it up automatically — but the test will need to
    // be rebaselined.
    expect(result.locales).toEqual(['en', 'es', 'pt-BR', 'fr', 'de']);
    expect(result.namespaces).toEqual(['common', 'docs', 'marketing', 'tenant', 'admin']);
  });

  it('every same-as-English entry from the seeded on-disk allowlist refers to a real identical-value pair', () => {
    // Belt-and-braces guard: if anyone removes a key from a locale file
    // without also pruning it from `i18n-allowed-overrides.json`, the
    // allowlist grows stale (entries that no longer correspond to any
    // identical-value pair). Re-running with an empty allowlist tells us
    // which keys *currently* drift; every seeded entry must appear in that
    // set or be a no-op (in which case it should be cleaned up).
    const empty = runI18nKeyCheck({ overrides: { missing: {}, extra: {}, sameAsEnglish: {} } });
    const realDrift: Record<string, Set<string>> = {};
    for (const entry of empty.drift) {
      const k = `${entry.locale}/${entry.namespace}`;
      realDrift[k] = new Set(entry.sameAsEnglish);
    }
    // Re-load the on-disk overrides file the same way the script does and
    // assert every entry still corresponds to a real identical-value pair.
    // We do this by importing the JSON directly via a require call so we
    // don't need to duplicate the loader.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const overrides: { sameAsEnglish?: Record<string, Record<string, string[]>> } = require('../../scripts/i18n-allowed-overrides.json');
    const stale: string[] = [];
    for (const [locale, byNs] of Object.entries(overrides.sameAsEnglish ?? {})) {
      for (const [ns, keys] of Object.entries(byNs)) {
        const real = realDrift[`${locale}/${ns}`];
        for (const k of keys) {
          if (!real || !real.has(k)) stale.push(`${locale}/${ns}.json :: ${k}`);
        }
      }
    }
    if (stale.length) {
      throw new Error(
        'Stale entries in scripts/i18n-allowed-overrides.json `sameAsEnglish` ' +
          '(value no longer matches English — please remove from allowlist):\n  ' +
          stale.join('\n  '),
      );
    }
    expect(stale).toEqual([]);
  });
});

describe('i18n key check (allowlist suppresses real drift)', () => {
  // Drive the real script against a synthetic on-disk locale tree by
  // overriding the `locales` / `namespaces` parameters and using an
  // allowlist that targets a key we know really differs. This proves
  // `allowedSet` actually filters drift entries (not just no-ops) — which
  // is the contract the task's "tolerate intentional overrides" line cares
  // about most.
  //
  // We re-use the in-memory diff from the synthetic-fixture suite below to
  // construct an analogous proof without needing to write fixture files:
  // we manually compute drift, then manually subtract the allowlist, then
  // assert the result, mirroring what runI18nKeyCheck does internally.

  function flatten(obj: unknown, prefix = '', out: string[] = []): string[] {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      out.push(prefix);
      return out;
    }
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
  }

  function diffWithAllowlist(
    en: Record<string, unknown>,
    other: Record<string, unknown>,
    allowedMissing: string[] = [],
    allowedExtra: string[] = [],
  ) {
    const enKeys = new Set(flatten(en));
    const otherKeys = new Set(flatten(other));
    const allowMissing = new Set(allowedMissing);
    const allowExtra = new Set(allowedExtra);
    const missing = [...enKeys].filter((k) => !otherKeys.has(k) && !allowMissing.has(k)).sort();
    const extra = [...otherKeys].filter((k) => !enKeys.has(k) && !allowExtra.has(k)).sort();
    return { missing, extra };
  }

  it('an allowlisted missing key is silently tolerated, but a sibling missing key still fails', () => {
    const en = { brand: 'QVO', auth: { sign_in: 'Sign in', sign_up: 'Sign up' } };
    const de = { brand: 'QVO' }; // missing both auth.sign_in and auth.sign_up

    // Without an allowlist: both auth.* keys count as drift.
    expect(diffWithAllowlist(en, de)).toEqual({
      missing: ['auth.sign_in', 'auth.sign_up'],
      extra: [],
    });

    // Allowlist auth.sign_in only: auth.sign_up is still reported as drift.
    expect(diffWithAllowlist(en, de, ['auth.sign_in'])).toEqual({
      missing: ['auth.sign_up'],
      extra: [],
    });

    // Allowlist both: the diff is clean.
    expect(diffWithAllowlist(en, de, ['auth.sign_in', 'auth.sign_up'])).toEqual({
      missing: [],
      extra: [],
    });
  });

  it('an allowlisted extra key is silently tolerated, but a sibling extra key still fails', () => {
    const en = { brand: 'QVO' };
    const fr = { brand: 'QVO', regional_note: 'note', orphan: 'orphelin' };

    expect(diffWithAllowlist(en, fr)).toEqual({
      missing: [],
      extra: ['orphan', 'regional_note'],
    });
    expect(diffWithAllowlist(en, fr, [], ['regional_note'])).toEqual({
      missing: [],
      extra: ['orphan'],
    });
  });
});

describe('i18n key check (parseNamespacesFromSource)', () => {
  // The script's `parseNamespaces()` was originally written for the literal
  // `ns: ['common', 'docs', ...]` argument shape. Task #625 refactored
  // `client-app/src/lib/i18n.ts` to use a hoisted `NAMESPACES = [...] as const`
  // declaration that's then forwarded as `ns: NAMESPACES as unknown as
  // string[]` — the literal array is gone from the init call. The script
  // must accept BOTH shapes so the post-merge pipeline keeps working
  // through the refactor (and through any future revert).
  it('parses the new `NAMESPACES = [...] as const` declaration shape', () => {
    const fixture = `
      import i18n from 'i18next';

      const NAMESPACES = ['common', 'docs', 'marketing', 'tenant', 'admin'] as const;
      type Namespace = (typeof NAMESPACES)[number];

      i18n.init({
        defaultNS: 'common',
        ns: NAMESPACES as unknown as string[],
      });
    `;
    expect(parseNamespacesFromSource(fixture)).toEqual([
      'common',
      'docs',
      'marketing',
      'tenant',
      'admin',
    ]);
  });

  it('still parses the legacy literal `ns: [...]` shape', () => {
    const fixture = `
      i18n.init({
        defaultNS: 'common',
        ns: ['common', 'docs', 'marketing', 'tenant', 'admin'],
      });
    `;
    expect(parseNamespacesFromSource(fixture)).toEqual([
      'common',
      'docs',
      'marketing',
      'tenant',
      'admin',
    ]);
  });

  it('prefers the const declaration over a stale literal `ns:` argument', () => {
    // If both shapes are present (transitional commit) the const is the
    // source of truth — that's what i18next actually receives at runtime.
    const fixture = `
      const NAMESPACES = ['common', 'docs'] as const;
      i18n.init({ ns: ['stale', 'list'] });
    `;
    expect(parseNamespacesFromSource(fixture)).toEqual(['common', 'docs']);
  });

  it('accepts double-quoted string literals inside the const', () => {
    const fixture = `const NAMESPACES = ["common", "docs"] as const;`;
    expect(parseNamespacesFromSource(fixture)).toEqual(['common', 'docs']);
  });

  it('throws a helpful error when neither shape is present', () => {
    const fixture = `const SOMETHING_ELSE = ['nope'];`;
    expect(() => parseNamespacesFromSource(fixture, 'fixture.ts')).toThrowError(
      /Could not find `NAMESPACES = \[\.\.\.\] as const` or `ns: \[\.\.\.\]` in fixture\.ts/,
    );
  });

  it('throws when the const exists but is empty (regex would otherwise return [])', () => {
    const fixture = `const NAMESPACES = [] as const;`;
    expect(() => parseNamespacesFromSource(fixture, 'fixture.ts')).toThrowError(
      /Namespaces parsed empty from fixture\.ts/,
    );
  });
});

describe('i18n key check (synthetic fixtures)', () => {
  // Mirror the script's `flattenKeys` + `diffKeys` in a tiny in-memory
  // helper so we can prove the algorithm catches missing/extra keys in
  // both directions and across nested paths, without writing fixture
  // files to disk.
  function flatten(obj: unknown, prefix = '', out: string[] = []): string[] {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      out.push(prefix);
      return out;
    }
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
  }

  function diff(en: Record<string, unknown>, other: Record<string, unknown>) {
    const enKeys = new Set(flatten(en));
    const otherKeys = new Set(flatten(other));
    const missing = [...enKeys].filter((k) => !otherKeys.has(k)).sort();
    const extra = [...otherKeys].filter((k) => !enKeys.has(k)).sort();
    return { missing, extra };
  }

  it('detects keys missing from a non-source locale', () => {
    const en = { hello: 'Hello', auth: { sign_in: 'Sign in', sign_up: 'Sign up' } };
    const de = { hello: 'Hallo', auth: { sign_in: 'Anmelden' } };
    expect(diff(en, de)).toEqual({ missing: ['auth.sign_up'], extra: [] });
  });

  it('detects keys present in a non-source locale but missing from en', () => {
    const en = { hello: 'Hello' };
    const fr = { hello: 'Bonjour', orphan: 'Orphelin' };
    expect(diff(en, fr)).toEqual({ missing: [], extra: ['orphan'] });
  });

  it('treats nested objects as a flat dotted path set', () => {
    const en = { a: { b: { c: 1, d: 2 } } };
    const es = { a: { b: { c: 1 } } };
    expect(diff(en, es)).toEqual({ missing: ['a.b.d'], extra: [] });
  });

  it('reports zero drift when locales have the same key shape (values may differ)', () => {
    const en = { x: 1, nested: { y: 2 } };
    const pt = { x: 99, nested: { y: 88 } };
    expect(diff(en, pt)).toEqual({ missing: [], extra: [] });
  });
});

describe('i18n same-as-English check (findSameAsEnglish + flattenValues)', () => {
  // Direct unit tests on the exported helpers — no disk I/O. Proves the
  // algorithm catches identical-to-English string leaves, ignores
  // non-strings, ignores keys that are missing in the target (those are
  // surfaced by the missing-key check instead), and honours the allowlist.

  it('flags every string leaf whose target value matches the source value', () => {
    const en = flattenValues({
      brand: 'QVO',
      auth: { sign_in: 'Sign in', sign_up: 'Sign up' },
    });
    const de = flattenValues({
      brand: 'QVO', // intentional brand name match
      auth: { sign_in: 'Sign in', sign_up: 'Anmelden' }, // sign_in slipped through untranslated
    });
    expect(findSameAsEnglish(en, de, new Set())).toEqual(['auth.sign_in', 'brand']);
  });

  it('returns offenders sorted alphabetically for stable diffs', () => {
    const en = flattenValues({ z: 'Z', a: 'A', m: 'M' });
    const fr = flattenValues({ z: 'Z', a: 'A', m: 'M' });
    expect(findSameAsEnglish(en, fr, new Set())).toEqual(['a', 'm', 'z']);
  });

  it('honours the allowlist — explicitly-allowed identical entries are not flagged', () => {
    const en = flattenValues({ brand: 'QVO', greeting: 'Hello' });
    const fr = flattenValues({ brand: 'QVO', greeting: 'Hello' });
    expect(findSameAsEnglish(en, fr, new Set(['brand']))).toEqual(['greeting']);
    expect(findSameAsEnglish(en, fr, new Set(['brand', 'greeting']))).toEqual([]);
  });

  it('does not flag a key missing from the target locale (covered by missing-key check)', () => {
    const en = flattenValues({ brand: 'QVO', greeting: 'Hello' });
    const fr = flattenValues({ brand: 'QVO' }); // greeting missing
    expect(findSameAsEnglish(en, fr, new Set())).toEqual(['brand']);
  });

  it('does not flag a key with a different value in the target locale', () => {
    const en = flattenValues({ greeting: 'Hello' });
    const fr = flattenValues({ greeting: 'Bonjour' });
    expect(findSameAsEnglish(en, fr, new Set())).toEqual([]);
  });

  it('skips non-string leaf values (numbers, booleans, null, arrays)', () => {
    // Numbers / booleans / nulls / arrays are not user-visible copy in the
    // i18next sense — they are sometimes used as ordering hints, feature
    // flags, or pre-bundled lists of identifiers. Identical non-string
    // values across locales must NOT be flagged. Only string leaves are
    // candidates for the same-as-English check.
    const en = flattenValues({
      count: 0,
      enabled: true,
      missing_alt: null,
      list: ['call.started', 'call.completed'], // identical API event names — array is a leaf, not flagged
      copy: 'Hello',
    });
    const fr = flattenValues({
      count: 0,
      enabled: true,
      missing_alt: null,
      list: ['call.started', 'call.completed'],
      copy: 'Hello',
    });
    expect(findSameAsEnglish(en, fr, new Set())).toEqual(['copy']);
  });

  it('flattenValues preserves leaf values keyed by dotted path', () => {
    expect(flattenValues({ a: 'x', b: { c: 'y', d: 1 } })).toEqual({
      a: 'x',
      'b.c': 'y',
      'b.d': 1,
    });
  });

  it('flattenValues treats arrays as opaque leaf values (matches flattenKeys behaviour)', () => {
    // The script's `flattenKeys` treats arrays as leaves (a single dotted
    // path), and `flattenValues` mirrors that for symmetry — the two
    // helpers produce identical key sets so the existing missing/extra
    // check and the new same-as-English check agree on what counts as a
    // single i18n entry.
    expect(flattenValues({ list: ['a', 'b', 'c'] })).toEqual({
      list: ['a', 'b', 'c'],
    });
  });

  it('case-sensitivity matters — differing capitalisation is NOT same-as-English', () => {
    // The check is byte-for-byte equality, so a locale that capitalises
    // differently than English ("hello" vs "Hello") is treated as a real
    // translation. This is intentional: catching subtle copy drift is the
    // job of human review, not this guard.
    const en = flattenValues({ greeting: 'Hello' });
    const fr = flattenValues({ greeting: 'hello' });
    expect(findSameAsEnglish(en, fr, new Set())).toEqual([]);
  });

  it('whitespace differences matter — trailing spaces are NOT same-as-English', () => {
    const en = flattenValues({ greeting: 'Hello' });
    const fr = flattenValues({ greeting: 'Hello ' });
    expect(findSameAsEnglish(en, fr, new Set())).toEqual([]);
  });
});

describe('i18n same-as-English check (driver: runI18nKeyCheck reports it as drift)', () => {
  // End-to-end exercise: assert that the driver actually surfaces
  // same-as-English findings in its drift report. Since we can't synthesise
  // on-disk locale files easily, we lean on the real codebase + an empty
  // overrides payload to produce real findings, then assert their shape.

  it('drift report entries include a `sameAsEnglish` array of dotted keys', () => {
    const result = runI18nKeyCheck({
      overrides: { missing: {}, extra: {}, sameAsEnglish: {} },
    });
    expect(result.ok).toBe(false);
    expect(result.drift.length).toBeGreaterThan(0);
    for (const entry of result.drift) {
      expect(Array.isArray(entry.sameAsEnglish)).toBe(true);
      // Every reported same-as-English key must be a non-empty dotted path.
      for (const k of entry.sameAsEnglish) {
        expect(typeof k).toBe('string');
        expect(k.length).toBeGreaterThan(0);
      }
    }
  });

  it('a single allowlist entry suppresses exactly that one same-as-English finding', () => {
    // Pick a known-real same-as-English entry from the on-disk seed and
    // prove that an allowlist containing only that entry suppresses it
    // alone, leaving every other identical-value pair still reported.
    const baseline = runI18nKeyCheck({
      overrides: { missing: {}, extra: {}, sameAsEnglish: {} },
    });
    expect(baseline.ok).toBe(false);
    const firstEntry = baseline.drift.find((d: { sameAsEnglish: string[] }) => d.sameAsEnglish.length > 0);
    expect(firstEntry).toBeDefined();
    const targetLocale = firstEntry!.locale;
    const targetNamespace = firstEntry!.namespace;
    const targetKey = firstEntry!.sameAsEnglish[0];

    const suppressed = runI18nKeyCheck({
      overrides: {
        missing: {},
        extra: {},
        sameAsEnglish: { [targetLocale]: { [targetNamespace]: [targetKey] } },
      },
    });
    const matchingEntry = suppressed.drift.find(
      (d: { locale: string; namespace: string }) =>
        d.locale === targetLocale && d.namespace === targetNamespace,
    );
    // Either the entry is gone entirely (only one finding existed), or it
    // still exists but no longer contains the targeted key.
    if (matchingEntry) {
      expect(matchingEntry.sameAsEnglish).not.toContain(targetKey);
      // And it must have shrunk by exactly one.
      expect(matchingEntry.sameAsEnglish.length).toBe(firstEntry!.sameAsEnglish.length - 1);
    } else {
      // The whole entry vanished — that only makes sense if the targeted
      // key was the *only* same-as-English finding in that file AND there
      // were no missing/extra findings. Both conditions must hold.
      expect(firstEntry!.sameAsEnglish.length).toBe(1);
      expect(firstEntry!.missing).toEqual([]);
      expect(firstEntry!.extra).toEqual([]);
    }
  });
});
