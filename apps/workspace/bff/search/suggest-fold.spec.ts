/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { FOLD_FROM, FOLD_TO, foldForSuggest } from './suggest-fold'

describe('foldForSuggest', () => {
  it('maps every folded character to exactly one, so SQL’s translate() reads the same table', () => {
    expect([...FOLD_FROM]).toHaveLength([...FOLD_TO].length)
    expect(new Set(FOLD_FROM).size).toBe([...FOLD_FROM].length)
  })

  it('drops case and accents, spells ß out, and reads the marks between words as one space', () => {
    expect(foldForSuggest('Ingenieurbüro SÜD')).toBe('ingenieurburo sud')
    expect(foldForSuggest('Hauptstraße')).toBe('hauptstrasse')
    expect(foldForSuggest('ÖNORM B 1600')).toBe('onorm b 1600')
    expect(foldForSuggest('Holz & Statik OG')).toBe('holz statik og')
    expect(foldForSuggest('  EP-05 ')).toBe('ep 05')
    expect(foldForSuggest('1 : 100')).toBe('1 100')
    expect(foldForSuggest('1:100')).toBe('1 100')
  })
})
