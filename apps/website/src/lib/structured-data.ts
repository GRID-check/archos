/**
 * JSON-LD for every page: the organisation behind the site and the site itself
 * (schema.org `Organization` and `WebSite`), linked by `@id`. Every string comes
 * from identity.json, so a rename needs no edit here. Rendered by BaseLayout.
 */
import type { Locale } from '../i18n/paths';
import identity from './identity';
import { socialProfiles } from './social';

export function siteGraph(site: URL, locale: Locale) {
  const home = new URL('/', site).href;
  const organization = `${home}#organization`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': organization,
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
        publisher: { '@id': organization },
      },
    ],
  };
}

/**
 * The graph as text for a `<script type="application/ld+json">`. `<` is escaped
 * so no string can close the script element.
 */
export function jsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
