/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { NO_VISIBLE_CHANGE, revisionCompareBodySchema, parseRevisionVisualChanges } from './revision-compare-types'

const REGION = { page: 1, x: 0.2, y: 0.3, w: 0.1, h: 0.25, label: 'Wand verschoben' }

describe('parseRevisionVisualChanges', () => {
  it.each([null, undefined, 'x', 3, [], {}, { regions: 'x', summary: 4 }])('reads %j as no visible change', (raw) => {
    expect(parseRevisionVisualChanges(raw)).toEqual({ regions: [], summary: [NO_VISIBLE_CHANGE] })
  })

  it('keeps sentences when no box survives, and boxes when no sentence comes', () => {
    expect(parseRevisionVisualChanges({ regions: [{ ...REGION, w: 0 }], summary: ['Index B auf C.'] })).toEqual({
      regions: [],
      summary: ['Index B auf C.'],
    })
    expect(parseRevisionVisualChanges({ regions: [REGION], summary: [] })).toEqual({ regions: [REGION], summary: [] })
  })

  it.each([
    ['x past the page', { ...REGION, x: 1.2 }],
    ['a negative y', { ...REGION, y: -0.1 }],
    ['an empty width', { ...REGION, w: 0 }],
    ['text as a coordinate', { ...REGION, h: '0.2' }],
    ['a blank label', { ...REGION, label: '  ' }],
    ['page 0', { ...REGION, page: 0 }],
    ['a missing field', { page: 1, x: 0.1, y: 0.1, w: 0.1, label: 'a' }],
  ])('drops a region with %s', (_name, bad) => {
    expect(parseRevisionVisualChanges({ regions: [bad, REGION], summary: ['s'] }).regions).toEqual([REGION])
  })

  it('bounds the boxes and the sentences', () => {
    const parsed = parseRevisionVisualChanges({
      regions: Array.from({ length: 40 }, () => REGION),
      summary: Array.from({ length: 40 }, (_, index) => `Satz ${index}`),
    })

    expect(parsed.regions).toHaveLength(12)
    expect(parsed.summary).toHaveLength(8)
  })
})

describe('revisionCompareBodySchema', () => {
  const OLDER = '2f1c6e0e-4f0a-4c53-9a3e-0f2b7d8f6a11'

  it('defaults the page to 1', () => {
    expect(revisionCompareBodySchema.parse({ older: OLDER })).toEqual({ older: OLDER, page: 1 })
  })

  it.each([{ older: 'x' }, { older: OLDER, page: 0 }, { older: OLDER, page: 2.5 }, { older: OLDER, page: 2001 }])(
    'refuses %j',
    (body) => {
      expect(revisionCompareBodySchema.safeParse(body).success).toBe(false)
    },
  )
})
