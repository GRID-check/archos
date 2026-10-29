/**
 * Copy of /llms.txt, the short plain-text summary of the site for answer engines
 * (src/pages/llms.txt.ts). German first, one English block. `{name}` is the brand name,
 * filled by `withName`. The page list reuses each page's own title and description.
 */
const de = {
  summary:
    '{name} ist der Workspace für Architektur- und Planungsbüros. Pläne, Modelle, Unterlagen und Bürowissen liegen an einem Ort. {name} durchsucht Baurecht, vergleicht Planstände und prüft Modelle. Planer:innen entwerfen und entscheiden. {name} erzeugt keine Entwürfe.',
  language: 'Sprache: Deutsch, Englisch unter /en/.',
  seat: 'Sitz',
  contact: 'Kontakt',
  product: 'Produkt',
  blog: 'Blog',
  optional: 'Optional',
  english: 'Englische Fassung der Website',
};

const en: typeof de = {
  summary:
    '{name} is the workspace for architecture and planning firms. Plans, models, documents and office knowledge sit in one place. {name} searches building law, compares plan revisions and checks models. Planners design and decide. {name} does not generate designs.',
  language: 'Language: German, English under /en/.',
  seat: 'Based in',
  contact: 'Contact',
  product: 'Product',
  blog: 'Blog',
  optional: 'Optional',
  english: 'English version of the website',
};

export default { de, en };
