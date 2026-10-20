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
      profileWith({ main_use: 'residential', building_class: 'GK2', escape_level: '<=7m' })
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
      profileWith({ main_use: 'residential', building_class: 'GK5', escape_level: '>22m' })
    )

    const oib23 = result.find((s) => s.code === 'OIB 2.3')
    expect(oib23).toBeDefined()
    expect(oib23?.status).toBe('required')
    expect(oib23?.reason).toContain('Hochhaus')
  })

  it('handles a storage building with a basement: 2.1 required, 2.2 check, 6 check', () => {
    const result = getApplicableStandards(
      profileWith({ main_use: 'storage', storeys_below_ground: 2 })
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
    expect(escapeLevelBand(profileWith({ 'escape_level_m@bldg1': metres }))).toBe(band)
  })

  it('takes the highest fluchtniveau_m across buildings, flat or scoped', () => {
    expect(
      escapeLevelBand(profileWith({ 'escape_level_m@bldg1': 5, 'escape_level_m@bldg2': 23 }))
    ).toBe('>22m')
    expect(escapeLevelBand(profileWith({ escape_level_m: 9, 'escape_level_m@bldg2': 4 }))).toBe(
      '7-11m'
    )
  })

  it('keeps a stated flat fluchtniveau over the metres', () => {
    expect(escapeLevelBand(profileWith({ escape_level: '<=7m', 'escape_level_m@bldg1': 30 }))).toBe(
      '<=7m'
    )
  })

  it('reads an empty stated fluchtniveau as no answer, so the metres still count', () => {
    expect(escapeLevelBand(profileWith({ escape_level: '', 'escape_level_m@bldg1': 30 }))).toBe(
      '>22m'
    )
  })

  it('reads nothing from a use-zone copy, and nothing without metres', () => {
    expect(escapeLevelBand(profileWith({ 'escape_level_m@bldg1@residential': 30 }))).toBeUndefined()
    expect(escapeLevelBand(profileWith({ main_use: 'residential' }))).toBeUndefined()
  })

  it('does not read a non-finite metre value', () => {
    expect(escapeLevelBand(profileWith({ 'escape_level_m@bldg1': 'NaN' }))).toBeUndefined()
  })
})

describe('getApplicableStandards reads the keys the wizard writes', () => {
  it('flags OIB 2.3 as a Hochhaus from a building fluchtniveau_m above 22 m', () => {
    const result = getApplicableStandards(
      profileWith({ building_class: 'GK5', 'escape_level_m@bldg1': 22.5 })
    )
    expect(verdictOf(result, 'OIB 2.3')?.status).toBe('required')
  })

  it('does not flag OIB 2.3 at exactly 22 m', () => {
    const result = getApplicableStandards(
      profileWith({ building_class: 'GK5', 'escape_level_m@bldg1': 22 })
    )
    expect(verdictOf(result, 'OIB 2.3')).toBeUndefined()
  })

  it('reads a scoped gebaeudeklasse "5" as GK5', () => {
    const scoped = getApplicableStandards(
      profileWith({ main_use: 'residential', 'building_class@bldg1': '5' })
    )
    const flat = getApplicableStandards(
      profileWith({ main_use: 'residential', building_class: 'GK5' })
    )
    expect(verdictOf(scoped, 'OIB 2.3')?.status).toBe('check')
    expect(scoped).toEqual(flat)
  })

  it('reads a scoped gebaeudeklasse "4" exactly as GK4', () => {
    const scoped = getApplicableStandards(
      profileWith({ main_use: 'residential', 'building_class@bldg1': '4' })
    )
    const flat = getApplicableStandards(
      profileWith({ main_use: 'residential', building_class: 'GK4' })
    )
    expect(verdictOf(scoped, 'OIB 2.3')).toBeUndefined()
    expect(scoped).toEqual(flat)
  })

  it('takes the highest gebaeudeklasse across buildings', () => {
    const result = getApplicableStandards(
      profileWith({ 'building_class@bldg1': '4', 'building_class@bldg2': 'GK5' })
    )
    expect(verdictOf(result, 'OIB 2.3')?.status).toBe('check')
  })

  it('takes the highest geschosse_unterirdisch across buildings', () => {
    const basement = getApplicableStandards(
      profileWith({ 'storeys_below_ground@bldg1': 0, 'storeys_below_ground@bldg2': 2 })
    )
    expect(verdictOf(basement, 'OIB 2.2')?.status).toBe('check')

    const none = getApplicableStandards(
      profileWith({ 'storeys_below_ground@bldg1': 0, 'storeys_below_ground@bldg2': 0 })
    )
    expect(verdictOf(none, 'OIB 2.2')).toBeUndefined()
  })

  it('reads the one verdict use the buildings share as hauptnutzung', () => {
    const result = getApplicableStandards(
      profileWith({ 'uses@bldg1': ['residential'], 'uses@bldg2': ['residential'] })
    )
    expect(verdictOf(result, 'OIB 2.1')).toBeUndefined()
    expect(verdictOf(result, 'OIB 5')?.status).toBe('required')
  })

  it('leaves the main use unknown when a use names no verdict token', () => {
    // `produktion` (D0) is not `produzierend`: an unknown use may be the
    // Betriebsbau, so a mixed building keeps its OIB 2.1 "check".
    const result = getApplicableStandards(
      profileWith({ 'uses@bldg1': ['residential', 'production'] })
    )
    expect(verdictOf(result, 'OIB 2.1')?.status).toBe('check')
  })

  it('leaves hauptnutzung unknown when the buildings name two verdict uses', () => {
    const result = getApplicableStandards(
      profileWith({ 'uses@bldg1': ['residential'], 'uses@bldg2': ['office'] })
    )
    expect(verdictOf(result, 'OIB 2.1')?.status).toBe('check')
    expect(verdictOf(result, 'OIB 5')?.status).toBe('likely')
  })

  it('does not map a D0 use onto a different verdict token', () => {
    const result = getApplicableStandards(profileWith({ 'uses@bldg1': ['production'] }))
    expect(verdictOf(result, 'OIB 2.1')?.status).toBe('check')
  })

  it('keeps a stated hauptnutzung over the nutzungen', () => {
    const result = getApplicableStandards(
      profileWith({ main_use: 'storage', 'uses@bldg1': ['residential'] })
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
      facts: { 'building_class@bldg1': '5' },
      expected: { 'OIB 2.3': 'check' },
    },
    {
      name: 'GK4 on one Bauwerk, GK5 on another',
      facts: { 'building_class@bldg1': '4', 'building_class@bldg2': 'GK5' },
      expected: { 'OIB 2.3': 'check' },
    },
    {
      name: 'GK5 with metres above 22',
      facts: { building_class: 'GK5', 'escape_level_m@bldg1': 22.5 },
      expected: { 'OIB 2.3': 'required' },
    },
    {
      name: 'GK5 with metres exactly 22',
      facts: { building_class: 'GK5', 'escape_level_m@bldg1': 22 },
      expected: { 'OIB 2.3': undefined },
    },
    {
      name: 'one use and a basement',
      facts: { 'uses@bldg1': ['residential'], 'storeys_below_ground@bldg1': 2 },
      expected: { 'OIB 2.1': undefined, 'OIB 2.2': 'check', 'OIB 5': 'required' },
    },
    {
      name: 'two verdict uses across Bauwerke',
      facts: { 'uses@bldg1': ['residential'], 'uses@bldg2': ['office'] },
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
