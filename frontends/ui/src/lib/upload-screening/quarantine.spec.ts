import { describe, expect, it } from 'vitest'
import { createTranslator } from '@/i18n/translate'
import { de } from '@/i18n/dictionaries/de'
import {
  describeNameMatch,
  describeQuarantineReason,
  findingsOf,
  firstFinding,
  parseQuarantine,
  quarantineReasonHead,
} from './quarantine'
import { classifyIngestFailure } from '@/features/documents/lib/ingest-failure'

const t = createTranslator(de, 'files')

const stored =
  'quarantined:{"reasons":[{"kind":"term","term":"Lohnzettel","count":2,"pages":[1,3]},' +
  '{"kind":"iban","count":1,"pages":[2],"sample":"AT61 •••• •••• •••• 1234"}],"checked":"partial"}'

describe('parseQuarantine', () => {
  it('reads the verdict the ingest job stores', () => {
    expect(parseQuarantine(stored)).toEqual({
      reasons: [
        { kind: 'term', term: 'Lohnzettel', count: 2, pages: [1, 3] },
        { kind: 'iban', count: 1, pages: [2], sample: 'AT61 •••• •••• •••• 1234' },
      ],
      checked: 'partial',
    })
  })

  it('answers null for any other error, and for a malformed verdict', () => {
    expect(parseQuarantine('interrupted: worker restarted')).toBeNull()
    expect(parseQuarantine('quarantined:{not json')).toBeNull()
    expect(parseQuarantine('quarantined:{"reasons":[{"kind":"salary"}]}')).toBeNull()
    expect(parseQuarantine(null)).toBeNull()
  })

  it('reads a reason whose page list the job cut', () => {
    const cut = parseQuarantine(
      'quarantined:{"reasons":[{"kind":"term","term":"Lohnzettel","count":80,"pages":[1,2,3],"pages_truncated":true}]}'
    )
    expect(cut?.reasons[0]).toEqual({ kind: 'term', term: 'Lohnzettel', count: 80, pages: [1, 2, 3], pages_truncated: true })
    // A verdict stored before the field existed lists every page, and still parses.
    expect(parseQuarantine(stored)?.reasons[0].pages_truncated).toBeUndefined()
    // A field of the wrong type is a malformed verdict, not a guess.
    expect(
      parseQuarantine('quarantined:{"reasons":[{"kind":"term","term":"L","pages":[1],"pages_truncated":"yes"}]}')
    ).toBeNull()
  })

  it('is classified as a quarantine, not as an unknown failure', () => {
    expect(classifyIngestFailure(stored)?.kind).toBe('quarantined')
  })
})

describe('describing a reason', () => {
  it('says the term and the pages', () => {
    const verdict = parseQuarantine(stored)
    expect(verdict && describeQuarantineReason(verdict.reasons[0], t)).toBe('„Lohnzettel“ im Text · Seiten 1, 3')
  })

  it('shows a detector hit only by its masked sample', () => {
    const verdict = parseQuarantine(stored)
    expect(verdict && describeQuarantineReason(verdict.reasons[1], t)).toBe('IBAN AT61 •••• •••• •••• 1234 · Seite 2')
  })

  it('says there are more pages when the job listed only some', () => {
    const cut = parseQuarantine(
      'quarantined:{"reasons":[{"kind":"term","term":"Lohnzettel","count":80,"pages":[1,3],"pages_truncated":true}]}'
    )
    expect(cut && describeQuarantineReason(cut.reasons[0], t)).toBe('„Lohnzettel“ im Text · Seiten 1, 3, …')
  })

  it('says the reason without its pages where the pages are buttons', () => {
    const verdict = parseQuarantine(stored)
    expect(verdict && quarantineReasonHead(verdict.reasons[0], t)).toBe('„Lohnzettel“ im Text')
  })

  it('names the folder for a name match on a folder', () => {
    expect(describeNameMatch({ term: 'Personal', segment: 'Personalunterlagen', kind: 'folder' }, t)).toBe(
      'Ordner „Personalunterlagen“ enthält „Personal“'
    )
  })
})

describe('where a finding is', () => {
  it('opens a term on each of its pages, with the term marked', () => {
    const verdict = parseQuarantine(stored)
    expect(verdict && findingsOf(verdict.reasons[0])).toEqual([
      { page: 1, highlight: 'Lohnzettel' },
      { page: 3, highlight: 'Lohnzettel' },
    ])
  })

  it('opens a detector hit at its page and marks nothing, because its value is never stored', () => {
    const verdict = parseQuarantine(stored)
    expect(verdict && findingsOf(verdict.reasons[1])).toEqual([{ page: 2, highlight: null }])
  })

  it('opens a held document at its first finding, and nowhere when no reason has a page', () => {
    expect(firstFinding(parseQuarantine(stored))).toEqual({ page: 1, highlight: 'Lohnzettel' })
    expect(firstFinding(parseQuarantine('quarantined:{"reasons":[{"kind":"term","term":"Lohn"}]}'))).toBeNull()
    expect(firstFinding(null)).toBeNull()
  })
})
