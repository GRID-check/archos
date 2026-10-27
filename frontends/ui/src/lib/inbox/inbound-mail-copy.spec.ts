/**
 * The words of the E-Mail-Eingang's seven notice types (ADR-0137, DECISION §9),
 * as a row and a push say them, in both languages: every type and every
 * variant it is emitted with reads a whole sentence naming the project, with
 * no placeholder left and no key printed. The rows carry the project's name
 * and codes only (`lib/inbound-mail/announce.ts`), so these sentences are
 * everything a lock screen ever shows of a mail.
 */

import { describe, expect, it } from 'vitest'
import { de } from '@/i18n/dictionaries/de'
import { en } from '@/i18n/dictionaries/en'
import { createTranslator } from '@/i18n/translate'
import { INBOUND_MAIL_FILING_FAILURES } from '@/lib/inbound-mail/inbound-mail-vocabulary'
import { inboxItemCopy } from './item-copy'
import { INBOX_TYPE_DEFINITIONS } from './registry'
import { INBOX_TYPE_PRESENTATION, type InboxItemType, type InboxItemView } from './types'

/** Each type, and every variant it is emitted with (null: none). */
const EMITTED: ReadonlyArray<[InboxItemType, ReadonlyArray<string | null>]> = [
  ['inbound_mail.waiting', [null, 'unconfirmed']],
  ['inbound_mail.expiring', [null, 'unconfirmed']],
  ['inbound_mail.decided', [null, 'dismissed']],
  ['inbound_mail.filing_failed', INBOUND_MAIL_FILING_FAILURES],
  ['inbound_mail.cap_reached', ['nearly_full', 'full']],
  ['inbound_mail.appended', [null]],
  ['mail_thread.follow_expiring', [null]],
]

function view(type: InboxItemType, variant: string | null, overrides: Partial<InboxItemView> = {}): InboxItemView {
  return {
    id: 'item-1',
    type,
    state: 'unread',
    archived: false,
    actionable: INBOX_TYPE_DEFINITIONS[type].actionable,
    resourceType: 'project',
    resourceId: 'project-1',
    anchorId: null,
    actorName: 'Petra Huber',
    actorUserId: 'u-petra',
    count: 1,
    href: '/app/projects/project-1/files/mail',
    subject: 'Wohnbau Hietzing',
    related: null,
    excerpt: null,
    mentions: [],
    variant,
    answerIn: null,
    createdAt: '2026-10-22T10:00:00.000Z',
    updatedAt: '2026-10-22T10:00:00.000Z',
    ...overrides,
  }
}

describe.each([
  ['de', de],
  ['en', en],
] as const)('the E-Mail-Eingang’s notices in %s', (_locale, dictionaryOf) => {
  const dictionary = { collaboration: dictionaryOf.collaboration }
  const t = createTranslator(dictionary, 'collaboration')

  it.each(EMITTED.flatMap(([type, variants]) => variants.map((variant) => [type, variant] as const)))(
    '%s (%s) reads a whole sentence naming the project',
    (type, variant) => {
      for (const count of [0, 1, 3]) {
        const { title, body } = inboxItemCopy(view(type, variant, { count }), t, dictionary)
        expect(title).toContain('Wohnbau Hietzing')
        for (const text of [title, body ?? '']) {
          expect(text).not.toMatch(/[{}]|inbox\.types/)
        }
        expect(body).toBeTruthy()
      }
    },
  )

  it('words each variant it is emitted with, where the type has words for it', () => {
    const decided = inboxItemCopy(view('inbound_mail.decided', 'dismissed'), t, dictionary)
    const filed = inboxItemCopy(view('inbound_mail.decided', null), t, dictionary)
    expect(decided.title).not.toBe(filed.title)
    const full = inboxItemCopy(view('inbound_mail.cap_reached', 'full'), t, dictionary)
    const nearly = inboxItemCopy(view('inbound_mail.cap_reached', 'nearly_full'), t, dictionary)
    expect(full.title).not.toBe(nearly.title)
  })

  it('names a decided mail’s folder only when the row carries it', () => {
    const named = inboxItemCopy(view('inbound_mail.decided', null, { related: 'Behörde/Bescheide' }), t, dictionary)
    expect(named.title).toContain('Behörde/Bescheide')
    expect(inboxItemCopy(view('inbound_mail.decided', null), t, dictionary).title).not.toContain('Behörde')
  })
})

describe('the seven types’ registration', () => {
  const types = EMITTED.map(([type]) => type)

  it('are operational, never mailed, and pushed as DECISION §9 says', () => {
    const push = Object.fromEntries(types.map((type) => [type, INBOX_TYPE_DEFINITIONS[type].push]))
    expect(push).toEqual({
      'inbound_mail.waiting': { category: 'requests', urgency: 'normal' },
      'inbound_mail.expiring': { category: 'requests', urgency: 'normal' },
      'inbound_mail.decided': { category: 'results', urgency: 'low' },
      'inbound_mail.filing_failed': { category: 'requests', urgency: 'normal' },
      'inbound_mail.cap_reached': { category: 'requests', urgency: 'normal' },
      'inbound_mail.appended': { category: 'results', urgency: 'low' },
      'mail_thread.follow_expiring': { category: 'requests', urgency: 'low' },
    })
    for (const type of types) {
      expect(INBOX_TYPE_DEFINITIONS[type], type).toMatchObject({ gate: 'operational', email: { send: 'never' } })
    }
  })

  it('collapse where many mails are one thing to do, and fold per mail, address or follow otherwise', () => {
    const grouping = Object.fromEntries(types.map((type) => [type, INBOX_TYPE_DEFINITIONS[type].grouping]))
    expect(grouping).toEqual({
      'inbound_mail.waiting': 'collapse',
      'inbound_mail.expiring': 'collapse',
      'inbound_mail.decided': 'per-anchor',
      'inbound_mail.filing_failed': 'per-anchor',
      'inbound_mail.cap_reached': 'per-anchor',
      'inbound_mail.appended': 'per-anchor',
      'mail_thread.follow_expiring': 'per-anchor',
    })
  })

  it('wear an envelope each, marked with what happened, and the requests are actionable', () => {
    expect(types.map((type) => INBOX_TYPE_PRESENTATION[type].icon)).toEqual([
      'mail',
      'mail-clock',
      'mail-check',
      'mail-x',
      'mail-warning',
      'mail-plus',
      'clock',
    ])
    expect(types.filter((type) => INBOX_TYPE_DEFINITIONS[type].actionable)).toEqual([
      'inbound_mail.waiting',
      'inbound_mail.expiring',
      'inbound_mail.filing_failed',
      'inbound_mail.cap_reached',
      'mail_thread.follow_expiring',
    ])
  })
})
