/**
 * Copy of the blog index, both locales. `{name}` is the brand name, filled by `withName`.
 * Post titles only: each card's teaser, date and image are added here when the copy exists.
 */
const de = {
  title: 'Blog',
  hero: {
    title: 'Aktuelles aus Planung und Technologie.',
    text: 'Neue Funktionen, Entwicklungen in KI und Planung und Erfahrungen aus führenden Planungsbüros.',
  },
  filterLabel: 'Beiträge filtern',
  filters: ['Alle', 'Produktfeatures', 'Praxiserfahrungen', 'Technologie'],
  posts: [
    'Baurecht durchsuchen: Wie {name} jede Antwort belegt',
    'Planstände vergleichen in der Entwurfsphase',
    'Pläne lesen statt Text: Wo die Modelle heute stehen',
    'Warum {name} keine Entwürfe generiert',
    'Wo die Daten Ihres Büros liegen',
    'Vom Projektwissen zur Projektintelligenz',
  ],
  more: 'Weitere Beiträge',
};

const en: typeof de = {
  title: 'Blog',
  hero: {
    title: 'News from planning and technology.',
    text: 'New features, developments in AI and planning, and experience from leading planning firms.',
  },
  filterLabel: 'Filter posts',
  filters: ['All', 'Product features', 'Practical experience', 'Technology'],
  posts: [
    'Searching building law: how {name} sources every answer',
    'Comparing plan states in the design phase',
    'Reading plans instead of text: where the models stand today',
    'Why {name} does not generate designs',
    'Where your office’s data is kept',
    'From project knowledge to project intelligence',
  ],
  more: 'More posts',
};

export default { de, en };
