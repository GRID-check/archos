/**
 * Each attachment's case (DECISION §9, the case table): its state, and the
 * reasons the row shows for it. Whether it is offered checked is the
 * server's `preselected` (`lib/inbound-mail/review-defaults.spec.ts` holds
 * that table); the row only follows it.
 */

import { describe, expect, it } from 'vitest'
import { mail, part } from '@/app/dev/inbound-mail/fixtures'
import { attachmentCase, notStagedSummary } from './attachment-case'

const view = mail()

describe('attachmentCase', () => {
  it('offers a clean, accepted, unflagged part checked', () => {
    const entry = attachmentCase(part({ name: 'a.pdf' }), view)
    expect(entry).toMatchObject({ status: 'waiting', selectable: true, defaultChecked: true, risk: null, previewable: true })
  })

  it.each<[string, Parameters<typeof part>[0], { status: string; selectable: boolean; defaultChecked: boolean }]>([
    // `part()` derives `preselected` with the server's rule, so the checked column still reads as the case table.
    ['scan pending', { scan: 'pending' }, { status: 'scan_pending', selectable: false, defaultChecked: false }],
    ['scan failed', { scan: 'failed' }, { status: 'scan_failed', selectable: false, defaultChecked: false }],
    ['infected', { scan: 'infected' }, { status: 'scan_infected', selectable: false, defaultChecked: false }],
    ['type not accepted', { offered: false, riskFlags: ['type_not_accepted'] }, { status: 'not_offered', selectable: false, defaultChecked: false }],
    ['identical bytes in the project', { duplicateOf: { documentId: 'd', name: 'a.pdf', folderPath: 'A' } }, { status: 'waiting', selectable: true, defaultChecked: false }],
    ['name stop', { riskFlags: ['name_stop'], nameStopTerms: ['Honorar'] }, { status: 'waiting', selectable: true, defaultChecked: false }],
    ['macro', { riskFlags: ['macro'] }, { status: 'waiting', selectable: true, defaultChecked: false }],
    ['type mismatch', { riskFlags: ['type_mismatch'] }, { status: 'waiting', selectable: true, defaultChecked: false }],
    ['a picture pasted into the mail', { filename: null, contentType: 'image/png' }, { status: 'waiting', selectable: true, defaultChecked: false }],
    ['filed', { state: 'filed' }, { status: 'filed', selectable: false, defaultChecked: false }],
    ['dismissed', { state: 'dismissed' }, { status: 'dismissed', selectable: false, defaultChecked: false }],
  ])('%s', (_, overrides, expected) => {
    expect(attachmentCase(part(overrides), view)).toMatchObject(expected)
  })

  it('says whether the sender vouches for a Fassung (D11), and follows the server on whether it is checked', () => {
    const revisionCandidate = { documentId: 'd', name: 'S-101_B.pdf', folderPath: 'Tragwerk', nextVersion: 3 }
    expect(attachmentCase(part({ revisionCandidate }), view).notes).toContainEqual(expect.objectContaining({ kind: 'revision', verified: true }))
    const unverified = mail({
      sender: { ...view.sender!, trust: 'external_unverified', reason: 'dkim_none', signerDomain: null },
      parts: [part({ name: 'S-101_C.pdf', revisionCandidate })],
    })
    const entry = attachmentCase(unverified.parts[0], unverified)
    expect(entry.defaultChecked).toBe(false)
    expect(entry.notes).toContainEqual(expect.objectContaining({ kind: 'revision', verified: false }))
    expect(attachmentCase(part({ revisionCandidate, riskFlags: ['unverified_thread'] }), view).notes).toContainEqual(
      expect.objectContaining({ kind: 'revision', verified: false })
    )
  })

  it('checks exactly what the server pre-selected, and never what cannot be chosen', () => {
    expect(attachmentCase(part({ preselected: false }), view).defaultChecked).toBe(false)
    expect(attachmentCase(part({ preselected: true, scan: 'pending' }), view).defaultChecked).toBe(false)
  })

  it('offers nothing in a closed project', () => {
    expect(attachmentCase(part(), mail({ projectClosed: true }))).toMatchObject({ selectable: false, defaultChecked: false })
  })

  it('draws a thumbnail only for a clean picture or PDF (RT-S19)', () => {
    expect(attachmentCase(part({ contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), view).previewable).toBe(false)
    expect(attachmentCase(part({ contentType: 'image/png', scan: 'pending' }), view).previewable).toBe(false)
    expect(attachmentCase(part({ contentType: 'image/jpeg' }), view).previewable).toBe(true)
  })
})

describe('notStagedSummary', () => {
  it('lists what is only in the original and counts layout images', () => {
    expect(
      notStagedSummary([
        { filename: 'winmail.dat', reason: 'tnef' },
        { filename: 'a.zip', reason: 'archive' },
        { filename: 'logo.png', reason: 'embedded' },
        { filename: 'smime.p7s', reason: 'signature' },
        { filename: 'empty.txt', reason: 'empty' },
      ])
    ).toEqual({
      listed: [
        { filename: 'winmail.dat', reason: 'tnef' },
        { filename: 'a.zip', reason: 'archive' },
      ],
      layoutImages: 1,
    })
  })
})
