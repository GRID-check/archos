import 'server-only'
/**
 * What on a mark needs a person's attention, as inbox items (ADR-0035, ADR-0109).
 *
 * The call sites name the EVENT; this module decides which person gets which
 * item, and resolves items whose cause is gone. Every function is best-effort:
 * it never throws into the write that called it.
 *
 * | Event | Item | For |
 * |---|---|---|
 * | A woken turn on a delegated mark ended `answered` | `piloti.work_done` | who delegated it |
 * | … ended `failed` | `piloti.work_failed` | who delegated it |
 * | A woken turn on a mention or an answer ended `answered` | `piloti.work_done` | who mentioned or answered |
 * | … ended `failed` | `piloti.work_failed` | who mentioned or answered |
 * | The wake job was refused, or gave up, before a turn answered | `piloti.work_failed` | whoever woke Piloti |
 * | Any woken turn ended `stopped` | none: the person stopped it | |
 * | Piloti set a Rückfrage, or replied on its own open Rückfrage | `piloti.asks_you` | the mark's Zuständige, else the person its turn acted for |
 * | Piloti set another mark | none: ordinary work | |
 * | A person made someone the mark's Zuständige (setting it, changing it, or taking over Piloti's proposal that names one) | `annotation.assigned_to_you` | the new Zuständige, unless they did it themselves |
 * | Piloti did, for the person its turn acted for | `annotation.assigned_to_you`, variant `piloti` | the same |
 * | Someone else became responsible, or nobody | resolves the previous Zuständige's `annotation.assigned_to_you` | |
 * | Someone set, moved or cleared the date of a mark that has a Zuständige | `annotation.assigned_to_you`, variant `due` / `due_cleared` (`…_piloti` when Piloti did it for a person), folded into their row for the mark | the Zuständige, unless they did it themselves |
 * | The daily reminder (`./due-reminders.ts`): the date is today or tomorrow, or it has passed | `annotation.assigned_to_you`, variant `due_soon`, then `overdue`, folded into the same row, each once per date | the Zuständige |
 * | A person mentioned a colleague in a mark's text (setting it, or rewording it) or in a reply | `annotation.mentioned` | each person mentioned anew, minus whoever wrote it and minus a Zuständige the same write made responsible (who hears `annotation.assigned_to_you`) |
 * | A person or Piloti replied in the thread | `annotation.activity`, variant `reply` | the mark's participants ({@link markParticipants}), minus whoever acted (for Piloti, the person its turn acted for: on a wake, who woke it and hears `piloti.work_done`), minus who Piloti's open Rückfrage asks, minus whom the reply mentions (who hear `annotation.mentioned` instead) |
 * | Someone resolved, dismissed or reopened a mark | `annotation.activity`, variant `resolved` / `dismissed` / `reopened` | the mark's author, unless they did it |
 * | A person answered in the thread | resolves `piloti.asks_you`, for everyone, and their own `annotation.mentioned` | |
 * | The mark was resolved or dismissed | resolves everyone's `piloti.asks_you`, `annotation.assigned_to_you` and `annotation.mentioned` | |
 * | A mention was taken out of the text, or its reply deleted, and nothing left on the mark names that person | their `annotation.mentioned` turns inert | |
 * | The mark was deleted | every row anchored on it turns inert, for everyone | |
 *
 * The author's `annotation.activity` row says `yours: true`: a reply or a move
 * on a mark they wrote answers them, and is pushed as a result, not as activity.
 *
 * Every recipient of a person's news is asked whether they may open the
 * document now (`lib/documents/may-open.ts`, handed in as {@link MayOpen}):
 * someone who cannot read the folder is never told what a mark in it says.
 *
 * Piloti's own items belong to a Piloti turn, so they carry no actor: Piloti
 * did it, and an actor equal to the recipient would make `emitInboxItems` drop
 * the row. A person's items carry the person, and Piloti's act for a person
 * carries that person. They point at the document, anchored on the mark, and
 * `lib/inbox/targets` builds the link that opens the Prüfansicht at it. Access
 * is the document's, re-derived when the row is read. They carry the document's
 * name and the mark's number, so the row says which mark in which document; as
 * the excerpt, a Rückfrage carries Piloti's question, a reply what it says, and
 * everything else what the mark says. A row asking the Zuständige carries the
 * mark's date (`dueOn`, null without one), so the row says by when. Rows fold per mark and their payloads
 * merge, so every row names its `variant`: a failed wake the class of its
 * reason (`./wake-end-reason.ts`), so the notice says why in words the person
 * can act on, never the stored reason itself.
 */

