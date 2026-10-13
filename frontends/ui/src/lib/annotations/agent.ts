/**
 * Piloti's hands on a document's Anmerkungen: read them, propose findings,
 * and, when the asker asks, everything the asker may do themselves: set a
 * mark, change one, delete one they set, answer in a thread
 * (`POST /api/internal/document-annotations`).
 *
 * ## Which document
 *
 * By default the CONVERSATION's subject, resolved here from the conversation
 * row the signed envelope names. The subject was set by a person's own session
 * when they opened a chat about the document, so the pair is exactly the
 * authority the turn already had (the argument `readVersionForService` makes for
 * the subject's bytes).
 *
 * A turn may also name another document („Mach eine Anmerkung im Grundriss
 * EG"), from any chat. That id is the MODEL's choice, so it is admitted only
 * the way the turn's other reads are (`internal/document-file`, ADR-0088): the
 * document must sit in a collection the envelope's signed scope covers, and a
 * restricted folder is admitted against the conversation's audience. Every
 * refusal is the same 404 as an unknown document. Beyond the scope, the asker's
 * own access rules hold, because `./service` runs as their pinned session.
 *
 * ## As whom
 *
 * As the asker: the pinned session the envelope names (ADR-0054 §4), so every
 * rule `./service` applies to a person applies here, and a proposal is filed
 * on their behalf. Beyond that, two rules only a model needs:
 *   - a held upload reaches no model, not even its own uploader's turn
 *     (ADR-0086), so the subject must have passed screening;
 *   - a subject in a restricted folder is admitted against the conversation's
 *     audience first (ADR-0087, ADR-0093), exactly as the subject's bytes are,
 *     because what Piloti reads lands in an answer everyone in the thread sees.
 */

