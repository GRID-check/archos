import { getCollection, type CollectionEntry } from 'astro:content';
import type { Locale } from '../i18n/paths';
import { blogPath, type Category } from './categories';

export type BlogPost = CollectionEntry<'blog'>;

/**
 * Preview builds render drafts. Set only for a local preview
 * (`PUBLIC_INCLUDE_DRAFTS=1 bun run build`), never by a release build: a truthy value there would publish every unfinished draft.
 */
const includeDrafts = import.meta.env.PUBLIC_INCLUDE_DRAFTS === '1';

/** `de/mein-post` -> `mein-post`. */
export function postSlug(id: string) {
  return id.slice(3);
}

/** Posts for one locale, newest first, drafts hidden outside preview builds. */
export async function getBlogPosts(locale: Locale, category?: Category) {
  const posts = await getCollection('blog', ({ id, data }) =>
    (includeDrafts || !data.draft) &&
    id.startsWith(`${locale}/`) &&
    (!category || data.category === category),
  );
  return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

/** Dates as the blog prints them: long form, in the locale's own order. */
export function formatDate(date: Date, locale: Locale) {
  return date.toLocaleDateString(locale === 'en' ? 'en-GB' : 'de-AT', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** The URL of a post in `locale`: `/blog/<slug>/` or `/en/blog/<slug>/`. */
export function postPath(locale: Locale, post: BlogPost) {
  return `${blogPath(locale)}${postSlug(post.id)}/`;
}
