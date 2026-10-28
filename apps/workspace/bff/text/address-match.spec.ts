/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { distanceMetres, normalizeAddress } from './address-match'

describe('normalizeAddress', () => {
  it('folds case, ß, diacritics, punctuation and spacing', () => {
    expect(normalizeAddress('Hauptstraße 12, 1010 Wien')).toBe('hauptstrasse 12 1010 wien')
    expect(normalizeAddress('  hauptstrasse   12 1010 WIEN ')).toBe('hauptstrasse 12 1010 wien')
    expect(normalizeAddress('Mödlinger Str. 3, 2340 Mödling')).toBe('modlinger str 3 2340 modling')
  })

  it('keeps different house numbers apart', () => {
    expect(normalizeAddress('Hauptstraße 12, 1010 Wien')).not.toBe(normalizeAddress('Hauptstraße 21, 1010 Wien'))
  })
})

describe('distanceMetres', () => {
  const stephansplatz = { lat: 48.2085, lon: 16.3731 }

  it('is zero for the same point', () => {
    expect(distanceMetres(stephansplatz, stephansplatz)).toBe(0)
  })

  it('measures a few tens of metres', () => {
    // 0.0003 degrees of latitude is about 33 m.
    const near = distanceMetres(stephansplatz, { lat: 48.2088, lon: 16.3731 })
    expect(near).toBeGreaterThan(30)
    expect(near).toBeLessThan(36)
  })

  it('measures Wien to Graz at about 145 km', () => {
    const km = distanceMetres(stephansplatz, { lat: 47.0707, lon: 15.4395 }) / 1000
    expect(km).toBeGreaterThan(140)
    expect(km).toBeLessThan(150)
  })
})
