import { describe, expect, it } from 'vitest'

import { kindCountsKnown } from './sections'

const empty = { hits: [], total: 0, totalIsLowerBound: false, nextCursor: null }

describe('kindCountsKnown', () => {
  it('shows counts once every tab’s count is known, a kind set aside by a filter not holding the others back', () => {
    expect(kindCountsKnown({ sections: { document: empty, folder: empty }, setAside: {} }, ['document', 'folder'])).toBe(true)
    expect(kindCountsKnown({ sections: { document: empty }, setAside: { folder: 'document_filters' } }, ['document', 'folder'])).toBe(true)
  })

  it('shows none while a tab’s kind was not searched, or before the first answer', () => {
    expect(kindCountsKnown({ sections: { document: empty }, setAside: {} }, ['document', 'annotation', 'folder'])).toBe(false)
    expect(kindCountsKnown(null, ['document'])).toBe(false)
  })
})
