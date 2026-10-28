/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import { keepUnitsTogether } from './keep-units'

const NBSP = '\u00A0'

describe('keepUnitsTogether', () => {
  it.each([
    ['Stiege 2, Länge 42,10 m', `Stiege 2, Länge 42,10${NBSP}m`],
    ['max. 40 m bis zum', `max. 40${NBSP}m bis zum`],
    ['Fläche 1,0 m² frei', `Fläche 1,0${NBSP}m² frei`],
    ['Gefälle 2 %', `Gefälle 2${NBSP}%`],
  ])('binds %s', (text, bound) => {
    expect(keepUnitsTogether(text)).toBe(bound)
  })

  it('leaves a figure before a word that only starts like a unit', () => {
    expect(keepUnitsTogether('Stiege 2 mit Podest, 3 tragende Wände')).toBe('Stiege 2 mit Podest, 3 tragende Wände')
  })
})
