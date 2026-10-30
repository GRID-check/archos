/**
 * The wire of `GET` and `PUT /api/documents/[id]/sketch` (ADR-0148), shared by
 * the route, the agent catalog (`bff/agent-api/catalog/documents.ts`) and the
 * browser's client (`ui/features/diagrams/sketch/sketch-document-client.ts`).
 */

import { z } from 'zod'
import type { ResolvedSketchLink } from './sketch-links'
import type { SketchOutline } from './sketch-outline'
import type { SceneElement } from './sketch-scene'
import type { SketchScene } from './sketch-scene'

export const saveSketchSchema = z.object({
  scene: z
    .looseObject({
      type: z.literal('excalidraw'),
      elements: z.array(z.unknown()),
    })
    .describe(
      'The whole Excalidraw scene from document-sketch-get, with your changes: keep each element’s `id`; ' +
        'optional `appState`; no `files` (no images).'
    ),
  baseVersionId: z
    .string()
    .min(1)
    .max(64)
    .nullable()
    .describe('The `versionId` document-sketch-get returned. A newer one answers 409: read again, redo the change'),
  baseContentHash: z
    .string()
    .min(1)
    .max(100)
    .nullable()
    .optional()
    .describe('The `contentHash` document-sketch-get returned'),
})

export type SaveSketchBody = z.infer<typeof saveSketchSchema>

/** At most this many elements in one focused read (`?ids=`). */
export const MAX_FOCUSED_IDS = 200

/** The query of `GET /api/documents/[id]/sketch` (beside `?probe=1`, the Files preview's, which is no operation). */
export const sketchReadQuerySchema = z.object({
  scene: z
    .enum(['include', 'omit'])
    .optional()
    .describe('`omit`: the outline without the scene.'),
  ids: z
    .string()
    .max(MAX_FOCUSED_IDS * 65)
    .optional()
    .describe(
      `Comma-separated element ids: answers those \`elements\` whole, no scene (at most ${MAX_FOCUSED_IDS}).`
    ),
})

export interface SketchReadOptions {
  scene: boolean
  ids: string[] | null
}

/** What a read asks for; a focused read (`ids`) carries no scene. */
export function sketchReadOptions(query: z.infer<typeof sketchReadQuerySchema>): SketchReadOptions {
  const ids = query.ids
    ? [...new Set(query.ids.split(',').map((id) => id.trim()).filter(Boolean))].slice(0, MAX_FOCUSED_IDS)
    : null
  return { scene: query.scene !== 'omit' && ids === null, ids }
}

/**
 * The saving editor's peer id in the document room, a header beside the body:
 * the server tells the room of every save (`scene.saved`) stamped with it, so
 * the saving tab hears no echo. Not part of the operation: an agent has no tab.
 */
export const ROOM_PEER_HEADER = 'x-room-peer-id'

/** What `GET` answers. */
export interface SketchDocumentView {
  documentId: string
  /** The Fassung read, to send back as `baseVersionId`; `null` for a sketch filed before it had Fassungen. */
  versionId: string | null
  /** Whether the reader may save a Fassung (and edit live): otherwise the editor only shows. */
  canWrite: boolean
  title: string
  /** The project the Skizze lies in; `null` in the Büroablage. Where the editor's „Verknüpfen“ looks. */
  projectId: string | null
  /** Before the scene, so a reader cut off at a size limit still has it. */
  outline: SketchOutline
  /**
   * The outline's links as this reader sees them: `available` with a title and
   * where it leads, or `unavailable` (gone, or not theirs to open) with nothing more.
   */
  links: ResolvedSketchLink[]
  /** The whole scene; absent for `?scene=omit` and for a focused read. */
  scene?: SketchScene
  /** For `?ids=`: those elements whole, in scene order; an id that is not drawn is left out. */
  elements?: SceneElement[]
  /**
   * What a save writes: `published`, the next current Fassung; `draft`, the open
   * Freigabe draft this view was read from (`versionId` is the draft's); or
   * `review_open`, nothing, because a version is in review (409 `review_open`).
   */
  saveTarget: 'published' | 'draft' | 'review_open'
  /** The draft's content hash, to send back as `baseContentHash`; `null` otherwise. */
  contentHash: string | null
}

/** What `GET ?probe=1` answers: whether to offer the editor, and nothing of the drawing. */
export interface SketchProbe {
  hasScene: boolean
  canWrite: boolean
  versionId: string | null
}

/** What `PUT` answers. */
export interface SavedSketch {
  documentId: string
  versionId: string
  versionNumber: number
  /** `published`: the save is the current Fassung; `draft`: it went into the open Freigabe draft. */
  state: 'published' | 'draft'
  /** The saved bytes' hash: the next save's `baseContentHash` when it went into a draft. */
  contentHash: string | null
  /** The PDF companion's new Fassung, or `null` when there is none or it could not be redrawn. */
  pdf: { documentId: string; versionId: string } | null
  /** True when there is a PDF beside the sketch and it could not be drawn again: it still shows an earlier version. */
  pdfStale: boolean
}
