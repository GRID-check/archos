/**
 * The wire of `GET` and `PUT /api/documents/[id]/sketch` (ADR-0148), shared by
 * the route, the agent catalog (`bff/agent-api/catalog/documents.ts`) and the
 * browser's client (`ui/features/diagrams/sketch/sketch-document-client.ts`).
 */

import { z } from 'zod'
import { MAX_DIAGRAM_SVG_BYTES } from './diagram-sources'
import type { SketchOutline } from './sketch-outline'
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
  svg: z
    .string()
    .min(1)
    .max(MAX_DIAGRAM_SVG_BYTES)
    .describe('That scene as SVG (Excalidraw’s exportToSvg), checked by the server’s SVG rules'),
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
  scene: SketchScene
  outline: SketchOutline
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
