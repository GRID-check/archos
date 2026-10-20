/**
 * The milestones' states, as pure data: what the step claims in each phase.
 */
import { describe, expect, it } from 'vitest'
import {
  READING_COMPLETED,
  READING_READY,
  READING_RUNNING,
  READING_SITE_SEARCHING,
  READING_WAITING,
} from '@/app/dev/_fixtures/project-setup-reading'
import { readingMilestones, readingPhase, valuesFound } from './reading-milestones'

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

  it('makes a site no reading found a question once the reading is over', () => {
    expect(byId(READING_SITE_SEARCHING).site.state).toBe('active')
    expect(byId({ ...READING_SITE_SEARCHING, status: 'ready' }).site.state).toBe('attention')
  })

  it('falls back to the stored count for a reading that reported nothing it opened', () => {
    const older = { ...READING_READY, readingProgress: { ...READING_READY.readingProgress, documentsOpened: 0 } }
    expect(byId(older).documents).toEqual({ id: 'documents', state: 'done', read: 23, total: null })
  })

  it('counts the values found in the documents, confirmed ones included', () => {
    expect(valuesFound(READING_COMPLETED)).toBe(valuesFound(READING_READY))
    expect(valuesFound(READING_READY)).toBeGreaterThan(0)
  })
})
