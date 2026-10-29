/**
 * A Skizze's Fassung made current by Freigabe, not by a save: the step of
 * `lib/documents/current-version.ts` that only a Skizze has.
 *
 * A save holds the scene it writes, so its marks are placed in the publishing
 * transaction and its PDF is drawn from the accepted SVG (`./sketch-document.ts`).
 * A Freigabe publishes a draft whose bytes the transition never reads: the
 * repository moved the pinned marks onto it keeping their boxes
 * (`lib/documents/published-version.ts`), and this step reads the promoted
 * bytes once to place them on the promoted scene and to draw the PDF beside the
 * Skizze from them (`./sketch-companion.ts`), so the rendition is of the
 * released drawing, not of the one it replaced.
 */

import 'server-only'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { viewBoxOf } from '@/lib/annotations/sketch-anchor'
import { moveSketchMarks } from '@/lib/annotations/sketch-carry'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getDb } from '@/lib/db'
import type { DocumentVersion } from '@/lib/db/schema/document-versions'
import type { Document } from '@/lib/db/schema/documents'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import { s3Client } from '@/lib/s3'
import { resolveDocumentBucket } from '@/lib/storage/bucket'
import { redrawCompanionPdf } from './sketch-companion'
import { parseStoredSketchScene, sceneHashOf } from './sketch-scene'
import { storedDiagramSource } from './stored-source'
import { parseDiagramSvg } from './svg'

/** The promoted Fassung's bytes as text, or null when they cannot be read. */
async function readVersionText(version: DocumentVersion): Promise<string | null> {
  try {
    const object = await s3Client.send(
      new GetObjectCommand({ Bucket: resolveDocumentBucket(version.storageBucket), Key: version.storageKey })
    )
    return (await object.Body?.transformToString('utf8')) ?? null
  } catch {
    return null
  }
}

/**
 * Place the pins on the promoted scene and draw the PDF again. Null when the
 * bytes carry no scene (a mermaid diagram filed as SVG): nothing to place.
 */
export async function sketchBecameCurrent(
  session: AuthorizedSession,
  document: Document,
  version: DocumentVersion
): Promise<{ sceneHash: number; placed: string[]; lost: string[] } | null> {
  const text = await readVersionText(version)
  const stored = text ? storedDiagramSource(text) : null
  const scene = stored?.kind === 'excalidraw' ? parseStoredSketchScene(stored.source) : null
  if (!text || !scene) return null
  const placed = await getDb().transaction((tx) =>
    moveSketchMarks(tx, {
      organizationId: session.organizationId,
      documentId: document.id,
      toVersionId: version.id,
      sketch: { elements: scene.elements, viewBox: viewBoxOf(text) },
      mode: 'place',
    })
  )
  const drawing = parseDiagramSvg(text)
  // The marking is the office's language: a transition carries no reader's locale.
  await redrawCompanionPdf({
    session,
    sketch: document,
    svgVersionId: version.id,
    drawing,
    marking: diagramsCopy.messages.de.markingEdited,
    title: (document.displayName ?? document.filename).replace(/\.svg$/i, ''),
  })
  return { sceneHash: sceneHashOf(scene.elements), placed: placed.moved, lost: placed.lost }
}
