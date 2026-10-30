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
 *
 * {@link sketchOpeningFor} is what a writer's editor opens on it: the draft
 * only when this session may receive its bytes (ADR-0086) and write into it
 * (the draft rows ask `project:documents:generate` beside the write), so the
 * editor never offers a save the draft write refuses.
 */

import 'server-only'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { DocumentVersion } from '@/lib/db/schema/document-versions'
import type { Document } from '@/lib/db/schema/documents'
import { findDocumentVersionTransition } from '@/lib/documents/lifecycle-types'
import { mayReceiveVersionBytes } from '@/lib/documents/version-content'
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

/** Whether this session may write into the Skizze's draft: the permissions of the draft's `update` row, the same ones the save asks. */
export async function mayWriteDraft(session: AuthorizedSession, document: Pick<Document, 'projectId'>, draft: Pick<DocumentVersion, 'state'>): Promise<boolean> {
  const transition = findDocumentVersionTransition(draft.state, 'update')
  if (!transition) return false
  if (!document.projectId) return true
  try {
    await requireProjectAccess(session, document.projectId, transition.permission)
    if (transition.alsoRequires) await requireProjectAccess(session, document.projectId, transition.alsoRequires)
    return true
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof NotFoundError) return false
    throw error
  }
}

/** What a writer's editor opens: the target, the draft whose bytes it reads (or none: the current Fassung), and whether a save will be taken. */
export interface SketchOpening {
  target: SketchTarget
  draft: DocumentVersion | null
  canWrite: boolean
}

/**
 * The editor's opening for `session`, given whether it may write the document
 * at all. A draft this session may not receive (held, ADR-0086) is not read:
 * the editor opens the current Fassung to watch. A draft it may not write into
 * opens to watch as well, since every save would be refused.
 */
export async function sketchOpeningFor(session: AuthorizedSession, document: Document, writer: boolean): Promise<SketchOpening> {
  if (!writer) return { target: { kind: 'published' }, draft: null, canWrite: false }
  const target = await sketchTargetOf(document)
  if (target.kind !== 'draft') return { target, draft: null, canWrite: true }
  if (!(await mayReceiveVersionBytes(session, document, target.version))) return { target, draft: null, canWrite: false }
  return { target, draft: target.version, canWrite: await mayWriteDraft(session, document, target.version) }
}
