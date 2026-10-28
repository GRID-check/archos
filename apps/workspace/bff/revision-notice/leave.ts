/**
 * What a notice leaves behind once it has marks (ADR-0130), shared by both
 * kinds of notice (the picture comparison of a new Fassung, the cross-document
 * check of a new document): one message in the person's thread about the
 * document, and one inbox row that opens the Prüfansicht at the first mark.
 *
 * The message id is derived from the notice, so a retry writes nothing twice.
 * The inbox row is best-effort: a row that could not be written never undoes
 * the message.
 */

import 'server-only'
import { ensureDocumentThread } from '@/lib/annotations/document-thread'
import type { AuthorizedSession } from '@/lib/auth/types'
import { insertMessages } from '@/lib/conversations/repository'
import type { Document } from '@/lib/db/schema/documents'
import { documentDisplayName } from '@/lib/documents/display-name'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { emitInboxItems } from '@/lib/inbox/service'

export interface NoticeLeaving {
  session: AuthorizedSession
  newer: Document
  /** Where the message goes: `ensureDocumentThread`'s id, already ensured by a caller that needs it first. */
  conversationId: string
  messageId: string
  /** German, because a person reads it. */
  content: string
  /** Merged into the message's metadata beside `messageType`. */
  metadata: Record<string, unknown>
  /** The marks the notice stands for, the first one anchors the inbox row. */
  marks: ReadonlyArray<{ id: string }>
  excerpt: string | null
  /** The inbox row's words (`inbox.types.agentRevisionChecked.variants.<variant>`). */
  variant: string
  /** The second name of the row (the older Fassung); absent for a check of one document. */
  related?: string
}

/** The thread of the document, for a caller that must write marks before the message. */
export const noticeThread = (session: AuthorizedSession, newer: Document): Promise<string> =>
  ensureDocumentThread(session, newer)

/** Write the message and the inbox row. */
export async function leaveNotice(input: NoticeLeaving): Promise<void> {
  const { session, newer } = input
  await insertMessages([
    {
      id: input.messageId,
      conversationId: input.conversationId,
      role: 'assistant',
      content: input.content,
      metadata: { messageType: 'agent_response', ...input.metadata },
    },
  ])
  const first = input.marks[0]
  if (!first) return
  await emitInboxItems([
    {
      organizationId: session.organizationId,
      recipientUserId: session.userId,
      type: 'piloti.revision_checked',
      resourceType: 'document',
      resourceId: newer.id,
      anchorId: first.id,
      actorUserId: null,
      groupKey: inboxGroupKey('piloti.revision_checked', 'document', newer.id, first.id),
      payload: {
        subject: documentDisplayName(newer),
        ...(input.related ? { related: input.related } : {}),
        openMarks: input.marks.length,
        variant: input.variant,
        ...(input.excerpt ? { excerpt: input.excerpt } : {}),
      },
    },
  ]).catch((error: unknown) => console.warn('[revision-notice] the inbox row could not be written', error))
}
