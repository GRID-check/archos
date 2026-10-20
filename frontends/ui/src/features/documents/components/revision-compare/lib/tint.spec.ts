import { describe, expect, it } from 'vitest'
import { MARK_INK, NEWER_INK, OLDER_INK, PAPER, PAPER_INK, UNCHANGED_INK, contrastRatio, multiplyInks } from './tint'

describe('the paper palette', () => {
  it('computes the unchanged swatch as the two inks multiplied, as the sheet does', () => {
    expect(multiplyInks(OLDER_INK, NEWER_INK)).toEqual([0, 49, 0])
    expect(UNCHANGED_INK).toEqual([0, 49, 0])
    expect(multiplyInks([255, 255, 255], NEWER_INK)).toEqual(NEWER_INK)
  })

  it('draws the boxes and the divider at 3:1 or more against the paper', () => {
    expect(contrastRatio(MARK_INK, PAPER)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(PAPER_INK, PAPER)).toBeGreaterThanOrEqual(3)
  })

  it('keeps the box colour apart from both overlay inks', () => {
    // Hue alone would be a weak claim; the overlay also dashes the boxes. This
    // holds the colour to not BEING either ink.
    expect(MARK_INK).not.toEqual(NEWER_INK)
    expect(MARK_INK).not.toEqual(OLDER_INK)
    expect(contrastRatio(MARK_INK, OLDER_INK)).toBeGreaterThan(1.3)
  })

  it('measures contrast symmetrically, 21:1 at the extremes', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21)
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21)
  })
})
