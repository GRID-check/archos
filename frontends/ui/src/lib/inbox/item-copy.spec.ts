import { describe, expect, it } from 'vitest'
import { de } from '@/i18n/dictionaries/de'
import { en } from '@/i18n/dictionaries/en'
import { createTranslator } from '@/i18n/translate'
import { inboxItemCopy } from './item-copy'
import type { InboxItemView } from './types'

const dictionary = { collaboration: de.collaboration }
const t = createTranslator(dictionary, 'collaboration')

function quarantined(overrides: Partial<InboxItemView> = {}): InboxItemView {
  return {
    id: 'item-1',
    type: 'document.quarantined',
    state: 'unread',
    archived: false,
    actionable: false,
    resourceType: 'organization',
    resourceId: 'org-1',
    anchorId: null,
    actorName: 'Anna Weber',
    actorUserId: 'u-anna',
    count: 1,
    href: '/app/organization/quarantine',
    subject: 'Lohnzettel_März.pdf',
    related: null,
    excerpt: null,
    variant: 'iban',
    answerIn: null,
    createdAt: '2026-10-17T10:00:00.000Z',
    updatedAt: '2026-10-17T10:00:00.000Z',
    ...overrides,
  }
}

describe('a reviewer’s notice about held files', () => {
  it('names the file and what it was held for, never the value found', () => {
    expect(inboxItemCopy(quarantined(), t, dictionary)).toEqual({
      title: '1 Datei wartet in der Quarantäne',
      body: '„Lohnzettel_März.pdf“ enthält eine IBAN. Kein Modell hat sie gelesen. Zulassen oder löschen?',
    })
  })

  it('says the newest of several is only the newest', () => {
    const { title, body } = inboxItemCopy(quarantined({ count: 3, variant: 'term' }), t, dictionary)
    expect(title).toBe('3 Dateien warten in der Quarantäne')
    expect(body).toBe(
      'Zuletzt „Lohnzettel_März.pdf“, mit einem Begriff aus der Liste sensibler Daten. Prüfen Sie sie: zulassen oder löschen.'
    )
  })

  it('claims no unread file when the vision model read the pages the match was in', () => {
    const { body } = inboxItemCopy(quarantined({ variant: 'transcript' }), t, dictionary)
    expect(body).toContain('Bildmodell')
    expect(body).not.toContain('Kein Modell')
  })

  it('keeps the sentence it had for a row from before it named the file', () => {
    const { body } = inboxItemCopy(quarantined({ subject: null, variant: null }), t, dictionary)
    expect(body).toBe('Kein Modell hat sie gelesen. Prüfen Sie sie: zulassen oder löschen.')
  })

  it('says why to a reviewer asked to look at a held file', () => {
    const { title, body } = inboxItemCopy(
      quarantined({ type: 'document.release_requested', variant: 'at_svnr' }),
      t,
      dictionary
    )
    expect(title).toBe('Anna Weber bittet Sie, „Lohnzettel_März.pdf“ zu prüfen')
    expect(body).toBe(
      'Sie enthält eine Sozialversicherungsnummer. Sehen Sie sie an und lassen Sie sie zu oder löschen Sie sie.'
    )
  })
})

describe('Piloti’s Rückfrage, by where it is answered', () => {
  const asks = (answerIn: InboxItemView['answerIn']) =>
    quarantined({
      type: 'piloti.asks_you',
      resourceType: 'document',
      resourceId: 'doc-1',
      anchorId: 'mark-4',
      actorName: null,
      actorUserId: null,
      href: '/app/projects/p1/files?doc=doc-1&review=1&mark=mark-4',
      subject: 'Grundriss EG',
      related: '4',
      excerpt: 'Gilt die Höhe ab Rohdecke?',
      variant: null,
      answerIn,
    })
  const enDictionary = { collaboration: en.collaboration }
  const enT = createTranslator(enDictionary, 'collaboration')

  // While events do not wake Piloti the row leads to the Prüfansicht
  // („In der Prüfansicht beantworten“): its line says so, never that Piloti
  // waits for an answer in the thread.
  it('says the answer goes in the review when the row leads there', () => {
    expect(inboxItemCopy(asks('review'), t, dictionary).body).toBe(
      'Antworten Sie in der Prüfansicht. Von dort erreicht Ihre Antwort Piloti.',
    )
    expect(inboxItemCopy(asks('review'), enT, enDictionary).body).toBe(
      'Answer in the review. From there your answer reaches Piloti.',
    )
  })

  it('keeps the thread for a row that answers in place', () => {
    expect(inboxItemCopy(asks('row'), t, dictionary).body).toBe(
      'Piloti wartet auf Ihre Antwort. Antworten Sie im Verlauf der Anmerkung.',
    )
    expect(inboxItemCopy(asks(null), enT, enDictionary).body).toBe(
      'Piloti is waiting for your answer. Reply in the annotation’s thread.',
    )
  })
})
