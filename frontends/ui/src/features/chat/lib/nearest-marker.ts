/**
 * Which citation marker a tap that missed every marker was meant for.
 *
 * An inline `[1]` is a 22px pill inside a sentence, and the Touch rule exempts
 * such a target from the 44px floor: a 44px catchment around each would overlap
 * its neighbours (`[2][3]` sit a few pixels apart) and the later one in the DOM
 * would take every tap meant for the earlier. A confidently wrong target is
 * worse than a small one.
 *
 * So the catchment is not drawn around each marker. A tap that lands on nothing
 * pressable is handed to the NEAREST marker within {@link NEAREST_MARKER_REACH_PX}
 * of the finger, and only then. Neighbours cannot steal from each other (the
 * closer one wins, and a tap that lands ON a marker never gets here), and what
 * is reachable is the 44px a thumb needs: the pill's own 22 plus the reach on
 * each side.
 *
 * Pure: the geometry is passed in, so the rule is testable without a layout.
 */

/** How far from a marker's edge a tap still belongs to it. 22px + 2 x 12px = 46px. */
export const NEAREST_MARKER_REACH_PX = 12

export interface MarkerBox {
  left: number
  right: number
  top: number
  bottom: number
}

/** Distance from a point to a box: 0 inside, straight-line outside. */
export const distanceToBox = (x: number, y: number, box: MarkerBox): number => {
  const dx = Math.max(box.left - x, 0, x - box.right)
  const dy = Math.max(box.top - y, 0, y - box.bottom)
  return Math.hypot(dx, dy)
}

/**
 * The index of the box nearest the point within `reach`, or -1 when none is
 * that near. A tie goes to the earlier box (reading order).
 */
export const nearestMarkerIndex = (
  x: number,
  y: number,
  boxes: readonly MarkerBox[],
  reach: number = NEAREST_MARKER_REACH_PX
): number => {
  let best = -1
  let bestDistance = Number.POSITIVE_INFINITY
  boxes.forEach((box, index) => {
    const distance = distanceToBox(x, y, box)
    if (distance <= reach && distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  })
  return best
}
