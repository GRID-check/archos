/**
 * @vitest-environment node
 */
/**
 * The excerpt of a cited page: the passage with its surroundings, inside the
 * page, never a sliver; the whole page when the passage was not found.
 */
import { describe, expect, it } from 'vitest'
import { excerptOf, MAX_ASPECT, MIN_WIDTH_SHARE } from './excerpt-geometry'

const A4 = { width: 600, height: 800 }

describe('excerptOf', () => {
  it('shows the whole page, unmarked, when the passage was not found', () => {
    expect(excerptOf(A4, null)).toEqual({ crop: { x: 0, y: 0, width: 600, height: 800 }, mark: null })
  })

  it('keeps the passage inside the crop, with a margin, and marks it relative to the crop', () => {
    const passage = { x: 200, y: 300, width: 250, height: 12 }
    const { crop, mark } = excerptOf(A4, passage)
    expect(crop.x).toBeLessThan(passage.x)
    expect(crop.y).toBeLessThan(passage.y)
    expect(crop.x + crop.width).toBeGreaterThan(passage.x + passage.width)
    expect(crop.y + crop.height).toBeGreaterThan(passage.y + passage.height)
    expect(mark).toEqual({ x: passage.x - crop.x, y: passage.y - crop.y, width: 250, height: 12 })
  })

  it('never shows less than half the width, nor a strip flatter than its limit', () => {
    const { crop } = excerptOf(A4, { x: 280, y: 400, width: 20, height: 10 })
    expect(crop.width).toBeGreaterThanOrEqual(A4.width * MIN_WIDTH_SHARE)
    expect(crop.width / crop.height).toBeLessThanOrEqual(MAX_ASPECT + 1e-9)
  })

  it('stays inside the page at its corners', () => {
    const { crop } = excerptOf(A4, { x: 560, y: 780, width: 40, height: 15 })
    expect(crop.x).toBeGreaterThanOrEqual(0)
    expect(crop.y).toBeGreaterThanOrEqual(0)
    expect(crop.x + crop.width).toBeLessThanOrEqual(A4.width + 1e-9)
    expect(crop.y + crop.height).toBeLessThanOrEqual(A4.height + 1e-9)
  })
})
