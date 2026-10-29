/**
 * A saved scene, made safe to merge with the canvases still open on the
 * Fassung before it (ADR-0148; the merge is `ui/features/diagrams/sketch/sketch-sync.ts`).
 *
 * An open canvas merges a newer Fassung element by element with Excalidraw's
 * `reconcileElements`: the higher `version` wins, the lower `versionNonce` on a
 * tie. The editor bumps both on every edit, so its saves merge as they should.
 * A scene written by anyone else, an agent through `document-sketch-update`
 * most of all, keeps the versions it read and simply leaves out what it
 * removed, and both would be lost in the merge: a changed label at the same
 * version loses half the time, and a missing element is no instruction to
 * delete it, so the stale canvas keeps it and its next save writes it back.
 *
 * So the save is compared with the scene it replaces, here, whoever wrote it:
 *
 * - an element whose content changed and whose `version` did not pass the
 *   stored one's gets the next version and a fresh nonce;
 * - an element without a numeric `version` or `versionNonce` gets them;
 * - an element the stored scene drew and the save leaves out stays, as a
 *   tombstone (`isDeleted`, the next version), so a canvas that still holds it
 *   drops it on merge.
 *
 * For a save from the editor this changes nothing but the tombstones: its
 * edits already carry their versions. Tombstones live one Fassung: the editor
 * writes only what it draws, so the next save from it leaves them out again.
 * Pure: the nonce comes from the caller.
 */

import type { SceneElement, SketchScene } from './sketch-scene'

/** Fields that are bookkeeping, not content: a change to only these is no edit. */
const BOOKKEEPING = new Set(['version', 'versionNonce', 'updated', 'seed'])

/** The element's content as one string, key order aside. */
function contentOf(element: SceneElement): string {
  const keys = Object.keys(element)
    .filter((key) => !BOOKKEEPING.has(key))
    .sort()
  return JSON.stringify(keys.map((key) => [key, element[key]]))
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export interface RevisedScene {
  scene: SketchScene
  /** How many elements got a version they did not bring. */
  bumped: number
  /** How many elements the save left out, kept as tombstones. */
  tombstoned: number
}

/** `next`, versioned against `stored` as above. `nonce()` is a random 31-bit integer, as Excalidraw's. */
export function reviseScene(stored: SketchScene | null, next: SketchScene, nonce: () => number, now = Date.now()): RevisedScene {
  const before = new Map((stored?.elements ?? []).map((element) => [element.id, element] as const))
  let bumped = 0
  const elements = next.elements.map((element) => {
    const old = before.get(element.id)
    const version = isNumber(element.version) ? element.version : 1
    const fresh = !isNumber(element.version) || !isNumber(element.versionNonce)
    const changed = old !== undefined && version <= Number(old.version ?? 0) && contentOf(old) !== contentOf(element)
    if (!fresh && !changed) return element
    bumped++
    return {
      ...element,
      version: changed ? Number(old.version ?? 0) + 1 : version,
      versionNonce: nonce(),
      updated: now,
    }
  })
  const kept = new Set(next.elements.map((element) => element.id))
  const tombstones = (stored?.elements ?? [])
    .filter((element) => !element.isDeleted && !kept.has(element.id))
    .map((element) => ({ ...element, isDeleted: true, version: Number(element.version ?? 0) + 1, versionNonce: nonce(), updated: now }))
  return {
    scene: { ...next, elements: [...elements, ...tombstones] },
    bumped,
    tombstoned: tombstones.length,
  }
}

/** The scene without the tombstones {@link reviseScene} added: what a save keeps when they do not fit. */
export function withoutTombstones(revised: RevisedScene, next: SketchScene): SketchScene {
  return { ...revised.scene, elements: revised.scene.elements.slice(0, next.elements.length) }
}
