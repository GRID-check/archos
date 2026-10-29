import identity from '../lib/identity';

/**
 * Blog index copy. The reference carries bracketed placeholders for each card's teaser, date and
 * image, so only the titles are set here; add `text`, `date` and `image` when the copy exists.
 */
export interface Post {
  title: string;
  href: string;
  text?: string;
  date?: string;
  image?: string;
  imageAlt?: string;
}

export const blogHero = {
  title: 'Aktuelles aus Planung und Technologie.',
  text: 'Neue Funktionen, Entwicklungen in KI und Planung und Erfahrungen aus führenden Planungsbüros.',
};

export const postFilters: { label: string; current?: boolean }[] = [
  { label: 'Alle', current: true },
  { label: 'Produktfeatures' },
  { label: 'Praxiserfahrungen' },
  { label: 'Technologie' },
];

export const posts: Post[] = [
  { title: `Baurecht durchsuchen: Wie ${identity.name} jede Antwort belegt`, href: '#' },
  { title: 'Planstände vergleichen in der Entwurfsphase', href: '#' },
  { title: 'Pläne lesen statt Text: Wo die Modelle heute stehen', href: '#' },
  { title: `Warum ${identity.name} keine Entwürfe generiert`, href: '#' },
  { title: 'Wo die Daten Ihres Büros liegen', href: '#' },
  { title: 'Vom Projektwissen zur Projektintelligenz', href: '#' },
];

export const moreLabel = 'Weitere Beiträge';
