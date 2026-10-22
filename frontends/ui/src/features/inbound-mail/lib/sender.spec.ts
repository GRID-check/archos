/**
 * What the E-Mail-Eingang says about a sender. What it asks before filing is
 * the server's (`lib/inbound-mail/sender-risk.spec.ts` holds the C2 table).
 */

import { describe, expect, it } from 'vitest'
import type { InboundMailSenderView } from '@/lib/inbound-mail/inbound-mail-wire'
import { followOffered, senderDisplayName, senderFlagLines, senderTone, senderTrustLine } from './sender'

const sender = (overrides: Partial<InboundMailSenderView> = {}): InboundMailSenderView => ({
  name: 'DI Petra Weber',
  address: 'p.weber@statik-weber.at',
  domain: 'statik-weber.at',
  signerDomain: 'statik-weber.at',
  trust: 'external_verified',
  reason: 'dkim_pass',
  flags: [],
  ...overrides,
})

describe('senderTrustLine', () => {
  it('names the signing domain, never the person', () => {
    expect(senderTrustLine(sender(), null)).toEqual({ kind: 'verified', domain: 'statik-weber.at' })
  })

  it('says a member’s own Bcc copy', () => {
    expect(senderTrustLine(sender({ trust: 'member_verified', flags: ['not_addressed_to_project', 'bcc_own'] }), null).kind).toBe('bcc_own')
  })

  it('says „Gibt sich als … aus“ exactly where the server reads an impersonation', () => {
    expect(senderTrustLine(sender({ trust: 'member_unverified', reason: 'dkim_fail', signerDomain: null }), 'rejected_signature')).toEqual({
      kind: 'impersonation',
      name: 'DI Petra Weber',
      basis: 'rejected_signature',
    })
    // A member's name on an outsider's address outranks the outsider's own confirmed domain.
    expect(senderTrustLine(sender({ flags: ['claims_member_name'] }), 'member_name').kind).toBe('impersonation')
    expect(senderTrustLine(sender({ trust: 'member_unverified', reason: 'dkim_none', signerDomain: null }), null).kind).toBe('member_unverified')
    expect(senderTrustLine(sender({ trust: 'external_unverified', reason: 'dkim_none', signerDomain: null }), null).kind).toBe('unverified')
  })

  it('draws only the two cases a person must not miss as warnings', () => {
    expect(senderTone({ kind: 'verified', domain: 'x' })).toBe('confirmed')
    expect(senderTone({ kind: 'unverified' })).toBe('neutral')
    expect(senderTone({ kind: 'member_unverified' })).toBe('warning')
    expect(senderTone({ kind: 'impersonation', name: 'x', basis: 'member_name' })).toBe('warning')
  })
})

describe('senderFlagLines', () => {
  it('says „addressed to others“ except for the member’s own Bcc copy', () => {
    expect(senderFlagLines(sender({ flags: ['not_addressed_to_project'] }))).toEqual(['not_addressed_to_project'])
    expect(senderFlagLines(sender({ trust: 'member_verified', flags: ['not_addressed_to_project', 'bcc_own'] }))).toEqual([])
  })

  it('says one date flag, the stale one first, and nothing for a reused Message-ID alone', () => {
    expect(senderFlagLines(sender({ flags: ['stale_date', 'date_out_of_range'] }))).toEqual(['stale_date'])
    expect(senderFlagLines(sender({ flags: ['message_id_reused'] }))).toEqual([])
    expect(senderFlagLines(sender({ flags: ['message_id_reused', 'already_filed'] }))).toEqual(['already_filed'])
  })
})

describe('followOffered (D31 conditions 2 and 4)', () => {
  it('offers the follow only where a later reply could qualify', () => {
    expect(followOffered({ sender: sender(), automatic: false })).toBe(true)
    expect(followOffered({ sender: sender({ trust: 'member_verified' }), automatic: false })).toBe(true)
    expect(followOffered({ sender: sender({ trust: 'external_unverified' }), automatic: false })).toBe(false)
    expect(followOffered({ sender: sender({ trust: 'member_verified', flags: ['not_addressed_to_project', 'bcc_own'] }), automatic: false })).toBe(false)
    expect(followOffered({ sender: sender({ flags: ['message_id_reused'] }), automatic: false })).toBe(false)
    expect(followOffered({ sender: sender(), automatic: true })).toBe(false)
    expect(followOffered({ sender: null, automatic: false })).toBe(false)
  })
})

describe('senderDisplayName', () => {
  it('falls back to the local part of the address', () => {
    expect(senderDisplayName({ name: '  ', address: 'office@clean-shine.example' })).toBe('office')
    expect(senderDisplayName({ name: 'Jo', address: 'jo@example.com' })).toBe('Jo')
  })
})
