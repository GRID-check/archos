/**
 * The blog's two strands, defined once. The content schema, the listing routes
 * and the filter row read this file, so adding a category here is the whole
 * change on the data side.
 *
 * Kept free of runtime imports except the brand name: content.config.ts loads
 * it while Astro builds the collection.
 */
import type { Locale } from '../i18n/paths';
import { withName } from './identity';

/** Stored in each post's frontmatter as `category`, and used as the URL segment. */
export const CATEGORY_IDS = ['journal', 'bautagebuch'] as const;
export type Category = (typeof CATEGORY_IDS)[number];

interface CategoryCopy {
  /** Filter label and listing heading. */
  label: string;
  /** One line under the heading: who the strand is for. */
  descriptor: string;
}

// `{name}` is the brand name, filled by withName.
export const CATEGORIES: Record<Locale, Record<Category, CategoryCopy>> = withName({
  de: {
    journal: {
      label: 'Journal',
      descriptor: 'Für Büros: Planungspraxis, Baurecht und was {name} im Alltag ändert.',
    },
    bautagebuch: {
      label: 'Bautagebuch',
      descriptor: 'Notizen aus der Entwicklung: wie {name} gebaut ist und warum.',
    },
  },
  en: {
    journal: {
      label: 'Journal',
      descriptor: 'For offices: planning practice, building law and what {name} changes day to day.',
    },
    bautagebuch: {
      label: 'Build log',
      descriptor: 'Notes from development: how {name} is built, and why.',
    },
  },
});

/** `/blog/` or `/blog/bautagebuch/`, prefixed with `/en` for English. */
export function blogPath(locale: Locale, category?: Category) {
  const base = locale === 'en' ? '/en/blog/' : '/blog/';
  return category ? `${base}${category}/` : base;
}
