/**
 * The milestones', the documents' and the found values' states, as pure data:
 * what the step claims in each phase.
 */
import { describe, expect, it } from 'vitest'
import {
  READING_COMPLETED,
  READING_FAILED,
  READING_QUEUED,
  READING_READY,
  READING_RUNNING,
  READING_SITE_SEARCHING,
  READING_WAITING,
} from '@/app/dev/_fixtures/project-setup-reading'
import { documentName, foundValues } from './found-values'
import { readingDocuments, readingMilestones, readingPhase, valuesFound } from './reading-milestones'

const byId = (view: Parameters<typeof readingMilestones>[0]) =>
  Object.fromEntries(readingMilestones(view).map((milestone) => [milestone.id, milestone]))

describe('readingMilestones', () => {
  it('names the phase, and tells waiting with documents from waiting without', () => {
    expect(readingPhase(READING_WAITING)).toBe('waiting')
    expect(readingPhase({ ...READING_WAITING, counts: { ...READING_WAITING.counts, unreadDocuments: 1 } })).toBe(
      'waitingWithDocuments'
    )
    expect(readingPhase(READING_RUNNING)).toBe('reading')
  })

  it('names the site, the values, the contradictions and the gaps, in that order', () => {
    expect(readingMilestones(READING_RUNNING).map((milestone) => milestone.id)).toEqual([
      'site',
      'values',
      'contradictions',
      'gaps',
    ])
    expect(readingMilestones(READING_WAITING).map((milestone) => milestone.id)).toEqual(['site'])
  })

  it('makes a site no reading found a question once the reading is over', () => {
    expect(byId(READING_SITE_SEARCHING).site.state).toBe('active')
    expect(byId({ ...READING_SITE_SEARCHING, status: 'ready' }).site.state).toBe('attention')
  })

  it('leaves the gaps for after the reading, and names them once it is over', () => {
    expect(byId(READING_RUNNING).gaps).toMatchObject({ state: 'pending', count: 4 })
    expect(byId(READING_READY).gaps).toMatchObject({ state: 'attention', count: 9 })
    expect(byId(READING_COMPLETED).gaps).toMatchObject({ state: 'done', count: 0 })
  })

  it('counts the values found in the documents, confirmed ones included', () => {
    expect(valuesFound(READING_COMPLETED)).toBe(valuesFound(READING_READY))
    expect(valuesFound(READING_READY)).toBeGreaterThan(0)
  })
})

describe('readingDocuments', () => {
  it('is this reading’s own count while it runs and once it is over', () => {
    expect(readingDocuments(READING_RUNNING)).toEqual({ read: 9, total: 23, unread: 23 })
    expect(readingDocuments(READING_FAILED)).toMatchObject({ read: 9, total: 23 })
  })

  it('reads nothing yet while the reading is queued', () => {
    expect(readingDocuments(READING_QUEUED)).toEqual({ read: 0, total: 23, unread: 23 })
  })

  it('falls back to the stored count, without a total, for a reading that reported nothing it opened', () => {
    const older = { ...READING_READY, readingProgress: { ...READING_READY.readingProgress, documentsOpened: 0 } }
    expect(readingDocuments(older)).toEqual({ read: 23, total: null, unread: 0 })
  })
})

describe('foundValues', () => {
  it('leads with the decisive values, each with its document and page', () => {
    const shown = foundValues(READING_READY, new Map())
    expect(shown).toHaveLength(3)
    expect(shown.every((value) => value.source.name.length > 0)).toBe(true)
    expect(shown.some((value) => value.fresh)).toBe(false)
  })

  it('puts what arrived while the page was open first, and marks it fresh', () => {
    const last = foundValues(READING_READY, new Map(), 100).at(-1)
    expect(last).toBeDefined()
    const shown = foundValues(READING_READY, new Map([[last?.key ?? '', 1]]))
    expect(shown[0]).toMatchObject({ key: last?.key, fresh: true })
  })

  it('names a document without its extension', () => {
    expect(documentName('E-02 Schnitt A-A.pdf')).toBe('E-02 Schnitt A-A')
    expect(documentName('Wohnungsliste.xlsx')).toBe('Wohnungsliste')
    expect(documentName('.pdf')).toBe('.pdf')
  })
})
