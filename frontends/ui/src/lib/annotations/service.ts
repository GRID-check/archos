/**
 * Anmerkungen service — the logic and the authorization for a document's
 * Anmerkungen and their threads (migration 0138; CONTEXT.md „Anmerkung").
 *
 * Access follows the document and nothing else: whoever may read the document
 * reads its Anmerkungen, and whoever may write in its folder sets, takes over,
 * resolves and answers them (`getAccessibleDocument`, so a closed project, a
 * read-only folder and a held upload refuse exactly as they refuse a rename).
 * Deleting one is for the person who set it: a mark somebody else is working
 * from does not vanish under them, it is resolved. A mark Piloti set for its
 * asker counts as theirs ({@link mayDeleteMark}), and a reply is deleted by
 * the person it was posted for ({@link deleteReply}).
 *
 * Piloti works through the same functions with the asker's pinned session
 * (`/api/internal/document-annotations`), so it may do exactly what the asker
 * may, and nothing more. Its own findings are born proposals a person takes
 * over or dismisses. A mark the asker asked for is born open, taken over by
 * the asker in the same move (`accepted_by`); a change the asker asked for runs
 * through `updateAnnotation` like a person's PATCH, and Piloti says what it did
 * in the mark's thread (`updateAnnotationForAsker`). The CHECKs in 0138 hold
 * that Piloti's mark is open only with a person behind it, so the rule does
 * not depend on this file.
 *
 * A mark's text and a reply mention colleagues the way the chat does: the
 * composer sends whom the person picked in the „@" picker, and the server keeps
 * those whose token still stands in the text and who may open the document
 * (`./mentions.ts`), and tells each person mentioned anew
 * (`annotation.mentioned`, `./attention.ts`). An @Piloti mention addresses
 * Piloti, as the chip's flag does.
 *
 * A reply that addresses Piloti, a reply on Piloti's own open question, and
 * making Piloti the delegate on a mark wake Piloti (ADR-0106, `./wake.ts`):
 * the wake is enqueued in the write's own transaction, and the response says
 * whether the server will answer (`wake`), so the browser never asks twice.
 *
 * Taking a mark back from Piloti (clearing the delegation, or resolving,
 * dismissing or deleting the mark) ends what the delegation started
 * (`./take-back.ts`): a wake still queued never starts, and a turn that runs
 * is stopped by a job queued in the take-back's own transaction. Only the
 * delegation's own turn ending hands a mark back, never a reply of Piloti's
 * (`lib/turns/outcome.ts`).
 *
 * A person's decisions leave traces after the write committed, all
 * best-effort: what Piloti asked on a mark is no longer waiting on them
 * (`./attention.ts`), and taking over or dismissing a mark Piloti proposed is
 * a line in the organization's audit trail (`piloti.mark.decided`,
 * `./mark-audit.ts`) and a score on the turn that proposed it
 * (`lib/langfuse/decision-score.ts`).
 *
 * Every write tells the document's room (the `doc:<id>` live channel,
 * `lib/realtime/document-channel.ts`), so everyone looking at the document
 * re-reads; a failed publish never fails the write.
 *
 * Only the office's own shelves carry Anmerkungen, the project and the
 * Büroablage. A chat attachment has no folder and no team to act on a mark.
 */

import 'server-only'
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document, DocumentAnnotationReplyRow, DocumentAnnotationRow, PilotiWakeRow } from '@/lib/db/schema'
import { getAccessibleDocument } from '@/lib/documents/access'
import { canWriteDocument } from '@/lib/documents/can-write'
import { documentDisplayName } from '@/lib/documents/display-name'
import { mayOpenDocument, mayWriteDocument } from '@/lib/documents/may-open'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { replacingDocumentOf } from './carry'
import {
  AlreadyCarriedError,
  AnnotationLimitReachedError,
  carryAnnotationToDocument,
  deleteAnnotationReply,
  deleteDocumentAnnotation,
  findDocumentAnnotation,
  insertAnnotationReply,
  insertDocumentAnnotations,
  listDocumentAnnotations,
  ReplyLimitReachedError,
  updateDocumentAnnotation,
  type AnnotationChanges,
  type AnnotationRecord,
  type CarryLink,
  type NewAnnotationValues,
} from './repository'
import { recordDecisionScore } from '@/lib/langfuse/decision-score'
import { publishToDocumentRoom } from '@/lib/realtime/document-channel'
import {
  onAssigneeChanged,
  onDueChanged,
  onMarkDeleted,
  onMarkMentioned,
  onMarkMoved,
  onMentionsWithdrawn,
  onMarkReplied,
  onMarkSettledByPerson,
  type MarkRef,
  type MayOpen,
} from './attention'
import { auditMarkDecided } from './mark-audit'
import { keepMentions, mentionsPiloti, newlyMentioned, noLongerMentioned } from './mentions'
import { enforceMentionBounds } from '@/lib/mentions/service'
import type { AnnotationChange } from './room-types'
import { auditSuppressedWake, enqueueWake, replyTrigger, wakeOutcomeOf, wakesEnabled, type EnqueuedWake } from './wake'
import { delegationEventId } from './wake-ids'
import { latestWakesFor, pilotiWorkOf } from './piloti-work'
import { wakeOfReply, wakeSpansFor, type WakeSpan } from './wake-attribution'
import {
  auditDeletedWithMark,
  readTakeBack,
  settleTakenBack,
  type EndedDelegation,
  type TakeBack,
  type TakeBackAudit,
} from './take-back'
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
  type CarryLinkView,
  type CarryTargetView,
  type CreateAnnotationRequest,
  type CreateReplyRequest,
  type InternalAnnotation,
  type MarkMention,
  type PilotiWakeTrigger,
  type UpdateAnnotationRequest,
  type WakeOutcome,
} from './types'

/** Who acts: a person in their own session, or Piloti in the asker's. `peerId` is the person's tab, when it says. */
export interface AnnotationActor {
  kind: AnnotationAuthor
  peerId?: string | null
}

const PERSON: AnnotationActor = { kind: 'person' }
export const PILOTI: AnnotationActor = { kind: 'piloti' }

/**
 * Whether this person may delete the mark: one they set themselves, or one
 * Piloti set for them. Piloti's mark carries the asker as `created_by` (the
 * session it works in), and `accepted_by` is the asker too when they asked for
 * exactly this mark (born open) or took their own proposal over. A mark
 * Piloti proposed and somebody ELSE took over has two people behind it, so
 * neither deletes it; it is resolved or dismissed. A proposal nobody took
 * over has no `accepted_by`, so it is dismissed, never deleted.
 */
