/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { localeFromAcceptLanguage, pickRequestLocale } from './request-locale'

const GERMAN_BROWSER = 'de-AT,de;q=0.9,en;q=0.8'

describe('pickRequestLocale', () => {
  it('answers a signed-in request in the saved language, whatever the cookie says', () => {
    // The pilot case: a stale `en` cookie from the old reconciliation, a German
    // browser, and a person (or office) who chose German.
    expect(
      pickRequestLocale({ saved: { known: true, locale: 'de' }, cookie: 'en', acceptLanguage: 'en-US' })
    ).toBe('de')
    expect(pickRequestLocale({ saved: { known: true, locale: 'en' }, cookie: 'de', acceptLanguage: GERMAN_BROWSER })).toBe(
      'en'
    )
  })

  it('answers a signed-in request that saved nothing in the browser’s language, not the stale cookie', () => {
    expect(
      pickRequestLocale({ saved: { known: true, locale: null }, cookie: 'en', acceptLanguage: GERMAN_BROWSER })
    ).toBe('de')
    expect(pickRequestLocale({ saved: { known: true, locale: null }, cookie: 'de', acceptLanguage: null })).toBe('en')
  })

  it('lets the cookie stand in when the saved facts cannot be read', () => {
    expect(pickRequestLocale({ saved: { known: false }, cookie: 'de', acceptLanguage: 'en-US' })).toBe('de')
    expect(pickRequestLocale({ saved: { known: false }, cookie: 'fr', acceptLanguage: GERMAN_BROWSER })).toBe('de')
    expect(pickRequestLocale({ saved: { known: false }, cookie: undefined, acceptLanguage: undefined })).toBe('en')
  })
})

describe('localeFromAcceptLanguage', () => {
  it('takes the first supported language in the header’s order', () => {
    expect(localeFromAcceptLanguage('fr-FR,de-AT;q=0.8,en;q=0.5')).toBe('de')
    expect(localeFromAcceptLanguage('DE-at')).toBe('de')
    expect(localeFromAcceptLanguage('fr,it')).toBeNull()
    expect(localeFromAcceptLanguage('')).toBeNull()
  })
})