import { findDocumentAnnotation, type AnnotationRecord } from './repository'
import { isLive, type MarkMention } from './types'
import { wakeEndReasonKind } from './wake-end-reason'
import { bestEffortInbox } from '@/lib/inbox/best-effort'
import { inboxGroupKey, MARK_ANCHORED_INBOX_TYPES } from '@/lib/inbox/registry'
import { emitInboxItems, markInboxItemsInertAnchoredOn, resolveInboxItemsAnchoredOn } from '@/lib/inbox/service'
import type { DocumentAnnotationReplyRow, InboxItemType } from '@/lib/db/schema'
import { AGENT_MENTION_ID } from '@/lib/mentions/types'
import { describeResource } from '@/lib/sharing/registry'

/** The mark an event is about. */
export interface MarkRef {
  organizationId: string
  documentId: string
  annotationId: string
  /** The mark's running number („Anmerkung 4“). */
  annotationNumber: number
  /** The document's project; null on the Büroablage. */
  projectId: string | null
}

/** Longest question quoted in a row. */
const EXCERPT_LENGTH = 160

function excerptOf(text: string | null | undefined): string | null {
  const trimmed = text?.replace(/\s+/g, ' ').trim()
  if (!trimmed) return null
  return trimmed.length > EXCERPT_LENGTH ? `${trimmed.slice(0, EXCERPT_LENGTH - 1)}…` : trimmed
}

/** The document's name for the row, or null when it cannot be read (the row then names no file). */
async function documentName(ref: MarkRef): Promise<string | null> {
  try {
    const found = await describeResource('document').describeRef(ref.documentId, ref.organizationId)
    return found?.title ?? null
  } catch {
    return null
  }
}

/** What a row about a mark says beyond the mark: its quote, its wording, and who did it (null: Piloti). */
interface MarkItem {
  excerpt: string | null
  /**
   * Whom the quoted text mentions, as the server kept them, so the row draws
   * the chips the thread draws. Written beside every excerpt, `[]` where the
   * caller has none: rows fold per mark and their payloads merge, and an
   * excerpt must never inherit the mentions of the one it replaced.
   */
  mentions?: readonly MarkMention[]
  /** Picks the row's wording, where its type has more than one. */
  variant?: string | null
  actorUserId?: string | null
  /**
   * Whose mark it is, when that matters to how the news reaches them: their
   * row says `yours: true`, and the push policy then treats it as an answer to
   * them (`InboxPushPolicy.yours`), not ambient activity.
   */
  author?: string | null
  /** Facts the row's words need beyond the mark's (its date), merged into the payload as given; null clears. */
  facts?: Record<string, string | number | null>
}

/** One item about a mark, addressed to each of these people. */
async function emitAboutMark(
  type: InboxItemType,
  ref: MarkRef,
  recipientUserIds: readonly string[],
  { excerpt, mentions = [], variant = null, actorUserId = null, author = null, facts = {} }: MarkItem
): Promise<void> {
  if (recipientUserIds.length === 0) return
  const subject = await documentName(ref)
  const payload = {
    ...(subject ? { subject } : {}),
    related: String(ref.annotationNumber),
    ...(excerpt ? { excerpt, mentions: [...mentions] } : {}),
    ...(variant ? { variant } : {}),
    ...facts,
  }
  await emitInboxItems(
    recipientUserIds.map((recipientUserId) => ({
      organizationId: ref.organizationId,
      recipientUserId,
      type,
      resourceType: 'document',
      resourceId: ref.documentId,
      anchorId: ref.annotationId,
      actorUserId,
      groupKey: inboxGroupKey(type, 'document', ref.documentId, ref.annotationId),
      payload: author !== null && recipientUserId === author ? { ...payload, yours: true } : payload,
    }))
  )
}

