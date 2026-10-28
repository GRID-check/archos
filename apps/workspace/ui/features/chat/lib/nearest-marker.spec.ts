/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { distanceToBox, NEAREST_MARKER_REACH_PX, nearestMarkerIndex, type MarkerBox } from './nearest-marker'

/** A 22 x 26 pill with its left edge at `left`, on one line. */
const pill = (left: number, top = 100): MarkerBox => ({ left, right: left + 22, top, bottom: top + 26 })

describe('distanceToBox', () => {
  it('is zero inside the box and straight-line outside it', () => {
    expect(distanceToBox(110, 110, pill(100))).toBe(0)
    expect(distanceToBox(130, 110, pill(100))).toBe(8)
    // Diagonal: 3 right of the corner, 4 below it.
    expect(distanceToBox(125, 130, pill(100))).toBe(5)
  })
})

describe('nearestMarkerIndex', () => {
  const [first, second] = [pill(100), pill(130)]

  it('hands a tap beside a marker to that marker', () => {
    expect(nearestMarkerIndex(126, 112, [first!, second!])).toBe(0)
  })

  it('gives a tap between two neighbours to the nearer, whichever is later in the DOM', () => {
    // 5px from the first pill's right edge, 3px from the second's left edge.
    expect(nearestMarkerIndex(127, 112, [first!, second!])).toBe(1)
    expect(nearestMarkerIndex(125, 112, [first!, second!])).toBe(0)
  })

  it('leaves a tap beyond the reach alone', () => {
    expect(nearestMarkerIndex(100 + 22 + NEAREST_MARKER_REACH_PX + 1, 112, [first!])).toBe(-1)
    expect(nearestMarkerIndex(100 + 22 + NEAREST_MARKER_REACH_PX, 112, [first!])).toBe(0)
  })

  it('reaches a marker on the line above or below as far as sideways', () => {
    expect(nearestMarkerIndex(110, 100 - NEAREST_MARKER_REACH_PX, [first!])).toBe(0)
    expect(nearestMarkerIndex(110, 100 - NEAREST_MARKER_REACH_PX - 1, [first!])).toBe(-1)
  })

  it('is -1 with no markers', () => {
    expect(nearestMarkerIndex(0, 0, [])).toBe(-1)
  })
})
