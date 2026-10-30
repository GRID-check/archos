/**
 * The layout problems a Skizze edit would leave (`sketch-edit.ts`), found
 * before the person sees the proposal and handed back to Piloti as warnings
 * so it can try again. They are warnings, not refusals: an edit that leaves
 * two boxes touching is still one a person may want.
 *
 *   - `overlap`: a new or moved shape or free text covers more than 5% of a
 *     smaller one (intersection over the smaller box, which catches a note
 *     dropped inside a big shape where IoU would not).
 *   - `label-overflow`: a label written into a box that, by estimate, does
 *     not hold it; the render grows the box (`sketch-label-fit.ts`), which may
 *     then overlap its neighbours.
 *   - `outside-frame`: a new or moved element of a frame now lies outside it.
 *   - `unbound-arrow`: a new arrow bound at neither end, which joins nothing.
 *   - `dimension-label`: a label or text that reads like a measurement, which
 *     a sketch must not claim (ADR-0146).
 *
 * Pure; boxes of texts are estimates, the render's exact widths come later.
 */

import { readsAsDimension } from './sketch-fence'
import { BOUND_TEXT_PADDING, boundIds, boxOf, estimatedTextSize, SHAPE_TYPES, type Box, type EditElement } from './sketch-edit-elements'
import type { SketchEditWarning } from './sketch-edit-wire'

/**
 * At most this many warnings go back with an edit, the rest as a count: a
 * frame of two thousand stacked boxes moved once would otherwise answer two
 * million overlaps, and every one of them is text Piloti reads.
 */
export const MAX_SKETCH_EDIT_WARNINGS = 20

/** Intersection over the smaller box above which two boxes overlap. */
export const OVERLAP_RATIO = 0.05

const area = (box: Box) => Math.max(0, box.w) * Math.max(0, box.h)

export function overlapRatio(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  const smaller = Math.min(area(a), area(b))
  return w > 0 && h > 0 && smaller > 0 ? (w * h) / smaller : 0
}

const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.w <= outer.x + outer.w + 1 && inner.y + inner.h <= outer.y + outer.h + 1

/** A shape or a free text: what can sit on top of another. */
const solid = (element: EditElement) => SHAPE_TYPES.has(element.type) || (element.type === 'text' && !element.containerId)

/** The room a container gives its label (Excalidraw's `getBoundTextMaxWidth`/`Height`). */
function labelRoom(container: EditElement): { width: number; height: number } {
  const { w, h } = boxOf(container)
  const factor = container.type === 'ellipse' ? Math.SQRT2 / 2 : container.type === 'diamond' ? 0.5 : 1
  return { width: Math.round(w * factor) - BOUND_TEXT_PADDING * 2, height: Math.round(h * factor) - BOUND_TEXT_PADDING * 2 }
}

function overflows(container: EditElement, label: EditElement): boolean {
  const room = labelRoom(container)
  const fontSize = typeof label.fontSize === 'number' ? label.fontSize : 16
  const text = String(label.originalText ?? label.text ?? '')
  const longestWord = Math.max(0, ...text.split(/\s+/).map((word) => estimatedTextSize(word, fontSize).width))
  const { width, height } = estimatedTextSize(text, fontSize)
  const lines = Math.max(1, Math.ceil(width / Math.max(1, room.width)))
  return longestWord > room.width || lines * (height / text.split('\n').length) > room.height
}

/** The warnings for the elements an edit placed (added or moved) and wrote (added or changed): the first {@link MAX_SKETCH_EDIT_WARNINGS}, and how many more. */
export function lintSketchEdit(
  live: ReadonlyMap<string, EditElement>,
  touched: { placed: ReadonlySet<string>; written: ReadonlySet<string> }
): { warnings: SketchEditWarning[]; more: number } {
  const warnings: SketchEditWarning[] = []
  let more = 0
  const warn = (warning: SketchEditWarning) => {
    if (warnings.length < MAX_SKETCH_EDIT_WARNINGS) warnings.push(warning)
    else more += 1
  }
  // Boxes once, not once per pair.
  const solids = [...live.values()].flatMap((element) => (solid(element) ? [{ id: element.id, box: boxOf(element) }] : []))
  const order = new Map(solids.map((entry, at) => [entry.id, at]))
  for (const id of touched.placed) {
    const element = live.get(id)
    if (!element || !solid(element)) continue
    const box = boxOf(element)
    const at = order.get(id) ?? -1
    for (const other of solids) {
      if (other.id === id) continue
      // A pair of two placed elements is looked at once, from the one drawn first.
      if (touched.placed.has(other.id) && (order.get(other.id) ?? -1) < at) continue
      if (overlapRatio(box, other.box) > OVERLAP_RATIO) warn({ kind: 'overlap', ids: [id, other.id] })
    }
    const frame = element.frameId ? live.get(element.frameId) : undefined
    if (frame && !inside(box, boxOf(frame))) warn({ kind: 'outside-frame', ids: [id, frame.id] })
  }
  for (const id of touched.written) {
    const element = live.get(id)
    if (!element) continue
    const labels = boundIds(element, 'text').flatMap((textId) => (live.get(textId) ? [live.get(textId) as EditElement] : []))
    const words = [element.type === 'text' ? element.text : undefined, element.name, ...labels.map((label) => label.text)]
    if (words.some((word) => typeof word === 'string' && readsAsDimension(word))) warn({ kind: 'dimension-label', ids: [id] })
    if (SHAPE_TYPES.has(element.type) && labels.some((label) => overflows(element, label))) {
      warn({ kind: 'label-overflow', ids: [id] })
    }
    if (element.type === 'arrow' && !element.startBinding && !element.endBinding && touched.placed.has(id)) {
      warn({ kind: 'unbound-arrow', ids: [id] })
    }
  }
  return { warnings, more }
}

/** The warnings as one line each, in English, for the model that proposed the edit; each line once, and the rest as a count. */
export function describeWarnings(warnings: readonly SketchEditWarning[], more = 0): string[] {
  const words: Record<SketchEditWarning['kind'], string> = {
    overlap: 'overlaps',
    'label-overflow': 'has a label wider or taller than its box; the box grows to fit it',
    'outside-frame': 'lies outside its frame',
    'unbound-arrow': 'is an arrow bound at neither end',
    'dimension-label': 'has a label that reads like a measurement; a sketch claims no dimension',
  }
  const lines = [
    ...new Set(
      warnings
        .slice(0, MAX_SKETCH_EDIT_WARNINGS)
        .map((warning) =>
          warning.kind === 'overlap' || warning.kind === 'outside-frame'
            ? `${warning.ids[0]} ${words[warning.kind]} ${warning.ids[1]}`
            : `${warning.ids[0]} ${words[warning.kind]}`
        )
    ),
  ]
  const left = more + Math.max(0, warnings.length - MAX_SKETCH_EDIT_WARNINGS)
  return left > 0 ? [...lines, `and ${left} more warnings: fix these first, then check the edit again`] : lines
}
