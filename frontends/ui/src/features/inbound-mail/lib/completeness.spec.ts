/**
 * The confirmation of „Wie vorgeschlagen ablegen“ for several mails: where
 * everything goes. Whether a mail may be filed so is the server's
 * (`lib/inbound-mail/review-defaults.spec.ts`).
 */

import { describe, expect, it } from 'vitest'
import { DETAIL_VARIANTS, FOLDERS } from '@/app/dev/inbound-mail/fixtures'
import { asSuggested, bulkPlan, fileableReason, isReady } from './completeness'
import { initialDraft, type DraftCopy } from './draft'

const copy: DraftCopy = { unnamedAttachment: (position) => `Attachment ${position}`, untitledThread: '(no subject)' }

describe('bulkPlan', () => {
  it('groups where things go, threads first', () => {
    const entries = ['member-verified', 'thread-append', 'revision'].map((name) => {
      const view = DETAIL_VARIANTS[name].view
      return { view, draft: initialDraft(view, FOLDERS, copy) }
    })
    expect(bulkPlan(entries)).toEqual({
      mails: 3,
      files: 2,
      texts: 3,
      destinations: [
        { kind: 'thread', label: 'Stellplatznachweis', count: 3 },
        { kind: 'folder', label: 'Behörde/Bescheide', count: 1 },
        { kind: 'folder', label: 'Tragwerk', count: 1 },
      ],
    })
  })
})

describe('fileableReason', () => {
  it('is the server’s reason for a waiting mail, and null when it is complete', () => {
    expect(fileableReason({ status: 'waiting', incompleteReason: null, riskLevel: 'none' })).toBeNull()
    expect(fileableReason({ status: 'waiting', incompleteReason: 'folder_missing', riskLevel: 'none' })).toBe('folder_missing')
    expect(fileableReason({ status: 'handled', incompleteReason: null, riskLevel: 'none' })).toBe('not_waiting')
  })

  it('never lets an impersonation through, whatever its view says', () => {
    expect(fileableReason({ status: 'waiting', incompleteReason: null, riskLevel: 'impersonation' })).toBe('sender')
    expect(isReady({ status: 'waiting', incompleteReason: null, riskLevel: 'impersonation' })).toBe(false)
  })
})

describe('asSuggested', () => {
  const view = (name: string) => DETAIL_VARIANTS[name].view

  it('builds the request from each mail’s defaults, with no acknowledgement, and the plan from the same drafts', () => {
    const built = asSuggested([view('member-verified')], FOLDERS, copy)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.decisions).toHaveLength(1)
    expect(built.decisions[0]).toMatchObject({ mailId: view('member-verified').id, message: { thread: { action: 'append' } } })
    expect(built.decisions[0]).not.toHaveProperty('acknowledgeSender')
    expect(built.decisions[0]).not.toHaveProperty('acknowledgeRisk')
    expect(built.plan.destinations).toEqual([
      { kind: 'thread', label: 'Stellplatznachweis', count: 1 },
      { kind: 'folder', label: 'Behörde/Bescheide', count: 1 },
    ])
  })

  it('is the same request whether one row or a bulk confirmation sends it', () => {
    const one = asSuggested([view('member-verified')], FOLDERS, copy)
    const many = asSuggested([view('member-verified'), view('revision')], FOLDERS, copy)
    expect(one.ok && many.ok && many.decisions[0]).toEqual(one.ok && one.decisions[0])
  })

  it('refuses the whole request when any mail is not complete, naming the first reason and its count', () => {
    expect(asSuggested([view('member-verified'), view('name-stop')], FOLDERS, copy)).toEqual({ ok: false, reason: 'needs_person', count: 1 })
  })

  it('refuses an impersonation even if its view were complete', () => {
    const forged = { ...view('member-verified'), riskLevel: 'impersonation' as const, impersonation: 'member_name' as const, incompleteReason: null }
    expect(asSuggested([forged], FOLDERS, copy)).toEqual({ ok: false, reason: 'sender', count: 1 })
  })
})
