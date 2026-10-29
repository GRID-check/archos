import rss from '@astrojs/rss';
import copy from '../i18n/pages/blog';
import type { Locale } from '../i18n/paths';
import { t } from '../i18n/ui';
import { CATEGORIES, blogPath } from './categories';
import identity from './identity';
import { getBlogPosts, postPath } from './posts';

/**
 * The blog of one locale as RSS 2.0 (`@astrojs/rss`), both strands, newest first, at the
 * old site's feed addresses (`/rss.xml`, `/en/rss.xml`) so subscribers keep their feed.
 * Items carry title, link, date, description and category; drafts never appear.
 */
export async function blogFeed(locale: Locale, site: URL | undefined) {
  const posts = await getBlogPosts(locale);
  return rss({
    title: t(locale).rssTitle,
    description: copy[locale].hero.text,
    // The channel's <link> is the listing; item links are absolute paths.
    site: new URL(blogPath(locale), site ?? `https://${identity.domain}`).href,
    trailingSlash: true,
    customData: `<language>${locale === 'de' ? 'de-at' : 'en'}</language>`,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: postPath(locale, post),
      categories: [CATEGORIES[locale][post.data.category].label],
    })),
  });
}
