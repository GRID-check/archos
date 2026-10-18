/**
 * Label declutter for a schematic drawn at phone width.
 *
 * Every template places its labels by hand, in viewBox units, for a drawing
 * that renders at about one pixel per unit. On a phone the drawing renders at
 * 0.6 to 0.7 and `SvgLabel` enlarges its text so it still reads (see
 * `legibleLabelSize`): the geometry shrank, the words did not, and two labels
 * authored ten units apart now overprint. Moving every template's offsets by
 * hand would trade one set of coordinates for another; this takes the
 * rendered boxes, as the reader sees them, and pushes the later of two
 * colliding labels clear of the first.
 *
 * Pure on purpose: `SchematicCanvas` measures the DOM and applies the result,
 * and this decides, so the decision is testable without a layout engine.
 */

export interface LabelBox {
  left: number
  right: number
  top: number
  bottom: number
  /** False for a label the pass must not move (a rotated dimension label). */
  movable: boolean
}

export interface LabelNudge {
  dx: number
  dy: number
}

interface Options {
  /** Air kept between two labels, in the boxes' unit. */
  gap?: number
  /** The most one label is moved along either axis: further and it no longer reads as belonging to its mark. */
  maxShift?: number
}

const PASSES = 6
/** Overlap below this is the glyphs' own side bearing, not a collision. */
const TOLERANCE = 0.75

const overlap = (a: LabelBox, b: LabelBox): { x: number; y: number } => ({
  x: Math.min(a.right, b.right) - Math.max(a.left, b.left),
  y: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
})

/**
 * How far each label moves so none overprints another or leaves `bounds`.
 *
 * A label inside the bounds that collides with nothing gets `{ dx: 0, dy: 0 }`.
 * Of two colliding labels the lower one moves down, unless it is fixed, in
 * which case the upper one moves up; a pair of fixed labels is left alone.
 * Vertical only for collisions: a label slid sideways would stop sitting at the
 * end of the line it names. Horizontal movement is for the bounds alone.
 */
export function declutterLabels(
  boxes: readonly LabelBox[],
  bounds: { left: number; right: number },
  { gap = 1, maxShift = 14 }: Options = {}
): LabelNudge[] {
  const moved = boxes.map((box) => ({ ...box }))
  const nudges: LabelNudge[] = boxes.map(() => ({ dx: 0, dy: 0 }))

  const shiftBy = (index: number, dx: number, dy: number): void => {
    const nudge = nudges[index]
    const box = moved[index]
    const nextDx = Math.max(-maxShift * 4, Math.min(maxShift * 4, nudge.dx + dx))
    const nextDy = Math.max(-maxShift, Math.min(maxShift, nudge.dy + dy))
    const appliedX = nextDx - nudge.dx
    const appliedY = nextDy - nudge.dy
    box.left += appliedX
    box.right += appliedX
    box.top += appliedY
    box.bottom += appliedY
    nudge.dx = nextDx
    nudge.dy = nextDy
  }

  // A label cut by the drawing's edge slides back inside it first, so the
  // collision pass sees the position the reader will see.
  moved.forEach((box, index) => {
    if (!box.movable) return
    const width = box.right - box.left
    if (width > bounds.right - bounds.left) return
    if (box.left < bounds.left) shiftBy(index, bounds.left - box.left, 0)
    else if (box.right > bounds.right) shiftBy(index, bounds.right - box.right, 0)
  })

  for (let pass = 0; pass < PASSES; pass += 1) {
    let changed = false
    const order = moved.map((_, index) => index).sort((a, b) => moved[a].top - moved[b].top)
    for (let i = 0; i < order.length; i += 1) {
      for (let j = i + 1; j < order.length; j += 1) {
        const upper = order[i]
        const lower = order[j]
        const o = overlap(moved[upper], moved[lower])
        if (o.x <= TOLERANCE || o.y <= TOLERANCE) continue
        const push = o.y + gap
        if (moved[lower].movable) {
          shiftBy(lower, 0, push)
          changed = true
        } else if (moved[upper].movable) {
          shiftBy(upper, 0, -push)
          changed = true
        }
      }
    }
    if (!changed) break
  }
  return nudges
}