/** Which of these people may open the mark's document now (`mayOpenDocument`, bound to the writer's session and the document). */
export type MayOpen = (userIds: readonly string[]) => Promise<ReadonlySet<string>>

/** What of a mark says who takes part in it. */
export type MarkPeople = Pick<AnnotationRecord, 'authorKind' | 'createdBy' | 'acceptedBy' | 'assigneeUserId' | 'delegatedBy'> &
  Partial<Pick<AnnotationRecord, 'mentions'>> & {
    replies: ReadonlyArray<
      Pick<DocumentAnnotationReplyRow, 'authorKind' | 'createdBy'> & Partial<Pick<DocumentAnnotationReplyRow, 'mentions'>>
    >
  }

/**
 * Whose mark it is: the person who set it, or for Piloti's mark the person who
 * took it over or asked for it (`accepted_by`). A proposal nobody took over is
 * nobody's.
 */
export const markAuthor = (mark: Pick<MarkPeople, 'authorKind' | 'createdBy' | 'acceptedBy'>): string | null =>
  mark.authorKind === 'person' ? mark.createdBy : mark.acceptedBy

/**
 * Everyone a mark's thread concerns, once each: its author, its Zuständige,
 * who delegated it to Piloti, every person who replied, and every person its
 * text or a reply mentions (being asked into a thread is taking part in it,
 * as in the chat). Derived from the mark when something happens, never stored
 * as a list, so it is always today's thread. Pure. The one definition every
 * item about a mark's thread asks.
 */
export function markParticipants(mark: MarkPeople): string[] {
  const mentioned = [mark.mentions ?? [], ...mark.replies.map((reply) => reply.mentions ?? [])]
    .flat()
    .map((mention) => mention.targetId)
    .filter((targetId) => targetId !== AGENT_MENTION_ID)
  const people = [
    markAuthor(mark),
    mark.assigneeUserId,
    mark.delegatedBy,
    ...mark.replies.filter((reply) => reply.authorKind === 'person').map((reply) => reply.createdBy),
    ...mentioned,
  ]
  return [...new Set(people.filter((userId): userId is string => Boolean(userId)))]
}

/** The people of `userIds` who may open the document, in order. */
async function whoMayOpen(mayOpen: MayOpen, userIds: readonly string[]): Promise<string[]> {
  if (userIds.length === 0) return []
  const allowed = await mayOpen(userIds)
  return userIds.filter((userId) => allowed.has(userId))
}

/**
 * A wake on a mark ended: its turn's outcome (`lib/turns/outcome.ts`), or the
 * wake job giving up or being refused before a turn answered
 * (`./wake-job.ts`). `actorUserId` is the person whose act woke Piloti: who
 * mentioned it, answered it, or delegated the mark. Called once per wake, with
 * its final word. `reason` is the wake's stored reason for a failure;
 * `markText` what the mark says, quoted so the person knows which one it was.
 */
export async function onWakeEnded(
  input: MarkRef & {
    actorUserId: string
    trigger: 'thread_mention' | 'thread_reply' | 'assigned'
    outcome: 'answered' | 'stopped' | 'failed'
    reason?: string | null
    markText?: string | null
  }
): Promise<void> {
  // A person stopped it, or took the mark back: they know.
  if (input.outcome === 'stopped') return
  // A mention or an answer that got nothing back would otherwise vanish: the
  // person asked Piloti something and waits in a thread that never says it
  // failed. The copy (`pilotiWorkFailed`) is the same for all three triggers;
  // what differs is why, and that is the variant.
  const type = input.outcome === 'answered' ? 'piloti.work_done' : 'piloti.work_failed'
  // Always named: rows fold per mark and their payloads merge, so an absent
  // variant would keep an earlier row's. A failure names its cause; work done
  // names what woke it, and a delegation's end says the mark is back.
  const variant =
    input.outcome === 'failed' ? (wakeEndReasonKind('failed', input.reason ?? null) ?? 'error') : input.trigger
  await bestEffortInbox(`${type} for mark ${input.annotationId}`, input.organizationId, () =>
    emitAboutMark(type, input, [input.actorUserId], { excerpt: excerptOf(input.markText), variant })
  )
}

