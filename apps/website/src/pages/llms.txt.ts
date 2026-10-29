import type { APIRoute } from 'astro';
import buildingLaw from '../i18n/pages/building-law';
import firms from '../i18n/pages/firms';
import home from '../i18n/pages/home';
import llms from '../i18n/pages/llms';
import revisions from '../i18n/pages/revisions';
import security from '../i18n/pages/security';
import { ROUTES, type Locale } from '../i18n/paths';
import identity, { withName } from '../lib/identity';
import { getBlogPosts, postPath } from '../lib/posts';

// /llms.txt (llmstxt.org): what the site is, its product pages and its newest posts, in
// plain Markdown. Generated from identity and the page copy at build time, so it cannot
// drift from the pages. Kept short on purpose: answer engines rank from the HTML and the
// JSON-LD; this file only spares them the guesswork.
export const prerender = true;

type PageCopy = Record<Locale, { title: string; description: string }>;

const PRODUCT_PAGES: { path: Record<Locale, string>; copy: PageCopy }[] = [
  { path: ROUTES.home, copy: { de: home.de.meta, en: home.en.meta } },
  { path: ROUTES.firms, copy: firms },
  { path: ROUTES.buildingLaw, copy: buildingLaw },
  { path: ROUTES.revisions, copy: revisions },
  { path: ROUTES.security, copy: security },
];

export const GET: APIRoute = async ({ site }) => {
  const base = site ?? new URL(`https://${identity.domain}`);
  const line = (title: string, path: string, description: string) =>
    `- [${withName(title)}](${new URL(path, base).href}): ${withName(description)}`;
  const pages = (locale: Locale) =>
    PRODUCT_PAGES.map((page) => line(page.copy[locale].title, page.path[locale], page.copy[locale].description));
  const posts = async (locale: Locale) =>
    (await getBlogPosts(locale)).slice(0, 10).map((post) => line(post.data.title, postPath(locale, post), post.data.description));
  const c = withName(llms.de);
  const en = withName(llms.en);

  const text = [
    `# ${identity.name}`,
    '',
    `> ${c.summary}`,
    '',
    `${c.language} ${c.seat}: ${identity.city}. ${c.contact}: ${identity.email}`,
    '',
    `## ${c.product}`,
    ...pages('de'),
    '',
    `## ${c.blog}`,
    ...(await posts('de')),
    '',
    `## ${c.optional}`,
    '',
    `${en.english}: ${en.summary}`,
    '',
    ...pages('en'),
    ...(await posts('en')),
    '',
  ].join('\n');

  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
