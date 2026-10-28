/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { CompareRegion } from '../types'
import { centeredScroll, groupByPage, mergeAnswers, numberRegions, regionToPixels, regionsOnPage } from './regions'

const region = (over: Partial<CompareRegion> = {}): CompareRegion => ({
  page: 1,
  x: 0.25,
  y: 0.5,
  w: 0.5,
  h: 0.25,
  label: 'Wand',
  ...over,
})

describe('regionToPixels', () => {
  it('maps page shares to pixels on the page as drawn', () => {
    expect(regionToPixels(region(), { width: 800, height: 400 })).toEqual({
      left: 200,
      top: 200,
      width: 400,
      height: 100,
    })
  })

  it('scales with the page: the same share on a page twice as large is twice the pixels', () => {
    const small = regionToPixels(region(), { width: 400, height: 200 })
    const large = regionToPixels(region(), { width: 800, height: 400 })
    expect(large.left).toBe(small.left * 2)
    expect(large.height).toBe(small.height * 2)
  })

  it('cuts a box at the page edge instead of moving it', () => {
    const box = regionToPixels(region({ x: 0.9, w: 0.3, y: 0.8, h: 0.5 }), { width: 1000, height: 1000 })
    expect(box.left).toBe(900)
    expect(box.width).toBeCloseTo(100)
    expect(box.top).toBe(800)
    expect(box.height).toBeCloseTo(200)
  })

  it('clamps coordinates outside 0..1 and draws nothing for a non-finite one', () => {
    const outside = regionToPixels(region({ x: -0.5, y: 2, w: 3, h: -1 }), { width: 100, height: 100 })
    expect(outside).toEqual({ left: 0, top: 100, width: 100, height: 0 })
    const broken = regionToPixels(region({ x: Number.NaN, w: Number.POSITIVE_INFINITY }), { width: 100, height: 100 })
    expect(Number.isNaN(broken.left)).toBe(false)
    expect(broken.left).toBe(0)
    expect(broken.width).toBe(0)
  })
})

describe('numberRegions / regionsOnPage', () => {
  const all = numberRegions([region({ page: 1 }), region({ page: 2 }), region({ page: 1 })])

  it('numbers across every page in the order given', () => {
    expect(all.map((entry) => entry.number)).toEqual([1, 2, 3])
  })

  it('keeps a region\'s number when only its page is shown', () => {
    expect(regionsOnPage(all, 1).map((entry) => entry.number)).toEqual([1, 3])
    expect(regionsOnPage(all, 2).map((entry) => entry.number)).toEqual([2])
    expect(regionsOnPage(all, 3)).toEqual([])
  })
})

describe('mergeAnswers: marking a second page keeps the first', () => {
  it('adds page 2 to page 1 instead of replacing it, numbered in the order asked', () => {
    const answers = new Map([
      [2, { regions: [region({ page: 2, label: 'Treppe' })], summary: [] }],
      [1, { regions: [region({ label: 'Wand' }), region({ label: 'Tür' })], summary: [] }],
    ])
    const merged = numberRegions(mergeAnswers(answers))
    expect(merged.map(({ number, region: r }) => [number, r.page, r.label])).toEqual([
      [1, 2, 'Treppe'],
      [2, 1, 'Wand'],
      [3, 1, 'Tür'],
    ])
  })

  it('holds a box to the page it was asked for', () => {
    const merged = mergeAnswers(new Map([[3, { regions: [region({ page: 1 })], summary: [] }]]))
    expect(merged[0]?.page).toBe(3)
  })
})

describe('groupByPage', () => {
  const numbered = numberRegions([
    region({ page: 1, label: 'Wand versetzt' }),
    region({ page: 2, label: 'Treppe' }),
    region({ page: 1, label: 'Tür gedreht' }),
  ])

  it('groups by page in page order and keeps the numbers', () => {
    const groups = groupByPage(numbered)
    expect(groups.map((group) => [group.page, group.rows.map((row) => row.number)])).toEqual([
      [1, [1, 3]],
      [2, [2]],
    ])
  })

  it('pairs one sentence per box when the counts match, so nothing is said twice', () => {
    const groups = groupByPage(numbered, new Map([[1, ['Die Wand steht 60 cm weiter rechts.', 'Der Anschlag ist gedreht.']]]))
    expect(groups[0]?.rows.map((row) => row.sentence)).toEqual([
      'Die Wand steht 60 cm weiter rechts.',
      'Der Anschlag ist gedreht.',
    ])
    expect(groups[0]?.notes).toEqual([])
  })

  it('keeps unpaired sentences as notes and drops the ones that only repeat a label', () => {
    const groups = groupByPage(numbered, new Map([[1, ['Wand versetzt', 'Zwei Dinge geändert.', 'Ein drittes.']]]))
    expect(groups[0]?.rows.every((row) => row.sentence === undefined)).toBe(true)
    expect(groups[0]?.notes).toEqual(['Zwei Dinge geändert.', 'Ein drittes.'])
  })

  it('drops a paired sentence that is the label again', () => {
    const groups = groupByPage(numberRegions([region({ label: 'Treppe' })]), new Map([[1, ['treppe']]]))
    expect(groups[0]?.rows[0]?.sentence).toBeUndefined()
  })

  it('gives a page with sentences and no boxes its own group', () => {
    const groups = groupByPage([], new Map([[4, ['keine sichtbare Änderung']]]))
    expect(groups).toEqual([{ page: 4, rows: [], notes: ['keine sichtbare Änderung'] }])
  })
})

describe('centeredScroll', () => {
  const frame = { left: 100, top: 50, width: 400, height: 300, scrollLeft: 0, scrollTop: 0, scrollWidth: 2000, scrollHeight: 1000 }

  it('puts the box in the middle of the frame', () => {
    expect(centeredScroll(frame, { left: 1000, top: 600, width: 100, height: 50 })).toEqual({ left: 750, top: 425 })
  })

  it('stays inside what the frame can scroll', () => {
    expect(centeredScroll(frame, { left: 110, top: 60, width: 10, height: 10 })).toEqual({ left: 0, top: 0 })
    expect(centeredScroll({ ...frame, scrollWidth: 400, scrollHeight: 300 }, { left: 450, top: 300, width: 10, height: 10 })).toEqual({ left: 0, top: 0 })
  })
})
