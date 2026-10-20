/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import { escapeLevelBand, getApplicableStandards } from './applicable-standards'
import type { ProjectProfile, ProjectPrimitiveValue } from '@/lib/project-profile/types'

/** Build a minimal, schema-shaped ProjectProfile from a flat map of fact values. */
function profileWith(facts: Record<string, ProjectPrimitiveValue>): ProjectProfile {
  const now = '2026-07-03T00:00:00.000Z'
  return {
    facts: Object.fromEntries(
      Object.entries(facts).map(([id, value]) => [
        id,
        { value, confidence: 'confirmed' as const, source: 'onboarding' as const, updatedAt: now },
      ])
    ),
    goals: {},
    unknowns: [],
    assumptions: {},
  }
}

const codesOf = (standards: ReturnType<typeof getApplicableStandards>): string[] =>
  standards.map((s) => s.code)

describe('getApplicableStandards', () => {
  it('returns the six near-universal standards, all required, for a null profile', () => {
    const result = getApplicableStandards(null)

    expect(codesOf(result)).toEqual(['OIB 1', 'OIB 2', 'OIB 3', 'OIB 4', 'OIB 5', 'OIB 6'])
    expect(result).toHaveLength(6)
    expect(result.every((s) => s.status === 'required')).toBe(true)
  })

  it('returns the six required standards for an empty profile (no facts)', () => {
    const result = getApplicableStandards(profileWith({}))

    expect(codesOf(result)).toEqual(['OIB 1', 'OIB 2', 'OIB 3', 'OIB 4', 'OIB 5', 'OIB 6'])
    expect(result.every((s) => s.status === 'required')).toBe(true)
  })

  it('omits fire sub-standards for a residential GK2 low-rise and marks OIB 5 required', () => {
    const result = getApplicableStandards(
      profileWith({ hauptnutzung: 'wohnen', gebaeudeklasse: 'GK2', fluchtniveau: '<=7m' })
    )

    const codes = codesOf(result)
    expect(codes).not.toContain('OIB 2.1')
    expect(codes).not.toContain('OIB 2.2')
    expect(codes).not.toContain('OIB 2.3')

    const oib5 = result.find((s) => s.code === 'OIB 5')
    expect(oib5?.status).toBe('required')
  })

  it('flags OIB 2.3 as required with the Hochhaus reason for a high-rise', () => {
    const result = getApplicableStandards(
      profileWith({ hauptnutzung: 'wohnen', gebaeudeklasse: 'GK5', fluchtniveau: '>22m' })
    )

    const oib23 = result.find((s) => s.code === 'OIB 2.3')
    expect(oib23).toBeDefined()
    expect(oib23?.status).toBe('required')
    expect(oib23?.reason).toContain('Hochhaus')
  })

  it('handles a storage building with a basement: 2.1 required, 2.2 check, 6 check', () => {
    const result = getApplicableStandards(
      profileWith({ hauptnutzung: 'lager', geschosse_unterirdisch: 2 })
    )

    const byCode = Object.fromEntries(result.map((s) => [s.code, s]))
    expect(byCode['OIB 2.1']?.status).toBe('required')
    expect(byCode['OIB 2.2']?.status).toBe('check')
    expect(byCode['OIB 6']?.status).toBe('check')
  })
})

const verdictOf = (standards: ReturnType<typeof getApplicableStandards>, code: string) =>
  standards.find((s) => s.code === code)

