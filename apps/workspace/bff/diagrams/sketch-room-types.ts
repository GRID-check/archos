/**
 * The sketch's share of the document room (`doc:<id>`, ADR-0110 and its
 * amendment of 2026-10-29): what two people editing one Skizze say to each
 * other while they draw.
 *
 * A Skizze is a document (ADR-0148), so its editor joins the room every
 * document has; this file only adds the words a canvas needs, composed into
 * `lib/annotations/room-types.ts`. Three classes, as on every channel:
 *
 * - **motion** (`scene`, `sceneSelection`): a pointer on the canvas in scene
 *   coordinates, and which elements are selected. Throttled, shed under load,
 *   worth nothing a moment later.
 * - **edits** (`delta`): the elements that changed since the sender last
 *   said, with Excalidraw's own `version` and `versionNonce`, merged on
 *   arrival by `reconcileElements` (last writer wins per element). A delta is
 *   a hint towards the same scene, never the record: the record is the
 *   Fassung a save writes (`PUT /api/documents/{id}/sketch`). Only a writer
 *   may send one (`document-channel.ts`, the `sketch-edit` lane).
 * - **repair** (`hash`, `want`, and a `delta` with `full`): a peer says what
 *   its scene hashes to; a peer whose scene differs asks for the whole of it,
 *   which comes back in parts. `saved` tells the room a Fassung was written,
 *   so everyone moves their base to it.
 *
 * No `server-only`: the browser parses these.
 */

import { z } from 'zod'
import { realtimePeerSchema } from '@/lib/realtime/types'

/** The fastest a canvas sends its pointer, as the document room's pointer. */
export const SCENE_POINTER_INTERVAL_MS = 80
/** The fastest a canvas sends its selection. */
export const SCENE_SELECTION_INTERVAL_MS = 150
/** The most element ids one selection names; a larger selection is cut, never refused. */
export const SCENE_SELECTION_MAX = 500
/** The most elements one delta carries; a larger change goes in several. */
export const SKETCH_DELTA_MAX_ELEMENTS = 400
/**
 * The most bytes one delta's elements may weigh, as JSON. One element over it
 * (a freehand line of thousands of points) does not travel live at all; it
 * reaches the others through the next Fassung.
 */
export const SKETCH_DELTA_MAX_BYTES = 64 * 1024
/** The most parts a full-scene answer is split into: 64 × 64 KB is past the scene's own 512 KiB cap. */
export const SKETCH_FULL_MAX_PARTS = 64

/** Element types that never travel: the SVG validator refuses them, and an embed is a third-party page. */
export const SKETCH_REFUSED_TYPES = ['image', 'embeddable', 'iframe'] as const

const coordinate = z.number().finite().min(-1e7).max(1e7)
const elementId = z.string().min(1).max(64)
/** A document version id; null while the scene has no Fassung the editor knows of. */
const versionIdSchema = z.string().min(1).max(64).nullable()
const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)
/** `hashElementsVersion`: an unsigned 32-bit number. */
const sceneHashSchema = z.number().int().min(0).max(0xffff_ffff)

export const SCENE_TOOLS = ['pointer', 'laser'] as const
export const SCENE_BUTTONS = ['up', 'down'] as const

/** A canvas pointer, in scene coordinates; `pointer: null` when it left the canvas. */
export const scenePointerSchema = z.object({
  pointer: z.object({ x: coordinate, y: coordinate }).nullable(),
  tool: z.enum(SCENE_TOOLS),
  button: z.enum(SCENE_BUTTONS),
})
export type ScenePointer = z.infer<typeof scenePointerSchema>

export const sceneSelectionSchema = z.array(elementId).max(SCENE_SELECTION_MAX)

/**
 * One element as it travels: what the merge reads is named, the rest of
 * Excalidraw's element passes through untouched (and is restored on arrival,
 * `restoreElements`, so a malformed one is repaired rather than drawn).
 */
export const wireElementSchema = z
  .object({
    id: elementId,
    type: z
      .string()
      .min(1)
      .max(32)
      .refine((type) => !(SKETCH_REFUSED_TYPES as readonly string[]).includes(type), 'this element type does not travel'),
    version: z.number().int().min(0),
    versionNonce: z.number().int(),
    isDeleted: z.boolean(),
    /** The fractional index Excalidraw orders the scene by. */
    index: z.string().max(256).nullable(),
  })
  .passthrough()
export type WireElement = z.infer<typeof wireElementSchema>

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

