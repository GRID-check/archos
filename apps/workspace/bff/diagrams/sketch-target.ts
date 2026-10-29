/**
 * Where a save of a Skizze goes, given its Freigabe state (ADR-0148, ADR-0104):
 *
 *   - `published`: no round is open; the save is the next current Fassung.
 *   - `draft`: a draft is open (`draft`, or `changes_requested` once a reviewer
 *     sent it back); the editor opens it and a save writes into it.
 *   - `review_open`: a version is `in_review` (or `approved`, from before
 *     approval became one step); the reviewer is reading those bytes, so a save
 *     is refused with that reason.
 *
 * One read of the document's bounded version list (`listDocumentVersions`).
 */

import 'server-only'
import type { DocumentVersion } from '@/lib/db/schema/document-versions'
import type { Document } from '@/lib/db/schema/documents'
import { listDocumentVersions } from '@/lib/documents/version-repository'

export type SketchTarget =
  | { kind: 'published' }
  | { kind: 'draft'; version: DocumentVersion }
  | { kind: 'review_open'; version: DocumentVersion }

const DRAFT_STATES: ReadonlySet<string> = new Set(['draft', 'changes_requested'])
const IN_REVIEW_STATES: ReadonlySet<string> = new Set(['in_review', 'approved'])

export async function sketchTargetOf(document: Pick<Document, 'id' | 'organizationId'>): Promise<SketchTarget> {
  const versions = await listDocumentVersions(document.id, document.organizationId)
  const reviewed = versions.find((version) => IN_REVIEW_STATES.has(version.state))
  if (reviewed) return { kind: 'review_open', version: reviewed }
  const draft = versions.find((version) => DRAFT_STATES.has(version.state))
  return draft ? { kind: 'draft', version: draft } : { kind: 'published' }
}