describe('escapeLevelBand', () => {
  it.each([
    [7, '<=7m'],
    [7.5, '7-11m'],
    [11, '7-11m'],
    [11.5, '11-22m'],
    [22, '11-22m'],
    [22.5, '>22m'],
  ])('derives the band for %s m from a Bauwerk fluchtniveau_m', (metres, band) => {
    expect(escapeLevelBand(profileWith({ 'fluchtniveau_m@bw1': metres }))).toBe(band)
  })

  it('takes the highest fluchtniveau_m across buildings, flat or scoped', () => {
    expect(
      escapeLevelBand(profileWith({ 'fluchtniveau_m@bw1': 5, 'fluchtniveau_m@bw2': 23 }))
    ).toBe('>22m')
    expect(escapeLevelBand(profileWith({ fluchtniveau_m: 9, 'fluchtniveau_m@bw2': 4 }))).toBe(
      '7-11m'
    )
  })

  it('keeps a stated flat fluchtniveau over the metres', () => {
    expect(escapeLevelBand(profileWith({ fluchtniveau: '<=7m', 'fluchtniveau_m@bw1': 30 }))).toBe(
      '<=7m'
    )
  })

  it('reads an empty stated fluchtniveau as no answer, so the metres still count', () => {
    expect(escapeLevelBand(profileWith({ fluchtniveau: '', 'fluchtniveau_m@bw1': 30 }))).toBe(
      '>22m'
    )
  })

  it('reads nothing from a use-zone copy, and nothing without metres', () => {
    expect(escapeLevelBand(profileWith({ 'fluchtniveau_m@bw1@wohnen': 30 }))).toBeUndefined()
    expect(escapeLevelBand(profileWith({ hauptnutzung: 'wohnen' }))).toBeUndefined()
  })

  it('does not read a non-finite metre value', () => {
    expect(escapeLevelBand(profileWith({ 'fluchtniveau_m@bw1': 'NaN' }))).toBeUndefined()
  })
})

describe('getApplicableStandards reads the keys the wizard writes', () => {
  it('flags OIB 2.3 as a Hochhaus from a building fluchtniveau_m above 22 m', () => {
    const result = getApplicableStandards(
      profileWith({ gebaeudeklasse: 'GK5', 'fluchtniveau_m@bw1': 22.5 })
    )
    expect(verdictOf(result, 'OIB 2.3')?.status).toBe('required')
  })

  it('does not flag OIB 2.3 at exactly 22 m', () => {
    const result = getApplicableStandards(
      profileWith({ gebaeudeklasse: 'GK5', 'fluchtniveau_m@bw1': 22 })
    )
    expect(verdictOf(result, 'OIB 2.3')).toBeUndefined()
  })

  it('reads a scoped gebaeudeklasse "5" as GK5', () => {
    const scoped = getApplicableStandards(
      profileWith({ hauptnutzung: 'wohnen', 'gebaeudeklasse@bw1': '5' })
    )
    const flat = getApplicableStandards(
      profileWith({ hauptnutzung: 'wohnen', gebaeudeklasse: 'GK5' })
    )
    expect(verdictOf(scoped, 'OIB 2.3')?.status).toBe('check')
    expect(scoped).toEqual(flat)
  })

  it('reads a scoped gebaeudeklasse "4" exactly as GK4', () => {
    const scoped = getApplicableStandards(
      profileWith({ hauptnutzung: 'wohnen', 'gebaeudeklasse@bw1': '4' })
    )
    const flat = getApplicableStandards(
      profileWith({ hauptnutzung: 'wohnen', gebaeudeklasse: 'GK4' })
    )
    expect(verdictOf(scoped, 'OIB 2.3')).toBeUndefined()
    expect(scoped).toEqual(flat)
  })

  it('takes the highest gebaeudeklasse across buildings', () => {
    const result = getApplicableStandards(
      profileWith({ 'gebaeudeklasse@bw1': '4', 'gebaeudeklasse@bw2': 'GK5' })
    )
    expect(verdictOf(result, 'OIB 2.3')?.status).toBe('check')
  })

  it('takes the highest geschosse_unterirdisch across buildings', () => {
    const basement = getApplicableStandards(
      profileWith({ 'geschosse_unterirdisch@bw1': 0, 'geschosse_unterirdisch@bw2': 2 })
    )
    expect(verdictOf(basement, 'OIB 2.2')?.status).toBe('check')

    const none = getApplicableStandards(
      profileWith({ 'geschosse_unterirdisch@bw1': 0, 'geschosse_unterirdisch@bw2': 0 })
    )
    expect(verdictOf(none, 'OIB 2.2')).toBeUndefined()
  })

  it('reads the one verdict use the buildings share as hauptnutzung', () => {
    const result = getApplicableStandards(
      profileWith({ 'nutzungen@bw1': ['wohnen'], 'nutzungen@bw2': ['wohnen'] })
    )
    expect(verdictOf(result, 'OIB 2.1')).toBeUndefined()
    expect(verdictOf(result, 'OIB 5')?.status).toBe('required')
  })

  it('leaves the main use unknown when a use names no verdict token', () => {
    // `produktion` (D0) is not `produzierend`: an unknown use may be the
    // Betriebsbau, so a mixed building keeps its OIB 2.1 "check".
    const result = getApplicableStandards(
      profileWith({ 'nutzungen@bw1': ['wohnen', 'produktion'] })
    )
    expect(verdictOf(result, 'OIB 2.1')?.status).toBe('check')
  })

  it('leaves hauptnutzung unknown when the buildings name two verdict uses', () => {
    const result = getApplicableStandards(
      profileWith({ 'nutzungen@bw1': ['wohnen'], 'nutzungen@bw2': ['buero'] })
    )
    expect(verdictOf(result, 'OIB 2.1')?.status).toBe('check')
    expect(verdictOf(result, 'OIB 5')?.status).toBe('likely')
  })

  it('does not map a D0 use onto a different verdict token', () => {
    const result = getApplicableStandards(profileWith({ 'nutzungen@bw1': ['produktion'] }))
    expect(verdictOf(result, 'OIB 2.1')?.status).toBe('check')
  })

  it('keeps a stated hauptnutzung over the nutzungen', () => {
    const result = getApplicableStandards(
      profileWith({ hauptnutzung: 'lager', 'nutzungen@bw1': ['wohnen'] })
    )
    expect(verdictOf(result, 'OIB 2.1')?.status).toBe('required')
  })
})

