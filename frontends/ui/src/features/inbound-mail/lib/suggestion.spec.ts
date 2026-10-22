/**
 * Piloti's stored suggestion, parsed and never trusted: a wrong-typed key is
 * no suggestion for that field, a Dokumentart outside the vocabulary is
 * dropped, and the reason a part shows none is said honestly.
 */

import { describe, expect, it } from 'vitest'
import type { InboundMailView } from '@/lib/inbound-mail/inbound-mail-wire'
import { folderLeaf, missingSuggestionReason, readSuggestion, SUGGESTION_GRACE_MS } from './suggestion'

describe('readSuggestion', () => {
  it('reads the filing judgement’s words', () => {
    expect(readSuggestion({ folder: 'Behörde/Bescheide', reason: 'Absender MA 37', documentType: 'Bescheid', new: true })).toEqual({
      folder: 'Behörde/Bescheide',
      folderId: null,
      isNew: true,
      documentType: 'Bescheid',
      name: null,
      reason: 'Absender MA 37',
    })
  })

  it('keeps the root (`""`) as a folder and a uuid as its id', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
    expect(readSuggestion({ folder: '', folderId: id })).toMatchObject({ folder: '', folderId: id })
    expect(readSuggestion({ folder: 'A', folderId: 'not-a-uuid' })?.folderId).toBeNull()
  })

  it('drops what it cannot trust', () => {
    expect(readSuggestion({ folder: 42, documentType: 'Liebesbrief', name: 'x'.repeat(300) })).toBeNull()
    expect(readSuggestion({ folder: 'A', documentType: 'Liebesbrief' })?.documentType).toBeNull()
    expect(readSuggestion(null)).toBeNull()
    expect(readSuggestion({})).toBeNull()
  })

  it('accepts the stored English token of Korrespondenz', () => {
    expect(readSuggestion({ type: 'correspondence' })?.documentType).toBe('correspondence')
  })
})

describe('folderLeaf', () => {
  it('names the last segment', () => {
    expect(folderLeaf('Behörde/Bescheide')).toBe('Bescheide')
    expect(folderLeaf('Tragwerk')).toBe('Tragwerk')
  })
})

describe('missingSuggestionReason', () => {
  const now = Date.parse('2026-10-22T10:00:00Z')
  const at = (ms: number) => new Date(now - ms).toISOString()
  type Sender = NonNullable<InboundMailView['sender']>
  const sender = (overrides: Partial<Sender> = {}): Sender => ({
    name: 'Mag. Huber',
    address: 'k.huber@ma37.wien.gv.at',
    domain: 'ma37.wien.gv.at',
    signerDomain: 'wien.gv.at',
    trust: 'external_verified',
    reason: 'dkim_pass',
    flags: [],
    ...overrides,
  })

  it('says Piloti never suggests for unconfirmed senders, impersonations and machines (D21), by the suggest job’s own rule', () => {
    expect(missingSuggestionReason({ automatic: false, sender: sender({ trust: 'external_unverified', reason: 'dkim_none' }), receivedAt: at(0) }, now)).toBe('skipped')
    expect(missingSuggestionReason({ automatic: true, sender: sender(), receivedAt: at(0) }, now)).toBe('skipped')
    expect(missingSuggestionReason({ automatic: false, sender: sender({ trust: 'member_unverified', reason: 'dkim_fail' }), receivedAt: at(0) }, now)).toBe('skipped')
    expect(missingSuggestionReason({ automatic: false, sender: sender({ flags: ['claims_member_name'] }), receivedAt: at(0) }, now)).toBe('skipped')
  })

  it('says „still reading“ for a fresh mail, and „none“ after', () => {
    expect(missingSuggestionReason({ automatic: false, sender: sender(), receivedAt: at(60_000) }, now)).toBe('pending')
    expect(missingSuggestionReason({ automatic: false, sender: sender(), receivedAt: at(SUGGESTION_GRACE_MS + 1) }, now)).toBe('none')
  })
})

describe('readSuggestion › the suggest job’s shape (D14)', () => {
  it('reads folderPath, newFolder and a null documentType', () => {
    expect(readSuggestion({ folderId: null, folderPath: 'Fotos', newFolder: true, documentType: null, reason: 'Foto vom Bauplatz.' })).toEqual({
      folder: 'Fotos',
      folderId: null,
      isNew: true,
      documentType: null,
      name: null,
      reason: 'Foto vom Bauplatz.',
    })
  })
})
