/**
 * The route-fate table (redirects.mjs) against the pages this site builds: every 301 lands
 * on a page in one hop, no live page is redirected away, and the plan's rows are there.
 * The built server is asked the same in scripts/check-route-fates.mjs (`bun run check:routes`).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PENDING_TARGETS, ROUTE_FATES, fateOf, redirects } from '../../redirects.mjs';
import { ROUTES } from '../i18n/paths';
import { CATEGORY_IDS } from './categories';

const CONTENT = join(import.meta.dir, '../content/blog');

/** Every path the build serves as a page or a file an old address may land on. */
function livePaths(): Set<string> {
  const live = new Set<string>(['/sign-in', '/llms.txt']);
  for (const route of Object.values(ROUTES)) {
    live.add(route.de);
    live.add(route.en);
  }
  for (const [locale, base] of [['de', '/blog/'], ['en', '/en/blog/']] as const) {
    for (const category of CATEGORY_IDS) live.add(`${base}${category}/`);
    for (const file of readdirSync(join(CONTENT, locale))) {
      if (/^draft:\s*true$/m.test(readFileSync(join(CONTENT, locale, file), 'utf8'))) continue;
      live.add(`${base}${file.replace(/\.mdx$/, '')}/`);
    }
  }
  return live;
}

const live = livePaths();
const trim = (path: string) => (path.length > 1 ? path.replace(/\/$/, '') : path);
const liveTrimmed = new Set([...live].map(trim));

describe('route fates', () => {
  test('every 301 lands on a page that exists (or one other work is adding)', () => {
    for (const [from, to] of ROUTE_FATES) {
      if (to === 'gone') continue;
      expect({ from, ok: live.has(to) || PENDING_TARGETS.has(to) }).toEqual({ from, ok: true });
    }
  });

  test('one hop: no target is itself an old address', () => {
    for (const [from, to] of ROUTE_FATES) {
      if (to === 'gone') continue;
      expect({ from, next: fateOf(to) }).toEqual({ from, next: null });
    }
  });

  test('no page that exists is redirected or gone', () => {
    for (const from of ROUTE_FATES.keys()) expect({ from, live: liveTrimmed.has(from) }).toEqual({ from, live: false });
  });

  test('Astro receives every 301 row as a 301', () => {
    for (const [from, to] of ROUTE_FATES) {
      if (to === 'gone') expect(redirects[from as keyof typeof redirects]).toBeUndefined();
      else expect(redirects[from as keyof typeof redirects]).toEqual({ status: 301, destination: to });
    }
  });

  test('the plan rows, spot-checked', () => {
    const fate = (path: string) => fateOf(path);
    expect(fate('/vergleich/ris-und-google/')).toEqual({ status: 301, location: ROUTES.buildingLaw.de });
    expect(fate('/en/comparisons/chatgpt/')).toEqual({ status: 301, location: ROUTES.firms.en });
    expect(fate('/anwendungen/bueroarchiv/')).toEqual({ status: 301, location: ROUTES.home.de });
    expect(fate('/glossar/gebaeudeklasse/')).toEqual({ status: 301, location: ROUTES.buildingLaw.de });
    expect(fate('/en/building-law/tirol/')).toEqual({ status: 301, location: ROUTES.buildingLaw.en });
    expect(fate('/fuer/architekturbueros/')).toEqual({ status: 301, location: ROUTES.firms.de });
    expect(fate('/neu/')).toEqual({ status: 301, location: '/changelog/' });
    expect(fate('/rechenweg/')).toEqual({ status: 410 });
    expect(fate('/fuer/baumeister-bautraeger/')).toEqual({ status: 410 });
    expect(fate('/bildmaterial/alle.zip')).toEqual({ status: 410 });
    expect(fate('/llms-full.txt')).toEqual({ status: 301, location: '/llms.txt' });
  });

  test('old aliases resolve straight to the final target', () => {
    expect(fateOf('/en/vergleich/perplexity/')).toEqual({ status: 301, location: ROUTES.firms.en });
    expect(fateOf('/en/glossar/ris/')).toEqual({ status: 301, location: ROUTES.buildingLaw.en });
    expect(fateOf('/en/impressum/')).toEqual({ status: 301, location: ROUTES.imprint.en });
    expect(fateOf('/en/rechenweg/')).toEqual({ status: 410 });
    expect(fateOf('/de/kontakt/')).toEqual({ status: 301, location: '/kontakt/' });
    expect(fateOf('/de/')).toEqual({ status: 301, location: '/' });
  });

  test('every detail page of the old site has a fate, in both locales', () => {
    const detail = [...ROUTE_FATES.keys()].filter((path) =>
      /^\/(vergleich|anwendungen|fuer|baurecht|glossar|en\/(comparisons|use-cases|for|building-law|glossary))\/[^/]+$/.test(path),
    );
    // 10 comparisons, 10 use cases, 3 audiences, 9 states, 10 glossary entries, per locale.
    expect(detail.length).toBe(42 * 2);
  });

  test('unknown addresses stay a plain 404', () => {
    expect(fateOf('/does-not-exist/')).toBeNull();
    expect(fateOf('/en/does-not-exist/')).toBeNull();
    expect(fateOf('/baurecht/')).toBeNull();
  });
});
