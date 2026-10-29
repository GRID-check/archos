/**
 * What the inbox preview (`/dev/inbox`) adds to its rows: the project each is
 * about, and who its reply composer may mention.
 */

import type { InboxItemView } from '@/lib/inbox/types'

/**
 * The project each row is about, as the server names it (`projectName`): the
 * Schnitt rows in a second project, so the preview shows that the line tells
 * two projects apart. Org, platform and redacted rows carry none.
 */
export function withProjects(items: readonly InboxItemView[]): InboxItemView[] {
  return items.map((item) =>
    item.href?.includes('/projects/p1') && item.state !== 'inert'
      ? item.resourceId === 'd-schnitt'
        ? { ...item, projectId: 'p2', projectName: 'Volksschule Am Hang' }
        : { ...item, projectId: 'p1', projectName: 'Wohnanlage Linzer Straße' }
      : item,
  )
}

/** Who may open the fixtures' documents: the rows the reply composer's „@" picker offers. */
export const MENTIONABLE = [
  { userId: 'u-anna', name: 'Anna Weber', email: 'anna@buero.at', profilePictureUrl: null },
  { userId: 'u-jakob', name: 'Jakob Huber', email: 'jakob@buero.at', profilePictureUrl: null },
  { userId: 'u-markus', name: 'Markus Lehner', email: 'markus@buero.at', profilePictureUrl: null },
]

/** The reader the fixtures are addressed to: Miriam Hofer. */
export const VIEWER_ID = 'u-miriam'

type MarkView = import('@/lib/annotations/types').AnnotationView
type ReplyView = import('@/lib/annotations/types').AnnotationReplyView

/** What a fixture mark's thread holds before the reader answers: who set it, and what was said since. */
const SEEDS: Record<string, { body: string; by: [string, string]; replies: Array<{ by: [string, string] | 'piloti'; body: string; daysAgo: number }> }> = {
  'mark-11': {
    body: 'Fluchtwegbreite im Gang nachweisen.',
    by: ['u-anna', 'Anna Weber'],
    replies: [
      { by: ['u-jakob', 'Jakob Huber'], body: 'Im Plan sind 1,15 m kotiert. Reicht das hier?', daysAgo: 1 },
      { by: 'piloti', body: 'Ich habe die kotierte Breite gefunden. Soll ich sie gegen die Anforderung für den Fluchtweg prüfen?', daysAgo: 1 },
    ],
  },
}

const threads = new Map<string, MarkView>()
const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString()

/** One fixture mark with its thread, as `GET …/annotations/:id` answers it; kept, so an answer stays in it. */
export function markThread(documentId: string, markId: string, excerpt = 'Anmerkung'): MarkView {
  const kept = threads.get(markId)
  if (kept) return kept
  const seed = SEEDS[markId] ?? { body: excerpt, by: ['u-anna', 'Anna Weber'] as [string, string], replies: [] }
  const created = daysAgo(2)
  const mark: MarkView = {
    id: markId, documentId, number: Number(markId.replace(/\D/g, '')) || 1, page: 1, shape: 'point', x: 0.4, y: 0.4, w: null, h: null,
    kind: 'question', body: seed.body, mentions: [], basis: null, authorKind: 'person',
    status: 'open', assigneeUserId: VIEWER_ID, assigneeName: 'Miriam Hofer', dueOn: null, revisionNumber: 3,
    onCurrentRevision: true, createdBy: seed.by[0], createdByName: seed.by[1], createdAt: created, updatedAt: created,
    acceptedBy: null, acceptedByName: null, closedBy: null, closedByName: null, closedAt: null,
    delegatedBy: null, delegatedByName: null, delegatedAt: null, canEdit: true, canDelete: false,
    replies: seed.replies.map((reply, index): ReplyView => ({
      id: `${markId}-r${index}`, annotationId: markId, authorKind: reply.by === 'piloti' ? 'piloti' : 'person', body: reply.body,
      // Piloti answers in the name of whoever asked it.
      createdBy: reply.by === 'piloti' ? seed.by[0] : reply.by[0], createdByName: reply.by === 'piloti' ? null : reply.by[1],
      createdAt: daysAgo(reply.daysAgo), addressesPiloti: false, mentions: [], editedAt: null,
    })),
  }
  threads.set(markId, mark)
  return mark
}

/** The reader's answer, kept in the thread, as the reply route answers it. */
export function replyToMark(documentId: string, markId: string, sent: Pick<ReplyView, 'body' | 'mentions' | 'addressesPiloti'>) {
  const mark = markThread(documentId, markId)
  const replyId = `reply-${Date.now()}`
  const reply: ReplyView = {
    id: replyId, annotationId: markId, authorKind: 'person', body: sent.body, createdBy: VIEWER_ID,
    createdByName: 'Miriam Hofer', createdAt: new Date().toISOString(), addressesPiloti: sent.addressesPiloti === true,
    mentions: sent.mentions ?? [], editedAt: null,
  }
  const annotation = { ...mark, replies: [...mark.replies, reply] }
  threads.set(markId, annotation)
  return { annotation, replyId, wake: sent.addressesPiloti ? 'queued' : 'none' }
}