/**
 * Whether Piloti's write waits on a person: its own Rückfrage, still live. An
 * answer to a person's question, or a reply on an ordinary mark, is work that
 * is shown in the thread and tells nobody to do anything.
 */
function waitsOnPerson(mark: Pick<AnnotationRecord, 'kind' | 'authorKind' | 'status'>): boolean {
  return mark.kind === 'question' && mark.authorKind === 'piloti' && isLive(mark)
}

/**
 * Piloti wrote on a mark in a turn (`lib/annotations/agent.ts`): set a mark
 * (`question` when it is a question), or replied in its thread. `onBehalfOf`
 * is the person the turn acted for; `assigneeUserId` the mark's responsible
 * person, if any.
 */
export async function onPilotiWrote(
  input: MarkRef & {
    onBehalfOf: string
    assigneeUserId: string | null
    what: 'mark' | 'question' | 'reply'
    replyId: string | null
  }
): Promise<void> {
  if (input.what === 'mark') return
  await bestEffortInbox(`piloti.asks_you for mark ${input.annotationId}`, input.organizationId, async () => {
    const mark = await findDocumentAnnotation(input.organizationId, input.documentId, input.annotationId)
    // Gone since: nobody can answer it.
    if (!mark) return
    if (!waitsOnPerson(mark)) return
    const written =
      input.what === 'reply' ? mark.replies.find((reply) => reply.id === input.replyId)?.body : mark.body
    await emitAboutMark('piloti.asks_you', input, [input.assigneeUserId ?? input.onBehalfOf], {
      excerpt: excerptOf(written),
    })
  })
}

/**
 * A person answered in a mark's thread, or the mark was resolved or dismissed
 * (`lib/annotations/service.ts`), by a person or by Piloti in their name:
 * whatever Piloti asked there is no longer waiting on anybody, since one
 * answer answers it for everyone, and a closed mark is nobody's to do. A
 * person who was mentioned has answered by answering (`answeredBy`): only
 * their own mention is settled, since a colleague asked in the same breath
 * has not.
 */
export async function onMarkSettledByPerson(
  input: Pick<MarkRef, 'organizationId' | 'annotationId'> & { closed: boolean; answeredBy?: string | null }
): Promise<void> {
  await bestEffortInbox(`settling mark ${input.annotationId}`, input.organizationId, async () => {
    await resolveInboxItemsAnchoredOn({
      organizationId: input.organizationId,
      types: input.closed
        ? ['piloti.asks_you', 'annotation.assigned_to_you', 'annotation.mentioned']
        : ['piloti.asks_you'],
      anchorId: input.annotationId,
    })
    if (input.closed || !input.answeredBy) return
    await resolveInboxItemsAnchoredOn({
      organizationId: input.organizationId,
      types: ['annotation.mentioned'],
      anchorId: input.annotationId,
      recipientUserId: input.answeredBy,
    })
  })
}

/** The mark was deleted: no row keeps a link to it, or a quote from it. */
export async function onMarkDeleted(input: Pick<MarkRef, 'organizationId' | 'annotationId'>): Promise<void> {
  await bestEffortInbox(`clearing deleted mark ${input.annotationId}`, input.organizationId, () =>
    markInboxItemsInertAnchoredOn({
      organizationId: input.organizationId,
      types: MARK_ANCHORED_INBOX_TYPES,
      anchorId: input.annotationId,
    })
  )
}

/**
 * Who did something to a mark: a person, or Piloti for the person its turn
 * acted for (`byPiloti`; `actorUserId` is then that person). `markText` is
 * what the mark says, quoted so the reader knows which one it was.
 */
export interface MarkAct extends MarkRef {
  actorUserId: string
  byPiloti: boolean
  markText: string | null
}

/**
 * The mark's Zuständige changed, or a person took over Piloti's proposal that
 * already names one (`previousAssigneeUserId` is then null). The new one is
 * asked to act, unless they made themselves responsible or the mark is not
 * open (a proposal is nobody's yet, a closed mark nobody's to do); the
 * previous one is no longer asked.
 */