const mayDeleteMark = (record: Pick<AnnotationRecord, 'authorKind' | 'createdBy' | 'acceptedBy'>, userId: string) =>
  record.createdBy === userId && (record.authorKind === 'person' || record.acceptedBy === userId)

/** Whether the document sits on a shelf that carries Anmerkungen. */
const annotatable = (doc: Document) => doc.scope === 'project' || doc.scope === 'archiv'

/** Display names by user id; empty when the directory cannot be read, which costs names and nothing else. */
type Names = ReadonlyMap<string, { name: string }>

async function directoryNames(organizationId: string): Promise<Names> {
  return loadOrganizationDirectory(organizationId).catch(() => new Map())
}

const nameOf = (names: Names, userId: string | null) => (userId ? (names.get(userId)?.name ?? null) : null)

function toReplyView(
  reply: DocumentAnnotationReplyRow,
  names: Names,
  wakes: readonly WakeSpan[]
): AnnotationReplyView {
  return {
    id: reply.id,
    annotationId: reply.annotationId,
    authorKind: reply.authorKind,
    body: reply.body,
    createdBy: reply.createdBy,
    createdByName: nameOf(names, reply.createdBy),
    createdAt: reply.createdAt.toISOString(),
    addressesPiloti: reply.addressesAgent,
    wokenBy: wakeOfReply(reply, wakes),
    mentions: reply.mentions,
  }
}

function toView(
  record: AnnotationRecord,
  doc: Document,
  session: AuthorizedSession,
  writable: boolean,
  names: Names,
  wakes: readonly WakeSpan[] = [],
  work: ReadonlyMap<string, PilotiWakeRow> = new Map(),
  linked: LinkedDocuments = new Map(),
  carryWay: CarryWay | null = null
): AnnotationView {
  const wake = work.get(record.id)
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
    mentions: record.mentions,
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
    delegatedBy: record.delegatedBy,
    delegatedByName: nameOf(names, record.delegatedBy),
    delegatedAt: record.delegatedAt ? record.delegatedAt.toISOString() : null,
    replies: record.replies.map((reply) => toReplyView(reply, names, wakes)),
    pilotiWork: wake ? pilotiWorkOf(wake, nameOf(names, wake.actorUserId)) : null,
    carriedFrom: linkView(record.carriedFrom, linked),
    carriedTo: linkView(record.carriedTo, linked),
    carryTarget: writable ? carryTargetOf(record, doc, carryWay) : null,
    canEdit: writable,
    canDelete: writable && mayDeleteMark(record, session.userId),
  }
}

/** The documents at the other end of the marks' carries that this reader may open, by id, with their names. */
type LinkedDocuments = ReadonlyMap<string, string>

const linkView = (link: CarryLink | null | undefined, linked: LinkedDocuments): CarryLinkView | null => {
  const documentName = link ? linked.get(link.documentId) : undefined
  return link && documentName !== undefined ? { ...link, documentName } : null
}

/**
 * The documents a carry links these marks to that the reader may open, each
 * asked once through the reader's own rule (`getAccessibleDocument`): a link
 * into a folder closed to them, or to a held upload, is no link at all, its
 * name included. Usually none, or the one document that replaced this one.
 */
async function linkedDocuments(session: AuthorizedSession, records: readonly AnnotationRecord[]): Promise<LinkedDocuments> {
  const ids = new Set<string>()
  for (const record of records) {
    if (record.carriedFrom) ids.add(record.carriedFrom.documentId)
    if (record.carriedTo) ids.add(record.carriedTo.documentId)
  }
  const names = await Promise.all(
    [...ids].map(async (id) => {
      const doc = await getAccessibleDocument(session, id, 'read').catch(() => null)
      return doc ? ([id, documentDisplayName(doc)] as const) : null
    })
  )
  return new Map(names.filter((entry): entry is readonly [string, string] => entry !== null))
}

/**
 * Where this reader's carry takes the open marks of one document
 * (`carryToCurrent`): `across` to the document that replaces it, at the end of
 * its chain as the reader sees it (`replacingDocumentOf`, the walk the carry
 * itself takes), or in place.
 */
interface CarryWay {
  to: CarryTargetView
  across: boolean
}

/**
 * The {@link CarryWay} for a reader who may write `doc`, read once per view:
 * null when nothing of it can be carried (no open mark, or a replacing
 * document the reader may not write, which the carry refuses), or when the
 * chain could not be read: a list read does not fail on it, and offers no
 * carry it cannot vouch for.
 */
async function carryWayOf(
  session: AuthorizedSession,
  doc: Document,
  records: readonly Pick<AnnotationRecord, 'status'>[]
): Promise<CarryWay | null> {
  if (!records.some((record) => record.status === 'open')) return null
  const replacing = await replacingDocumentOf(session, doc).catch((error: unknown) => {
    console.warn(`[annotations] could not read what replaces document ${doc.id}:`, error)
    return undefined
  })
  if (replacing === undefined) return null
  if (!replacing) return { to: { documentId: doc.id, documentName: documentDisplayName(doc) }, across: false }
  if (!annotatable(replacing) || !(await canWriteDocument(session, replacing.id))) return null
  return { to: { documentId: replacing.id, documentName: documentDisplayName(replacing) }, across: true }
}

/**
 * Where one mark goes when this reader carries it, as {@link carryToCurrent}
 * would take it, or null where it refuses or does nothing: a mark that is not
 * open; across, one Piloti works (`carryAcross` asks for it back first); in
 * place, one already on the current Fassung.
 */
function carryTargetOf(record: AnnotationRecord, doc: Document, way: CarryWay | null): CarryTargetView | null {
  if (!way || record.status !== 'open') return null
  if (way.across) return record.delegatedBy ? null : way.to
  return (record.versionId ?? null) === (doc.publishedVersionId ?? null) ? null : way.to
}

/**
 * Whether this person may be a mark's Zuständige: they may write the
 * document, its folder included (`mayWriteDocument`), because answering the
 * mark and closing it are writes. Someone who could only read it would be on
 * the hook for a mark they cannot answer. Mentioning asks less: whoever may
 * open the document (`./mentions`).
 */
async function isAssignable(session: AuthorizedSession, doc: Document, userId: string): Promise<boolean> {
  return (await mayWriteDocument(session, doc, [userId])).has(userId)
}

