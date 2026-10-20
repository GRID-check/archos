/**
 * Confidence in words: from who decided and how many independent sources
 * agree, never a number nobody measured.
 */
import { describe, expect, it } from 'vitest'
import type { ProfileEvidence } from '@/lib/project-intake/types'
import { confidenceOf, distinctSources } from './confidence'

const doc = (fileName: string, page: number | null = 1): ProfileEvidence => ({ kind: 'document', fileName, page, quote: 'q' })
const person: ProfileEvidence = { kind: 'person', userId: 'u', at: '2026-10-14T08:30:00.000Z' }
const geocoder: ProfileEvidence = { kind: 'geocoder', provider: 'photon', label: 'Wien', resolvedAt: '2026-10-14T08:30:00.000Z' }

describe('distinctSources', () => {
  it('counts a document once however many pages it is quoted on, and never a person', () => {
    expect(distinctSources([doc('Baubeschreibung.pdf', 3), doc('baubeschreibung.PDF', 4), person])).toBe(1)
    expect(distinctSources([doc('Baubeschreibung.pdf'), doc('E-02 Schnitt.pdf'), geocoder])).toBe(3)
  })
})

describe('confidenceOf', () => {
  it('says two agreeing documents corroborate a suggestion', () => {
    expect(
      confidenceOf({ state: 'suggested', evidence: [doc('Baubeschreibung.pdf'), doc('Wohnungsliste.xlsx', null)], alternatives: [] })
    ).toEqual({ level: 'corroborated', count: 2, ownAnswer: false })
  })

  it('says one source is one source, and no source is unsupported', () => {
    expect(confidenceOf({ state: 'suggested', evidence: [doc('A.pdf'), doc('A.pdf', 2)], alternatives: [] }).level).toBe('single')
    expect(confidenceOf({ state: 'suggested', evidence: [], alternatives: [] }).level).toBe('unsupported')
  })

  it('counts the values a contradiction offers', () => {
    const alternative = { value: 7, evidence: [doc('B.pdf')], recordedAt: '2026-10-14T08:30:00.000Z' }
    expect(confidenceOf({ state: 'contested', evidence: [doc('A.pdf')], alternatives: [alternative] })).toEqual({
      level: 'contested',
      count: 2,
      ownAnswer: false,
    })
  })

  it('tells a confirmed suggestion from the person’s own answer', () => {
    expect(confidenceOf({ state: 'confirmed', evidence: [doc('A.pdf')], alternatives: [] })).toEqual({
      level: 'confirmed',
      count: 1,
      ownAnswer: false,
    })
    expect(confidenceOf({ state: 'confirmed', evidence: [person], alternatives: [] }).ownAnswer).toBe(true)
  })
})
