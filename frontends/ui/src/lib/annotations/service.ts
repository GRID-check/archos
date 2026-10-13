/**
 * Anmerkungen service — the logic and the authorization for a document's
 * Anmerkungen and their threads (migration 0135; CONTEXT.md „Anmerkung").
 *
 * Access follows the document and nothing else: whoever may read the document
 * reads its Anmerkungen, and whoever may write in its folder sets, takes over,
 * resolves and answers them (`getAccessibleDocument`, so a closed project, a
 * read-only folder and a held upload refuse exactly as they refuse a rename).
 * Deleting one is for the person who set it: a mark somebody else is working
 * from does not vanish under them, it is resolved.
 *
 * Piloti works through the same functions with the asker's pinned session
 * (`/api/internal/document-annotations`): its marks are born proposals, and
 * only a person takes one over or dismisses it. The CHECKs in 0135 hold that
 * too, so the rule does not depend on this file.
 *
 * Every write tells the document's room (`./room`), so everyone looking at the
 * document re-reads; a failed publish never fails the write.
 *
 * Only the office's own shelves carry Anmerkungen, the project and the
 * Büroablage. A chat attachment has no folder and no team to act on a mark.
 */

import 'server-only'
import {
  ApiError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { canUserAccessProject } from '@/lib/authz/project-membership'
import type { Document, DocumentAnnotationReplyRow } from '@/lib/db/schema'
import { getAccessibleDocument } from '@/lib/documents/access'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import {
  AnnotationLimitReachedError,
  deleteDocumentAnnotation,
  findDocumentAnnotation,
  insertAnnotationReply,
  insertDocumentAnnotations,
  listDocumentAnnotations,
  ReplyLimitReachedError,
  updateDocumentAnnotation,
  type AnnotationChanges,
  type AnnotationRecord,
  type NewAnnotationValues,
} from './repository'
import { publishToRoom } from './room'
import type { AnnotationChange } from './room-types'
import {
  annotationBox,
  annotationProposalSchema,
  compareAnnotations,
  createAnnotationRequestSchema,
  createReplyRequestSchema,
  MAX_ANNOTATIONS_PER_DOCUMENT,
  MAX_PROPOSALS_PER_CALL,
  MAX_REPLIES_PER_ANNOTATION,
  updateAnnotationRequestSchema,
  type AnnotationAuthor,
  type AnnotationListResponse,
  type AnnotationProposal,
  type AnnotationReplyView,
  type AnnotationStatus,
  type AnnotationView,
  type CreateAnnotationRequest,
  type CreateReplyRequest,
  type InternalAnnotation,
  type UpdateAnnotationRequest,
} from './types'

/** Who acts: a person in their own session, or Piloti in the asker's. `peerId` is the person's tab, when it says. */
export interface AnnotationActor {
  kind: AnnotationAuthor
  peerId?: string | null
}

const PERSON: AnnotationActor = { kind: 'person' }
export const PILOTI: AnnotationActor = { kind: 'piloti' }

/** Whether the document sits on a shelf that carries Anmerkungen. */
const annotatable = (doc: Document) => doc.scope === 'project' || doc.scope === 'archiv'

/**
 * Whether this session may write on the document, as a boolean. A refusal of
 * the write (403) is an answer here, not an error: the reader still sees the
 * Anmerkungen, without the controls.
 */
async function mayWrite(session: AuthorizedSession, documentId: string): Promise<boolean> {
  try {
    await getAccessibleDocument(session, documentId, 'write')
    return true
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return false
    throw error
  }
}

/** Display names by user id; empty when the directory cannot be read, which costs names and nothing else. */
type Names = ReadonlyMap<string, { name: string }>

async function directoryNames(organizationId: string): Promise<Names> {
  return loadOrganizationDirectory(organizationId).catch(() => new Map())
}

const nameOf = (names: Names, userId: string | null) => (userId ? (names.get(userId)?.name ?? null) : null)

function toReplyView(reply: DocumentAnnotationReplyRow, names: Names): AnnotationReplyView {
  return {
    id: reply.id,
    annotationId: reply.annotationId,
    authorKind: reply.authorKind,
    body: reply.body,
    createdBy: reply.createdBy,
    createdByName: nameOf(names, reply.createdBy),
    createdAt: reply.createdAt.toISOString(),
  }
}

function toView(
  record: AnnotationRecord,
  doc: Document,
  session: AuthorizedSession,
  writable: boolean,
  names: Names
): AnnotationView {
  return {
    id: record.id,
    documentId: record.documentId,
    number: record.number,
    page: record.page,
    shape: record.shape,
    x: record.x,
    y: record.y,
    w: record.w,
    h: record.h,
    kind: record.kind,
    body: record.body,
    basis: record.basis,
    authorKind: record.authorKind,
    status: record.status,
    assigneeUserId: record.assigneeUserId,
    assigneeName: nameOf(names, record.assigneeUserId),
    dueOn: record.dueOn,
    fassungNumber: record.fassungNumber,
    // A document with no version row shows the bytes its row holds, which is
    // where an Anmerkung set without a version was set.
    onCurrentFassung: (record.versionId ?? null) === (doc.publishedVersionId ?? null),
    createdBy: record.createdBy,
    createdByName: nameOf(names, record.createdBy),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    acceptedBy: record.acceptedBy,
    acceptedByName: nameOf(names, record.acceptedBy),
    closedBy: record.closedBy,
    closedByName: nameOf(names, record.closedBy),
    closedAt: record.closedAt ? record.closedAt.toISOString() : null,
    replies: record.replies.map((reply) => toReplyView(reply, names)),
    canEdit: writable,
    canDelete: writable && record.authorKind === 'person' && record.createdBy === session.userId,
  }
}

/**
 * Refuse an assignee who could not open the document: assigning is not access
 * (ADR-0059), so a person outside the project would be on the hook for a sheet
 * they cannot see.
 */
async function requireAssignable(session: AuthorizedSession, doc: Document, userId: string): Promise<void> {
  if (doc.scope === 'project' && doc.projectId) {
    if (await canUserAccessProject(session, doc.projectId, userId)) return
  } else if (doc.scope === 'archiv') {
    const directory = await loadOrganizationDirectory(session.organizationId)
    if (directory.has(userId)) return
  }
  throw new UnprocessableError('The assignee cannot open this document.', { field: 'assigneeUserId' })
}

/** Tell the room, never failing the write that caused it. */
function announce(
  session: AuthorizedSession,
  documentId: string,
  annotationIds: string[],
  change: AnnotationChange,
  actor: AnnotationActor
): void {
  void publishToRoom(documentId, {
    kind: 'annotations.changed',
    annotationIds,
    change,
    actor: {
      peerId: actor.peerId ?? null,
      userId: session.userId,
      name: actor.kind === 'piloti' ? 'Piloti' : (session.name ?? session.email),
      kind: actor.kind,
    },
  })
}

async function requireWritableDocument(session: AuthorizedSession, documentId: string): Promise<Document> {
  const doc = await getAccessibleDocument(session, documentId, 'write')
  if (!annotatable(doc)) throw new BadRequestError('This document cannot carry Anmerkungen.')
  return doc
}

async function viewOf(session: AuthorizedSession, doc: Document, annotationId: string): Promise<AnnotationView> {
  const record = await findDocumentAnnotation(session.organizationId, doc.id, annotationId)
  if (!record) throw new NotFoundError()
  return toView(record, doc, session, true, await directoryNames(session.organizationId))
}

const limitReached = (error: unknown): never => {
  if (error instanceof AnnotationLimitReachedError) {
    throw new UnprocessableError(`A document carries at most ${MAX_ANNOTATIONS_PER_DOCUMENT} Anmerkungen.`)
  }
  throw error
}

const toMark = (input: {
  page: number
  shape: NewAnnotationValues['shape']
  x: number
  y: number
  w?: number | null
  h?: number | null
  kind: NewAnnotationValues['kind']
  body: string
  basis?: string | null
  assigneeUserId?: string | null
  dueOn?: string | null
}): NewAnnotationValues => ({
  page: input.page,
  shape: input.shape,
  x: input.x,
  y: input.y,
  w: input.shape === 'region' ? (input.w ?? null) : null,
  h: input.shape === 'region' ? (input.h ?? null) : null,
  kind: input.kind,
  body: input.body,
  basis: input.basis ?? null,
  assigneeUserId: input.assigneeUserId ?? null,
  dueOn: input.dueOn ?? null,
})

/** Every Anmerkung on a document this session may read, live ones first. */
export async function listAnnotations(session: AuthorizedSession, documentId: string): Promise<AnnotationListResponse> {
  const doc = await getAccessibleDocument(session, documentId, 'read')
  if (!annotatable(doc)) return { annotations: [], canAnnotate: false }
  const [records, writable, names] = await Promise.all([
    listDocumentAnnotations(session.organizationId, doc.id),
    mayWrite(session, doc.id),
    directoryNames(session.organizationId),
  ])
  const annotations = records.map((record) => toView(record, doc, session, writable, names)).sort(compareAnnotations)
  return { annotations, canAnnotate: writable }
}

/** A person sets one Anmerkung on the Fassung the document shows now. */
export async function createAnnotation(
  session: AuthorizedSession,
  documentId: string,
  input: CreateAnnotationRequest,
  actor: AnnotationActor = PERSON
): Promise<{ annotation: AnnotationView }> {
  const parsed = createAnnotationRequestSchema.parse(input)
  const doc = await requireWritableDocument(session, documentId)
  if (parsed.assigneeUserId) await requireAssignable(session, doc, parsed.assigneeUserId)
  const [row] = await insertDocumentAnnotations({
    organizationId: session.organizationId,
    documentId: doc.id,
    versionId: doc.publishedVersionId ?? null,
    authorKind: 'person',
    createdBy: session.userId,
    marks: [toMark(parsed)],
  }).catch(limitReached)
  announce(session, doc.id, [row.id], 'created', { ...actor, kind: 'person' })
  return { annotation: await viewOf(session, doc, row.id) }
}

/**
 * Piloti proposes findings on a document, on behalf of the person it works for.
 * Each is born `proposed`; none counts until a person takes it over.
 */
export async function proposeAnnotations(
  session: AuthorizedSession,
  documentId: string,
  proposals: readonly AnnotationProposal[]
): Promise<{ annotations: AnnotationView[] }> {
  if (proposals.length === 0 || proposals.length > MAX_PROPOSALS_PER_CALL) {
    throw new BadRequestError(`Between 1 and ${MAX_PROPOSALS_PER_CALL} proposals per call.`)
  }
  const parsed = proposals.map((proposal) => annotationProposalSchema.parse(proposal))
  const doc = await requireWritableDocument(session, documentId)
  const rows = await insertDocumentAnnotations({
    organizationId: session.organizationId,
    documentId: doc.id,
    versionId: doc.publishedVersionId ?? null,
    authorKind: 'piloti',
    createdBy: session.userId,
    marks: parsed.map(toMark),
  }).catch(limitReached)
  const ids = rows.map((row) => row.id)
  announce(session, doc.id, ids, 'created', PILOTI)
  const names = await directoryNames(session.organizationId)
  const records = await listDocumentAnnotations(session.organizationId, doc.id)
  const annotations = records
    .filter((record) => ids.includes(record.id))
    .map((record) => toView(record, doc, session, true, names))
  return { annotations }
}

/**
 * The bookkeeping a status move carries, or a 409 for a move that does not
 * exist. Taking over a proposal is the only way a machine finding becomes the
 * office's; dismissing it closes it as „verworfen".
 */
export function transition(
  from: AnnotationStatus,
  to: 'open' | 'resolved' | 'dismissed',
  record: Pick<AnnotationRecord, 'acceptedBy' | 'authorKind'>,
  userId: string,
  now: Date
): NonNullable<AnnotationChanges['transition']> {
  const closed = { closedBy: userId, closedAt: now }
  const reopened = { closedBy: null, closedAt: null }
  const acceptance = record.acceptedBy ? {} : { acceptedBy: userId, acceptedAt: now }
  if (from === 'proposed' && to === 'open') return { status: 'open', ...reopened, ...acceptance }
  if (from === 'proposed' && to === 'dismissed') return { status: 'dismissed', ...closed }
  if (from === 'open' && to === 'resolved') return { status: 'resolved', ...closed }
  if (from === 'resolved' && to === 'open') return { status: 'open', ...reopened }
  if (from === 'dismissed' && to === 'open') {
    return { status: 'open', ...reopened, ...(record.authorKind === 'piloti' ? acceptance : {}) }
  }
  throw new ConflictError(`An Anmerkung cannot go from ${from} to ${to}.`)
}

/** Change one Anmerkung: take it over, dismiss, resolve or reopen it, reword it, assign it, give it a date. */
export async function updateAnnotation(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string,
  input: UpdateAnnotationRequest,
  actor: AnnotationActor = PERSON
): Promise<{ annotation: AnnotationView }> {
  const parsed = updateAnnotationRequestSchema.parse(input)
  const doc = await requireWritableDocument(session, documentId)
  const existing = await findDocumentAnnotation(session.organizationId, doc.id, annotationId)
  if (!existing) throw new NotFoundError()
  if (parsed.assigneeUserId) await requireAssignable(session, doc, parsed.assigneeUserId)

  const changes: AnnotationChanges = {
    ...(parsed.kind !== undefined && { kind: parsed.kind }),
    ...(parsed.body !== undefined && { body: parsed.body }),
    ...(parsed.basis !== undefined && { basis: parsed.basis }),
    ...(parsed.assigneeUserId !== undefined && { assigneeUserId: parsed.assigneeUserId }),
    ...(parsed.dueOn !== undefined && { dueOn: parsed.dueOn }),
  }
  if (parsed.status !== undefined && parsed.status !== existing.status) {
    changes.transition = transition(existing.status, parsed.status, existing, session.userId, new Date())
  }
  if (Object.keys(changes).length === 0) return { annotation: await viewOf(session, doc, annotationId) }

  const updated = await updateDocumentAnnotation(session.organizationId, doc.id, annotationId, existing.status, changes)
  // Gone, or a colleague moved it first: say so rather than overwrite their move.
  if (!updated) throw new ConflictError('Somebody changed this Anmerkung a moment ago. Look again.')
  announce(session, doc.id, [annotationId], 'updated', actor)
  return { annotation: await viewOf(session, doc, annotationId) }
}

/** Delete one Anmerkung the session set itself. Piloti's proposals are dismissed, never deleted. */
export async function deleteAnnotation(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string,
  actor: AnnotationActor = PERSON
): Promise<null> {
  const doc = await requireWritableDocument(session, documentId)
  const existing = await findDocumentAnnotation(session.organizationId, doc.id, annotationId)
  if (!existing) throw new NotFoundError()
  if (existing.authorKind !== 'person' || existing.createdBy !== session.userId) {
    throw new ForbiddenError('Only the person who set an Anmerkung can delete it. Resolve or dismiss it instead.')
  }
  await deleteDocumentAnnotation(session.organizationId, doc.id, annotationId)
  announce(session, doc.id, [annotationId], 'deleted', actor)
  return null
}

/** Answer in an Anmerkung's thread, as a person or as Piloti for one. */
export async function replyToAnnotation(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string,
  input: CreateReplyRequest,
  actor: AnnotationActor = PERSON
): Promise<{ annotation: AnnotationView }> {
  const { body } = createReplyRequestSchema.parse(input)
  const doc = await requireWritableDocument(session, documentId)
  const existing = await findDocumentAnnotation(session.organizationId, doc.id, annotationId)
  if (!existing) throw new NotFoundError()
  await insertAnnotationReply({
    organizationId: session.organizationId,
    annotationId,
    authorKind: actor.kind,
    body,
    createdBy: session.userId,
  }).catch((error: unknown) => {
    if (error instanceof ReplyLimitReachedError) {
      throw new UnprocessableError(`A thread carries at most ${MAX_REPLIES_PER_ANNOTATION} replies.`)
    }
    throw error
  })
  announce(session, doc.id, [annotationId], 'replied', actor)
  return { annotation: await viewOf(session, doc, annotationId) }
}

/** The Anmerkungen as Piloti reads them: place as a box, without a reader's controls. */
export async function listAnnotationsForAgent(
  session: AuthorizedSession,
  documentId: string
): Promise<{ documentId: string; annotations: InternalAnnotation[] }> {
  const { annotations } = await listAnnotations(session, documentId)
  return {
    documentId,
    annotations: annotations.map((annotation) => ({
      id: annotation.id,
      number: annotation.number,
      page: annotation.page,
      shape: annotation.shape,
      box: annotationBox(annotation),
      kind: annotation.kind,
      status: annotation.status,
      authorKind: annotation.authorKind,
      body: annotation.body,
      basis: annotation.basis,
      assigneeName: annotation.assigneeName,
      dueOn: annotation.dueOn,
      onCurrentFassung: annotation.onCurrentFassung,
      createdByName: annotation.createdByName,
      createdAt: annotation.createdAt,
      replies: annotation.replies.map((reply) => ({
        authorKind: reply.authorKind,
        body: reply.body,
        createdByName: reply.createdByName,
      })),
    })),
  }
}
