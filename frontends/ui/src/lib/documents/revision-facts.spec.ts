import { describe, expect, it } from 'vitest'
import { parseRevisionFacts } from './revision-facts'

describe('parseRevisionFacts', () => {
  it('maps the snake_case title-block facts to camelCase', () => {
    expect(
      parseRevisionFacts({
        document_number: 'A-101',
        revision: 'C',
        revision_date: '2026-03-14',
        scale: '1:100',
        title: 'Grundriss EG',
        page: 2,
      })
    ).toEqual({
      documentNumber: 'A-101',
      revision: 'C',
      revisionDate: '2026-03-14',
      scale: '1:100',
      title: 'Grundriss EG',
      page: 2,
    })
  })

  it('trims text and bounds it to 80 characters', () => {
    const long = 'x'.repeat(120)
    expect(parseRevisionFacts({ title: `  Schnitt A-A  `, document_number: long })).toEqual({
      title: 'Schnitt A-A',
      documentNumber: 'x'.repeat(80),
    })
  })

  it('keeps the facts that are valid and drops the rest field by field', () => {
    expect(
      parseRevisionFacts({
        document_number: 'A-101',
        revision: '   ',
        revision_date: '14.03.2026',
        scale: 42,
        page: 0,
      })
    ).toEqual({ documentNumber: 'A-101' })
  })

  it('accepts only a strict ISO calendar date for the revision date', () => {
    expect(parseRevisionFacts({ revision_date: '2026-03-14' })).toEqual({
      revisionDate: '2026-03-14',
    })
    expect(parseRevisionFacts({ revision_date: '2026-03-14T09:00:00' })).toBeNull()
    expect(parseRevisionFacts({ revision_date: 20260314 })).toBeNull()
  })

  it('accepts a page only as a positive integer no greater than 2000', () => {
    expect(parseRevisionFacts({ page: 1 })).toEqual({ page: 1 })
    expect(parseRevisionFacts({ page: 2000 })).toEqual({ page: 2000 })
    expect(parseRevisionFacts({ page: 2001 })).toBeNull()
    expect(parseRevisionFacts({ page: 1.5 })).toBeNull()
    expect(parseRevisionFacts({ page: -3 })).toBeNull()
    expect(parseRevisionFacts({ page: '2' })).toBeNull()
    expect(parseRevisionFacts({ page: Number.NaN })).toBeNull()
  })

  it('returns null for anything that is not an object with usable facts', () => {
    expect(parseRevisionFacts(null)).toBeNull()
    expect(parseRevisionFacts(undefined)).toBeNull()
    expect(parseRevisionFacts('A-101')).toBeNull()
    expect(parseRevisionFacts(7)).toBeNull()
    expect(parseRevisionFacts(['A-101'])).toBeNull()
    expect(parseRevisionFacts({})).toBeNull()
    expect(parseRevisionFacts({ document_number: null, scale: '' })).toBeNull()
  })
})
