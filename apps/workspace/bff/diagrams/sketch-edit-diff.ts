/**
 * The picture of a Skizze edit before the person accepts it: one scene that
 * shows the sketch after the edit with what it changes marked, drawn by the
 * server's renderer like any Skizze (ADR-0149). Pure: it builds the scene; the
 * service renders it (`sketch-edit-service.ts`).
 *
 *   - added: drawn in green;
 *   - removed: the element as it was, dashed red, on top;
 *   - changed: the element as it was, dashed grey, under the element as it
 *     will be, in blue;
 *   - everything else as it is, faded, so the change stands out.
 *
 * The legend is the card's (`sketch-edit-receipt.tsx`), in the reader's
 * language; the picture carries no words of its own.
 */

import { boundIds, type EditElement } from './sketch-edit-elements'
import type { SceneElement, SketchScene } from './sketch-scene'
import type { SketchEditDiff } from './sketch-edit-wire'

export const DIFF_COLORS = { added: '#2f9e44', removed: '#e03131', before: '#868e96', changed: '#1971c2' } as const
const FADED = 30

type Mutable = Record<string, unknown> & { id: string; type: string }

/** An element with its own id, and its labels, as they were or are. */
function withLabels(id: string, elements: ReadonlyMap<string, SceneElement>): SceneElement[] {
  const element = elements.get(id)
  if (!element) return []
  const labels = new Set(boundIds(element as EditElement, 'text'))
  const texts = [...elements.values()].filter((other) => other.type === 'text' && (other.containerId === id || labels.has(other.id)))
  return [element, ...texts]
}

/** A copy of what an element was, under a new id, unbound, in `color` and dashed. */
function ghost(elements: readonly SceneElement[], suffix: string, color: string, opacity: number): Mutable[] {
  const renamed = new Map(elements.map((element) => [element.id, `${element.id}~${suffix}`]))
  return elements.map((element) => ({
    ...(element as Mutable),
    id: renamed.get(element.id) as string,
    strokeColor: color,
    strokeStyle: 'dashed',
    opacity,
    frameId: null,
    index: null,
    startBinding: element.startBinding ? null : element.startBinding,
    endBinding: element.endBinding ? null : element.endBinding,
    containerId: element.containerId ? (renamed.get(element.containerId) ?? null) : (element.containerId ?? null),
    boundElements: Array.isArray(element.boundElements)
      ? (element.boundElements as { id: string; type: string }[]).flatMap((entry) => (renamed.has(entry.id) ? [{ ...entry, id: renamed.get(entry.id) as string }] : []))
      : null,
  }))
}

/** The diff's elements, ready to render: the scene after the edit, marked, with the before-copies around it. */
export function sketchEditDiffElements(before: SketchScene, after: SketchScene, diff: SketchEditDiff): Record<string, unknown>[] {
  const was = new Map(before.elements.filter((element) => !element.isDeleted).map((element) => [element.id, element]))
  const now = new Map(after.elements.filter((element) => !element.isDeleted).map((element) => [element.id, element]))
  const colour = new Map<string, string>()
  for (const id of diff.added) for (const element of withLabels(id, now)) colour.set(element.id, DIFF_COLORS.added)
  for (const id of diff.changed) for (const element of withLabels(id, now)) colour.set(element.id, DIFF_COLORS.changed)
  const under = diff.changed.flatMap((id) => ghost(withLabels(id, was), 'before', DIFF_COLORS.before, 60))
  const over = diff.removed.flatMap((id) => ghost(withLabels(id, was), 'removed', DIFF_COLORS.removed, 80))
  const drawn = [...now.values()].map((element) => {
    const marked = colour.get(element.id)
    return { ...(element as Mutable), index: null, ...(marked ? { strokeColor: marked, opacity: 100 } : { opacity: FADED }) }
  })
  // Fresh indices in this order (`index: null`): the renderer's restore numbers them as the array stands.
  return [...under, ...drawn, ...over]
}
