/**
 * Copy of the blog, both locales. The listing's labels and the post page's
 * strings. Category names and descriptors live in src/lib/categories.ts.
 */
const de = {
  title: 'Blog',
  hero: {
    title: 'Aktuelles aus Planung und Technologie.',
    text: 'Neue Funktionen, Entwicklungen in KI und Planung und Erfahrungen aus führenden Planungsbüros.',
  },
  filterLabel: 'Beiträge filtern',
  filterAll: 'Alle',
  backToBlog: 'Zurück zum Blog',
};

const en: typeof de = {
  title: 'Blog',
  hero: {
    title: 'News from planning and technology.',
    text: 'New features, developments in AI and planning, and experience from leading planning firms.',
  },
  filterLabel: 'Filter posts',
  filterAll: 'All',
  backToBlog: 'Back to the blog',
};

export default { de, en };
