/**
 * JSON-LD (schema.org) for the pages. Every page carries the organisation behind the
 * site and the site itself (`Organization`, `WebSite`), linked by `@id`; a page adds
 * its own nodes: `BreadcrumbList` on every inner page, `FAQPage` where an FAQ renders
 * (built from the same items the component shows, so the two cannot drift),
 * `SoftwareApplication` on the home page, `BlogPosting` on a post. Every brand string
 * comes from identity.json, so a rename needs no edit here. Rendered by BaseLayout.
 *
 * Belegpflicht holds here too: no `offers` (there is no public price) and no
 * `aggregateRating` (there are no public reviews).
 */
import type { Locale } from '../i18n/paths';
import identity from './identity';
import { socialProfiles } from './social';

/** One node of the graph. */
export type GraphNode = Record<string, unknown>;

const homeUrl = (site: URL) => new URL('/', site).href;
const organizationId = (site: URL) => `${homeUrl(site)}#organization`;

export function siteGraph(site: URL, locale: Locale, nodes: GraphNode[] = []) {
  const home = homeUrl(site);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': organizationId(site),
        name: identity.name,
        legalName: identity.legalEntity,
        slogan: identity.tagline,
        url: home,
        logo: new URL('/icons/icon-512.png', site).href,
        email: identity.email,
        address: {
          '@type': 'PostalAddress',
          streetAddress: identity.street,
          postalCode: identity.postalCode,
          addressLocality: identity.city,
          addressCountry: identity.country,
        },
        ...(socialProfiles.length ? { sameAs: socialProfiles } : {}),
      },
      {
        '@type': 'WebSite',
        '@id': `${home}#website`,
        name: identity.name,
        url: home,
        inLanguage: locale,
        publisher: { '@id': organizationId(site) },
      },
      ...nodes,
    ],
  };
}

/** The product, on the home page. `description` is the page's own, in planning language. */
export function softwareApplication(site: URL, locale: Locale, description: string, path: string): GraphNode {
  return {
    '@type': 'SoftwareApplication',
    '@id': `${homeUrl(site)}#software`,
    name: identity.name,
    description,
    url: new URL(path, site).href,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    inLanguage: locale,
    publisher: { '@id': organizationId(site) },
  };
}

/** A crumb: the page's name and its path. */
export interface Crumb {
  name: string;
  path: string;
}

/** Start › … › this page. */
export function breadcrumbList(site: URL, crumbs: Crumb[]): GraphNode {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: crumb.name,
      item: new URL(crumb.path, site).href,
    })),
  };
}

/** The questions an FAQ component renders on the page. */
export function faqPage(site: URL, path: string, items: { q: string; a: string }[]): GraphNode {
  return {
    '@type': 'FAQPage',
    url: new URL(path, site).href,
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };
}

/** A blog post, from its frontmatter (no schema change: `dateModified` is `pubDate` until a post has an update date). */
export function blogPosting(
  site: URL,
  post: { headline: string; description: string; path: string; published: Date; locale: Locale; section: string },
): GraphNode {
  const url = new URL(post.path, site).href;
  return {
    '@type': 'BlogPosting',
    headline: post.headline,
    description: post.description,
    url,
    mainEntityOfPage: url,
    datePublished: post.published.toISOString(),
    dateModified: post.published.toISOString(),
    inLanguage: post.locale,
    articleSection: post.section,
    image: new URL('/media/share-card.jpg', site).href,
    author: { '@id': organizationId(site) },
    publisher: { '@id': organizationId(site) },
  };
}

/**
 * The graph as text for a `<script type="application/ld+json">`. `<` is escaped
 * so no string can close the script element.
 */
export function jsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
