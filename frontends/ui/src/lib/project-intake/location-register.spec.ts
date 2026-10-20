/**
 * @vitest-environment node
 *
 * The location register: from Bundesland, Gemeinde, Vorhaben and mode, which
 * documents step 4 asks for, why, and when a request is settled. Read with the
 * real intake definition, so the register's keys are the wizard's.
 */
import { describe, expect, it } from 'vitest'
import { projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import { emptyProjectProfile } from '@/lib/project-profile/patch-engine'
import type { ProjectPrimitiveValue, ProjectProfile } from '@/lib/project-profile/types'
import { LOCATION_REGISTER, locationRegisterFor, type LocationRegisterInput } from './location-register'
import { computeNeeds } from './needs'
import { flattenIntakeQuestions } from '@/lib/project-profile/intake-definition'
import { BUNDESLAND_TOKENS } from '@/lib/project-profile/intake-definition'
import { locationRegisterViewSchema, type IntakeMode } from './types'

const at = '2026-10-20T08:00:00.000Z'

function profileWith(
  facts: Record<string, ProjectPrimitiveValue>,
  suggestions: Record<string, ProjectPrimitiveValue> = {},
  unknowns: string[] = []
): ProjectProfile {
  const profile = emptyProjectProfile()
  for (const [key, value] of Object.entries(facts)) {
    profile.facts[key] = { value, confidence: 'confirmed', source: 'onboarding', updatedAt: at }
  }
  for (const [key, value] of Object.entries(suggestions)) {
    profile.assumptions[key] = { value, status: 'unconfirmed', reason: 'gelesen', source: 'agent_suggested', updatedAt: at }
  }
  profile.unknowns.push(...unknowns)
  return profile
}

function register(
  profile: ProjectProfile,
  options: { mode?: IntakeMode; location?: LocationRegisterInput['location'] } = {}
) {
  const mode = options.mode ?? 'active'
  const needs = computeNeeds(profile, projectIntakeDefinitionV1, { mode, dismissed: [] })
  const view = locationRegisterFor({ profile, location: options.location ?? null, mode, needs })
  // Every answer is what the wire carries.
  expect(locationRegisterViewSchema.parse(view)).toEqual(view)
  return view
}

const determinants = (view: ReturnType<typeof register>) => view.documentRequests.map((request) => request.determinant)
const request = (view: ReturnType<typeof register>, determinant: string) =>
  view.documentRequests.find((entry) => entry.determinant === determinant)

const AT_NEUBAU = { country: 'at', vorhabensart: ['neubau'] }

describe('the register as data', () => {
  it('settles only keys a wizard question writes', () => {
    const written = new Set(
      flattenIntakeQuestions(projectIntakeDefinitionV1).map((question) => /^\/facts\/([^/]+)/.exec(question.writesTo ?? '')?.[1])
    )
    for (const entry of LOCATION_REGISTER) for (const key of entry.keys) expect(written).toContain(key)
  })

  it('cites a source for every entry and every Bundesland variant, and names only real Bundesländer', () => {
    for (const entry of LOCATION_REGISTER) {
      expect(entry.sources.length).toBeGreaterThan(0)
      for (const [land, variant] of Object.entries(entry.byBundesland ?? {})) {
        expect(BUNDESLAND_TOKENS).toContain(land)
        expect(variant?.sources.length).toBeGreaterThan(0)
      }
      for (const local of entry.byGemeinde ?? []) expect(local.sources.length).toBeGreaterThan(0)
    }
  })

  it('has a Widmung source for each of the nine Bundesländer', () => {
    const widmung = LOCATION_REGISTER.find((entry) => entry.determinant === 'widmung')
    expect(Object.keys(widmung?.byBundesland ?? {}).sort()).toEqual(
      BUNDESLAND_TOKENS.filter((token) => token !== 'ausserhalb_oesterreichs').sort()
    )
  })
})

describe('locationRegisterFor', () => {
  it('asks for the Bundesland and the Vorhaben when a typed address left them open', () => {
    const view = register(profileWith({ standort_adresse: 'Hauptplatz 1, Irgendwo' }))
    expect(view.bundesland).toBeNull()
    expect(view.questions.map((need) => need.key)).toEqual(['bundesland', 'vorhabensart'])
    // Without a Bundesland the register still asks, in the words that hold everywhere.
    expect(request(view, 'widmung')).toMatchObject({ document: 'Auszug aus Flächenwidmungs- und Bebauungsplan' })
  })

  it('takes the Bundesland from the geocoder when the profile has none', () => {
    const view = register(profileWith({ country: 'at' }), { location: { bundesland: 'wien', gemeinde: 'Wien' } })
    expect(view).toMatchObject({ bundesland: 'wien', gemeinde: 'Wien' })
  })

  it('does not ask for a Bundesland a reading already suggested', () => {
    const view = register(profileWith(AT_NEUBAU, { bundesland: 'tirol' }))
    expect(view.bundesland).toBe('tirol')
    expect(view.questions).toEqual([])
  })

  it('asks Wien for its Plandokument, with the Bauordnung as source', () => {
    const view = register(profileWith({ ...AT_NEUBAU, bundesland: 'wien' }))
    expect(view.gemeinde).toBe('Wien')
    const widmung = request(view, 'widmung')
    expect(widmung?.document).toBe('Plandokument (Flächenwidmungs- und Bebauungsplan)')
    expect(widmung?.reason).toContain('Plandokument')
    expect(widmung?.sources[0]?.title).toBe('Bauordnung für Wien (BO für Wien)')
    expect(widmung?.keys).toEqual(['flaechenwidmung', 'bebauungsplan'])
  })

  it('cites the Land’s Raumordnungsgesetz outside Wien, and adds the Altstadt law in Graz', () => {
    const steiermark = register(profileWith({ ...AT_NEUBAU, bundesland: 'steiermark' }), {
      location: { bundesland: 'steiermark', gemeinde: 'Leoben' },
    })
    expect(request(steiermark, 'widmung')?.sources.map((source) => source.title)).toEqual([
      'Steiermärkisches Raumordnungsgesetz 2010 (StROG)',
    ])
    const graz = register(profileWith({ ...AT_NEUBAU, bundesland: 'steiermark' }), {
      location: { bundesland: 'steiermark', gemeinde: 'Graz' },
    })
    expect(request(graz, 'widmung')?.reason).toContain('Grazer Altstadterhaltungsgesetz')
    expect(request(graz, 'widmung')?.sources.map((source) => source.title)).toContain(
      'Grazer Altstadterhaltungsgesetz 2008 (GAEG 2008)'
    )
  })

  it('asks a Neubau for the Grundbuch, Widmung, Gefahrenzonen and, until the Nutzungen are known, Lärm', () => {
    const view = register(profileWith({ ...AT_NEUBAU, bundesland: 'tirol' }))
    expect(determinants(view)).toEqual(['grundstueck', 'widmung', 'standortrisiken', 'laerm'])
    expect(request(view, 'grundstueck')).toMatchObject({
      document: 'Grundbuchauszug',
      keys: ['grundstueck_ez', 'grundstuecksflaeche'],
      satisfied: false,
    })
    expect(request(view, 'grundstueck')?.needs.map((need) => need.key)).toEqual(['grundstueck_ez', 'grundstuecksflaeche'])
  })

  it('leaves Lärm out for a use the outside noise does not concern', () => {
    const view = register(profileWith({ ...AT_NEUBAU, bundesland: 'tirol', 'bauwerkstyp@bw1': 'gebaeude', 'nutzungen@bw1': ['garage'] }))
    expect(determinants(view)).not.toContain('laerm')
  })

  it('asks a Sanierung of a Bestand about Denkmalschutz per Bauwerk, not about Widmung or Gefahrenzonen', () => {
    const view = register(
      profileWith({
        country: 'at',
        bundesland: 'salzburg',
        vorhabensart: ['sanierung'],
        'bauwerkstyp@bw1': 'gebaeude',
        'errichtungsstatus@bw1': 'bestand',
        'nutzungen@bw1': ['wohnen'],
      })
    )
    expect(determinants(view)).toEqual(['grundstueck', 'denkmalschutz', 'laerm'])
    expect(request(view, 'denkmalschutz')).toMatchObject({ keys: ['denkmalschutz@bw1'], satisfied: false })
    expect(request(view, 'denkmalschutz')?.needs.map((need) => need.key)).toEqual(['denkmalschutz@bw1'])
  })

  it('asks no Denkmalschutz of a Neubau', () => {
    const view = register(profileWith({ ...AT_NEUBAU, bundesland: 'wien', 'errichtungsstatus@bw1': 'neubau' }))
    expect(determinants(view)).not.toContain('denkmalschutz')
  })

  it('settles a request when each key holds a value, a suggestion or „nicht bekannt"', () => {
    const view = register(
      profileWith(
        { ...AT_NEUBAU, bundesland: 'wien', flaechenwidmung: 'wohngebiet', grundstueck_ez: 'EZ 1234, KG Hernals' },
        { bebauungsplan: 'ja', gefahrenzonen: ['keine'] },
        ['grundstuecksflaeche']
      )
    )
    expect(request(view, 'grundstueck')).toMatchObject({ satisfied: true, needs: [] })
    expect(request(view, 'widmung')?.satisfied).toBe(true)
    expect(request(view, 'standortrisiken')?.satisfied).toBe(true)
    expect(request(view, 'laerm')?.satisfied).toBe(false)
  })

  it('asks a past project only for its Bundesland, and for no document', () => {
    const open = register(profileWith({}), { mode: 'closing' })
    expect(open.questions.map((need) => need.key)).toEqual(['bundesland'])
    expect(open.documentRequests).toEqual([])
  })

  it('has nothing to say about a project outside Austria', () => {
    expect(register(profileWith({ country: 'de', vorhabensart: ['neubau'] }))).toEqual({
      bundesland: null,
      gemeinde: null,
      questions: [],
      documentRequests: [],
    })
    expect(register(profileWith({ bundesland: 'ausserhalb_oesterreichs' })).documentRequests).toEqual([])
  })
})
