/**
 * A Skizze's Fassung made current by Freigabe, not by a save: the step of
 * `lib/documents/current-version.ts` that only a Skizze has.
 *
 * A save holds the scene it writes, so its marks are placed in the publishing
 * transaction and its PDF is drawn from the accepted SVG (`./sketch-document.ts`).
 * A Freigabe publishes a version in review, whose bytes no row may change any
 * more: the transition reads them before its transaction ({@link promotedSketchOf})
 * and the repository places the pinned marks on that scene as it publishes
 * (`lib/documents/published-version.ts`). Once it committed, this step reads
 * the bytes again to draw the PDF beside the Skizze from them
 * (`./sketch-companion.ts`), so the rendition is of the released drawing, and
 * places the marks once more, which changes nothing when the first placing
 * ran and repairs the boxes when its read failed.
 *
 * Only bytes screening let through reach here (`isReleasableSketch`, ADR-0086).
 *
 * ## A failure is seen and retried
 *
 * The Fassung is committed whatever this step does. When the bytes cannot be
 * read or the PDF cannot be drawn, the outcome is scored (`sketch-released`,
 * `lib/langfuse/sketch-score.ts`) and a `sketch_rendition` job runs the step
 * again as the person who released it ({@link runSketchRenditionSlice}), until
 * it lands, a newer Fassung draws its own, or the queue's attempts run out.
 */

import 'server-only'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { viewBoxOf } from '@/lib/annotations/sketch-anchor'
import { moveSketchMarks, type NextSketch } from '@/lib/annotations/sketch-carry'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getDb } from '@/lib/db'
import type { DocumentVersion } from '@/lib/db/schema/document-versions'
import type { Document } from '@/lib/db/schema/documents'
import { defaultLocale, isLocale } from '@/i18n/config'
import { diagramsCopy } from '@/i18n/namespaces/diagrams'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { getAccessibleDocument } from '@/lib/documents/access'
import { findDocumentVersion } from '@/lib/documents/version-repository'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { requesterOf, type JobSliceResult, type SketchRenditionPayload } from '@/lib/jobs-queue/types'
import { recordSketchReleasedScore, type SketchReleasedOutcome } from '@/lib/langfuse/sketch-score'
import { findOrganization } from '@/lib/organizations/repository'
import { publishToDocumentRoom } from '@/lib/realtime/document-channel'
import { s3Client } from '@/lib/s3'
import { resolveDocumentBucket } from '@/lib/storage/bucket'
import { redrawCompanionPdf, type CompanionPdfOutcome } from './sketch-companion'
import { parseStoredSketchScene, sceneHashOf, type SketchScene } from './sketch-scene'
import { storedDiagramSource } from './stored-source'
import { parseDiagramSvg } from './svg'
import { liftUnderlayImage } from './sketch-underlay-svg'
import { underlayForRendition } from './sketch-underlay-access'
import { aiDrewOn, sketchNoticeFor, sketchNoticesOf } from './sketch-notice'

/** A promoted Fassung's bytes as text. Throws when they cannot be read: that is a failure to retry, not a Skizze without a scene. */
async function readVersionText(version: Pick<DocumentVersion, 'storageBucket' | 'storageKey'>): Promise<string> {
  const object = await s3Client.send(
    new GetObjectCommand({ Bucket: resolveDocumentBucket(version.storageBucket), Key: version.storageKey })
  )
  const text = await object.Body?.transformToString('utf8')
  if (text === undefined) throw new Error('the promoted sketch has no bytes')
  return text
}

/** The text of a Skizze's Fassung, its scene, and the scene as its marks are placed on it. */
export interface PromotedSketch {
  text: string
  scene: SketchScene
  next: NextSketch
}

/** The scene a Fassung's bytes carry, or null when they carry none (a mermaid diagram filed as SVG). Throws when they cannot be read. */
export async function promotedSketchOf(version: Pick<DocumentVersion, 'storageBucket' | 'storageKey'>): Promise<PromotedSketch | null> {
  const text = await readVersionText(version)
  const stored = storedDiagramSource(text)
  const scene = stored?.kind === 'excalidraw' ? parseStoredSketchScene(stored.source) : null
  return scene ? { text, scene, next: { elements: scene.elements, viewBox: viewBoxOf(text) } } : null
}

/**
 * A stored Skizze's picture for its PDF: the vector half through the validator,
 * the page it is traced over lifted out first (S6), and drawn only while it is
 * the server's raster of screened bytes this session may read; else the sheet
 * is blank (`underlayForRendition`).
 */
async function drawingOf(session: AuthorizedSession, sketch: PromotedSketch) {
  const { svg, underlay } = liftUnderlayImage(sketch.text)
  return { ...parseDiagramSvg(svg), underlay: await underlayForRendition(session, sketch.scene, underlay) }
}

/**
 * The Skizze's line in the office's language: a transition carries no reader's
 * locale, so the office's choice, else the product's default. Who drew it is
 * read from its reference and its bytes (`sketch-notice.ts`).
 */
