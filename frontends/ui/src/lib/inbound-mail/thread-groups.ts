/**
 * Waiting mails that continue one E-Mail-Verlauf, as the list offers them in
 * one press („4 E-Mails in E-Mail-Verlauf „Stellplatznachweis“ ablegen (wird
 * Fassung 4–7)“, DECISION §9 „List row“), and the order a filing appends them
 * in, so the Fassung each would become is the one it does become.
 *
 * A mail joins a group only when it waits, its strongest thread candidate is
 * pre-selected (a stranger's References never are, RT-S1), and it is no
 * automatic mail. The group's one button carries no acknowledgement (RT-S5),
 * so each mail still needs to be complete to be filed by it.
 *
 * Pure.
 */

import type { InboundMailSummaryView, InboundMailThreadGroupView } from './inbound-mail-wire'

/** What filing order is decided by. */
export interface FilingOrderFacts {
  id: string
  sentAt: Date | string | null
  receivedAt: Date | string
}

const time = (value: Date | string | null): number => (value === null ? Number.NaN : new Date(value).getTime())

/**
 * The order the filing job files the mails of one request in (`findFilingWork`),
 * and so the order their texts become a thread's Fassungen: sent first, then
 * received first, then by id. A conversation reads in the order it was
 * written, whatever order the request named the mails in.
 */
export function byFilingOrder(a: FilingOrderFacts, b: FilingOrderFacts): number {
  const sentA = time(a.sentAt)
  const sentB = time(b.sentAt)
  const sent = (Number.isNaN(sentA) ? time(a.receivedAt) : sentA) - (Number.isNaN(sentB) ? time(b.receivedAt) : sentB)
  if (sent !== 0) return sent
  return time(a.receivedAt) - time(b.receivedAt) || a.id.localeCompare(b.id)
}

/** Whether a mail of the list may be filed with others of its thread in one press. */
function joinsThreadGroup(summary: InboundMailSummaryView): boolean {
  return summary.status === 'waiting' && !summary.automatic && summary.thread?.preselected === true
}

/**
 * The thread groups of one page of the waiting list, in the order the page
 * first names each thread: two mails or more each, in filing order, each with
 * the Fassung its text would become.
 */
export function threadGroupsOf(
  entries: ReadonlyArray<{ summary: InboundMailSummaryView; order: FilingOrderFacts }>,
): InboundMailThreadGroupView[] {
  const byThread = new Map<string, Array<{ summary: InboundMailSummaryView; order: FilingOrderFacts }>>()
  for (const entry of entries) {
    const thread = entry.summary.thread
    if (!thread || !joinsThreadGroup(entry.summary)) continue
    byThread.set(thread.threadId, [...(byThread.get(thread.threadId) ?? []), entry])
  }
  const groups: InboundMailThreadGroupView[] = []
  for (const [threadId, members] of byThread) {
    if (members.length < 2) continue
    const first = Math.min(...members.map((member) => member.summary.thread?.nextVersion ?? 1))
    const ordered = [...members].sort((a, b) => byFilingOrder(a.order, b.order))
    groups.push({
      threadId,
      name: members[0]?.summary.thread?.name ?? '',
      mails: ordered.map((member, index) => ({ mailId: member.summary.id, version: first + index })),
      firstVersion: first,
      lastVersion: first + ordered.length - 1,
    })
  }
  return groups
}