/**
 * Refuse an assignee who could not answer the mark: assigning is not access
 * (ADR-0059), so a person outside the project, or one who may only read the
 * document, would be on the hook for a mark they cannot answer.
 */
async function requireAssignable(session: AuthorizedSession, doc: Document, userId: string): Promise<void> {
  if (await isAssignable(session, doc, userId)) return
  throw new UnprocessableError('The assignee cannot answer Anmerkungen on this document.', {
    field: 'assigneeUserId',
    reason: 'assignee-cannot-answer',
  })
}

/** How many name matches an assignee lookup checks for access before it asks instead. */
const MAX_ASSIGNEE_CANDIDATES = 10

const nameKey = (value: string | null | undefined) =>
  (value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de')

/**
 * The one member a name or an e-mail address means, among those who may be the
 * mark's Zuständige ({@link isAssignable}: who may write the document). Piloti
 * has no roster and never sees a user id, so it passes
 * the person as the asker said it („Anna"): an exact name or address first,
 * then a first name or the start of a name. None, or more than one, is a 422
 * naming the candidates, which the tool turns into a question.
 */
export async function resolveAssignee(session: AuthorizedSession, doc: Document, query: string): Promise<string> {
  const key = nameKey(query)
  const people = [...(await loadOrganizationDirectory(session.organizationId)).values()]
  const exact = people.filter(
    (person) => person.userId === query.trim() || nameKey(person.name) === key || nameKey(person.email) === key
  )
  const loose = people.filter((person) => {
    const name = nameKey(person.name)
    return name.startsWith(key) || name.split(' ').includes(key)
  })
  const candidates = (exact.length > 0 ? exact : loose).slice(0, MAX_ASSIGNEE_CANDIDATES)
  const mayAnswer = await mayWriteDocument(session, doc, candidates.map((person) => person.userId))
  const reachable = candidates.filter((person) => mayAnswer.has(person.userId))
  if (reachable.length === 1) return reachable[0].userId
  if (reachable.length === 0) {
    throw new UnprocessableError(`Nobody called „${query.trim()}" can answer Anmerkungen on this document.`, {
      field: 'assignee',
      reason: 'assignee-unknown',
    })
  }
  const named = reachable.map((person) => (person.email ? `${person.name} (${person.email})` : person.name))
  throw new UnprocessableError(`„${query.trim()}" could be ${named.join(', ')}.`, {
    field: 'assignee',
    reason: 'assignee-ambiguous',
  })
}

/** Tell the room, never failing the write that caused it. */
function announce(
  session: AuthorizedSession,
  documentId: string,
  annotationIds: string[],
  change: AnnotationChange,
  actor: AnnotationActor
): void {
  void publishToDocumentRoom(documentId, {
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
  const [names, wakes, work, linked, carryWay] = await Promise.all([
    directoryNames(session.organizationId),
    wakeSpansFor(session.organizationId, doc.id, [record]),
    latestWakesFor(session.organizationId, doc.id, record.id),
    linkedDocuments(session, [record]),
    carryWayOf(session, doc, [record]),
  ])
  return toView(record, doc, session, true, names, wakes, work, linked, carryWay)
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
  mentions?: MarkMention[]
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
  mentions: input.mentions ?? [],
  basis: input.basis ?? null,
  assigneeUserId: input.assigneeUserId ?? null,
  dueOn: input.dueOn ?? null,
})

/** Every Anmerkung on a document this session may read, live ones first. */
export async function listAnnotations(session: AuthorizedSession, documentId: string): Promise<AnnotationListResponse> {
  const doc = await getAccessibleDocument(session, documentId, 'read')
  if (!annotatable(doc)) return { annotations: [], canAnnotate: false, pilotiWakes: false }
  const [records, writable, names] = await Promise.all([
    listDocumentAnnotations(session.organizationId, doc.id),
    canWriteDocument(session, doc.id),
    directoryNames(session.organizationId),
  ])
  const [wakes, work, linked, carryWay] = await Promise.all([
    wakeSpansFor(session.organizationId, doc.id, records),
    latestWakesFor(session.organizationId, doc.id),
    linkedDocuments(session, records),
    writable ? carryWayOf(session, doc, records) : null,
  ])
  const annotations = records
    .map((record) => toView(record, doc, session, writable, names, wakes, work, linked, carryWay))
    .sort(compareAnnotations)
  return { annotations, canAnnotate: writable, pilotiWakes: wakesEnabled(session) }
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
  const mentions = await keepMentions(session, doc, parsed.body, parsed.mentions ?? [], { piloti: false })
  const mentioned = await spendMentions(session, newlyMentioned(mentions, [], session.userId), false)
  const [row] = await insertDocumentAnnotations({
    organizationId: session.organizationId,
    documentId: doc.id,
    versionId: doc.publishedVersionId ?? null,
    authorKind: 'person',
    createdBy: session.userId,
    marks: [toMark({ ...parsed, mentions })],
  }).catch(limitReached)
  announce(session, doc.id, [row.id], 'created', { ...actor, kind: 'person' })
  if (row.assigneeUserId) traceAssigned(session, doc, row, null, PERSON)
  traceMentioned(session, doc, row, mentioned, row.body, mentions, row.assigneeUserId)
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
  return insertPilotiMarks(session, documentId, proposals, null)
}

/**
 * Piloti sets marks the asker asked for („Setz dort eine Anmerkung"). Each is
 * born `open`, taken over by the asker in the same move, because the person
 * stood behind it by asking: the asker is `accepted_by` and accountable.
 */
export async function setAnnotationsForAsker(
  session: AuthorizedSession,
  documentId: string,
  marks: readonly AnnotationProposal[]
): Promise<{ annotations: AnnotationView[] }> {
  return insertPilotiMarks(session, documentId, marks, session.userId)
}

async function insertPilotiMarks(
  session: AuthorizedSession,
  documentId: string,
  proposals: readonly AnnotationProposal[],
  acceptedBy: string | null
): Promise<{ annotations: AnnotationView[] }> {
  if (proposals.length === 0 || proposals.length > MAX_PROPOSALS_PER_CALL) {
    throw new BadRequestError(`Between 1 and ${MAX_PROPOSALS_PER_CALL} marks per call.`)
  }
  const parsed = proposals.map((proposal) => annotationProposalSchema.parse(proposal))
  const doc = await requireWritableDocument(session, documentId)
  const rows = await insertDocumentAnnotations({
    organizationId: session.organizationId,
    documentId: doc.id,
    versionId: doc.publishedVersionId ?? null,
    authorKind: 'piloti',
    createdBy: session.userId,
    acceptedBy,
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

/** Run work that must never fail the write behind it: a throw or a rejection is a warning. */
function bestEffort(label: string, work: () => Promise<unknown>): void {
  const warn = (error: unknown) => console.warn(`[annotations] ${label} failed:`, error)
  try {
    void Promise.resolve(work()).catch(warn)
  } catch (error) {
    warn(error)
  }
}

/**
 * A person answered in a mark's thread, or the mark was closed (by a person, or
 * by Piloti in their name): what Piloti asked there no longer waits on anybody,
 * and a closed mark asks its Zuständige nothing.
 */
function traceSettled(session: AuthorizedSession, annotationId: string, closed: boolean): void {
  bestEffort('mark the mark settled', () =>
    onMarkSettledByPerson({
      organizationId: session.organizationId,
      annotationId,
      closed,
      answeredBy: closed ? null : session.userId,
    })
  )
}

/**
 * The people a write mentions anew, after the mention budget the chat spends
 * (`enforceMentionBounds`): refused before anything is written, so a refused
 * write leaves no mark and tells nobody. @Piloti (`piloti`) counts like a
 * person, as it does in the chat: one budget for one gesture.
 */
async function spendMentions(session: AuthorizedSession, mentioned: string[], piloti: boolean): Promise<string[]> {
  const count = mentioned.length + (piloti ? 1 : 0)
  if (count > 0) await enforceMentionBounds(session, count)
  return mentioned
}

/**
 * The people a write stopped mentioning, whom nothing left on the mark
 * mentions: their `annotation.mentioned` goes inert, so no row keeps asking
 * about, or quoting, a text that no longer names them.
 */
function traceWithdrawn(session: AuthorizedSession, annotationId: string, withdrawn: readonly string[]): void {
  if (withdrawn.length === 0) return
  bestEffort('withdraw the mentions taken out', () =>
    onMentionsWithdrawn({ organizationId: session.organizationId, annotationId, userIds: withdrawn })
  )
}

/**
 * Tell the people a write mentioned anew, once it committed. A Zuständige the
 * same write made responsible (`assignedNow`) hears that instead: one row for
 * one write.
 */
function traceMentioned(
  session: AuthorizedSession,
  doc: Document,
  mark: { id: string; number: number },
  mentioned: readonly string[],
  text: string,
  mentions: readonly MarkMention[],
  assignedNow: string | null = null
): void {
  const told = mentioned.filter((userId) => userId !== assignedNow)
  if (told.length === 0) return
  bestEffort('tell the people mentioned', () =>
    onMarkMentioned({
      ...markRefOf(session, doc, mark),
      actorUserId: session.userId,
      byPiloti: false,
      markText: text,
      mentioned: told,
      text,
      mentions,
      mayOpen: mayOpenOf(session, doc),
    })
  )
}

/** The mark an inbox item is about. */
const markRefOf = (session: AuthorizedSession, doc: Document, mark: { id: string; number: number }): MarkRef => ({
  organizationId: session.organizationId,
  documentId: doc.id,
  annotationId: mark.id,
  annotationNumber: mark.number,
  projectId: doc.projectId ?? null,
})

/** Who may open the document now: the one filter every item about its marks passes. */
const mayOpenOf =
  (session: AuthorizedSession, doc: Document): MayOpen =>
  (userIds) =>
    mayOpenDocument(session, doc, userIds)

/** The mark as a change left it, for the people the change concerns. */
type ChangedMark = Pick<DocumentAnnotationRow, 'id' | 'number' | 'body' | 'assigneeUserId' | 'status' | 'dueOn'>

/**
 * The mark's Zuständige changed, or a person took over Piloti's proposal that
 * names one (`previous` is then null): tell the new one, settle the old one's
 * row (`onAssigneeChanged`). Whoever acted is the session, Piloti's for the asker.
 */
function traceAssigned(
  session: AuthorizedSession,
  doc: Document,
  mark: ChangedMark,
  previous: string | null,
  actor: AnnotationActor
): void {
  bestEffort('tell the Zuständige', () =>
    onAssigneeChanged({
      ...markRefOf(session, doc, mark),
      actorUserId: session.userId,
      byPiloti: actor.kind === 'piloti',
      markText: mark.body,
      previousAssigneeUserId: previous,
      assigneeUserId: mark.assigneeUserId,
      open: mark.status === 'open',
      dueOn: mark.dueOn,
    })
  )
}

/** The date of a mark changed and its Zuständige did not: tell them (`onDueChanged`). */
function traceRedated(session: AuthorizedSession, doc: Document, mark: ChangedMark, actor: AnnotationActor): void {
  bestEffort('tell the Zuständige the date', () =>
    onDueChanged({
      ...markRefOf(session, doc, mark),
      actorUserId: session.userId,
      byPiloti: actor.kind === 'piloti',
      markText: mark.body,
      assigneeUserId: mark.assigneeUserId,
      dueOn: mark.dueOn,
      open: mark.status === 'open',
    })
  )
}

/**
 * What a change tells people, once it committed, whoever made it (a person in
 * their PATCH, or Piloti for the asker through {@link updateAnnotationForAsker}):
 * a new Zuständige, a new date to the Zuständige who stays, a mark closed or
 * reopened under its author, and a closed mark settles what was asked on it.
 */
function traceChange(
  session: AuthorizedSession,
  doc: Document,
  existing: AnnotationRecord,
  after: ChangedMark,
  actor: AnnotationActor
): void {
  const reassigned = after.assigneeUserId !== existing.assigneeUserId
  const takenOver = existing.status === 'proposed' && after.status === 'open'
  if (reassigned || (takenOver && after.assigneeUserId)) {
    traceAssigned(session, doc, after, reassigned ? existing.assigneeUserId : null, actor)
  } else if (after.dueOn !== existing.dueOn && after.assigneeUserId) {
    traceRedated(session, doc, after, actor)
  }
  if (after.status === existing.status) return
  const closedAs = after.status === 'resolved' || after.status === 'dismissed' ? after.status : null
  if (closedAs) traceSettled(session, existing.id, true)
  // Taking over a proposal is no news to its author: there was none yet.
  const move = closedAs ?? (existing.status === 'proposed' ? null : 'reopened')
  if (!move) return
  bestEffort('tell the mark’s author', () =>
    onMarkMoved({
      ...markRefOf(session, doc, existing),
      actorUserId: session.userId,
      byPiloti: actor.kind === 'piloti',
      markText: after.body,
      move,
      mark: existing,
      mayOpen: mayOpenOf(session, doc),
    })
  )
}

/**
 * What a person's move of status leaves behind, once it committed: taking
 * over or dismissing a mark Piloti proposed is a decision on Piloti's work, in
 * the audit trail (`piloti.mark.decided`, `./mark-audit.ts`) and as a score on
 * the turn that proposed it.
 */
function traceMove(
  session: AuthorizedSession,
  doc: { id: string; projectId: string | null },
  annotationId: string,
  existing: Pick<AnnotationRecord, 'authorKind' | 'status' | 'number' | 'kind' | 'createdBy'>,
  to: 'open' | 'resolved' | 'dismissed' | undefined
): void {
  const proposal = existing.authorKind === 'piloti' && existing.status === 'proposed'
  if (!proposal || (to !== 'open' && to !== 'dismissed')) return
  auditMarkDecided(session, doc, { ...existing, id: annotationId }, to === 'open' ? 'taken_over' : 'dismissed')
  bestEffort('score the decision', () =>
    recordDecisionScore({
      subject: 'annotation',
      subjectId: annotationId,
      decision: to === 'open' ? 'accepted' : 'dismissed',
      decidedBy: session.userId,
      organizationId: session.organizationId,
    })
  )
}

/** The delegation a mark carries, with where it lives; none when the mark is not delegated. */
const delegationOfMark = (
  session: AuthorizedSession,
  documentId: string,
  mark: Pick<AnnotationRecord, 'id' | 'delegatedAt'>
): EndedDelegation | null =>
  mark.delegatedAt
    ? { organizationId: session.organizationId, documentId, annotationId: mark.id, delegatedAt: mark.delegatedAt }
    : null

const conflict = () => new ConflictError('Somebody changed this Anmerkung a moment ago. Look again.')

/**
 * The delegation a change makes, or none. Making Piloti the delegate is a
 * person's act on an open mark, and only with the organization's switch on;
 * a mark already delegated is not delegated again, so a second click is no
 * second event. Closing a mark ends a delegation, because nobody works a
 * closed mark.
 */
function delegationOf(
  session: AuthorizedSession,
  existing: AnnotationRecord,
  parsed: { delegateToPiloti?: boolean; status?: 'open' | 'resolved' | 'dismissed' },
  actor: AnnotationActor,
  now: Date
): AnnotationChanges['delegation'] | undefined {
  const cleared = { delegatedBy: null, delegatedAt: null } as const
  const closing = parsed.status === 'resolved' || parsed.status === 'dismissed'
  if (parsed.delegateToPiloti === undefined) return closing && existing.delegatedBy ? cleared : undefined
  if (actor.kind === 'piloti') throw new ForbiddenError('Piloti cannot delegate a mark to itself.')
  if (!parsed.delegateToPiloti) return existing.delegatedBy ? cleared : undefined
  if (!wakesEnabled(session)) {
    throw new ForbiddenError('Delegating to Piloti is not switched on for this organization.', {
      reason: 'piloti-wakes-off',
    })
  }
  if ((parsed.status ?? existing.status) !== 'open') {
    throw new UnprocessableError('Only an open Anmerkung can be delegated to Piloti.', { field: 'delegateToPiloti' })
  }
  return existing.delegatedBy ? undefined : { delegatedBy: session.userId, delegatedAt: now }
}

/**
 * Change one Anmerkung: take it over, dismiss, resolve or reopen it, reword
 * it, assign it, give it a date, delegate it to Piloti or take it back.
 * Delegating wakes Piloti, enqueued in the change's transaction; nothing else
 * a change does wakes it, taking over or dismissing Piloti's mark included.
 */
export async function updateAnnotation(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string,
  input: UpdateAnnotationRequest,
  actor: AnnotationActor = PERSON
): Promise<{ annotation: AnnotationView; wake?: WakeOutcome }> {
  const parsed = updateAnnotationRequestSchema.parse(input)
  const doc = await requireWritableDocument(session, documentId)
  const existing = await findDocumentAnnotation(session.organizationId, doc.id, annotationId)
  if (!existing) throw new NotFoundError()
  if (parsed.expectedStatus && parsed.expectedStatus !== existing.status) throw conflict()
  if (parsed.carryToCurrent) return carryToCurrent(session, doc, existing, actor)
  if (parsed.assigneeUserId) await requireAssignable(session, doc, parsed.assigneeUserId)
  // A new body keeps whom it mentions: the ones picked with it, else the ones
  // stored whose token it still shows. Only the people it adds are told, and
  // nobody when the same write closes the mark: a closed mark asks nobody.
  const mentions =
    parsed.body === undefined
      ? undefined
      : await keepMentions(session, doc, parsed.body, parsed.mentions ?? existing.mentions, { piloti: false })
  const closes = parsed.status === 'resolved' || parsed.status === 'dismissed'
  const mentioned =
    mentions && !closes ? await spendMentions(session, newlyMentioned(mentions, existing.mentions, session.userId), false) : []
  const withdrawn = mentions
    ? noLongerMentioned(existing.mentions, [mentions, ...existing.replies.map((reply) => reply.mentions)])
    : []

  const now = new Date()
  const changes: AnnotationChanges = {
    ...(parsed.kind !== undefined && { kind: parsed.kind }),
    ...(parsed.body !== undefined && { body: parsed.body }),
    ...(mentions !== undefined && { mentions }),
    ...(parsed.basis !== undefined && { basis: parsed.basis }),
    ...(parsed.assigneeUserId !== undefined && { assigneeUserId: parsed.assigneeUserId }),
    ...(parsed.dueOn !== undefined && { dueOn: parsed.dueOn }),
  }
  const moves = parsed.status !== undefined && parsed.status !== existing.status
  if (moves && parsed.status) {
    changes.transition = transition(existing.status, parsed.status, existing, session.userId, now)
  }
  const delegation = delegationOf(session, existing, { ...parsed, status: moves ? parsed.status : undefined }, actor, now)
  if (delegation) changes.delegation = delegation
  if (Object.keys(changes).length === 0) return { annotation: await viewOf(session, doc, annotationId) }

  const delegating = delegation?.delegatedBy ? delegation.delegatedAt : null
  // A change that clears the delegation ends it; delegating an already delegated mark changes nothing.
  const ended = delegation && delegation.delegatedBy === null ? delegationOfMark(session, doc.id, existing) : null
  // Piloti closing a mark in the asker's name is usually the delegation's own turn finishing: it is not stopped.
  const stopTurn = actor.kind === 'person'
  // Set in the write's transaction; a holder, because a closure's assignment is not narrowed.
  const enqueued: { wake: EnqueuedWake | null; takeBack: TakeBack | null } = { wake: null, takeBack: null }
  const updated = await updateDocumentAnnotation(
    session.organizationId,
    doc.id,
    annotationId,
    existing.status,
    changes,
    delegating || ended
      ? async (tx) => {
          if (ended) enqueued.takeBack = await readTakeBack(tx, ended, { stopTurn })
          if (!delegating) return
          enqueued.wake = await enqueueWake(tx, {
            organizationId: session.organizationId,
            documentId: doc.id,
            annotationId,
            trigger: 'assigned',
            eventId: delegationEventId(annotationId, delegating),
            actor: { userId: session.userId, email: session.email || null },
          })
        }
      : undefined
  )
  // Gone, or a colleague moved it first: say so rather than overwrite their move.
  if (!updated) throw conflict()
  announce(session, doc.id, [annotationId], 'updated', actor)
  auditHeldWake(session, doc.id, annotationId, 'assigned', enqueued.wake)
  if (ended && enqueued.takeBack) {
    const { takeBack } = enqueued
    // The queued wake is the one thing a crash here can leave behind; its job would run a turn nobody wants.
    const by = takeBackAudit(session, doc, existing, actor)
    await settleTakenBack(ended, takeBack, { stopTurn }, by).catch((error: unknown) =>
      console.warn('[annotations] could not keep a taken-back wake from starting:', error)
    )
  }
  traceChange(
    session,
    doc,
    existing,
    {
      id: annotationId,
      number: existing.number,
      body: changes.body ?? existing.body,
      assigneeUserId: changes.assigneeUserId !== undefined ? changes.assigneeUserId : existing.assigneeUserId,
      status: changes.transition?.status ?? existing.status,
      dueOn: changes.dueOn !== undefined ? changes.dueOn : existing.dueOn,
    },
    actor
  )
  if (actor.kind === 'person' && moves) {
    traceMove(session, { id: doc.id, projectId: doc.projectId ?? null }, annotationId, existing, parsed.status)
  }
  traceMentioned(
    session,
    doc,
    existing,
    mentioned,
    changes.body ?? existing.body,
    mentions ?? existing.mentions,
    changes.assigneeUserId !== undefined && changes.assigneeUserId !== existing.assigneeUserId ? changes.assigneeUserId : null
  )
  traceWithdrawn(session, annotationId, withdrawn)
  const annotation = await viewOf(session, doc, annotationId)
  return delegating ? { annotation, wake: wakeOutcomeOf(enqueued.wake) } : { annotation }
}

/**
 * „Gilt weiter": an open mark goes on with the Fassung the document shows now,
 * at the place it was set (a position never changes under someone who read
 * it; a mark that no longer fits is resolved and set again instead).
 *
 * Under the same name the mark moves in place: its `version_id` becomes the
 * published version's, compared and swapped against the Fassung it was read
 * on, so its number, its thread and every inbox row and wake anchored on it
 * stay whole. Nobody is told: the new Fassung told the people working on its
 * marks (`lib/documents/fassung-notify.ts`), and the room re-reads.
 *
 * When another document replaces this one, the mark goes on there instead
 * ({@link carryAcross}).
 */
async function carryToCurrent(
  session: AuthorizedSession,
  doc: Document,
  existing: AnnotationRecord,
  actor: AnnotationActor
): Promise<{ annotation: AnnotationView }> {
  if (existing.status !== 'open') {
    throw new UnprocessableError('Only an open Anmerkung goes on with the current Fassung.', {
      field: 'carryToCurrent',
      reason: 'not-open',
    })
  }
  const replacing = await replacingDocumentOf(session, doc)
  if (replacing) return carryAcross(session, doc, existing, replacing, actor)
  const current = doc.publishedVersionId ?? null
  if ((existing.versionId ?? null) === current) return { annotation: await viewOf(session, doc, existing.id) }
  const updated = await updateDocumentAnnotation(session.organizationId, doc.id, existing.id, 'open', {
    fassung: { from: existing.versionId ?? null, to: current },
  })
  // Closed, or carried by a colleague a moment ago: say so rather than guess.
  if (!updated) throw conflict()
  announce(session, doc.id, [existing.id], 'updated', actor)
  return { annotation: await viewOf(session, doc, existing.id) }
}

/**
 * The mark of a document another one replaced (Index B, filed again as Index
 * C under another name) goes on as a mark of C: set there with its place, its
 * text, its author, its Zuständige (while they may still answer on C) and its
 * date, numbered on C and linked back (`carried_from_id`), while B's is closed
 * in the same transaction (`carryAnnotationToDocument`).
 *
 * A linked copy and not a move, because a move would cut what hangs on the
 * mark: B's number is what a Protokoll and a Jour fixe named, its thread is
 * anchored on B in every inbox row, wake and change record that points at it,
 * and C has numbers of its own. So B's thread stays readable where every link
 * expects it, C's mark says where it came from, and B's says where it went.
 * Closing B's mark settles what it asked of people (`traceSettled`); its
 * Zuständige is asked again on C's (`annotation.assigned_to_you`), unless they
 * carried it themselves. A mark Piloti works is taken back from Piloti first:
 * its running turn writes on B.
 */
async function carryAcross(
  session: AuthorizedSession,
  doc: Document,
  existing: AnnotationRecord,
  replacing: Document,
  actor: AnnotationActor
): Promise<{ annotation: AnnotationView }> {
  const target = await requireWritableDocument(session, replacing.id)
  if (existing.delegatedBy) {
    throw new UnprocessableError('Take the Anmerkung back from Piloti before it goes on with the new Fassung.', {
      field: 'carryToCurrent',
      reason: 'delegated',
    })
  }
  const assignee =
    existing.assigneeUserId && (await isAssignable(session, target, existing.assigneeUserId)) ? existing.assigneeUserId : null
  const mentions = await keepMentions(session, target, existing.body, existing.mentions, { piloti: false })
  const row = await carryAnnotationToDocument({
    organizationId: session.organizationId,
    source: existing,
    target: { documentId: target.id, versionId: target.publishedVersionId ?? null },
    values: { mentions, assigneeUserId: assignee },
    closedBy: session.userId,
  }).catch((error: unknown) => {
    if (error instanceof AlreadyCarriedError) throw conflict()
    return limitReached(error)
  })
  if (!row) throw conflict()
  announce(session, doc.id, [existing.id], 'updated', actor)
  announce(session, target.id, [row.id], 'created', actor)
  traceSettled(session, existing.id, true)
  if (row.assigneeUserId) traceAssigned(session, target, row, null, actor)
  return { annotation: await viewOf(session, target, row.id) }
}

/** Who took a mark back from Piloti, for the wakes it stops (`./take-back`). */
const takeBackAudit = (
  session: AuthorizedSession,
  doc: { projectId: string | null },
  mark: { number: number },
  actor: AnnotationActor
): TakeBackAudit => ({
  userId: session.userId,
  email: session.email || null,
  piloti: actor.kind === 'piloti',
  projectId: doc.projectId ?? null,
  markNumber: mark.number,
})

/** A wake a cap held at enqueue goes into the audit trail, after its write committed. */
function auditHeldWake(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string,
  trigger: PilotiWakeTrigger,
  wake: EnqueuedWake | null
): void {
  if (wake?.outcome !== 'suppressed') return
  auditSuppressedWake({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email || null },
    annotationId,
    documentId,
    trigger,
    status: 'suppressed',
    reason: wake.reason,
    stage: 'enqueue',
  })
}

/**
 * Delete one Anmerkung the session set itself, or Piloti set for it
 * ({@link mayDeleteMark}). Piloti's proposals are dismissed, never deleted.
 */
export async function deleteAnnotation(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string,
  actor: AnnotationActor = PERSON
): Promise<null> {
  const doc = await requireWritableDocument(session, documentId)
  const existing = await findDocumentAnnotation(session.organizationId, doc.id, annotationId)
  if (!existing) throw new NotFoundError()
  if (!mayDeleteMark(existing, session.userId)) {
    throw new ForbiddenError('Only the person who set an Anmerkung can delete it. Resolve or dismiss it instead.')
  }
  const ended = delegationOfMark(session, doc.id, existing)
  const stopTurn = actor.kind === 'person'
  // Set in the delete's transaction; a holder, because a closure's assignment is not narrowed.
  const found: { takeBack: TakeBack | null } = { takeBack: null }
  await deleteDocumentAnnotation(
    session.organizationId,
    doc.id,
    annotationId,
    // The mark takes its wakes with it: the running turn is read, and its stop queued, before they go.
    // A wake still queued needs nothing: its job finds the mark gone.
    ended
      ? async (tx) => {
          found.takeBack = await readTakeBack(tx, ended, { stopTurn })
        }
      : undefined
  )
  announce(session, doc.id, [annotationId], 'deleted', actor)
  if (found.takeBack) auditDeletedWithMark(found.takeBack, takeBackAudit(session, doc, existing, actor))
  bestEffort('clear the deleted mark’s rows', () =>
    onMarkDeleted({ organizationId: session.organizationId, annotationId })
  )
  return null
}

/** One Anmerkung as this session reads it; 404 when the document or the mark is not there for it. */
export async function readAnnotation(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string
): Promise<AnnotationView> {
  const doc = await getAccessibleDocument(session, documentId, 'read')
  const record = annotatable(doc) ? await findDocumentAnnotation(session.organizationId, doc.id, annotationId) : null
  if (!record) throw new NotFoundError()
  const [writable, names, wakes, work, linked] = await Promise.all([
    canWriteDocument(session, doc.id),
    directoryNames(session.organizationId),
    wakeSpansFor(session.organizationId, doc.id, [record]),
    latestWakesFor(session.organizationId, doc.id, record.id),
    linkedDocuments(session, [record]),
  ])
  const carryWay = writable ? await carryWayOf(session, doc, [record]) : null
  return toView(record, doc, session, writable, names, wakes, work, linked, carryWay)
}

/** What Piloti may change on a mark for the asker: what a person's PATCH changes, the assignee by name. */
export interface AskedChange {
  status?: 'open' | 'resolved' | 'dismissed'
  /** A name or an e-mail address as the asker said it ({@link resolveAssignee}); null clears it. */
  assignee?: string | null
  dueOn?: string | null
  kind?: AnnotationView['kind']
  body?: string
  expectedStatus?: AnnotationStatus
}

/** The fields a change can move, compared between two reads of one mark. */
const CHANGEABLE = ['status', 'assigneeUserId', 'dueOn', 'kind', 'body'] as const
export type ChangeableField = (typeof CHANGEABLE)[number]

export const changedFields = (before: AnnotationView, after: AnnotationView): ChangeableField[] =>
  CHANGEABLE.filter((field) => before[field] !== after[field])

/**
 * Piloti changes a mark because the asker asked it to, and says so in the
 * mark's thread: the change runs through {@link updateAnnotation} exactly as
 * the asker's own PATCH would (their rights, the state machine, the 409 on a
 * stale `expectedStatus`), then `note` is posted as Piloti's reply in the same
 * request, so the change and its note cannot drift apart. A change that moved
 * nothing posts nothing.
 *
 * The thread's room is checked BEFORE the change, so a full thread refuses the
 * change rather than landing it without its note. Without an `expectedStatus`
 * the status read here is the one the write compares against, so a colleague's
 * move between this read and the write is a 409 rather than overwritten.
 */
export async function updateAnnotationForAsker(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string,
  change: AskedChange,
  note: string
): Promise<{ before: AnnotationView; after: AnnotationView; changed: ChangeableField[] }> {
  const { body: noteBody } = createReplyRequestSchema.parse({ body: note })
  const doc = await requireWritableDocument(session, documentId)
  const before = await viewOf(session, doc, annotationId)
  if (change.expectedStatus && change.expectedStatus !== before.status) throw conflict()
  if (before.replies.length >= MAX_REPLIES_PER_ANNOTATION) {
    throw new UnprocessableError(`A thread carries at most ${MAX_REPLIES_PER_ANNOTATION} replies.`)
  }
  const assigneeUserId =
    change.assignee === undefined || change.assignee === null
      ? change.assignee
      : await resolveAssignee(session, doc, change.assignee)
  const { annotation: after } = await updateAnnotation(
    session,
    doc.id,
    annotationId,
    {
      ...(change.status !== undefined && { status: change.status }),
      ...(assigneeUserId !== undefined && { assigneeUserId }),
      ...(change.dueOn !== undefined && { dueOn: change.dueOn }),
      ...(change.kind !== undefined && { kind: change.kind }),
      ...(change.body !== undefined && { body: change.body }),
      expectedStatus: change.expectedStatus ?? before.status,
    },
    PILOTI
  )
  const changed = changedFields(before, after)
  if (changed.length === 0) return { before, after, changed }
  // The note says what the change did; the change already told whoever it
  // concerns, exactly as the asker's own PATCH would, so the note tells nobody twice.
  await postReply(session, doc.id, annotationId, { body: noteBody }, PILOTI)
  return { before, after: await viewOf(session, doc, annotationId), changed }
}

/**
 * Answer in an Anmerkung's thread, as a person or as Piloti for one.
 *
 * A person's reply that addresses Piloti, or answers Piloti's own open
 * question, wakes Piloti: with the organization's switch on, the wake is
 * enqueued in the reply's transaction (`wake: 'queued'`, or `'suppressed'`
 * when a cap holds it); with it off, the response says `'off'` and the
 * browser asks Piloti itself, as before. Piloti's reply never wakes it, and
 * never hands a delegated mark back: only the delegation's own turn ending does.
 */
export async function replyToAnnotation(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string,
  input: CreateReplyRequest,
  actor: AnnotationActor = PERSON
): Promise<{ annotation: AnnotationView; replyId: string; wake: WakeOutcome }> {
  const { doc, existing, reply, wake, mentioned } = await postReply(session, documentId, annotationId, input, actor)
  traceMentioned(session, doc, existing, mentioned, reply.body, reply.mentions)
  bestEffort('tell the thread', () =>
    onMarkReplied({
      ...markRefOf(session, doc, existing),
      actorUserId: session.userId,
      byPiloti: actor.kind === 'piloti',
      markText: existing.body,
      mark: existing,
      replyText: reply.body,
      replyMentions: reply.mentions,
      mayOpen: mayOpenOf(session, doc),
      mentioned,
    })
  )
  return { annotation: await viewOf(session, doc, annotationId), replyId: reply.id, wake }
}

/** Post one reply, wake Piloti where it should, tell the room: {@link replyToAnnotation} without telling the thread. */
async function postReply(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string,
  input: CreateReplyRequest,
  actor: AnnotationActor
): Promise<{
  doc: Document
  existing: AnnotationRecord
  reply: DocumentAnnotationReplyRow
  wake: WakeOutcome
  mentioned: string[]
}> {
  const { body, addressesPiloti, mentions: picked } = createReplyRequestSchema.parse(input)
  const doc = await requireWritableDocument(session, documentId)
  const existing = await findDocumentAnnotation(session.organizationId, doc.id, annotationId)
  if (!existing) throw new NotFoundError()
  // Piloti mentions nobody: only a person's reply carries what they picked.
  const mentions = actor.kind === 'person' ? await keepMentions(session, doc, body, picked ?? [], { piloti: true }) : []
  const mentioned = await spendMentions(session, newlyMentioned(mentions, [], session.userId), mentionsPiloti(mentions))
  const addresses = actor.kind === 'person' && (Boolean(addressesPiloti) || mentionsPiloti(mentions))
  const trigger = replyTrigger(existing, { authorKind: actor.kind, addressesPiloti: addresses })
  const enabled = trigger !== null && wakesEnabled(session)
  const enqueued: { wake: EnqueuedWake | null } = { wake: null }
  const reply = await insertAnnotationReply(
    {
      organizationId: session.organizationId,
      annotationId,
      authorKind: actor.kind,
      body,
      createdBy: session.userId,
      addressesAgent: addresses,
      mentions,
    },
    enabled && trigger
      ? async (tx, row) => {
          enqueued.wake = await enqueueWake(tx, {
            organizationId: session.organizationId,
            documentId: doc.id,
            annotationId,
            trigger,
            eventId: row.id,
            actor: { userId: session.userId, email: session.email || null },
          })
        }
      : undefined
  ).catch((error: unknown) => {
    if (error instanceof ReplyLimitReachedError) {
      throw new UnprocessableError(`A thread carries at most ${MAX_REPLIES_PER_ANNOTATION} replies.`)
    }
    throw error
  })
  announce(session, doc.id, [annotationId], 'replied', actor)
  if (trigger) auditHeldWake(session, doc.id, annotationId, trigger, enqueued.wake)
  if (actor.kind === 'person') traceSettled(session, annotationId, false)
  const outcome: WakeOutcome = trigger === null ? 'none' : enabled ? wakeOutcomeOf(enqueued.wake) : 'off'
  return { doc, existing, reply, wake: outcome, mentioned }
}

/**
 * Delete one reply from a thread: the person it was posted for may, whether
 * they wrote it or Piloti did in their name (`created_by` is the session the
 * reply was posted in, for both). Nobody else's thread entry vanishes under
 * them. `expectedBody` is a compare-and-swap for undo: a reply that says
 * something else now is a 409, never deleted. Tells the room, which re-reads.
 */
export async function deleteReply(
  session: AuthorizedSession,
  documentId: string,
  annotationId: string,
  replyId: string,
  options: { expectedBody?: string; actor?: AnnotationActor } = {}
): Promise<null> {
  const actor = options.actor ?? PERSON
  const doc = await requireWritableDocument(session, documentId)
  const existing = await findDocumentAnnotation(session.organizationId, doc.id, annotationId)
  const reply = existing?.replies.find((candidate) => candidate.id === replyId)
  if (!existing || !reply) throw new NotFoundError()
  if (reply.createdBy !== session.userId) {
    throw new ForbiddenError('Only the person an answer was written for can delete it.')
  }
  if (options.expectedBody !== undefined && options.expectedBody !== reply.body) throw conflict()
  const gone = await deleteAnnotationReply(session.organizationId, annotationId, replyId, options.expectedBody)
  if (!gone) throw conflict()
  announce(session, doc.id, [annotationId], 'updated', actor)
  const left = existing.replies.filter((candidate) => candidate.id !== replyId)
  traceWithdrawn(
    session,
    annotationId,
    noLongerMentioned(reply.mentions, [existing.mentions, ...left.map((candidate) => candidate.mentions)])
  )
  return null
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