const elementsSchema = z
  .array(wireElementSchema)
  .max(SKETCH_DELTA_MAX_ELEMENTS)
  .superRefine((elements, context) => {
    if (byteLength(elements) > SKETCH_DELTA_MAX_BYTES) {
      context.addIssue({ code: 'custom', message: `a delta weighs at most ${SKETCH_DELTA_MAX_BYTES} bytes` })
    }
  })

/** Which part of a full-scene answer a delta is. */
export const fullPartSchema = z
  .object({ requestId: requestIdSchema, part: z.number().int().min(0), of: z.number().int().min(1).max(SKETCH_FULL_MAX_PARTS) })
  .refine((full) => full.part < full.of, 'part is past the last')

export const sceneDeltaSchema = z.object({
  /** The Fassung the sender's scene started from. */
  base: versionIdSchema,
  /** The sender's count of deltas; a gap tells the receiver it missed one. */
  seq: z.number().int().min(0),
  /** Present when the delta is a part of a full-scene answer to a `want`. */
  full: fullPartSchema.optional(),
  elements: elementsSchema,
})
export type SceneDelta = z.infer<typeof sceneDeltaSchema>

export const sceneHashBeaconSchema = z.object({ base: versionIdSchema, sceneHash: sceneHashSchema, count: z.number().int().min(0) })
export type SceneHashBeacon = z.infer<typeof sceneHashBeaconSchema>

export const sceneWantSchema = z.object({ requestId: requestIdSchema, base: versionIdSchema })
export type SceneWant = z.infer<typeof sceneWantSchema>

export const sceneSavedSchema = z.object({ versionId: z.string().min(1).max(64), sceneHash: sceneHashSchema })
export type SceneSaved = z.infer<typeof sceneSavedSchema>

/** The fields a browser may add to a room post, composed into `roomPostSchema`. */
export const sketchPostFields = {
  /** The canvas pointer. Motion. */
  scene: scenePointerSchema.optional(),
  /** The selected elements' ids. Motion. */
  sceneSelection: sceneSelectionSchema.optional(),
  /** Changed elements. Only a writer sends one. */
  delta: sceneDeltaSchema.optional(),
  /** What this tab's scene hashes to. */
  hash: sceneHashBeaconSchema.optional(),
  /** Ask the room for the whole scene. */
  want: sceneWantSchema.optional(),
  /** A Fassung was written. Only a writer sends one. */
  saved: sceneSavedSchema.optional(),
}

/** The post fields only a writer may send: the `sketch-edit` lane. */
export const SKETCH_EDIT_FIELDS = ['delta', 'saved'] as const

/** The room events the sketch fields become, each stamped with its sender. Composed into `roomEventSchema`. */
export const sketchEventSchemas = [
  z.object({ kind: z.literal('scene.pointer'), peer: realtimePeerSchema, ...scenePointerSchema.shape }),
  z.object({ kind: z.literal('scene.selection'), peer: realtimePeerSchema, selected: sceneSelectionSchema }),
  z.object({ kind: z.literal('scene.delta'), peer: realtimePeerSchema, ...sceneDeltaSchema.shape }),
  z.object({ kind: z.literal('scene.hash'), peer: realtimePeerSchema, ...sceneHashBeaconSchema.shape }),
  z.object({ kind: z.literal('scene.want'), peer: realtimePeerSchema, ...sceneWantSchema.shape }),
  z.object({ kind: z.literal('scene.saved'), peer: realtimePeerSchema, ...sceneSavedSchema.shape }),
] as const

type SketchEventUnion = z.infer<(typeof sketchEventSchemas)[number]>
export type SketchRoomEvent = SketchEventUnion
export type SketchRoomEventKind = SketchRoomEvent['kind']

export interface SketchPost {
  scene?: ScenePointer
  sceneSelection?: string[]
  delta?: SceneDelta
  hash?: SceneHashBeacon
  want?: SceneWant
  saved?: SceneSaved
}

type Peer = z.infer<typeof realtimePeerSchema>

/** The events a post's sketch fields become, in a fixed order. */
export function sketchEventsOf(post: SketchPost, peer: Peer): SketchRoomEvent[] {
  const events: SketchRoomEvent[] = []
  if (post.scene) events.push({ kind: 'scene.pointer', peer, ...post.scene })
  if (post.sceneSelection) events.push({ kind: 'scene.selection', peer, selected: post.sceneSelection })
  if (post.delta) events.push({ kind: 'scene.delta', peer, ...post.delta })
  if (post.hash) events.push({ kind: 'scene.hash', peer, ...post.hash })
  if (post.want) events.push({ kind: 'scene.want', peer, ...post.want })
  if (post.saved) events.push({ kind: 'scene.saved', peer, ...post.saved })
  return events
}
