/**
 * How alike two projects are (docs/design/cross-project-escalation.md): the
 * Bundesland outweighs everything else (it decides the OIB edition and the
 * Bauordnung), the Gebäudeklasse comes next, a neighbouring class still counts
 * a little, and malformed facts read as unknown rather than throwing.
 */

import { describe, expect, it } from 'vitest'
import type { Project } from '@/lib/db/schema'
import { buildIntakeProfile, projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import { SIMILARITY_WEIGHTS, federalStateOf, rankBySimilarity, sharedTraits, similarity, similarityFacts } from './similarity'

type Profile = Project['profile']

function profile(facts: Record<string, unknown>, assumptions: Profile['assumptions'] = {}): Profile {
  return {
    facts: Object.fromEntries(
      Object.entries(facts).map(([key, value]) => [
        key,
        { value: value as string, confidence: 'confirmed' as const, source: 'onboarding' as const, updatedAt: '' },
      ])
    ),
    goals: {},
    unknowns: [],
    assumptions,
  }
}

/** An unconfirmed assumption as the document extractor (`agent_suggested`) or the onboarding (`onboarding_default`) writes it. */
function assumption(value: unknown, source: 'agent_suggested' | 'onboarding_default' = 'agent_suggested'): Profile['assumptions'][string] {
  return { value: value as string, status: 'unconfirmed', reason: 'Aus den Unterlagen', source, updatedAt: '' }
}

const here = similarityFacts(
  profile({ federal_state: 'lower_austria', building_class: 'GK 4', construction_method: ['timber'], uses: ['residential', 'office'] })
)

describe('similarityFacts', () => {
  it('reads the class from a number or any spelling with a digit, and treats anything else as unknown', () => {
    expect(similarityFacts(profile({ building_class: 4 })).building_class).toEqual([4])
    expect(similarityFacts(profile({ building_class: 'GK4' })).building_class).toEqual([4])
    expect(similarityFacts(profile({ building_class: 'unklar' })).building_class).toEqual([])
    expect(similarityFacts(profile({ federal_state: 42, uses: 'Wohnen' }))).toMatchObject({
      federal_state: null,
      uses: ['residential'],
    })
  })

  it('reads only a building class that exists, 1 to 5, and the class a note names rather than its first digit', () => {
    for (const value of [0, 6, 4.5, -1, '0', '6', 'GK 6', 'GK45']) {
      expect(similarityFacts(profile({ building_class: value })).building_class, String(value)).toEqual([])
    }
    expect(similarityFacts(profile({ building_class: 'Fluchtniveau 8 m → GK4' })).building_class).toEqual([4])
    expect(similarityFacts(profile({ building_class: 'Fluchtniveau 3 m → GK 2' })).building_class).toEqual([2])
    expect(similarityFacts(profile({ building_class: ' 5 ' })).building_class).toEqual([5])
  })

  it('reads what the intake wizard stores: a building’s answers under its instance, every building', () => {
    // The producer, not a hand-written profile: the wizard keys a building's
    // answers `construction_method@bldg1`, and a ranking that read only `construction_method` saw
    // nothing of a real project but its Bundesland and kind of work.
    const facts = similarityFacts(
      buildIntakeProfile(
        {
          A2_country: 'at',
          A2_land: 'lower_austria',
          A5: ['new_build'],
          'C1@bldg1': 'building',
          'C10@bldg1': ['timber'],
          'D0@bldg1': ['residential'],
          'C1@bldg2': 'building',
          'C10@bldg2': ['masonry_solid'],
          'D0@bldg2': ['office'],
        },
        projectIntakeDefinitionV1,
        {
          buildings: [
            { id: 'bldg1', name: 'Haupthaus' },
            { id: 'bldg2', name: 'Nebengebäude' },
          ],
        }
      )
    )

    expect(facts).toMatchObject({
      federal_state: 'lower_austria',
      construction_method: ['timber', 'masonry_solid'],
      uses: ['residential', 'office'],
      work_type: ['new_build'],
    })
  })

  it('reads a Land’s label and its token as one Land, and a site abroad as no Land', () => {
    const at = (federalState: string) => similarityFacts(profile({ federal_state: federalState })).federal_state
    expect(at('Niederösterreich')).toBe('lower_austria')
    expect(at('lower_austria')).toBe('lower_austria')
    expect(at('outside_austria')).toBeNull()
    const abroad = similarityFacts(profile({ federal_state: 'outside_austria' }))
    expect(similarity(abroad, abroad)).toBe(0)
  })

  it('keeps a site abroad’s token for the wire, while the ranking still reads it as no Land', () => {
    const abroad = profile({ federal_state: 'outside_austria' })
    expect(federalStateOf(abroad)).toBe('outside_austria')
    expect(federalStateOf(profile({ federal_state: 'Niederösterreich' }))).toBe('lower_austria')
    expect(federalStateOf(null)).toBeNull()
    const facts = similarityFacts(abroad)
    expect(facts.federal_state).toBeNull()
    expect(similarity(facts, similarityFacts(abroad))).toBe(0)
  })

  it('reads every building’s class, and a use zone’s copy of a fact as no building’s', () => {
    expect(similarityFacts(profile({ 'building_class@bldg2': 'GK 2', 'building_class@bldg1': 4 })).building_class).toEqual([2, 4])
    expect(similarityFacts(profile({ 'uses@bldg1@residential': ['garage'] })).uses).toEqual([])
  })
})

describe('similarity', () => {
  it('matches a project of several buildings on its closest one', () => {
    const mixed = similarityFacts(profile({ 'building_class@bldg1': 2, 'building_class@bldg2': 4 }))
    expect(similarity(mixed, similarityFacts(profile({ building_class: 4 })))).toBe(SIMILARITY_WEIGHTS.buildingClass)
    expect(similarity(mixed, similarityFacts(profile({ building_class: 5 })))).toBe(SIMILARITY_WEIGHTS.buildingClassAdjacent)
  })

  it('weighs the same federal state above any single trait, and below class, construction and uses together', () => {
    const at = (facts: Record<string, unknown>) => similarity(here, similarityFacts(profile(facts)))
    const sameLand = at({ federal_state: 'lower_austria' })
    expect(sameLand).toBeGreaterThan(at({ building_class: 4 }))
    expect(sameLand).toBeGreaterThan(at({ construction_method: ['timber'] }))
    expect(at({ building_class: 4, construction_method: ['timber'], uses: ['residential', 'office'] })).toBeGreaterThan(sameLand)
  })

  it('reads the Bauweise as the multi-select it is: a hybrid shares its timber with a timber building', () => {
    const at = (construction_method: unknown) => similarity(here, similarityFacts(profile({ construction_method })))
    expect(at(['reinforced_concrete', 'timber'])).toBeGreaterThan(0)
    expect(at(['reinforced_concrete'])).toBe(0)
    // „noch offen" says nothing about the building, so two undecided projects share nothing.
    expect(similarity(similarityFacts(profile({ construction_method: ['open'] })), similarityFacts(profile({ construction_method: ['open'] })))).toBe(0)
  })

  it('reads the kind of work as the multi-select the intake stores, and an older single token alike', () => {
    const work = (work_type: unknown) => similarityFacts(profile({ work_type }))
    expect(similarity(work(['new_build', 'extension']), work(['extension']))).toBe(SIMILARITY_WEIGHTS.workType)
    expect(similarity(work(['new_build']), work('new_build'))).toBe(SIMILARITY_WEIGHTS.workType)
    expect(similarity(work(['conversion']), work(['new_build']))).toBe(0)
  })

  it('counts a neighbouring class a little and a distant one not at all', () => {
    const at = (gk: number) => similarity(here, similarityFacts(profile({ building_class: gk })))
    expect(at(4)).toBeGreaterThan(at(5))
    expect(at(5)).toBeGreaterThan(at(2))
    expect(at(2)).toBe(0)
  })

  it('is 0 when either side knows nothing', () => {
    expect(similarity(similarityFacts(profile({})), here)).toBe(0)
    expect(similarity(here, similarityFacts(null as unknown as Profile))).toBe(0)
  })
})

describe('suggestions from the documents', () => {
  it('ranks a project by a suggested building class when no fact says it', () => {
    const suggested = profile({}, { building_class: assumption('4') })

    expect(similarityFacts(suggested).building_class).toEqual([4])
    expect(similarity(here, similarityFacts(suggested))).toBe(SIMILARITY_WEIGHTS.buildingClass)
    const ranked = rankBySimilarity(profile({ building_class: 4 }), [
      { id: 'no-facts', profile: profile({}) },
      { id: 'suggested', profile: suggested },
    ])
    expect(ranked.map((project) => project.id)).toEqual(['suggested', 'no-facts'])
  })

  it('lets a confirmed fact beat a conflicting suggestion, on every key it holds', () => {
    const both = profile({ building_class: 2, federal_state: 'styria' }, { building_class: assumption('4'), federal_state: assumption('lower_austria') })

    expect(similarityFacts(both)).toMatchObject({ federal_state: 'styria', building_class: [2] })
    // The suggestion would have matched `here` on Land and class; the fact matches on neither.
    expect(similarity(here, similarityFacts(both))).toBe(0)
  })

  it('does not let a suggestion overrule a confirmed „offen"', () => {
    expect(similarityFacts(profile({ building_class: 'offen' }, { building_class: assumption('4') })).building_class).toEqual([])
  })

  it('ignores an onboarding default: a wizard guess is no evidence', () => {
    const defaulted = profile(
      {},
      {
        building_class: assumption('4', 'onboarding_default'),
        uses: assumption(['residential'], 'onboarding_default'),
        federal_state: assumption('lower_austria', 'onboarding_default'),
      }
    )

    expect(similarityFacts(defaulted)).toMatchObject({ federal_state: null, building_class: [], uses: [] })
    expect(similarity(here, similarityFacts(defaulted))).toBe(0)
  })

  it('ranks by a suggested Land, but the wire still names only a confirmed one', () => {
    const suggestedLand = profile({}, { federal_state: assumption('lower_austria') })

    expect(similarity(here, similarityFacts(suggestedLand))).toBe(SIMILARITY_WEIGHTS.federalState)
    expect(federalStateOf(suggestedLand)).toBeNull()
  })
})

describe('sharedTraits', () => {
  it('names what the two have in common, for the catalog line', () => {
    const other = similarityFacts(
      profile({ federal_state: 'lower_austria', building_class: 4, construction_method: ['reinforced_concrete'], uses: ['residential'] })
    )
    expect(sharedTraits(here, other)).toEqual([
      { key: 'federal_state', value: 'lower_austria' },
      { key: 'building_class', value: '4' },
      { key: 'uses', value: 'residential' },
    ])
  })

  it('names every fact that scored, the kind of work included', () => {
    const current = similarityFacts(profile({ work_type: ['extension'] }))
    const other = similarityFacts(profile({ work_type: ['new_build', 'extension'] }))

    expect(similarity(current, other)).toBeGreaterThan(0)
    expect(sharedTraits(current, other)).toEqual([{ key: 'work_type', value: 'extension' }])
  })
})

describe('rankBySimilarity', () => {
  it('orders the most alike first and keeps the given order among equals', () => {
    const projects = [
      { id: 'vienna', profile: profile({ federal_state: 'Wien', building_class: 4 }) },
      { id: 'noe-gk2', profile: profile({ federal_state: 'Niederösterreich', building_class: 2 }) },
      { id: 'noe-gk4', profile: profile({ federal_state: 'Niederösterreich', building_class: 4 }) },
      { id: 'none-a', profile: profile({}) },
      { id: 'none-b', profile: profile({}) },
    ]
    const current = profile({ federal_state: 'Niederösterreich', building_class: 4 })

    expect(rankBySimilarity(current, projects).map((project) => project.id)).toEqual([
      'noe-gk4',
      'noe-gk2',
      'vienna',
      'none-a',
      'none-b',
    ])
    expect(rankBySimilarity(null, projects).map((project) => project.id)).toEqual(projects.map((project) => project.id))
  })
})
