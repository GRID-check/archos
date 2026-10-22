/**
 * The confirmation of „Wie vorgeschlagen ablegen“ for several mails: where
 * everything goes. Whether a mail may be filed so is the server's
 * (`lib/inbound-mail/review-defaults.spec.ts`).
 */

import { describe, expect, it } from 'vitest'
import { DETAIL_VARIANTS, FOLDERS } from '@/app/dev/inbound-mail/fixtures'
import { bulkPlan } from './completeness'
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
