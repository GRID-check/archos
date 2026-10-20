/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import { deriveIntakeEntry, salvageProjectProfile } from './salvage'
import type { ProjectAssumption, ProjectFact } from './types'

/** A well-formed confirmed fact for a given value. */
function fact(value: ProjectFact['value']): ProjectFact {
  return {
    value,
    confidence: 'confirmed',
    source: 'onboarding',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/** A well-formed unconfirmed assumption for a given value. */
function assumption(value: ProjectAssumption['value']): ProjectAssumption {
  return {
    value,
    status: 'unconfirmed',
    reason: 'agent guess',
    source: 'agent_suggested',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('salvageProjectProfile', () => {
  it('returns a fully valid profile unchanged with nothing dropped', () => {
    const raw = {
      facts: { main_use: fact('residential'), storeys_above_ground: fact(3) },
      goals: { focus_areas: ['einreichung'] },
      unknowns: ['land_designation'],
      assumptions: {},
    }
    const { profile, dropped } = salvageProjectProfile(raw)
    expect(dropped).toEqual([])
    expect(profile).not.toBeNull()
    expect(profile!.facts.main_use.value).toBe('residential')
    expect(profile!.goals.focus_areas).toEqual(['einreichung'])
    expect(profile!.unknowns).toEqual(['land_designation'])
  })

  it('treats the empty {} default as absent — no salvage, no banner', () => {
    const { profile, dropped } = salvageProjectProfile({})
    expect(dropped).toEqual([])
    // An empty profile has no facts/goals/unknowns → the page treats it as create mode.
    expect(profile).not.toBeNull()
    expect(Object.keys(profile!.facts)).toHaveLength(0)
  })

  it('treats a genuinely absent profile (null/undefined) as create mode, no banner', () => {
    expect(salvageProjectProfile(null)).toEqual({ profile: null, dropped: [] })
    expect(salvageProjectProfile(undefined)).toEqual({ profile: null, dropped: [] })
  })

  it('salvages the valid facts and drops only the invalid ones (partial → banner)', () => {
    const raw = {
      facts: {
        main_use: fact('residential'), // valid
        broken: { value: 'x', confidence: 'guessed' }, // invalid confidence + missing fields
        storeys_above_ground: fact(3), // valid
      },
      goals: {},
      unknowns: [],
      assumptions: {},
    }
    const { profile, dropped } = salvageProjectProfile(raw)
    expect(profile).not.toBeNull()
    expect(profile!.facts.main_use.value).toBe('residential')
    expect(profile!.facts.storeys_above_ground.value).toBe(3)
    // The invalid fact is gone...
    expect(profile!.facts.broken).toBeUndefined()
    // ...and reported so the wizard can warn.
    expect(dropped).toContain('facts.broken')
  })

  describe('evidence and alternatives (ADR-0111)', () => {
    const goodEvidence = [
      { kind: 'document', fileName: 'Baubeschreibung.pdf', page: 4, quote: 'drei Geschoße' },
    ]
    const goodAlternative = {
      value: 4,
      evidence: goodEvidence,
      recordedAt: '2026-01-01T00:00:00.000Z',
    }
    const malformed = [{ kind: 'document', fileName: '', page: 'vier', quote: 7 }, 'not evidence']

    it('keeps the value of a fact whose evidence or alternatives are malformed, and reports nothing dropped', () => {
      const raw = {
        facts: {
          storeys_above_ground: { ...fact(3), evidence: malformed, alternatives: [{ value: {} }] },
        },
        goals: {},
        unknowns: [],
        assumptions: {},
      }
      const { profile, dropped } = salvageProjectProfile(raw)
      expect(dropped).toEqual([])
      expect(profile!.facts.storeys_above_ground.value).toBe(3)
      expect(profile!.facts.storeys_above_ground.evidence).toBeUndefined()
      expect(profile!.facts.storeys_above_ground.alternatives).toBeUndefined()
    })

    it('keeps the value of an assumption whose evidence or alternatives are malformed, fact by fact', () => {
      // `broken` sends the profile down the per-part path rather than the fast one.
      const raw = {
        facts: {
          broken: { value: 'x', confidence: 'guessed' },
          federal_state: { ...fact('vienna'), evidence: 'Seite 4' },
        },
        goals: {},
        unknowns: [],
        assumptions: {
          storeys_above_ground: { ...assumption(3), evidence: malformed, alternatives: 'viele' },
          escape_level_m: {
            ...assumption(9),
            evidence: goodEvidence,
            alternatives: [goodAlternative],
          },
        },
      }
      const { profile, dropped } = salvageProjectProfile(raw)
      expect(dropped).toEqual(['facts.broken'])
      expect(profile!.facts.federal_state).toMatchObject({ value: 'vienna' })
      expect(profile!.facts.federal_state.evidence).toBeUndefined()
      expect(profile!.assumptions.storeys_above_ground.value).toBe(3)
      expect(profile!.assumptions.storeys_above_ground.evidence).toBeUndefined()
      expect(profile!.assumptions.storeys_above_ground.alternatives).toBeUndefined()
      // Well-formed evidence is not collateral damage.
      expect(profile!.assumptions.escape_level_m.evidence).toEqual(goodEvidence)
      expect(profile!.assumptions.escape_level_m.alternatives).toEqual([goodAlternative])
    })

    it('opens an assumptions-only profile with malformed evidence in edit mode, without a banner', () => {
      const entry = deriveIntakeEntry({
        facts: {},
        goals: {},
        unknowns: [],
        assumptions: { storeys_above_ground: { ...assumption(3), evidence: malformed } },
      })
      expect(entry.mode).toBe('edit')
      expect(entry.salvageNotice).toBeNull()
    })
  })

  it('salvages valid goals and unknowns while dropping malformed entries', () => {
    const raw = {
      facts: {},
      goals: { focus_areas: ['einreichung'], bad: { not: 'a primitive' } },
      unknowns: ['land_designation', 42, 'construction_method'],
      assumptions: {},
    }
    const { profile, dropped } = salvageProjectProfile(raw)
    expect(profile).not.toBeNull()
    expect(profile!.goals.focus_areas).toEqual(['einreichung'])
    expect(profile!.goals.bad).toBeUndefined()
    expect(profile!.unknowns).toEqual(['land_designation', 'construction_method'])
    expect(dropped).toContain('goals.bad')
    expect(dropped).toContain('unknowns[1]')
  })

  it('drops a whole section whose container is the wrong type', () => {
    const raw = { facts: 'not an object', goals: {}, unknowns: [], assumptions: {} }
    const { profile, dropped } = salvageProjectProfile(raw)
    // facts is unsalvageable, but a valid (empty) profile shell still results — and
    // since nothing was salvaged, the page opens in create mode.
    expect(profile).toBeNull()
    expect(dropped).toContain('facts')
  })

  it('reports a full failure (profile null + banner) for a non-object profile', () => {
    const { profile, dropped } = salvageProjectProfile('totally corrupt')
    expect(profile).toBeNull()
    expect(dropped.length).toBeGreaterThan(0)
  })

  it('reports a full failure when every entry is invalid', () => {
    const raw = {
      facts: { a: { bogus: true }, b: 12 },
      goals: { c: { nested: 'object' } },
      unknowns: [{ not: 'a string' }],
      assumptions: {},
    }
    const { profile, dropped } = salvageProjectProfile(raw)
    expect(profile).toBeNull()
    expect(dropped.length).toBeGreaterThan(0)
    expect(dropped).toContain('facts.a')
  })
})

describe('deriveIntakeEntry', () => {
  it('opens an assumptions-only profile in edit mode with the assumptions kept', () => {
    const raw = {
      facts: {},
      goals: {},
      unknowns: [],
      assumptions: { land_designation: assumption('residential') },
    }
    const entry = deriveIntakeEntry(raw)
    expect(entry.mode).toBe('edit')
    expect(entry.initialProfile).not.toBeNull()
    expect(entry.initialProfile?.assumptions.land_designation?.value).toBe('residential')
    // Fully valid → nothing dropped → no banner.
    expect(entry.salvageNotice).toBeNull()
  })

  it('shows the partial banner and edits when assumptions survive but a fact dropped', () => {
    const raw = {
      facts: { a: { bogus: true } },
      goals: {},
      unknowns: [],
      assumptions: { land_designation: assumption('residential') },
    }
    const entry = deriveIntakeEntry(raw)
    expect(entry.mode).toBe('edit')
    expect(entry.initialProfile?.assumptions.land_designation?.value).toBe('residential')
    expect(entry.salvageNotice).toBe('partial')
  })

  it('opens a genuinely empty ({}) profile in create mode with no banner', () => {
    const entry = deriveIntakeEntry({})
    expect(entry.mode).toBe('create')
    expect(entry.initialProfile).toBeNull()
    expect(entry.salvageNotice).toBeNull()
  })

  it('opens an edit session for a facts-bearing profile', () => {
    const raw = {
      facts: { main_use: fact('residential') },
      goals: {},
      unknowns: [],
      assumptions: {},
    }
    const entry = deriveIntakeEntry(raw)
    expect(entry.mode).toBe('edit')
    expect(entry.initialProfile?.facts.main_use?.value).toBe('residential')
    expect(entry.salvageNotice).toBeNull()
  })

  it('shows the full-failure banner and create mode when nothing salvageable remained', () => {
    const entry = deriveIntakeEntry('totally corrupt')
    expect(entry.mode).toBe('create')
    expect(entry.initialProfile).toBeNull()
    expect(entry.salvageNotice).toBe('full')
  })
})
