import { germanToEnglishPath, englishToGermanPath } from './paths'
import { ui, defaultLang, showDefaultLang, languages, type Locale } from './ui'

export function getLangFromUrl(url: URL): Locale {
  const [, lang] = url.pathname.split('/')
  if (lang in languages) return lang as Locale
  return defaultLang
}

export function useTranslations(lang: Locale) {
  return ui[lang]
}

export function useTranslatedPath(lang: Locale) {
  return function translatePath(path: string, l: Locale = lang) {
    return getLocalizedPath(path, l)
  }
}

/** Any page's path as the German site spells it: the `/en` prefix gone, an English segment turned back into its German one. */
export function getPathWithoutLocale(pathname: string): string {
  return englishToGermanPath(pathname.replace(/^\/en(?=\/|$)/, '') || '/')
}

/** A German path (`/vergleich/`) in `lang`: the English site gets its prefix and its own segment (`/en/comparisons/`). */
export function getLocalizedPath(path: string, lang: Locale): string {
  if (!showDefaultLang && lang === defaultLang) return path
  return `/${lang}${lang === 'en' ? germanToEnglishPath(path) : path}`
}
