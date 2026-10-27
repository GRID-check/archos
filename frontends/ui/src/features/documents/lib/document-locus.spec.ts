import { describe, expect, it } from 'vitest'
import {
  clearDocumentLocus,
  clipHighlight,
  HIGHLIGHT_LINK_CHARS,
  parsePage,
  readDocumentLocus,
  setDocumentLocus,
  withDocumentLocus,
} from './document-locus'

describe('parsePage', () => {
  it('reads a positive whole number', () => {
    expect(parsePage('7')).toBe(7)
    expect(parsePage(' 12 ')).toBe(12)
  })

  it('reads nothing else', () => {
    for (const value of [null, undefined, '', '0', '-3', '2.5', '7a', 'abc', '1e3', '99999999999999999999']) {
      expect(parsePage(value)).toBeNull()
    }
  })
})

describe('clipHighlight', () => {
  it('collapses whitespace and keeps a short passage whole', () => {
    expect(clipHighlight('  Die maximale\n Gehweglänge  ')).toBe('Die maximale Gehweglänge')
  })

  it('is null for nothing', () => {
    expect(clipHighlight(null)).toBeNull()
    expect(clipHighlight('   ')).toBeNull()
  })

  it('cuts a long passage on a word boundary', () => {
    const text = Array.from({ length: 80 }, (_, index) => `Wort${index}`).join(' ')
    const clipped = clipHighlight(text) ?? ''
    expect(clipped.length).toBeLessThanOrEqual(HIGHLIGHT_LINK_CHARS)
    expect(text.startsWith(clipped)).toBe(true)
    expect(text.charAt(clipped.length)).toBe(' ')
  })
})

describe('readDocumentLocus', () => {
  it('reads the page and passage for the document `doc` names', () => {
    const params = new URLSearchParams('doc=d1&page=7&highlight=Fluchtweg%20max.%2040%20m')
    expect(readDocumentLocus(params, 'd1')).toEqual({ page: 7, highlight: 'Fluchtweg max. 40 m' })
  })

  it('reads nothing for another document', () => {
    const params = new URLSearchParams('doc=d2&page=7&highlight=x')
    expect(readDocumentLocus(params, 'd1')).toEqual({ page: null, highlight: null })
  })

  it('reads nothing without params, and drops a page that is not one', () => {
    expect(readDocumentLocus(null, 'd1')).toEqual({ page: null, highlight: null })
    expect(readDocumentLocus(new URLSearchParams('doc=d1&page=zero'), 'd1')).toEqual({ page: null, highlight: null })
  })
})

describe('setDocumentLocus and clearDocumentLocus', () => {
  it('sets both, and takes off a missing part', () => {
    const params = new URLSearchParams('doc=d1&page=3&highlight=old')
    setDocumentLocus(params, { page: 9, highlight: null })
    expect(params.toString()).toBe('doc=d1&page=9')
    clearDocumentLocus(params)
    expect(params.toString()).toBe('doc=d1')
  })
})

describe('withDocumentLocus', () => {
  it('appends the page and passage to a shelf link', () => {
    const href = withDocumentLocus('/app/office-shelf?doc=d1', { page: 7, highlight: 'REI 90' })
    expect(href).toBe('/app/office-shelf?doc=d1&page=7&highlight=REI+90')
    const url = new URL(href, 'https://piloti.test')
    expect(readDocumentLocus(url.searchParams, 'd1')).toEqual({ page: 7, highlight: 'REI 90' })
  })

  it('keeps the hash and leaves a link without a place unchanged', () => {
    expect(withDocumentLocus('/a?doc=d1#x', { page: 2 })).toBe('/a?doc=d1&page=2#x')
    expect(withDocumentLocus('/a?doc=d1', { page: null, highlight: '' })).toBe('/a?doc=d1')
  })
})
