'use client'

/**
 * Answering a request on a mark, from wherever the inbox shows it: its row,
 * and the detail beside the list. One implementation, so the two places can
 * never differ on what an answer or „Erledigen“ writes.
 *
 * The writes are the thread's own (`replyToAnnotation`, `updateAnnotation`):
 * the answer goes in as the thread's would, with whom it mentions as picked
 * and @{productName} as its flag; „Erledigen“ is held for the undo window and sent
 * from the status the reader knows the mark in, so a mark somebody moved
 * meanwhile is a 409, never overwritten from a copy of it. The server decides
 * where an answer may be written (`answerIn`); nothing here guesses it.
 */

import { useState } from 'react'

import { AnnotationRequestError, replyToAnnotation, updateAnnotation } from '@/lib/annotations/client'
import type { MarkMention } from '@/lib/annotations/types'
import type { InboxItemView } from '@/lib/inbox/types'
import { AGENT_MENTION_ID } from '@/lib/mentions/types'
import type { ComposerSend } from '@/features/documents/review-links'
import { useUndoableArchive } from './use-undoable-archive'

/** The two writes an answer makes, through the annotations' own client. Injected by the specs. */
export interface InboxMarkClient {
  reply: typeof replyToAnnotation
  update: typeof updateAnnotation
}

export const MARK_CLIENT: InboxMarkClient = { reply: replyToAnnotation, update: updateAnnotation }

export type MarkOutcome = 'sent' | 'sentAgentNotAsked' | 'resolved' | 'conflict' | 'failed'

export interface UseMarkAnswerOptions {
  item: InboxItemView
  /** The item is about a reachable mark: a document's, with the mark as its anchor. */
  markRow: boolean
  markClient?: InboxMarkClient
  /** Answered from here is read here: told after a reply lands. */
  onOpen?: (item: InboxItemView) => void
}

export function useMarkAnswer({ item, markRow, markClient = MARK_CLIENT, onOpen }: UseMarkAnswerOptions) {
  const resolved = item.state === 'resolved'
  const archived = item.archived
  /*
    A request on a mark is answered where the server says it may be
    (`answerIn`): here in the row, only in the Prüfansicht (Piloti's Rückfrage
    while events do not wake Piloti: the review asks Piloti itself), or not at
    all (the reader may only read the document). Never guessed here.
  */
  const markOpen = markRow && item.answerIn !== null && item.actionable && !resolved && !archived
  const answerHere = markOpen && item.answerIn === 'row'
  const answerInReview = markOpen && item.answerIn === 'review'
  const canResolveMark = answerHere && item.type === 'annotation.assigned_to_you'
  const [replying, setReplying] = useState(false)
  const [markBusy, setMarkBusy] = useState(false)
  const [markOutcome, setMarkOutcome] = useState<MarkOutcome | null>(null)
  /** Whom the last answer named and the server did not keep: they cannot open the document, so nobody told them. */
  const [untold, setUntold] = useState<string[]>([])

  /*
    The answer goes in as the thread's would, with whom it mentions as picked
    and @Piloti as its flag. A failure throws back into the composer, which
    keeps the text and says the row's own words for it (`describeFailure`).
    Answers with the mentions the server kept.
  */
  const sendReply = async (body: string, { piloti, mentions }: ComposerSend): Promise<readonly MarkMention[] | void> => {
    if (!answerHere || !item.anchorId) return
    setMarkBusy(true)
    setMarkOutcome(null)
    try {
      const { annotation, replyId, wake } = await markClient.reply(item.resourceId, item.anchorId, {
        body: body.trim(),
        ...(piloti ? { addressesPiloti: true } : {}),
        ...(mentions.length > 0 ? { mentions } : {}),
      })
      const kept = annotation.replies.find((reply) => reply.id === replyId)?.mentions ?? []
      const keptIds = new Set(kept.map((mention) => mention.targetId))
      setUntold(
        mentions
          .filter((mention) => mention.targetId !== AGENT_MENTION_ID && !keptIds.has(mention.targetId))
          .map((mention) => mention.display),
      )
      setReplying(false)
      // `off`: the answer met a wake rule but nothing wakes the agent here; the row says how to ask it.
      setMarkOutcome(wake === 'off' ? 'sentAgentNotAsked' : 'sent')
      // Answered from here is read here: the thread has the reply.
      onOpen?.(item)
      return kept
    } finally {
      setMarkBusy(false)
    }
  }

  /*
    „Erledigen“ holds its write for the undo window, as archiving a row does
    and as the review holds a decision by a key (`useUndoableArchive`): the
    row says „Als erledigt markiert. Rückgängig“ at once, and the PATCH goes
    when the window ends, the page is hidden or the row goes. „Rückgängig“
    inside the window lets go of it: nothing was sent, so the request this row
    asks is still open on the server and the list keeps the row. The write is
    from the status the row knows the mark in (`expectedStatus`): a mark
    somebody moved meanwhile is a 409, never overwritten from a copy of it,
    and the row says so when the write finally goes.
  */
  const sendResolve = async (anchorId: string): Promise<void> => {
    setMarkBusy(true)
    try {
      await markClient.update(item.resourceId, anchorId, { status: 'resolved', expectedStatus: 'open' })
    } catch (error) {
      setMarkOutcome(error instanceof AnnotationRequestError && error.status === 409 ? 'conflict' : 'failed')
    } finally {
      setMarkBusy(false)
    }
  }
  const resolveLater = useUndoableArchive(sendResolve)
  const resolveHeld = item.anchorId !== null && resolveLater.pendingIds.has(item.anchorId)

  const resolveMark = (): void => {
    if (!canResolveMark || !item.anchorId || markBusy) return
    setMarkOutcome('resolved')
    resolveLater.request(item.anchorId)
  }

  const undoResolve = (): void => {
    if (!item.anchorId) return
    resolveLater.undo(item.anchorId)
    setMarkOutcome(null)
  }

  // „Rückgängig“ while the write is held, not once it has gone out.
  const offerUndo = resolveHeld && !markBusy && markOutcome === 'resolved'

  return {
    answerHere,
    answerInReview,
    canResolveMark,
    replying,
    setReplying,
    markBusy,
    markOutcome,
    setMarkOutcome,
    untold,
    sendReply,
    resolveMark,
    undoResolve,
    offerUndo,
  }
}
