/**
 * The Postfach as a queue: what waits on the reader, most urgent first and
 * gathered by the thing it is about, then the news.
 *
 * The inbox stores one row per event, which is right for delivery and wrong
 * for reading: five rows about „Grundriss EG“ asked the reader to assemble the
 * document's state in their head. Here the rows that wait on the reader (an
 * open request) are ordered by how late they are and gathered under their
 * document or chat, and everything else that is new is news.
 *
 * Pure, so the order is testable without a list or a clock beyond `today`.
 */

import type { InboxItemView } from '@/lib/inbox/types'

/** A request still waiting on the reader: actionable, not answered, not redacted, not put away. */
export function isOpenRequest(item: InboxItemView): boolean {
  return item.actionable && item.state !== 'resolved' && item.state !== 'inert' && !item.archived
}

/**
 * How urgent a waiting row is, smaller first: a passed date, a near one, any
 * other date, then no date. The daily reminder words a mark's date as
 * `overdue` or `due_soon`; a date it has not reminded of yet is compared to
 * `today` (`YYYY-MM-DD`, the reader's calendar day), so a date that passed
 * since the last reminder still counts as late.
 */
export function urgencyOf(item: InboxItemView, today: string): number {
  if (item.variant === 'overdue') return 0
  if (item.dueOn && item.dueOn < today) return 0
  if (item.variant === 'due_soon') return 1
  if (item.dueOn) return 2
  return 3
}

function byUrgency(today: string) {
  return (a: InboxItemView, b: InboxItemView): number =>
    urgencyOf(a, today) - urgencyOf(b, today) ||
    // Two dated rows: the earlier date first. ISO days compare as strings.
    (a.dueOn && b.dueOn ? a.dueOn.localeCompare(b.dueOn) : 0) ||
    // Otherwise the newest change first, as the server orders a page.
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
}

/** One thing the reader is asked about, and every waiting row about it. */
export interface InboxQueueGroup {
  /** `document:<id>`, `conversation:<id>`, or `item:<id>` for a row that stands alone. */
  key: string
  /** The document's or the chat's name; null for a row that stands alone. */
  subject: string | null
  /** The project it belongs to, when the server named one. */
  projectName: string | null
  /** Whether it is a chat (the header says so where a document's name would do). */
  chat: boolean
  items: InboxItemView[]
}

/**
 * A row gathers with others about the same document or chat when it names
 * that thing; anything else (an organization's notice, a proposal about many
 * files) stands alone.
 */
function groupKeyOf(item: InboxItemView): string {
  const gathers = (item.resourceType === 'document' || item.resourceType === 'conversation') && item.subject !== null
  return gathers ? `${item.resourceType}:${item.resourceId}` : `item:${item.id}`
}

/**
 * The waiting rows, most urgent first, gathered by what they are about. A
 * group stands where its most urgent row would, and keeps its rows in that
 * order, so the first row on screen is always the most urgent one.
 */
export function waitingGroups(items: readonly InboxItemView[], today: string): InboxQueueGroup[] {
  const groups = new Map<string, InboxQueueGroup>()
  for (const item of items.filter(isOpenRequest).sort(byUrgency(today))) {
    const key = groupKeyOf(item)
    const group = groups.get(key)
    if (group) {
      group.items.push(item)
      continue
    }
    groups.set(key, {
      key,
      subject: key.startsWith('item:') ? null : item.subject,
      projectName: item.projectName ?? null,
      chat: item.resourceType === 'conversation',
      items: [item],
    })
  }
  return [...groups.values()]
}

/**
 * What is new and asks nothing: not opened yet, still there, and no open
 * request. Newest first, as the server sent it. `read`, never `state`: a
 * request answered before the reader opened it says `resolved` and is still
 * unread, and the badge counts it.
 */
export function newsOf(items: readonly InboxItemView[]): InboxItemView[] {
  return items.filter((item) => !item.read && item.state !== 'inert' && !item.archived && !isOpenRequest(item))
}

/** The rows in the order they are drawn: the queue's, then the news. What j/k walks. */
export function queueOrder(groups: readonly InboxQueueGroup[], news: readonly InboxItemView[]): InboxItemView[] {
  return [...groups.flatMap((group) => group.items), ...news]
}

/**
 * Whether the reader is at an entry's place: the same path, and every
 * parameter the entry's link names present in the address with the same value
 * (the chat's `session`, the review's `doc` and `mark`). The address may say
 * more (the review's tool, a page); `back` and the hash say where to return
 * and where to scroll, not where the reader is.
 */
export function isAtHref(href: string, pathname: string, params: Pick<URLSearchParams, 'get'> | null): boolean {
  const target = new URL(href, 'https://inbox.invalid')
  if (target.pathname !== pathname) return false
  for (const [key, value] of target.searchParams) {
    if (key === 'back') continue
    if (params?.get(key) !== value) return false
  }
  return true
}
