/**
 * @vitest-environment node
 */
/**
 * The fingerprint the closing debrief asks for is the one the reference ranking
 * reads, in the shape the intake wizard really stores: a building's answers
 * under its instance (`construction_method@bldg1`), several buildings read as all of them.
 * Each case builds its profile with `buildIntakeProfile`, the producer, so a
 * hand-written profile in a shape production never stores cannot pass here.
 * Whether a fact applies, and whether the wizard can write it, is read off the
 * intake definition.
 */

import { describe, expect, it } from 'vitest'
import { projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import { buildIntakeProfile } from '@/lib/project-profile/intake-profile'
import type { ProjectPrimitiveValue } from '@/lib/project-profile/types'
import { FINGERPRINT_KEYS, factLabel, fingerprintLabels, fingerprintOf, type FingerprintFact } from './fingerprint'

type Answers = Record<string, ProjectPrimitiveValue>

const built = (answers: Answers, buildings = [{ id: 'bldg1', name: 'Bauwerk 1' }]) =>
  buildIntakeProfile(answers, projectIntakeDefinitionV1, { buildings })

const byKey = (facts: FingerprintFact[]) => Object.fromEntries(facts.map((fact) => [fact.key, fact]))

describe('fingerprintOf', () => {
  it('reads what the wizard wrote, per building, with the wizard’s labels', () => {
    const facts = byKey(
      fingerprintOf(
        built({
          A2_country: 'at',
          A2_land: 'lower_austria',
          A5: ['new_build', 'extension'],
          'C1@bldg1': 'building',
          'C10@bldg1': ['timber', 'reinforced_concrete'],
          'D0@bldg1': ['residential'],
        })
      )
    )

    expect(Object.keys(facts)).toEqual([...FINGERPRINT_KEYS])
    expect(facts.federal_state.value).toBe('Niederösterreich')
    expect(facts.construction_method.value).toBe('Holzbau/Stahlbeton')
    expect(facts.uses.value).not.toBeNull()
    expect(facts.work_type.value).toBe('Neubau/Zubau')
  })

  it('reads a project of two buildings as both', () => {
    const facts = byKey(
      fingerprintOf(
        built(
          {
            A2_land: 'vienna',
            'C1@bldg1': 'building',
            'C10@bldg1': ['timber'],
            'C1@bldg2': 'building',
            'C10@bldg2': ['masonry_solid'],
          },
          [
            { id: 'bldg1', name: 'Haupthaus' },
            { id: 'bldg2', name: 'Nebengebäude' },
          ]
        )
      )
    )

    expect(facts.construction_method.value).toBe('Holzbau/Mauerwerk / Massivbau')
  })

  it('says the Bauweise does not apply to a structure that is no building, rather than calling it missing', () => {
    const facts = byKey(fingerprintOf(built({ A2_land: 'tyrol', 'C1@bldg1': 'other' })))

    expect(facts.construction_method).toMatchObject({ value: null, applies: false })
    expect(facts.building_class.applies).toBe(false)
    expect(facts.work_type.applies).toBe(true)
  })

  it('keeps a fact open, not inapplicable, while the answer it hangs on is still missing', () => {
    const facts = byKey(fingerprintOf(built({ A2_land: 'vienna' })))

    expect(facts.construction_method).toMatchObject({ value: null, applies: true, editable: true })
  })

  it('knows the wizard derives the building class, so the briefing cannot fill it', () => {
    const facts = byKey(fingerprintOf(built({ A2_land: 'vienna', 'C1@bldg1': 'building' })))

    expect(facts.building_class).toMatchObject({ value: null, applies: true, editable: false })
    expect(facts.construction_method.editable).toBe(true)
  })

  it('reads a class set on the project, as an accepted proposal writes it', () => {
    const profile = built({ A2_land: 'vienna', 'C1@bldg1': 'building' })
    profile.facts.building_class = { value: 'GK4', confidence: 'confirmed', source: 'user_confirmed', updatedAt: '' }

    expect(byKey(fingerprintOf(profile)).building_class.value).toBe('GK 4')
  })

  it('reads „noch offen" as open, and a project without a profile as entirely open', () => {
    expect(byKey(fingerprintOf(built({ 'C1@bldg1': 'building', 'C10@bldg1': ['open'] }))).construction_method.value).toBeNull()
    expect(fingerprintOf(null).every((fact) => fact.value === null && fact.applies)).toBe(true)
    expect(fingerprintLabels(null)).toEqual([])
  })
})

describe('a value only the documents suggest', () => {
  const withSuggestion = () => {
    const profile = built({ A2_country: 'at', A2_land: 'lower_austria' })
    profile.assumptions.building_class = {
      value: 4,
      status: 'unconfirmed',
      reason: 'Baubeschreibung.pdf, S. 2: „Gebäudeklasse 4"',
      source: 'agent_suggested',
      updatedAt: '2026-10-08T00:00:00.000Z',
    }
    return profile
  }

  it('is flagged as suggested, and a confirmed value is not', () => {
    const facts = byKey(fingerprintOf(withSuggestion()))
    expect(facts.building_class).toMatchObject({ value: 'GK 4', suggested: true })
    expect(facts.federal_state).toMatchObject({ value: 'Niederösterreich', suggested: false })
  })

  it('is marked in the one-line summary the agent’s catalog prints', () => {
    expect(fingerprintLabels(withSuggestion())).toEqual(['Niederösterreich', 'GK 4 (aus den Unterlagen, unbestätigt)'])
  })
})

describe('factLabel', () => {
  it('shows a token no option names as it is', () => {
    expect(factLabel('federal_state', 'atlantis')).toBe('atlantis')
  })
})
