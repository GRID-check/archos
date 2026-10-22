/**
 * The tab's rules, each once: whose follow is the viewer's and whether it can
 * still grow; who may end someone else's; which entry a link or a citation
 * means; what a detach keeps; which Fassungen „Vergleichen“ lays side by side;
 * what came with a mail; how far a filed sender was confirmed.
 */

import { describe, expect, it } from 'vitest'
import { FIXTURE_NOW, VIEWER_ID, attachment, entry, follow, thread, versions } from '@/app/dev/mail-thread/fixtures'
import {
  attachmentLines,
  comparedVersions,
  currentVersionNumber,
  detachKeeps,
  entriesNewestFirst,
  filedSenderTrust,
  focusedEntryId,
  followRenewable,
  mayEndFollow,
  mayWrite,
  otherFollows,
  viewerFollow,
} from './mail-thread-model'

const DAY = 86_400_000
const iso = (offsetDays: number) => new Date(FIXTURE_NOW + offsetDays * DAY).toISOString()

describe('the viewer’s follow', () => {
  it('is found by user id, with its renewal', () => {
    const own = follow({ userId: VIEWER_ID })
    expect(viewerFollow(thread({ followed: true, follows: [follow({ userId: 'other' }), own] }), VIEWER_ID)).toEqual({ kind: 'following', follow: own, renewable: true })
  })

  it('is followed without a date where the surface does not know the viewer', () => {
    expect(viewerFollow(thread({ followed: true, follows: [follow({ userId: VIEWER_ID })] }), null)).toEqual({ kind: 'following', follow: null, renewable: false })
  })

  it('is none when the server says the viewer does not follow', () => {
    expect(viewerFollow(thread({ followed: false, follows: [follow({ userId: 'other' })] }), VIEWER_ID)).toEqual({ kind: 'none' })
  })

  it('can grow only while 180 days from its start leave at least a day', () => {
    expect(followRenewable(follow({ userId: 'u', createdAt: iso(-10), expiresAt: iso(50) }))).toBe(true)
    expect(followRenewable(follow({ userId: 'u', createdAt: iso(-100), expiresAt: iso(79) }))).toBe(true)
    expect(followRenewable(follow({ userId: 'u', createdAt: iso(-100), expiresAt: iso(79.5) }))).toBe(false)
    expect(followRenewable(follow({ userId: 'u', createdAt: iso(-100), expiresAt: iso(80) }))).toBe(false)
  })
})

describe('ending someone else’s follow', () => {
  const others = follow({ userId: 'user_other' })
  it('is a manager’s only', () => {
    expect(mayEndFollow({ managesFollows: false }, others, VIEWER_ID)).toBe(false)
    expect(mayEndFollow({ managesFollows: true }, others, VIEWER_ID)).toBe(true)
  })
  it('is everybody’s for their own', () => {
    expect(mayEndFollow({ managesFollows: false }, follow({ userId: VIEWER_ID }), VIEWER_ID)).toBe(true)
  })
  it('lists the others without the viewer', () => {
    expect(otherFollows(thread({ follows: [follow({ userId: VIEWER_ID }), others] }), VIEWER_ID)).toEqual([others])
  })
})

it('reads the right to follow and detach off the waiting count', () => {
  expect(mayWrite({ waitingCount: 0 })).toBe(true)
  expect(mayWrite({ waitingCount: null })).toBe(false)
})

describe('which entry a link or a citation means', () => {
  const entries = [entry({ key: 'a', version: 1, heading: '02.10.2026, 16:40 · Miriam Huber (huber-architektur.at)' }), entry({ key: 'b', version: 2 })]
  it('by id first', () => {
    expect(focusedEntryId(entries, { entryId: entries[1].id, heading: entries[0].heading })).toBe(entries[1].id)
  })
  it('by the heading a citation prints, whatever its spaces', () => {
    expect(focusedEntryId(entries, { heading: '02.10.2026, 16:40  ·  Miriam Huber (huber-architektur.at) ' })).toBe(entries[0].id)
  })
  it('none for an old link or a section that moved away', () => {
    expect(focusedEntryId(entries, { entryId: 'gone', heading: 'nothing like it' })).toBeNull()
    expect(focusedEntryId(entries, {})).toBeNull()
  })
})

it('lists the newest mail first, keeping the document’s section order', () => {
  const entries = [entry({ key: 'a', version: 1 }), entry({ key: 'b', version: 2 }), entry({ key: 'c', version: 3 })]
  expect(entriesNewestFirst(entries).map((item) => item.id)).toEqual([entries[2].id, entries[1].id, entries[0].id])
  expect(entries[0].id).toBe(entry({ key: 'a', version: 1 }).id)
})

describe('Fassungen', () => {
  it('the current one is the newest version, else the newest an entry names', () => {
    expect(currentVersionNumber(versions(5), [entry({ key: 'a', version: 3 })])).toBe(5)
    expect(currentVersionNumber(null, [entry({ key: 'a', version: 3 }), entry({ key: 'b', version: 4 })])).toBe(4)
    expect(currentVersionNumber(null, [])).toBeNull()
  })

  it('„Vergleichen“ lays the mail’s Fassung beside the one before', () => {
    expect(comparedVersions(entry({ key: 'b', version: 3 }), versions(4))).toEqual({
      from: { id: versions(4)[1].id, number: 2 },
      to: { id: versions(4)[2].id, number: 3 },
    })
  })

  it('nothing to compare for the first mail, a missing Fassung or bytes the reader may not open', () => {
    expect(comparedVersions(entry({ key: 'a', version: 1 }), versions(3))).toBeNull()
    expect(comparedVersions(entry({ key: 'b', version: 5 }), versions(3))).toBeNull()
    const held = versions(3).map((version) => (version.versionNumber === 1 ? { ...version, bytesReadable: false } : version))
    expect(comparedVersions(entry({ key: 'b', version: 2 }), held)).toBeNull()
  })

  it('a detach names the Fassungen that keep the mail and the one written without it', () => {
    expect(detachKeeps(entry({ key: 'b', version: 4 }), 6)).toEqual({ first: 4, last: 6, next: 7 })
    expect(detachKeeps(entry({ key: 'b', version: 6 }), 6)).toEqual({ first: 6, last: 6, next: 7 })
    expect(detachKeeps({ firstVersion: null }, 6)).toBeNull()
  })
})

it('lists what came with a mail by position, naming nothing the reader may not see', () => {
  const lines = attachmentLines([
    attachment({ position: 3, filename: 'secret.pdf', visible: false }),
    attachment({ position: 1, filename: 'S-101_C.pdf' }),
    attachment({ position: 2, filename: 'x.zip', disposition: 'not_filed', notFiledReason: 'archive', documentId: undefined }),
    attachment({ position: 4, filename: 'Alt.pdf', disposition: 'already_present' }),
  ])
  expect(lines.map((line) => line.kind)).toEqual(['filed', 'not_filed', 'hidden', 'already_present'])
  expect(JSON.stringify(lines[2])).not.toContain('secret')
  expect(lines[1]).toMatchObject({ reason: 'archive' })
})

it('says a filed sender in three words', () => {
  expect(filedSenderTrust('member_verified')).toBe('verified')
  expect(filedSenderTrust('external_verified')).toBe('verified')
  expect(filedSenderTrust('member_unverified')).toBe('unverified')
  expect(filedSenderTrust('external_unverified')).toBe('unverified')
  expect(filedSenderTrust('not_checked')).toBe('not_checked')
})
