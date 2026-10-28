/**
 * @vitest-environment node
 */
/**
 * `evidence` and `alternatives` on a fact or an assumption (ADR-0111) are
 * optional and lenient: a malformed list is dropped and the value kept, because
 * `salvage.ts` parses a stored profile fact by fact and a bad evidence entry
 * must not cost the fact. And they survive the profile's one door, the patch
 * engine, which re-parses the whole profile on every write.
 */
import { describe, expect, it } from 'vitest'
import { applyProjectProfilePatch, emptyProjectProfile } from './patch-engine'
import { salvageProjectProfile } from './salvage'
import { ProjectAssumptionSchema, ProjectFactSchema, ProjectProfileSchema, type ProjectProfile } from './types'
import type { ProfileAlternative, ProfileEvidence } from './evidence-schema'

const NOW = '2026-10-14T09:00:00.000Z'

const PAGE: ProfileEvidence = {
  kind: 'document',
  fileName: 'EP_Schnitt_A-A.pdf',
  page: 2,
  quote: 'Fluchtniveau +10,85 m',
}

const DERIVED: ProfileEvidence = {
  kind: 'derivation',
  rule: 'building_class',
  citation: 'OIB-Richtlinien, Begriffsbestimmungen (Ausgabe 2023)',
  inputs: [{ key: 'escape_level_m@bldg1', value: 10.85, suggested: true }],
}

const OTHER: ProfileAlternative = {
  value: 11.2,
  evidence: [{ ...PAGE, page: 3, quote: 'FN 11,20 m' }],
  recordedAt: NOW,
}

describe('evidence on the profile', () => {
  it('keeps evidence and alternatives that are well formed', () => {
    const fact = ProjectFactSchema.parse({
      value: 10.85,
      confidence: 'confirmed',
      source: 'user_confirmed',
      updatedAt: NOW,
      evidence: [PAGE, { kind: 'person', userId: 'user_1', at: NOW }],
      alternatives: [OTHER],
    })
    expect(fact.evidence).toEqual([PAGE, { kind: 'person', userId: 'user_1', at: NOW }])
    expect(fact.alternatives).toEqual([OTHER])
  })

  it('reads a fact without either field as before', () => {
    const fact = ProjectFactSchema.parse({ value: 'vienna', confidence: 'confirmed', source: 'onboarding', updatedAt: NOW })
    expect(fact).toEqual({ value: 'vienna', confidence: 'confirmed', source: 'onboarding', updatedAt: NOW })
  })

  it('drops a malformed evidence list and keeps the fact', () => {
    const parsed = ProjectFactSchema.safeParse({
      value: 4,
      confidence: 'confirmed',
      source: 'user_confirmed',
      updatedAt: NOW,
      evidence: [{ kind: 'document', fileName: 'EP.pdf', page: 0, quote: '' }],
      alternatives: 'not a list',
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.value).toBe(4)
    expect(parsed.data?.evidence).toBeUndefined()
    expect(parsed.data?.alternatives).toBeUndefined()
  })

  it('drops an evidence list past its bound, or with a quote past 400 characters', () => {
    const tooMany = ProjectAssumptionSchema.parse({
      value: 4,
      status: 'unconfirmed',
      reason: '',
      source: 'agent_suggested',
      updatedAt: NOW,
      evidence: Array.from({ length: 6 }, () => PAGE),
    })
    expect(tooMany.evidence).toBeUndefined()
    const longQuote = ProjectAssumptionSchema.parse({
      value: 4,
      status: 'unconfirmed',
      reason: '',
      source: 'agent_suggested',
      updatedAt: NOW,
      evidence: [{ ...PAGE, quote: 'x'.repeat(401) }],
    })
    expect(longQuote.evidence).toBeUndefined()
    expect(longQuote.value).toBe(4)
  })

  it('loses nothing in the salvage for a malformed evidence: the profile parses whole', () => {
    const raw = {
      facts: {
        federal_state: {
          value: 'vienna',
          confidence: 'confirmed',
          source: 'onboarding',
          updatedAt: NOW,
          evidence: [{ kind: 'telepathy' }],
        },
      },
      goals: {},
      unknowns: [],
      assumptions: {},
    }
    const salvaged = salvageProjectProfile(raw)
    expect(salvaged.dropped).toEqual([])
    expect(salvaged.profile?.facts.federal_state?.value).toBe('vienna')
    expect(salvaged.profile?.facts.federal_state?.evidence).toBeUndefined()
  })

  it('survives a write through the patch engine, on facts and on assumptions', () => {
    const profile: ProjectProfile = ProjectProfileSchema.parse({
      facts: {
        'escape_level_m@bldg1': {
          value: 10.85,
          confidence: 'confirmed',
          source: 'user_confirmed',
          updatedAt: NOW,
          evidence: [PAGE],
          alternatives: [OTHER],
        },
      },
    })
    const next = applyProjectProfilePatch(profile, [
      {
        op: 'add',
        path: '/assumptions/building_class@bldg1',
        value: {
          value: 3,
          status: 'unconfirmed',
          reason: '',
          source: 'agent_suggested',
          updatedAt: NOW,
          evidence: [DERIVED],
        },
      },
    ])
    expect(next.facts['escape_level_m@bldg1']?.evidence).toEqual([PAGE])
    expect(next.facts['escape_level_m@bldg1']?.alternatives).toEqual([OTHER])
    expect(next.assumptions['building_class@bldg1']?.evidence).toEqual([DERIVED])

    // And a second pass, as every later write re-parses the stored profile.
    const again = applyProjectProfilePatch(JSON.parse(JSON.stringify(next)) as ProjectProfile, [])
    expect(again).toEqual(next)
  })

  it('keeps the fact when a patch writes it with malformed evidence', () => {
    const next = applyProjectProfilePatch(emptyProjectProfile(), [
      {
        op: 'add',
        path: '/facts/federal_state',
        value: { value: 'tyrol', confidence: 'confirmed', source: 'user_confirmed', updatedAt: NOW, evidence: 'x' },
      },
    ])
    expect(next.facts.federal_state?.value).toBe('tyrol')
    expect(next.facts.federal_state?.evidence).toBeUndefined()
  })
})
