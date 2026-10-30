/**
 * One path makes a Fassung current, and this is what follows once it has
 * committed (`docs/architecture/revisions.md`, „One path makes a Fassung
 * current").
 *
 * Every way a document gets a new current Fassung runs it: a Freigabe that
 * publishes a draft and an upload of a new Fassung (the `announceCurrentVersion`
 * effect of every promoting row in `./lifecycle-types.ts`), and a Skizze's save
 * (`lib/diagrams/sketch-version.ts`). Inside the publishing transaction the
 * repository has already carried the pinned marks (`./published-version.ts`);
 * here the room hears of it:
 *
 *   - `annotations.changed` for the marks that moved, so an open review reads
 *     them again;
 *   - for a Skizze, `scene.saved` with the scene's hash, so every open canvas
 *     compares and merges the Fassung in (`ui/features/diagrams/sketch/sketch-sync.ts`).
 *     A save hands in the hash it holds; a Freigabe that made a draft current
 *     has no scene at hand, so the Skizze's own step reads it from the bytes,
 *     places the marks on it and draws its PDF again (`lib/diagrams/sketch-promoted.ts`),
 *     only for bytes screening let through, and retried by a job when it fails;
 *   - `version.published`, so a preview shows the new picture and timeline.
 *
 * For a Skizze it also scores the carry (`sketch-pins-kept`): the share of the
 * pins that moved and are still on an element.
 *
 * Never throws: the Fassung is committed, and a lost hint costs a stale view
 * until the next read, never the publish.
 */

import 'server-only'
import { randomBytes } from 'node:crypto'
import type { MovedSketchMarks, NextSketch } from '@/lib/annotations/sketch-carry'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { DocumentVersion } from '@/lib/db/schema/document-versions'
import type { Document } from '@/lib/db/schema/documents'
import { publishToDocumentRoom } from '@/lib/realtime/document-channel'
import { recordSketchPinsKeptScore } from '@/lib/langfuse/sketch-score'
import { versionBytesPassedScreening } from './document-reader'

export interface CurrentFassungInput {
  session: AuthorizedSession
  document: Document
  /** The version now current. */
  version: DocumentVersion
  carried: MovedSketchMarks
  /** A Skizze's save: the hash of the scene it wrote, and the saving tab, which hears no echo. */
  scene?: { sceneHash: number; peerId: string | null }
}

/**
 * A Skizze the sketch editor saves: Piloti filed it, and its SVG carries a
 * scene. Never a person's upload, whatever its producer column says: a
 * person's bytes are an upload, held until screened (ADR-0086), and never the
 * source of a machine-authored PDF.
 */
export const isFiledSketch = (document: Pick<Document, 'authoredBy' | 'authoredByProducer' | 'contentType'>) =>
  document.authoredBy !== 'user' && document.authoredByProducer === 'diagram_svg' && document.contentType === 'image/svg+xml'

/** A filed Skizze's Fassung whose bytes may be drawn into its PDF and placed under its marks: screening let them through. */
export const isReleasableSketch = (document: Document, version: DocumentVersion) =>
  isFiledSketch(document) && versionBytesPassedScreening(document, version)

/**
 * The scene a Fassung about to be promoted carries, for the repository to place
 * the pinned marks on in the publishing transaction (`./published-version.ts`).
 * A version in review is frozen (no row updates it), so these are the bytes the
 * promotion makes current. Null when it is no releasable Skizze, carries no
 * scene, or cannot be read: the step after the commit places them then.
 */
export async function sketchToPlace(document: Document, version: DocumentVersion): Promise<NextSketch | null> {
  if (!isReleasableSketch(document, version)) return null
  const { promotedSketchOf } = await import('@/lib/diagrams/sketch-promoted')
  return promotedSketchOf(version).then(
    (sketch) => sketch?.next ?? null,
    () => null
  )
}

export async function versionBecameCurrent(input: CurrentFassungInput): Promise<void> {
  const { session, document, version } = input
  try {
    let scene = input.scene ?? null
    const marks = new Set(input.carried.moved)
    let lost = input.carried.lost.length
    if (!scene && isReleasableSketch(document, version)) {
      const { releasedSketch } = await import('@/lib/diagrams/sketch-promoted')
      const promoted = await releasedSketch(session, document, version)
      if (promoted) {
        scene = { sceneHash: promoted.sceneHash, peerId: null }
        for (const id of promoted.placed) marks.add(id)
        lost = promoted.lost.length
      }
    }
    const actor = { userId: session.userId, name: session.name ?? session.email, kind: 'person' as const }
    if (marks.size > 0) {
      await publishToDocumentRoom(document.id, {
        kind: 'annotations.changed',
        annotationIds: [...marks],
        change: 'updated',
        actor: { ...actor, peerId: null },
      })
    }
    if (scene) {
      await publishToDocumentRoom(document.id, {
        kind: 'scene.saved',
        peer: { ...actor, peerId: scene.peerId ?? `save_${randomBytes(6).toString('hex')}` },
        versionId: version.id,
        sceneHash: scene.sceneHash,
      })
    }
    await publishToDocumentRoom(document.id, { kind: 'version.published', versionId: version.id, actor: { ...actor, peerId: scene?.peerId ?? null } })
    if (isFiledSketch(document) && document.authoredByRef) {
      // Carry-forward, observable (ADR-0089): how many pins are still on an element. Not awaited; never rejects.
      void recordSketchPinsKeptScore({
        organizationId: session.organizationId,
        documentId: document.id,
        answerRef: document.authoredByRef,
        versionId: version.id,
        moved: marks.size,
        lost,
        path: input.scene ? 'save' : 'publish',
      })
    }
  } catch (error) {
    console.error('[documents] a Fassung became current and its room was not told', {
      documentId: document.id,
      versionId: version.id,
      cause: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown',
    })
  }
}