async function officeMarking(organizationId: string, ref: string, text: string): Promise<{ marking: string; aiAssisted: boolean }> {
  const organization = await findOrganization(organizationId).catch(() => null)
  const locale = isLocale(organization?.defaultLocale) ? organization.defaultLocale : defaultLocale
  const voiced = sketchNoticeFor(ref, sketchNoticesOf(diagramsCopy.messages[locale]), aiDrewOn(text))
  return { marking: voiced.notice, aiAssisted: voiced.aiAssisted }
}

export interface SketchRendition {
  sceneHash: number
  placed: string[]
  lost: string[]
  pdf: CompanionPdfOutcome
}

/**
 * Place the pins on the promoted scene and draw the PDF again. Null when the
 * bytes carry no scene: nothing to place or draw. Throws when they cannot be read.
 */
export async function sketchBecameCurrent(
  session: AuthorizedSession,
  document: Document,
  version: DocumentVersion
): Promise<SketchRendition | null> {
  const sketch = await promotedSketchOf(version)
  if (!sketch) return null
  const placed = await getDb().transaction((tx) =>
    moveSketchMarks(tx, {
      organizationId: session.organizationId,
      documentId: document.id,
      toVersionId: version.id,
      sketch: sketch.next,
      mode: 'place',
    })
  )
  const { outcome } = await redrawCompanionPdf({
    session,
    sketch: document,
    svgVersionId: version.id,
    drawing: await drawingOf(session, sketch),
    ...(await officeMarking(session.organizationId, document.authoredByRef ?? '', sketch.text)),
    title: (document.displayName ?? document.filename).replace(/\.svg$/i, ''),
  })
  return { sceneHash: sceneHashOf(sketch.scene.elements), placed: placed.moved, lost: placed.lost, pdf: outcome }
}

const causeOf = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : 'unknown')

/** Score one attempt of the step; `attempt` 1 is the release itself. Never rejects. */
function score(document: Document, version: DocumentVersion, outcome: SketchReleasedOutcome, attempt: number, queued: boolean) {
  if (!document.authoredByRef) return
  void recordSketchReleasedScore({
    organizationId: document.organizationId,
    documentId: document.id,
    answerRef: document.authoredByRef,
    versionId: version.id,
    outcome,
    attempt,
    queued,
  })
}

/**
 * {@link sketchBecameCurrent} right after a Freigabe, never throwing: a failure
 * is scored and handed to a `sketch_rendition` job. Null when there was
 * nothing to do or it failed; the room was told of the Fassung either way.
 */
export async function releasedSketch(
  session: AuthorizedSession,
  document: Document,
  version: DocumentVersion
): Promise<SketchRendition | null> {
  let done: SketchRendition | null = null
  let failed = false
  try {
    done = await sketchBecameCurrent(session, document, version)
    failed = done?.pdf === 'failed'
  } catch (error) {
    failed = true
    console.error('[diagrams] a released sketch could not be read for its PDF and marks', { documentId: document.id, cause: causeOf(error) })
  }
  const queued = failed && (await queueRendition(session, document, version))
  score(document, version, failed ? (done ? 'failed' : 'unreadable') : (done?.pdf ?? 'none'), 1, queued)
  return failed && !done ? null : done
}

async function queueRendition(session: AuthorizedSession, document: Document, version: DocumentVersion): Promise<boolean> {
  try {
    const payload: SketchRenditionPayload = { documentId: document.id, versionId: version.id, requester: requesterOf(session) }
    await enqueueJob({ kind: 'sketch_rendition', organizationId: session.organizationId, payload })
    return true
  } catch (error) {
    console.error('[diagrams] the retry of a released sketch was not queued', { documentId: document.id, cause: causeOf(error) })
    return false
  }
}

/**
 * `sketch_rendition`: the step again, as the person who released the Fassung.
 * Done, with nothing drawn, when the Fassung is no longer current (the save
 * that replaced it drew its own) or the person may no longer change the
 * Skizze; throws for the queue to retry while the bytes or the PDF fail.
 */
export async function runSketchRenditionSlice(
  session: AuthorizedSession,
  payload: SketchRenditionPayload,
  attempt = 2
): Promise<JobSliceResult<SketchRenditionPayload>> {
  const finished = { done: true, payload }
  const document = await getAccessibleDocument(session, payload.documentId, 'write').catch((error: unknown) => {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) return null
    throw error
  })
  if (!document || document.publishedVersionId !== payload.versionId) return finished
  const version = await findDocumentVersion(payload.versionId, document.id, session.organizationId)
  if (!version) return finished
  const done = await sketchBecameCurrent(session, document, version).catch((error: unknown) => {
    score(document, version, 'unreadable', attempt, true)
    throw error
  })
  score(document, version, done?.pdf ?? 'none', attempt, done?.pdf === 'failed')
  if (done?.pdf === 'failed') throw new Error('the PDF beside the released sketch was not drawn again')
  if (done && done.placed.length > 0) {
    const actor = { userId: session.userId, name: session.name ?? session.email, kind: 'person' as const, peerId: null }
    await publishToDocumentRoom(document.id, { kind: 'annotations.changed', annotationIds: done.placed, change: 'updated', actor })
  }
  return finished
}