/**
 * Parity fixtures. The Python twin asserts the same table in
 * tests/aiq_agent/common/test_applicability.py (TestTwinParityFixtures).
 * Keep the two tables identical.
 */
describe('parity fixtures shared with the Python twin', () => {
  it.each<{
    name: string
    facts: Record<string, ProjectPrimitiveValue>
    expected: Record<string, string | undefined>
  }>([
    {
      name: 'scoped GK5 without metres',
      facts: { 'gebaeudeklasse@bw1': '5' },
      expected: { 'OIB 2.3': 'check' },
    },
    {
      name: 'GK4 on one Bauwerk, GK5 on another',
      facts: { 'gebaeudeklasse@bw1': '4', 'gebaeudeklasse@bw2': 'GK5' },
      expected: { 'OIB 2.3': 'check' },
    },
    {
      name: 'GK5 with metres above 22',
      facts: { gebaeudeklasse: 'GK5', 'fluchtniveau_m@bw1': 22.5 },
      expected: { 'OIB 2.3': 'required' },
    },
    {
      name: 'GK5 with metres exactly 22',
      facts: { gebaeudeklasse: 'GK5', 'fluchtniveau_m@bw1': 22 },
      expected: { 'OIB 2.3': undefined },
    },
    {
      name: 'one use and a basement',
      facts: { 'nutzungen@bw1': ['wohnen'], 'geschosse_unterirdisch@bw1': 2 },
      expected: { 'OIB 2.1': undefined, 'OIB 2.2': 'check', 'OIB 5': 'required' },
    },
    {
      name: 'two verdict uses across Bauwerke',
      facts: { 'nutzungen@bw1': ['wohnen'], 'nutzungen@bw2': ['buero'] },
      expected: { 'OIB 2.1': 'check', 'OIB 5': 'likely' },
    },
  ])('$name', ({ facts, expected }) => {
    const result = getApplicableStandards(profileWith(facts))
    const actual = Object.fromEntries(
      Object.keys(expected).map((code) => [code, verdictOf(result, code)?.status])
    )
    expect(actual).toEqual(expected)
  })
})
