import { withName } from '../lib/identity';
import type { Locale } from './paths';

/**
 * Shared strings: the shell (header, footer, skip link, language switch) and the
 * labels of shared components. Page copy lives in `pages/<key>.ts`. Both
 * locales have identical keys: `en` is typed as `typeof de`, so a missing key
 * fails `astro check`. The brand name is `{name}`, filled by `withName`.
 */
const de = {
  skipLink: 'Zum Inhalt springen',
  mainNavLabel: 'Hauptnavigation',
  menu: 'Menü',
  menuClose: 'Schließen',
  homeLabel: '{name} – Startseite',
  switchLanguage: 'Sprache wechseln',
  navPlatform: 'Plattform',
  navSecurity: 'Datensicherheit',
  navBlog: 'Blog',
  login: 'Login',
  openApp: 'App öffnen',
  demo: 'Demo anfragen',
  footerProduct: 'Produkt',
  footerKnowledge: 'Wissen',
  footerFunding: 'Gefördert von der aws – Austria Wirtschaftsservice',
  fundingLogoAlt: 'aws – Austria Wirtschaftsservice',
  footerNote: '© {name}',
  impressum: 'Impressum',
  datenschutz: 'Datenschutz',
  kontakt: 'Kontakt',
  galleryCarousel: 'Karussell',
  gallerySlide: 'Folie',
  galleryPosition: '{index} von {count}',
  galleryDot: 'Folie {index}',
  galleryPrevious: 'Vorherige Folie',
  galleryNext: 'Nächste Folie',
  playVideo: 'Video abspielen',
  aiImage: 'KI-generiertes Bild',
};

export type UiCopy = typeof de;

const en: UiCopy = {
  skipLink: 'Skip to content',
  mainNavLabel: 'Main navigation',
  menu: 'Menu',
  menuClose: 'Close',
  homeLabel: '{name} – Home page',
  switchLanguage: 'Switch language',
  navPlatform: 'Platform',
  navSecurity: 'Data security',
  navBlog: 'Blog',
  login: 'Login',
  openApp: 'Open app',
  demo: 'Request a demo',
  footerProduct: 'Product',
  footerKnowledge: 'Knowledge',
  footerFunding: 'Funded by aws – Austria Wirtschaftsservice',
  fundingLogoAlt: 'aws – Austria Wirtschaftsservice',
  footerNote: '© {name}',
  impressum: 'Imprint',
  datenschutz: 'Privacy',
  kontakt: 'Contact',
  galleryCarousel: 'Carousel',
  gallerySlide: 'Slide',
  galleryPosition: '{index} of {count}',
  galleryDot: 'Slide {index}',
  galleryPrevious: 'Previous slide',
  galleryNext: 'Next slide',
  playVideo: 'Play video',
  aiImage: 'AI-generated image',
};

const dictionaries: Record<Locale, UiCopy> = { de, en };

/** The shared strings in `locale`, brand name filled in. */
export function t(locale: Locale): UiCopy {
  return withName(dictionaries[locale]);
}

/** The language code shown by the language switch: the other locale's code is the link text. */
export const localeCodes: Record<Locale, string> = { de: 'DE', en: 'EN' };

/** Fills `{index}`-style placeholders in a string. Brand name is `withName`'s job, not this. */
export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}
