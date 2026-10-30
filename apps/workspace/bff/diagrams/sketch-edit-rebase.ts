/**
 * Whether an edit made on one Fassung may go onto a newer one (a rebase,
 * `sketch-edit-service.ts`). Operations address elements, so a colleague's
 * change elsewhere in the sketch leaves them valid. A change to an element the
 * edit leans on does not: the card's picture was drawn on the older Fassung,
 * and applying it on the newer one would overwrite the colleague's label or
 * position without a word, or delete an arrow they bound to a removed box.
 *
 * The edit leans on the elements it names, their labels, and for a `remove`
 * what the removal takes along (the arrows bound to it and their labels). One
 * of them changed when it is gone, or its `version` or `versionNonce` moved:
 * every save versions what changed (`sketch-revise.ts`). Pure.
 */

import { idsNamedBy } from './sketch-edit'
import type { SketchEditOp } from './sketch-edit-wire'
import type { SceneElement, SketchScene } from './sketch-scene'

const CONNECTORS = new Set(['arrow', 'line'])

const bindingOf = (element: SceneElement, end: 'startBinding' | 'endBinding') =>
  (element[end] as { elementId?: unknown } | null | undefined)?.elementId

/** The ids `ops` lean on in `scene`. */
function leanedOn(scene: SketchScene, ops: readonly SketchEditOp[]): Set<string> {
  const named = new Set(idsNamedBy(ops))
  const removed = new Set(ops.flatMap((op) => (op.op === 'remove' ? [op.id] : [])))
  const out = new Set(named)
  const taken = new Set<string>()
  for (const element of scene.elements) {
    if (element.isDeleted) continue
    if (typeof element.containerId === 'string' && named.has(element.containerId)) out.add(element.id)
    if (CONNECTORS.has(element.type) && [bindingOf(element, 'startBinding'), bindingOf(element, 'endBinding')].some((id) => removed.has(id as string))) {
      out.add(element.id)
      taken.add(element.id)
    }
  }
  for (const element of scene.elements) {
    if (!element.isDeleted && typeof element.containerId === 'string' && taken.has(element.containerId)) out.add(element.id)
  }
  return out
}

/** One element's state as a save leaves it: its version and nonce, or its content when it has none. */
function stateOf(element: SceneElement | undefined): string {
  if (!element || element.isDeleted) return 'gone'
  if (typeof element.version === 'number' && typeof element.versionNonce === 'number') return `${element.version}:${element.versionNonce}`
  return JSON.stringify(Object.entries(element).sort(([a], [b]) => a.localeCompare(b)))
}

/** The ids the edit leans on that differ between the Fassung it was made on and the current one; empty when it may rebase. */
export function changedUnderEdit(base: SketchScene, current: SketchScene, ops: readonly SketchEditOp[]): string[] {
  const before = new Map(base.elements.map((element) => [element.id, element]))
  const now = new Map(current.elements.map((element) => [element.id, element]))
  const ids = new Set([...leanedOn(base, ops), ...leanedOn(current, ops)])
  return [...ids].filter((id) => stateOf(before.get(id)) !== stateOf(now.get(id)))
}