export async function onAssigneeChanged(
  input: MarkAct & {
    previousAssigneeUserId: string | null
    assigneeUserId: string | null
    open: boolean
    /** The mark's date, so the row says by when; null when it has none. */
    dueOn: string | null
  }
): Promise<void> {
  const { previousAssigneeUserId: previous, assigneeUserId: assignee } = input
  await bestEffortInbox(`annotation.assigned_to_you for mark ${input.annotationId}`, input.organizationId, async () => {
    if (previous && previous !== assignee) {
      await resolveInboxItemsAnchoredOn({
        organizationId: input.organizationId,
        types: ['annotation.assigned_to_you'],
        anchorId: input.annotationId,
        recipientUserId: previous,
      })
    }
    if (!assignee || assignee === input.actorUserId || !input.open) return
    await emitAboutMark('annotation.assigned_to_you', input, [assignee], {
      excerpt: excerptOf(input.markText),
      variant: input.byPiloti ? 'piloti' : 'person',
      actorUserId: input.actorUserId,
      // Handed anew, the Frist is reminded of anew: the payload merges, so the last reminder's stamp is cleared.
      facts: { dueOn: input.dueOn, reminder: null },
    })
  })
}

/**
 * The date of a mark that has a Zuständige was set, moved or cleared, and the
 * Zuständige stayed: they are told, in the row they have for the mark (the
 * shape of {@link onAssigneeChanged}, one row per mark), unless they changed it
 * themselves or the mark is not open. A change that also hands the mark to
 * someone new is that one's assignment, which carries the date.
 */
export async function onDueChanged(
  input: MarkAct & { assigneeUserId: string | null; dueOn: string | null; open: boolean }
): Promise<void> {
  const assignee = input.assigneeUserId
  if (!assignee || assignee === input.actorUserId || !input.open) return
  const variant = `${input.dueOn ? 'due' : 'due_cleared'}${input.byPiloti ? '_piloti' : ''}`
  await bestEffortInbox(`annotation.assigned_to_you (date) for mark ${input.annotationId}`, input.organizationId, () =>
    emitAboutMark('annotation.assigned_to_you', input, [assignee], {
      excerpt: excerptOf(input.markText),
      variant,
      actorUserId: input.actorUserId,
      // A date moved is reminded of anew, even back to one reminded of before: the stamp is cleared.
      facts: { dueOn: input.dueOn, reminder: null },
    })
  )
}

/** What the daily reminder says about a date: it is near (today or tomorrow), or it has passed. */
export type DueReminder = 'due_soon' | 'overdue'

/**
 * The daily reminder of a Zuständige's date (`./due-reminders.ts`): the
 * Zuständige is asked again in the row they have for the mark, worded by how
 * the date stands, the overdue reminder upgrading the earlier one. `reminder`
 * records which reminder for which date the row last carried, so the job tells
 * each once (`remindedFor`), and a moved date is reminded of anew. No actor:
 * the calendar did it. Unlike the rest of this module it throws: the job counts
 * what it could not tell, and the next day's run tells it.
 */
export async function onMarkDue(
  input: MarkRef & { assigneeUserId: string; dueOn: string; reminder: DueReminder; markText: string | null }
): Promise<void> {
  await emitAboutMark('annotation.assigned_to_you', input, [input.assigneeUserId], {
    excerpt: excerptOf(input.markText),
    variant: input.reminder,
    facts: { dueOn: input.dueOn, reminder: remindedFor(input.reminder, input.dueOn) },
  })
}

/** The stamp a row carries once it reminded of `dueOn` this way: the job's idempotency key, per mark and recipient. */
export const remindedFor = (reminder: DueReminder, dueOn: string): string => `${reminder}:${dueOn}`

/**
 * Someone answered in a mark's thread: its participants hear it, as one
 * counted row per mark, except whoever acted (for Piloti, the person its turn
 * acted for: on a wake, who woke it, and they hear `piloti.work_done`), when
 * Piloti follows up its own open Rückfrage, the Zuständige it asks
 * (`piloti.asks_you`), and whom the reply mentions (`mentioned`: they hear
 * `annotation.mentioned`, one row for one reply). `mark` is the mark as it
 * was read for the reply.
 */
