import { describe, expect, it } from 'vitest'

import { SAVED_SEARCH_NAME_MAX } from '@/lib/search/saved-search-wire'
import { suggestSavedSearchName } from './saved-search-name'

describe('suggestSavedSearchName', () => {
  it('names the search by its words, then its filters in the chips’ order', () => {
    expect(suggestSavedSearchName('Fluchtweg GK 4', ['Einreichplan', 'Nur aktuelle Fassung'])).toBe(
      'Fluchtweg GK 4, Einreichplan, Nur aktuelle Fassung'
    )
  })

  it('leaves out what is empty, unnamed or said twice, and tidies the spaces', () => {
    expect(suggestSavedSearchName('  Fluchtweg   GK 4 ', [null, '', 'einreichplan', 'Einreichplan'])).toBe('Fluchtweg GK 4, einreichplan')
    expect(suggestSavedSearchName('', [])).toBe('')
  })

  it('stays within the name’s limit, cut at a word with an ellipsis', () => {
    const name = suggestSavedSearchName('Brandschutz', Array.from({ length: 30 }, (_, index) => `Schlagwort ${index}`))
    expect(name.length).toBeLessThanOrEqual(SAVED_SEARCH_NAME_MAX)
    expect(name.endsWith('…')).toBe(true)
    expect(name).not.toMatch(/[,\s]…$/)
  })
})
