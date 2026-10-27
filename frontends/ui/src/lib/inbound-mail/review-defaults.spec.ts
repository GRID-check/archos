/**
 * What a held mail offers checked, and whether it is complete (DECISION §9,
 * the case table, RT-X10): the server's rules, which the E-Mail-Eingang
 * derived in the browser before they were on the wire. The tables below are
 * the ones its specs pinned there, now against these functions.
 */

import { describe, expect, it } from 'vitest'
import { DETAIL_VARIANTS, mail, messagePart, part, thread } from '@/app/dev/inbound-mail/fixtures'
import type { InboundMailSenderView } from './inbound-mail-wire'
import { incompleteReason, partPreselected, withReviewDefaults } from './review-defaults'
import type { SenderFacts } from './sender-risk'

const confirmed: SenderFacts = { trust: 'external_verified', reason: 'dkim_pass', flags: [] }
const open = { projectClosed: false, rawScan: 'clean' as const, sender: confirmed }

/** Miriam Huber's address, its signature failed: „Dringend: Kontoänderung Honorarnote“. */
const forgedMember: InboundMailSenderView = {
  name: 'Miriam Huber',
  address: 'm.huber@huber-architektur.at',
  domain: 'huber-architektur.at',
  signerDomain: null,
  trust: 'member_unverified',
  reason: 'dkim_fail',
  flags: [],
}

/** Her name on an outsider's address whose own domain signed. */
const memberName: InboundMailSenderView = {
  name: 'Miriam Huber',
  address: 'miriam.huber@mail.example',
  domain: 'mail.example',
  signerDomain: 'mail.example',
  trust: 'external_verified',
  reason: 'dkim_pass',
  flags: ['claims_member_name'],
}

describe('partPreselected: an attachment', () => {
  it('offers a clean, accepted, unflagged attachment checked', () => {
    expect(partPreselected(part({ name: 'a.pdf' }), open)).toBe(true)
  })

  it.each<[string, Parameters<typeof part>[0]]>([
    ['scan pending', { scan: 'pending' }],
    ['scan failed', { scan: 'failed' }],
    ['infected', { scan: 'infected' }],
    ['type not accepted', { offered: false, riskFlags: ['type_not_accepted'] }],
    ['identical bytes in the project', { duplicateOf: { documentId: 'd', name: 'a.pdf', folderPath: 'A' } }],
    ['name stop', { riskFlags: ['name_stop'], nameStopTerms: ['Honorar'] }],
    ['macro', { riskFlags: ['macro'] }],
    ['type mismatch', { riskFlags: ['type_mismatch'] }],
    ['a picture pasted into the mail', { filename: null, contentType: 'image/png' }],
    ['filed', { state: 'filed' }],
    ['dismissed', { state: 'dismissed' }],
  ])('offers it unchecked: %s', (_, overrides) => {
    expect(partPreselected(part(overrides), open)).toBe(false)
  })

  it('offers a Fassung checked from a confirmed sender, unchecked from one that cannot vouch (D11)', () => {
    const revisionCandidate = { documentId: 'd', name: 'S-101_B.pdf', folderPath: 'Tragwerk', nextVersion: 3 }
    expect(partPreselected(part({ revisionCandidate }), open)).toBe(true)
    expect(partPreselected(part({ revisionCandidate }), { projectClosed: false, rawScan: 'clean' as const, sender: { trust: 'external_unverified', reason: 'dkim_none', flags: [] } })).toBe(false)
    expect(partPreselected(part({ revisionCandidate, riskFlags: ['unverified_thread'] }), open)).toBe(false)
  })

  it('offers nothing in a closed project', () => {
    expect(partPreselected(part(), { projectClosed: true, rawScan: 'clean' as const, sender: confirmed })).toBe(false)
    expect(partPreselected(messagePart(), { projectClosed: true, rawScan: 'clean' as const, sender: confirmed })).toBe(false)
  })
})

