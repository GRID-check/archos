import { describe, expect, it } from 'vitest'
import { clampPage, clampZoom, commonStage, fitScale, hasPage, isFitZoom, MAX_ZOOM, MIN_ZOOM, nextZoom, pageSpan } from './pages'

describe('page arithmetic', () => {
  it('holds a page inside 1..count', () => {
    expect(clampPage(0, 5)).toBe(1)
    expect(clampPage(9, 5)).toBe(5)
    expect(clampPage(3, 5)).toBe(3)
    expect(clampPage(Number.NaN, 5)).toBe(1)
    expect(clampPage(4, 0)).toBe(1)
  })

  it('spans the longer of the two documents and says when they differ', () => {
    expect(pageSpan(3, 5)).toEqual({ count: 5, differs: true })
    expect(pageSpan(4, 4)).toEqual({ count: 4, differs: false })
    expect(pageSpan(0, 0)).toEqual({ count: 1, differs: false })
  })

  it('knows when a shorter document has no such page', () => {
    expect(hasPage(2, 2)).toBe(true)
    expect(hasPage(2, 3)).toBe(false)
    expect(hasPage(2, 0)).toBe(false)
  })

  it('fits both pages into one box at one scale', () => {
    const stage = commonStage([
      { width: 840, height: 594 },
      { width: 595, height: 842 },
    ])
    expect(stage).toEqual({ width: 840, height: 842 })
    expect(commonStage([])).toBeNull()
    expect(fitScale({ width: 420 }, { width: 840, height: 842 }, 1)).toBe(0.5)
    expect(fitScale({ width: 420 }, { width: 840, height: 842 }, 2)).toBe(1)
    expect(fitScale({ width: 0 }, { width: 840, height: 842 }, 1)).toBe(0)
  })

  it('fits the whole sheet when the height is known, and the width alone when it is not', () => {
    const stage = { width: 840, height: 594 }
    // A wide frame, but short: the height decides.
    expect(fitScale({ width: 1680, height: 297 }, stage, 1)).toBe(0.5)
    // A tall frame: the width decides.
    expect(fitScale({ width: 420, height: 2000 }, stage, 1)).toBe(0.5)
    expect(fitScale({ width: 420, height: 0 }, stage, 1)).toBe(0.5)
  })

  it('walks the zoom ladder without leaving it', () => {
    expect(nextZoom(1, 1)).toBe(1.5)
    expect(nextZoom(1, -1)).toBe(0.75)
    expect(nextZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM)
    expect(nextZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM)
    expect(MAX_ZOOM).toBe(8)
  })

  it('steps from between two rungs to the nearer one in that direction', () => {
    expect(nextZoom(1.2, 1)).toBe(1.5)
    expect(nextZoom(1.2, -1)).toBe(1)
  })

  it('clamps a free zoom and calls the fit by name', () => {
    expect(clampZoom(20)).toBe(MAX_ZOOM)
    expect(clampZoom(0.1)).toBe(MIN_ZOOM)
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(isFitZoom(1.004)).toBe(true)
    expect(isFitZoom(1.5)).toBe(false)
  })
})
