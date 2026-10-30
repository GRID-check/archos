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

/** The warnings for the elements an edit placed (added or moved) and wrote (added or changed). */
export function lintSketchEdit(
  live: ReadonlyMap<string, EditElement>,
  touched: { placed: ReadonlySet<string>; written: ReadonlySet<string> }
): SketchEditWarning[] {
  const warnings: SketchEditWarning[] = []
  const elements = [...live.values()]
  const seen = new Set<string>()
  for (const id of touched.placed) {
    const element = live.get(id)
    if (!element || !solid(element)) continue
    const box = boxOf(element)
    for (const other of elements) {
      if (other.id === id || !solid(other)) continue
      const pair = [id, other.id].sort().join('\u0000')
      if (seen.has(pair) || overlapRatio(box, boxOf(other)) <= OVERLAP_RATIO) continue
      seen.add(pair)
      warnings.push({ kind: 'overlap', ids: [id, other.id] })
    }
    const frame = element.frameId ? live.get(element.frameId) : undefined
    if (frame && !inside(box, boxOf(frame))) warnings.push({ kind: 'outside-frame', ids: [id, frame.id] })
  }
  for (const id of touched.written) {
    const element = live.get(id)
    if (!element) continue
    const labels = boundIds(element, 'text').flatMap((textId) => (live.get(textId) ? [live.get(textId) as EditElement] : []))
    const words = [element.type === 'text' ? element.text : undefined, element.name, ...labels.map((label) => label.text)]
    if (words.some((word) => typeof word === 'string' && readsAsDimension(word))) warnings.push({ kind: 'dimension-label', ids: [id] })
    if (SHAPE_TYPES.has(element.type) && labels.some((label) => overflows(element, label))) {
      warnings.push({ kind: 'label-overflow', ids: [id] })
    }
    if (element.type === 'arrow' && !element.startBinding && !element.endBinding && touched.placed.has(id)) {
      warnings.push({ kind: 'unbound-arrow', ids: [id] })
    }
  }
  return warnings
}

/** The warnings as one line each, in English, for the model that proposed the edit. */
export function describeWarnings(warnings: readonly SketchEditWarning[]): string[] {
  const words: Record<SketchEditWarning['kind'], string> = {
    overlap: 'overlaps',
    'label-overflow': 'has a label wider or taller than its box; the box grows to fit it',
    'outside-frame': 'lies outside its frame',
    'unbound-arrow': 'is an arrow bound at neither end',
    'dimension-label': 'has a label that reads like a measurement; a sketch claims no dimension',
  }
  return warnings.map((warning) =>
    warning.kind === 'overlap' || warning.kind === 'outside-frame'
      ? `${warning.ids[0]} ${words[warning.kind]} ${warning.ids[1]}`
      : `${warning.ids[0]} ${words[warning.kind]}`
  )
}