import 'server-only'
import { BadRequestError, NotFoundError, UnprocessableError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { findConversationInOrg } from '@/lib/conversations/repository'
import { SCREENED_ONLY } from '@/lib/documents/document-reader'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { getAccessibleDocument } from '@/lib/documents/access'
import { admitSubjectRead } from '@/lib/documents/version-content'
import { type AgentRoomOp, pilotiPeer, publishAsAgent, roomSnapshot } from '@/lib/realtime/document-channel'
import type { VerifiedGridRequestContext } from '@/lib/request-context'
import {
  deleteAnnotation,
  listAnnotationsForAgent,
  PILOTI,
  proposeAnnotations,
  readAnnotation,
  replyToAnnotation,
  setAnnotationsForAsker,
  updateAnnotationForAsker,
  type ChangeableField,
} from './service'
import type { AnnotationView, InternalAnnotationRequest, InternalMarkFields } from './types'

/** Thrown when the conversation is not about a document: the tool relays it as „open a chat on the document". */
export class NoDocumentSubjectError extends UnprocessableError {
  constructor() {
    super('This conversation is not about a document. Open the document and ask Piloti from there.', {
      reason: 'no-document-subject',
    })
  }
}

/** The document a turn acts on: its id and the name a person knows it by. */
export interface AgentDocument {
  id: string
  name: string
}

/**
 * The document Piloti acts on, admitted for a model to read: the one the turn
 * named, or else the conversation's subject.
 */
export async function resolveAgentDocument(
  context: VerifiedGridRequestContext,
  requestedId: string | null,
  answerMessageId: string | null
): Promise<AgentDocument> {
  if (!context.conversationId) throw new NoDocumentSubjectError()
  const conversation = await findConversationInOrg(context.conversationId, context.organizationId)
  const subjectId =
    conversation?.subjectResourceType === 'document' ? (conversation.subjectResourceId ?? null) : null
  const documentId = requestedId ?? subjectId
  if (!documentId) throw new NoDocumentSubjectError()
  const document = await findDocumentInOrg(documentId, context.organizationId, SCREENED_ONLY)
  if (!document) throw new NotFoundError('Document not found')
  if (documentId !== subjectId && !context.collectionScope.includes(document.collectionName)) {
    throw new NotFoundError('Document not found')
  }
  await admitSubjectRead(document, context.organizationId, context.conversationId, {
    askerUserId: context.userId,
    answerMessageId,
  })
  return { id: document.id, name: document.filename }
}

/** Who the turn acts for in a room: the conversation, on behalf of the asker. */
interface AgentInRoom {
  organizationId: string
  conversationId: string
  onBehalfOf: string
}

/**
 * Who has the document open, for Piloti: names, where each looks, the mark
 * each has selected (by its number, the handle people say) and the box each
 * is drawing. Piloti's own peer for this conversation is left out.
 */
async function readRoom(session: AuthorizedSession, document: AgentDocument, agent: AgentInRoom) {
  const { annotations } = await listAnnotationsForAgent(session, document.id)
  const numbers = new Map(annotations.map((annotation) => [annotation.id, annotation.number]))
  const self = pilotiPeer(agent.conversationId, agent.onBehalfOf).peerId
  const peers = (await roomSnapshot(document.id, agent.organizationId)).filter((peer) => peer.peerId !== self)
  return {
    documentId: document.id,
    documentName: document.name,
    peers: peers.map((peer) => ({
      name: peer.name,
      kind: peer.kind,
      page: peer.page,
      viewport: peer.viewport,
      selectedMarkNumber: (peer.selected && numbers.get(peer.selected)) ?? null,
      draft: peer.draft,
    })),
    marks: {
      open: annotations.filter((annotation) => annotation.status === 'open').length,
      proposed: annotations.filter((annotation) => annotation.status === 'proposed').length,
    },
  }
}

/**
 * A gesture in the room, as Piloti for this conversation. The asker must be
 * able to read the document; presence is renewed with every gesture, so a
 * Piloti that stops gesturing times out of the room on its own.
 */
async function gesture(session: AuthorizedSession, document: AgentDocument, agent: AgentInRoom, ops: AgentRoomOp[]) {
  await getAccessibleDocument(session, document.id, 'read')
  for (const op of ops) {
    await publishAsAgent(document.id, agent.organizationId, agent, op)
  }
  return { documentId: document.id, documentName: document.name, ok: true as const }
}

/** A mark Piloti set, as the activity card draws it. */
const setMark = (annotation: AnnotationView) => ({
  id: annotation.id,
  number: annotation.number,
  page: annotation.page,
  shape: annotation.shape,
  x: annotation.x,
  y: annotation.y,
  w: annotation.w,
  h: annotation.h,
  kind: annotation.kind,
  body: annotation.body,
})

/** The fields a change moved, as they stood in one read: the card's before and after, and its undo. */
const movedFields = (view: AnnotationView, changed: readonly ChangeableField[]): InternalMarkFields => ({
  ...(changed.includes('status') && { status: view.status }),
  ...(changed.includes('assigneeUserId') && { assigneeUserId: view.assigneeUserId, assigneeName: view.assigneeName }),
  ...(changed.includes('dueOn') && { dueOn: view.dueOn }),
  ...(changed.includes('kind') && { kind: view.kind }),
  ...(changed.includes('body') && { body: view.body }),
})

type UpdateRequest = Extract<InternalAnnotationRequest, { op: 'update' }>

async function update(session: AuthorizedSession, document: AgentDocument, request: UpdateRequest) {
  const { annotationId, note, expectedStatus, status, assignee, dueOn, kind, body } = request
  if ([status, assignee, dueOn, kind, body].every((value) => value === undefined)) {
    throw new BadRequestError('Name at least one change: status, assignee, dueOn, kind or body.')
  }
  const { before, after, changed } = await updateAnnotationForAsker(
    session,
    document.id,
    annotationId,
    { status, assignee, dueOn, kind, body, expectedStatus },
    note
  )
  return {
    documentId: document.id,
    documentName: document.name,
    annotationId: after.id,
    number: after.number,
    status: after.status,
    before: movedFields(before, changed),
    after: movedFields(after, changed),
    noted: changed.length > 0,
  }
}

/** Run one of Piloti's operations on the document, as the asker. */
export async function runAgentAnnotationRequest(
  session: AuthorizedSession,
  document: AgentDocument,
  request: InternalAnnotationRequest,
  agent: AgentInRoom
) {
  const documentId = document.id
  switch (request.op) {
    case 'room':
      return readRoom(session, document, agent)
    case 'point':
      return gesture(session, document, agent, [
        { op: 'presence', state: 'here' },
        { op: 'cursor', cursor: { page: request.page, x: request.x, y: request.y }, label: request.label },
      ])
    case 'highlight': {
      const box = {
        page: request.page,
        x: request.x,
        y: request.y,
        w: Math.min(request.w, 1 - request.x),
        h: Math.min(request.h, 1 - request.y),
      }
      return gesture(session, document, agent, [
        { op: 'presence', state: 'here' },
        { op: 'highlight', box, label: request.label },
      ])
    }
    case 'leave':
      return gesture(session, document, agent, [
        { op: 'cursor', cursor: null },
        { op: 'activity', state: 'idle' },
        { op: 'presence', state: 'gone' },
      ])
    case 'list':
      return { ...(await listAnnotationsForAgent(session, documentId)), documentName: document.name }
    case 'propose': {
      const { annotations } = await proposeAnnotations(session, documentId, request.proposals)
      return { documentId, documentName: document.name, proposed: annotations.map(setMark) }
    }
    case 'create': {
      const { annotations } = await setAnnotationsForAsker(session, documentId, request.marks)
      return { documentId, documentName: document.name, created: annotations.map(setMark) }
    }
    case 'update':
      return update(session, document, request)
    case 'delete': {
      // Read first, for the number and the text the card names: once deleted,
      // the mark and its thread are gone. The delete applies the asker's rule.
      const mark = await readAnnotation(session, documentId, request.annotationId)
      await deleteAnnotation(session, documentId, request.annotationId, PILOTI)
      return {
        documentId,
        documentName: document.name,
        annotationId: mark.id,
        number: mark.number,
        body: mark.body,
      }
    }
    case 'reply': {
      const { annotation } = await replyToAnnotation(session, documentId, request.annotationId, { body: request.body }, PILOTI)
      return {
        documentId,
        documentName: document.name,
        annotationId: annotation.id,
        number: annotation.number,
        replies: annotation.replies.length,
      }
    }
  }
}
