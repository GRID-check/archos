/**
 * A stored Excalidraw scene, checked before it is stored and when it is read
 * back (ADR-0148).
 *
 * The fence checker (`sketch-fence.ts`) holds what a MODEL may write: a skeleton
 * of at most 150 elements. A scene a person saved from the editor is a different
 * object, whole Excalidraw elements with versions, seeds and bindings, and it
 * may hold far more than a model writes. So this is not that checker run again.
 * It keeps that checker's vocabulary and its stance on what a sketch is:
 *
 *   - **The same element types**, plus `freedraw`, which only a hand makes. An
 *     `image`, an `embeddable` or an `iframe` is refused: the editor has no
 *     image tool and no embeds, and a scene that names one did not come from it.
 *   - **No files.** A sketch carries no binary payloads (the same reason).
 *   - **Bounded.** The byte cap is the excalidraw source cap the filing route
 *     already applies (`DIAGRAM_SOURCE_FACTS.excalidraw`); the element count,
 *     coordinates and text are bounded so a scene stays a sketch and its
 *     outline (`sketch-outline.ts`) stays a page.
 *
 * Only what is read later is checked; every other field Excalidraw writes is
 * kept as it came, so the editor reopens exactly what it saved.
 */

import { DIAGRAM_SOURCE_FACTS } from './diagram-sources'
import { SKETCH_ELEMENT_TYPES } from './sketch-fence'

export const MAX_SCENE_ELEMENTS = 2_000
export const MAX_SCENE_COORDINATE = 1_000_000
export const MAX_SCENE_TEXT_CHARS = 5_000

/** The element types a stored scene may hold: the fence's, and a hand's freehand line. */
export const SCENE_ELEMENT_TYPES: ReadonlySet<string> = new Set([...SKETCH_ELEMENT_TYPES, 'freedraw'])

export const SCENE_REFUSALS = [
  'too-large',
  'not-a-scene',
  'too-many-elements',
  'unsupported-element',
  'bad-coordinate',
  'text-too-long',
  'duplicate-id',
  'has-files',
] as const
export type SceneRefusal = (typeof SCENE_REFUSALS)[number]

export class SketchSceneError extends Error {
  constructor(
    readonly refusal: SceneRefusal,
    detail?: string,
  ) {
    super(detail ? `${refusal}: ${detail}` : refusal)
    this.name = 'SketchSceneError'
  }
}

/** One element as the outline reads it. Every other field is kept untouched. */
export interface SceneElement {
  readonly id: string
  readonly type: string
  readonly x: number
  readonly y: number
  readonly isDeleted?: boolean
  readonly text?: string
  readonly containerId?: string | null
  readonly frameId?: string | null
  readonly name?: string | null
  readonly startBinding?: { elementId: string } | null
  readonly endBinding?: { elementId: string } | null
  readonly [field: string]: unknown
}

export interface SketchScene {
  readonly type: 'excalidraw'
  readonly elements: readonly SceneElement[]
  readonly appState?: Record<string, unknown>
  readonly [field: string]: unknown
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkElement(raw: unknown, seen: Set<string>): void {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id || typeof raw.type !== 'string') {
    throw new SketchSceneError('not-a-scene', 'an element without id or type')
  }
  if (!SCENE_ELEMENT_TYPES.has(raw.type)) throw new SketchSceneError('unsupported-element', raw.type)
  if (seen.has(raw.id)) throw new SketchSceneError('duplicate-id', raw.id)
  seen.add(raw.id)
  for (const axis of ['x', 'y'] as const) {
    const value = raw[axis]
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_SCENE_COORDINATE) {
      throw new SketchSceneError('bad-coordinate', `${raw.id}.${axis}`)
    }
  }
  if (raw.text !== undefined && (typeof raw.text !== 'string' || [...raw.text].length > MAX_SCENE_TEXT_CHARS)) {
    throw new SketchSceneError('text-too-long', raw.id)
  }
}

function hasFiles(files: unknown): boolean {
  if (files === undefined || files === null) return false
  return !isObject(files) || Object.keys(files).length > 0
}

/**
 * Check a scene object and hand it back typed, or throw {@link SketchSceneError}.
 *
 * Deleted elements are counted against the cap like any other: they are bytes
 * in the file whether or not the canvas draws them.
 */
export function checkSketchScene(value: unknown): SketchScene {
  if (!isObject(value) || value.type !== 'excalidraw' || !Array.isArray(value.elements)) {
    throw new SketchSceneError('not-a-scene')
  }
  if (value.elements.length > MAX_SCENE_ELEMENTS) throw new SketchSceneError('too-many-elements')
  if (hasFiles(value.files)) throw new SketchSceneError('has-files')
  const seen = new Set<string>()
  for (const element of value.elements) checkElement(element, seen)
  if (value.appState !== undefined && !isObject(value.appState)) throw new SketchSceneError('not-a-scene', 'appState')
  return value as unknown as SketchScene
}

/** The scene as the text stored in the SVG's `<metadata>`, refused above the excalidraw source cap. */
export function serializeSketchScene(scene: SketchScene): string {
  const source = JSON.stringify(scene)
  const bytes = new TextEncoder().encode(source).byteLength
  const limit = DIAGRAM_SOURCE_FACTS.excalidraw.maxSourceBytes
  if (bytes > limit) throw new SketchSceneError('too-large', `${bytes} > ${limit}`)
  return source
}

/** Parse and check stored scene text; `null` when it is not a scene this product wrote. */
export function parseStoredSketchScene(source: string): SketchScene | null {
  try {
    return checkSketchScene(JSON.parse(source))
  } catch {
    return null
  }
}
