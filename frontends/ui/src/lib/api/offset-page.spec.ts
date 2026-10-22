/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { collectPages, offsetPageOf, pageOfList } from './offset-page'

describe('offset pages', () => {
  it('pages an ordered list and ends with a null cursor', () => {
    const rows = [1, 2, 3, 4, 5]
    const first = pageOfList(rows, offsetPageOf({ limit: 2 }))
    expect(first).toEqual({ rows: [1, 2], nextCursor: '2' })
    const last = pageOfList(rows, offsetPageOf({ limit: 2, cursor: '4' }))
    expect(last).toEqual({ rows: [5], nextCursor: null })
  })

  it('refuses a cursor it did not issue', () => {
    expect(() => offsetPageOf({ cursor: 'abc' })).toThrow(/cursor/)
  })

  it('collects every page', async () => {
    const all = await collectPages(async (cursor) =>
      cursor === null ? { items: [1, 2], nextCursor: '2' } : { items: [3], nextCursor: null }
    )
    expect(all).toEqual([1, 2, 3])
  })
})
