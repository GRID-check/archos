/**
 * The waiting mails one press files into a thread, and the Fassung each
 * becomes (DECISION §9 „wird Fassung 4–7“): the order the filing job appends
 * them in is the order they were written.
 */

import { describe, expect, it } from 'vitest'
import { mail, summaryOf, thread } from '@/app/dev/inbound-mail/fixtures'
import type { InboundMailSummaryView } from './inbound-mail-wire'
import { byFilingOrder, threadGroupsOf } from './thread-groups'

const entry = (key: string, sentAt: string | null, receivedAt: string, overrides: Partial<InboundMailSummaryView> = {}) => {
  const view = mail({ key, sentAt, receivedAt, threadCandidates: [thread({ nextVersion: 4 })] })
  return { summary: summaryOf(view, overrides), order: { id: view.id, sentAt, receivedAt } }
}

describe('byFilingOrder', () => {
  it('files by the time it was sent, then received, then id', () => {
    const a = { id: 'b', sentAt: '2026-10-13T09:00:00Z', receivedAt: '2026-10-14T10:00:00Z' }
    const b = { id: 'a', sentAt: '2026-10-14T09:00:00Z', receivedAt: '2026-10-14T09:01:00Z' }
    expect([b, a].sort(byFilingOrder).map((mail) => mail.id)).toEqual(['b', 'a'])
    const sameSent = { ...b, id: 'c', receivedAt: '2026-10-14T09:00:30Z' }
    expect([b, sameSent].sort(byFilingOrder).map((mail) => mail.id)).toEqual(['c', 'a'])
    expect([{ ...b, id: 'z' }, b].sort(byFilingOrder).map((mail) => mail.id)).toEqual(['a', 'z'])
  })

  it('takes the receipt for a mail without a send time', () => {
    const undated = { id: 'u', sentAt: null, receivedAt: '2026-10-12T09:00:00Z' }
    const dated = { id: 'd', sentAt: '2026-10-13T09:00:00Z', receivedAt: '2026-10-13T09:01:00Z' }
    expect([dated, undated].sort(byFilingOrder).map((mail) => mail.id)).toEqual(['u', 'd'])
  })
})

describe('threadGroupsOf', () => {
  it('numbers the Fassungen in filing order, not in the list’s newest-first order', () => {
    const groups = threadGroupsOf([
      entry('newest', '2026-10-15T09:00:00Z', '2026-10-15T09:01:00Z'),
      entry('middle', '2026-10-14T09:00:00Z', '2026-10-14T09:01:00Z'),
      entry('oldest', '2026-10-13T09:00:00Z', '2026-10-13T09:01:00Z'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ name: 'Stellplatznachweis', firstVersion: 4, lastVersion: 6 })
    expect(groups[0]?.mails.map((member) => member.version)).toEqual([4, 5, 6])
    expect(groups[0]?.mails[0]?.mailId).toBe(mail({ key: 'oldest' }).id)
  })

  it('leaves out automatic mail, mail not pre-selected into the thread, mail that no longer waits, and a single mail', () => {
    const one = entry('one', '2026-10-13T09:00:00Z', '2026-10-13T09:01:00Z')
    const robot = entry('robot', '2026-10-14T09:00:00Z', '2026-10-14T09:01:00Z', { automatic: true })
    const unchecked = entry('unchecked', '2026-10-14T09:00:00Z', '2026-10-14T09:01:00Z')
    unchecked.summary = { ...unchecked.summary, thread: unchecked.summary.thread && { ...unchecked.summary.thread, preselected: false } }
    const handled = entry('handled', '2026-10-14T09:00:00Z', '2026-10-14T09:01:00Z', { status: 'handled' })
    expect(threadGroupsOf([one, robot, unchecked, handled])).toEqual([])
  })
})
