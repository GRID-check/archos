/**
 * How the waiting list is arranged: the server's thread groups placed where
 * their first mail stands, unconfirmed and automatic mail in a quiet group at
 * the end (never an impersonation), and the keyboard's order skipping the
 * quiet group while it is closed.
 */

import { describe, expect, it } from 'vitest'
import { listPage, mail, summaryOf, thread } from '@/app/dev/inbound-mail/fixtures'
import { isQuietMail, listSections, visibleMails } from './list-sections'

const a = summaryOf(mail({ key: 'a' }))
const b = summaryOf(mail({ key: 'b', threadCandidates: [thread({ nextVersion: 4 })] }))
const unrelated = summaryOf(mail({ key: 'c', threadCandidates: [] }))
const unconfirmed = summaryOf(mail({ key: 'd', threadCandidates: [thread({ preselected: false, blocks: ['sender_not_verified'] })] }))
const stranger = summaryOf(
  mail({
    key: 'e',
    sender: { name: null, address: 'x@clean-shine.example', domain: 'clean-shine.example', signerDomain: null, trust: 'external_unverified', reason: 'dkim_none', flags: [] },
    threadCandidates: [thread({ preselected: false, blocks: ['sender_not_verified'] })],
  })
)
const robot = summaryOf(mail({ key: 'f' }), { automatic: true })
const forged = summaryOf(mail({ key: 'g' }), { senderTrust: 'external_unverified', riskLevel: 'impersonation', impersonation: 'member_name' })

const sectionsOf = (items: typeof a[]) => listSections(items, { grouped: true, groups: listPage(items).threadGroups })

describe('listSections', () => {
  it('places the server’s group where the first of its mails stands, with its range of Fassungen', () => {
    const sections = sectionsOf([unrelated, a, unconfirmed, b, stranger, robot])
    expect(sections.map((section) => section.kind)).toEqual(['mail', 'thread', 'mail', 'quiet'])
    const group = sections[1]
    expect(group.kind === 'thread' && [group.firstVersion, group.lastVersion]).toEqual([4, 5])
    expect(group.kind === 'thread' && group.mails.map((member) => member.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('never groups without the server’s group, nor a group with one mail on the page', () => {
    expect(listSections([a, b], { grouped: true }).map((section) => section.kind)).toEqual(['mail', 'mail'])
    const groups = listPage([a, b]).threadGroups
    expect(listSections([a], { grouped: true, groups }).map((section) => section.kind)).toEqual(['mail'])
  })

  it('keeps the server’s order ungrouped for the handled list', () => {
    expect(listSections([a, b, stranger], { grouped: false }).map((section) => section.kind)).toEqual(['mail', 'mail', 'mail'])
  })
})

describe('visibleMails', () => {
  it('walks the quiet group only while it is open', () => {
    const sections = sectionsOf([a, stranger, robot])
    expect(visibleMails(sections, false).map((mail) => mail.id)).toEqual([a.id])
    expect(visibleMails(sections, true).map((mail) => mail.id)).toEqual([a.id, stranger.id, robot.id])
  })
})

describe('isQuietMail', () => {
  it('is quiet for an unconfirmed stranger and for a machine', () => {
    expect(isQuietMail(stranger)).toBe(true)
    expect(isQuietMail(robot)).toBe(true)
    expect(isQuietMail(a)).toBe(false)
  })

  it('never hides an impersonation in the collapsed group', () => {
    expect(isQuietMail(forged)).toBe(false)
  })
})