describe('partPreselected: the text', () => {
  it('offers a readable, waiting text checked, even from an unsigned stranger (it starts a thread of its own)', () => {
    expect(partPreselected(messagePart(), open)).toBe(true)
    expect(partPreselected(messagePart(), { projectClosed: false, rawScan: 'clean' as const, sender: { trust: 'external_unverified', reason: 'dkim_none', flags: [] } })).toBe(true)
  })

  it('offers no text whose raw message did not scan clean: it cannot be filed (review D, finding 7)', () => {
    expect(partPreselected(messagePart(), { ...open, rawScan: 'infected' })).toBe(false)
    expect(partPreselected(messagePart(), { ...open, rawScan: 'failed' })).toBe(false)
  })

  it('offers a text already in a thread, or one that could not be read, unchecked', () => {
    expect(partPreselected(messagePart(), { projectClosed: false, rawScan: 'clean' as const, sender: { ...confirmed, flags: ['message_id_reused', 'already_filed'] } })).toBe(false)
    expect(partPreselected(messagePart({ riskFlags: ['unreadable'] }), open)).toBe(false)
  })
})

describe('an impersonation: nothing is pre-selected', () => {
  it.each([
    ['a member’s address whose signature failed', forgedMember],
    ['a member’s name on an outsider’s signed address', memberName],
  ])('%s: neither the text nor a clean attachment is offered checked', (_, sender) => {
    const view = mail({ sender, threadCandidates: [], parts: [messagePart(), part({ name: 'Honorarnote_neu.pdf' })] })
    expect(view.parts.map((candidate) => candidate.preselected)).toEqual([false, false])
    expect(view.riskLevel).toBe('impersonation')
    expect(view.needsSenderAcknowledgement).toBe(true)
    expect(view.incompleteReason).toBe('sender')
  })

  it('says why on the view, for the warning', () => {
    expect(mail({ sender: forgedMember }).impersonation).toBe('rejected_signature')
    expect(mail({ sender: memberName }).impersonation).toBe('member_name')
    expect(mail().impersonation).toBeNull()
  })
})

describe('incompleteReason (RT-X10)', () => {
  const reason = (name: string) => incompleteReason(DETAIL_VARIANTS[name].view)

  it('is complete for a confirmed sender, a pre-selected thread and suggested folders', () => {
    expect(reason('member-verified')).toBeNull()
    expect(reason('thread-append')).toBeNull()
    expect(reason('revision')).toBeNull()
  })

  it.each([
    ['impersonation', 'sender'],
    ['not-addressed', 'sender'],
    ['new-thread', 'no_thread'],
    ['name-stop', 'needs_person'],
    ['macro', 'needs_person'],
    ['scan-pending', 'scanning'],
    ['no-suggestion', 'folder_missing'],
    ['closed', 'project_closed'],
    ['dismissed', 'not_waiting'],
  ])('%s → %s', (name, expected) => {
    expect(reason(name)).toBe(expected)
  })

  it('counts a member’s own Bcc copy with nothing attached as complete', () => {
    expect(reason('bcc-own')).toBeNull()
  })

  it('lets a duplicate stay behind: it is already in the project', () => {
    const view = mail({ parts: [messagePart({ id: '22222222-2222-4222-8222-222222222222' }), part({ duplicateOf: { documentId: 'd', name: 'a', folderPath: null } })] })
    expect(incompleteReason(view)).toBeNull()
  })

  it('asks for a look at a thread that is full, as at one that is not pre-selected', () => {
    expect(incompleteReason(mail({ threadCandidates: [thread({ full: true })] }))).toBe('no_thread')
    expect(incompleteReason(mail({ threadCandidates: [thread({ preselected: false, blocks: ['weak_match'] })] }))).toBe('no_thread')
  })
})

describe('withReviewDefaults', () => {
  it('derives every field from the view it is given, so the route and a preview cannot disagree', () => {
    const view = DETAIL_VARIANTS['member-verified'].view
    expect(withReviewDefaults(view)).toEqual(view)
  })
})
