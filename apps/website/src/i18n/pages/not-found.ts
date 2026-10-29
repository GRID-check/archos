/**
 * Copy of the page shown for an address that does not exist, both locales.
 * `{name}` is the brand name, filled by `withName`.
 */
const de = {
  title: 'Seite nicht gefunden',
  description: 'Diese Seite gibt es nicht oder nicht mehr.',
  hero: {
    title: 'Diese Seite gibt es nicht.',
    text: 'Vielleicht hat sich die Adresse geändert, oder sie war nie richtig. Von der Startseite aus finden Sie alles, was {name} anbietet.',
  },
  home: 'Zur Startseite',
  contact: 'Kontakt aufnehmen',
};

const en: typeof de = {
  title: 'Page not found',
  description: 'This page does not exist, or no longer does.',
  hero: {
    title: 'This page does not exist.',
    text: 'The address may have changed, or it was never quite right. The home page leads to everything {name} offers.',
  },
  home: 'Go to the home page',
  contact: 'Get in touch',
};

export default { de, en };
