/**
 * Copy of the page shown for an address that does not exist, both locales, and of
 * its variant for an old address removed on purpose (status 410, see redirects.mjs).
 * `{name}` is the brand name, filled by `withName`.
 */
const de = {
  title: 'Seite nicht gefunden',
  description: 'Diese Seite gibt es nicht oder nicht mehr.',
  hero: {
    title: 'Diese Seite gibt es nicht.',
    text: 'Vielleicht hat sich die Adresse geändert, oder sie war nie richtig. Von der Startseite aus finden Sie alles, was {name} anbietet.',
  },
  gone: {
    title: 'Diese Seite gibt es nicht mehr.',
    text: 'Wir haben sie bewusst entfernt, und keine andere Seite tritt an ihre Stelle. Von der Startseite aus finden Sie alles, was {name} heute anbietet.',
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
  gone: {
    title: 'This page no longer exists.',
    text: 'We removed it on purpose, and no other page takes its place. The home page leads to everything {name} offers today.',
  },
  home: 'Go to the home page',
  contact: 'Get in touch',
};

export default { de, en };
