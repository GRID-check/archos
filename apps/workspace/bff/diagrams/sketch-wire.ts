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
      'The whole Excalidraw scene, as document-sketch-get returned it with your changes: `type: "excalidraw"`, ' +
        '`elements` (keep each element’s `id`), optional `appState`. No `files`: a sketch carries no images.'
    ),
  svg: z
    .string()
    .min(1)
    .max(MAX_DIAGRAM_SVG_BYTES)
    .describe('The picture of that scene as SVG (Excalidraw’s exportToSvg); it is checked by the server’s SVG rules'),
  baseVersionId: z
    .string()
    .min(1)
    .max(64)
    .nullable()
    .describe(
      'The `versionId` document-sketch-get returned: the version these changes start from. A newer one answers 409 ' +
        'with `currentVersionId`; read again and redo the change on it'
    ),
})

export type SaveSketchBody = z.infer<typeof saveSketchSchema>

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
}

/** What `PUT` answers. */
export interface SavedSketch {
  documentId: string
  versionId: string
  versionNumber: number
  /** The PDF companion's new Fassung, or `null` when there is none or it could not be redrawn. */
  pdf: { documentId: string; versionId: string } | null
}
