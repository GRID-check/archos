/**
 * Piloti's hands on a document's Anmerkungen: read them, propose findings,
 * answer in a thread (`POST /api/internal/document-annotations`).
 *
 * ## Which document
 *
 * Only the CONVERSATION's subject, resolved here from the conversation row the
 * signed envelope names, never an id the model typed. The subject was set by a
 * person's own session when they opened a chat about the document („Piloti
 * dazu fragen", „Piloti prüfen lassen"), so the pair is exactly the authority
 * the turn already had (the argument `readVersionForService` makes for the
 * subject's bytes). A conversation without a document subject has no
 * Anmerkungen to touch, and says so.
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
import { NotFoundError, UnprocessableError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { findConversationInOrg } from '@/lib/conversations/repository'
import { SCREENED_ONLY } from '@/lib/documents/document-reader'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { admitSubjectRead } from '@/lib/documents/version-content'
import type { VerifiedGridRequestContext } from '@/lib/request-context'
import {
  listAnnotationsForAgent,
  PILOTI,
  proposeAnnotations,
  replyToAnnotation,
} from './service'
import type { InternalAnnotationRequest } from './types'

/** Thrown when the conversation is not about a document: the tool relays it as „open a chat on the document". */
export class NoDocumentSubjectError extends UnprocessableError {
  constructor() {
    super('This conversation is not about a document. Open the document and ask Piloti from there.', {
      reason: 'no-document-subject',
    })
  }
}

/** The conversation's subject document, admitted for a model to read; its id. */
export async function resolveAgentSubject(
  context: VerifiedGridRequestContext,
  answerMessageId: string | null
): Promise<string> {
  if (!context.conversationId) throw new NoDocumentSubjectError()
  const conversation = await findConversationInOrg(context.conversationId, context.organizationId)
  if (!conversation || conversation.subjectResourceType !== 'document' || !conversation.subjectResourceId) {
    throw new NoDocumentSubjectError()
  }
  const document = await findDocumentInOrg(conversation.subjectResourceId, context.organizationId, SCREENED_ONLY)
  if (!document) throw new NotFoundError('Document not found')
  await admitSubjectRead(document, context.organizationId, context.conversationId, {
    askerUserId: context.userId,
    answerMessageId,
  })
  return document.id
}

/** Run one of Piloti's operations on the subject, as the asker. */
export async function runAgentAnnotationRequest(
  session: AuthorizedSession,
  documentId: string,
  request: InternalAnnotationRequest
) {
  switch (request.op) {
    case 'list':
      return listAnnotationsForAgent(session, documentId)
    case 'propose': {
      const { annotations } = await proposeAnnotations(session, documentId, request.proposals)
      return {
        documentId,
        proposed: annotations.map((annotation) => ({ id: annotation.id, number: annotation.number, page: annotation.page })),
      }
    }
    case 'reply': {
      const { annotation } = await replyToAnnotation(session, documentId, request.annotationId, { body: request.body }, PILOTI)
      return { documentId, annotationId: annotation.id, number: annotation.number, replies: annotation.replies.length }
    }
  }
}
