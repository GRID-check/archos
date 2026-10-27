import { describe, expect, it } from 'vitest'

import { savedSearchSummary, type SavedSearchSummaryWords } from './saved-search-summary'

const words: SavedSearchSummaryWords = {
  quote: (text) => `„${text}“`,
  register: 'Planliste',
  filter: (filter) => filter.id,
  everything: 'Ohne Begriffe und Filter',
}

describe('savedSearchSummary', () => {
  it('says the words, then the register, then each filter as its chip, in the chips’ order', () => {
    expect(
      savedSearchSummary(
        { text: 'Fluchtweg', kinds: ['document'], sort: 'plan_number', filters: { documentTypes: ['submission_drawing'], currentOnly: true } },
        words
      )
    ).toBe('„Fluchtweg“ · Planliste · documentTypes:submission_drawing · currentOnly')
  })

  it('names no register for a list, and says when a search asks for nothing in particular', () => {
    expect(savedSearchSummary({ text: 'Fluchtweg' }, words)).toBe('„Fluchtweg“')
    expect(savedSearchSummary({}, words)).toBe('Ohne Begriffe und Filter')
  })
})