export async function onMarkReplied(
  input: MarkAct & {
    mark: MarkPeople & Pick<AnnotationRecord, 'kind' | 'status'>
    replyText: string
    mayOpen: MayOpen
    mentioned?: readonly string[]
    /** Whom the reply mentions, as the server kept them. */
    replyMentions?: readonly MarkMention[]
  }
): Promise<void> {
  await bestEffortInbox(`annotation.activity for mark ${input.annotationId}`, input.organizationId, async () => {
    const asked = input.byPiloti && waitsOnPerson(input.mark) ? input.mark.assigneeUserId : null
    const toldOtherwise = new Set([input.actorUserId, asked, ...(input.mentioned ?? [])])
    const candidates = markParticipants(input.mark).filter((userId) => !toldOtherwise.has(userId))
    await emitAboutMark('annotation.activity', input, await whoMayOpen(input.mayOpen, candidates), {
      excerpt: excerptOf(input.replyText),
      mentions: input.replyMentions,
      variant: 'reply',
      actorUserId: input.byPiloti ? null : input.actorUserId,
      author: markAuthor(input.mark),
    })
  })
}

/** Someone resolved, dismissed or reopened a mark: its author hears it, unless they did it. */
export async function onMarkMoved(
  input: MarkAct & {
    move: 'resolved' | 'dismissed' | 'reopened'
    mark: Pick<MarkPeople, 'authorKind' | 'createdBy' | 'acceptedBy'>
    mayOpen: MayOpen
  }
): Promise<void> {
  const author = markAuthor(input.mark)
  if (!author || author === input.actorUserId) return
  await bestEffortInbox(`annotation.activity for mark ${input.annotationId}`, input.organizationId, async () =>
    emitAboutMark('annotation.activity', input, await whoMayOpen(input.mayOpen, [author]), {
      excerpt: excerptOf(input.markText),
      variant: input.move,
      actorUserId: input.actorUserId,
      author,
    })
  )
}

/**
 * A person mentioned colleagues in a mark's text or in a reply: each of
 * `mentioned` (already the people the write mentions ANEW) is asked to look,
 * at the mark, unless they wrote it themselves. `text` is what mentions them,
 * quoted so the row says what they are asked about. Every one of them is asked
 * again whether they may open the document now, as every item about a mark is.
 */
export async function onMarkMentioned(
  input: MarkAct & {
    mentioned: readonly string[]
    text: string
    /** Whom `text` mentions, as the server kept them: the row draws them as chips. */
    mentions: readonly MarkMention[]
    mayOpen: MayOpen
  }
): Promise<void> {
  const recipients = input.mentioned.filter((userId) => userId !== input.actorUserId)
  if (recipients.length === 0) return
  await bestEffortInbox(`annotation.mentioned for mark ${input.annotationId}`, input.organizationId, async () =>
    emitAboutMark('annotation.mentioned', input, await whoMayOpen(input.mayOpen, recipients), {
      excerpt: excerptOf(input.text),
      mentions: input.mentions,
      actorUserId: input.actorUserId,
    })
  )
}

/**
 * These people's mention on the mark is gone: the text that named them was
 * changed or its reply deleted, and nothing left on the mark names them. Their
 * `annotation.mentioned` turns inert, its quote wiped, as a deleted mark's
 * rows do; nobody else's row is touched.
 */
export async function onMentionsWithdrawn(
  input: Pick<MarkRef, 'organizationId' | 'annotationId'> & { userIds: readonly string[] }
): Promise<void> {
  await bestEffortInbox(`withdrawing mentions on mark ${input.annotationId}`, input.organizationId, async () => {
    for (const recipientUserId of input.userIds) {
      await markInboxItemsInertAnchoredOn({
        organizationId: input.organizationId,
        types: ['annotation.mentioned'],
        anchorId: input.annotationId,
        recipientUserId,
      })
    }
  })
}
