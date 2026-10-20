/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import { emptyProjectProfile } from '@/lib/project-profile/patch-engine'
import type { ProjectPrimitiveValue, ProjectProfile } from '@/lib/project-profile/types'
import {
  computeNeeds,
  buildingClassInputsFor,
  openedNeeds,
  questionForKey,
  recordableKey,
  type ComputeNeedsOptions,
} from './needs'
import { needSchema, type Need } from './types'

const at = '2026-10-14T08:00:00.000Z'

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
    profile.assumptions[key] = {
      value,
      status: 'unconfirmed',
      reason: 'Im Einreichplan gelesen',
      source: 'agent_suggested',
      updatedAt: at,
    }
  }
  profile.unknowns.push(...unknowns)
  return profile
}

const active: ComputeNeedsOptions = { mode: 'active', dismissed: [] }

function needs(profile: ProjectProfile, options: Partial<ComputeNeedsOptions> = {}): Need[] {
  return computeNeeds(profile, projectIntakeDefinitionV1, { ...active, ...options })
}

const byKey = (list: Need[]) => new Map(list.map((need) => [need.key, need]))

const building = { 'building_type@bldg1': 'building' }

describe('computeNeeds', () => {
  it('asks an empty project for its A module and its first building', () => {
    const list = needs(emptyProjectProfile())
    const found = byKey(list)
    expect(found.get('project_name')).toMatchObject({
      baseKey: 'project_name',
      bauwerkId: null,
      type: 'text',
      state: 'open',
    })
    expect(found.get('work_type')).toMatchObject({ type: 'multi_select', bauwerkId: null })
    expect(found.get('building_type@bldg1')).toMatchObject({
      baseKey: 'building_type',
      bauwerkId: 'bldg1',
      decisive: true,
    })
    // The building questions wait for C1. The federal state does not wait for the
    // country: Piloti is Austria's, and a document names the Land first.
    expect(found.has('storeys_above_ground@bldg1')).toBe(false)
    expect(found.get('federal_state')).toMatchObject({ type: 'single_select', state: 'open' })
    // Only questions that write a value; every need is one the contract accepts.
    for (const need of list) expect(() => needSchema.parse(need), need.key).not.toThrow()
    expect(
      list.every((need) => !need.options?.some((option) => option.label.startsWith('noch offen')))
    ).toBe(true)
  })

  it('asks for the federal state unless another country was chosen', () => {
    expect(byKey(needs(profileWith({ country: 'at' }))).has('federal_state')).toBe(true)
    expect(byKey(needs(profileWith({}, { country: 'at' }))).has('federal_state')).toBe(true)
    expect(byKey(needs(profileWith({ country: 'de' }))).has('federal_state')).toBe(false)
    expect(byKey(needs(profileWith({ country: 'other' }))).has('federal_state')).toBe(false)
  })

  it('says what a recorded building opened: its building class inputs, decisive', () => {
    const opened = openedNeeds(needs(emptyProjectProfile()), needs(profileWith({}, building)))
    const keys = new Map(opened.map((need) => [need.key, need.decisive]))
    expect(keys.get('storeys_above_ground@bldg1')).toBe(true)
    expect(keys.get('escape_level_m@bldg1')).toBe(true)
    // Listed before, so not opened by it; and nothing opened twice.
    expect(keys.has('building_type@bldg1')).toBe(false)
    expect(new Set(opened.map((need) => need.key)).size).toBe(opened.length)
    expect(opened.findIndex((need) => !need.decisive)).toBeGreaterThan(opened.findLastIndex((need) => need.decisive))
  })

  it('names the documents a value is usually in', () => {
    const found = byKey(needs(profileWith(building)))
    expect(found.get('storeys_above_ground@bldg1')?.foundIn).toContain('Einreichplan (Schnitt)')
    expect(found.get('escape_level_m@bldg1')).toMatchObject({ unit: 'm', type: 'number_tri' })
  })

  it('opens the Nutzungszonen of each use: Wohnungen for Wohnen, the garage area for a garage', () => {
    const wohnen = byKey(needs(profileWith({ ...building, 'uses@bldg1': ['residential'] })))
    expect(wohnen.get('dwelling_units@bldg1@residential')).toMatchObject({
      baseKey: 'dwelling_units',
      bauwerkId: 'bldg1',
      label: 'Anzahl Wohneinheiten (Wohnen)',
    })
    expect(wohnen.has('residential_form@bldg1@residential')).toBe(true)
    expect(wohnen.get('zone_area@bldg1@residential')?.label).toBe('Fläche der Zone (BGF) (Wohnen)')
    expect(wohnen.has('garage_area@bldg1@garage')).toBe(false)

    const withGarage = byKey(
      needs(profileWith({ ...building, 'uses@bldg1': ['residential', 'garage'] }))
    )
    expect(withGarage.get('garage_area@bldg1@garage')).toMatchObject({
      unit: 'm²',
      bauwerkId: 'bldg1',
    })
    expect(withGarage.has('parking_spaces@bldg1@garage')).toBe(true)
    expect(withGarage.has('zone_area@bldg1@garage')).toBe(true)
  })

  it('drops a confirmed key, keeps a suggested one as suggested', () => {
    const found = byKey(
      needs(
        profileWith(
          { ...building, 'storeys_above_ground@bldg1': 3, 'construction_method@bldg1': ['timber'] },
          { 'escape_level_m@bldg1': 6.5 }
        )
      )
    )
    expect(found.has('construction_method@bldg1')).toBe(false)
    expect(found.get('escape_level_m@bldg1')?.state).toBe('suggested')
    expect(found.get('gfa_above_ground@bldg1')?.state).toBe('open')
  })

  it('keeps a confirmed building class input as confirmed, never decisive, after every other need', () => {
    const list = needs(profileWith({ ...building, 'storeys_above_ground@bldg1': 3 }))
    const found = byKey(list)
    expect(found.get('storeys_above_ground@bldg1')).toMatchObject({ state: 'confirmed', decisive: false })
    expect(found.get('building_type@bldg1')).toMatchObject({ state: 'confirmed', decisive: false })
    const confirmed = list.filter((need) => need.state === 'confirmed').map((need) => need.key)
    expect(confirmed).toEqual(['building_type@bldg1', 'storeys_above_ground@bldg1'])
    expect(list.slice(-confirmed.length).map((need) => need.key)).toEqual(confirmed)
    for (const need of list) expect(() => needSchema.parse(need), need.key).not.toThrow()
  })

  it('opens follow-up questions on a suggested answer, as on a confirmed one', () => {
    const found = byKey(
      needs(
        profileWith({}, { 'building_type@bldg1': 'building', 'building_position@bldg1': 'freestanding' })
      )
    )
    expect(found.get('building_type@bldg1')?.state).toBe('suggested')
    expect(found.has('storeys_above_ground@bldg1')).toBe(true)
    expect(found.has('access_three_sides@bldg1')).toBe(true)
  })

  it('leaves out a key a person marked unknown', () => {
    expect(
      byKey(needs(profileWith(building), { unknownKeys: ['escape_level_m@bldg1'] })).has(
        'escape_level_m@bldg1'
      )
    ).toBe(false)
    expect(
      byKey(needs(profileWith(building, {}, ['escape_level_m@bldg1']))).has('escape_level_m@bldg1')
    ).toBe(false)
    // An explicit list replaces the profile's.
    expect(
      byKey(needs(profileWith(building, {}, ['escape_level_m@bldg1']), { unknownKeys: [] })).has(
        'escape_level_m@bldg1'
      )
    ).toBe(true)
  })

  it('does not offer a value a person dismissed, nor „noch offen"', () => {
    const found = byKey(
      needs(profileWith({ ...building, development_plan: true }), {
        dismissed: [{ key: 'building_position@bldg1', value: 'freestanding' }],
      })
    )
    expect(found.get('building_position@bldg1')?.options?.map((option) => option.token)).toEqual([
      'attached',
      'terraced',
    ])
    // B3_weise: `open` is the offene Bebauungsweise, `noch_offen` the deferral.
    expect(found.get('development_pattern')?.options?.map((option) => option.token)).toEqual([
      'open',
      'semi_detached',
      'closed',
    ])
  })

  it('marks what could change the building class, first', () => {
    const list = needs(
      profileWith({
        ...building,
        'storeys_above_ground@bldg1': 2,
        'gfa_above_ground@bldg1': 300,
        'building_position@bldg1': 'attached',
      })
    )
    const decisive = list.filter((need) => need.decisive).map((need) => need.key)
    expect(decisive).toEqual([
      'escape_level_m@bldg1',
      'use_units@bldg1',
      'units_over_400@bldg1',
    ])
    expect(list.slice(0, 3).map((need) => need.key)).toEqual(decisive)
    // Open and read by the derivation, but no value of them changes the class here.
    expect(byKey(list).get('uses@bldg1')?.decisive).toBe(false)
    expect(byKey(list).has('access_three_sides@bldg1')).toBe(false)
  })

  it('weighs a v1.0 answer through the wizard’s bridge (C8’s inverted ne_unter_400)', () => {
    const list = needs(
      profileWith({
        ...building,
        'storeys_above_ground@bldg1': 2,
        'gfa_above_ground@bldg1': 300,
        'building_position@bldg1': 'attached',
        'units_under_400@bldg1': true,
      })
    )
    // No unit above 400 m²: at 7 to 11 m it is GK 4 whatever the count, so only the Fluchtniveau decides.
    expect(list.filter((need) => need.decisive).map((need) => need.key)).toEqual([
      'escape_level_m@bldg1',
    ])
  })

  it('counts a suggestion as known when it weighs what is decisive', () => {
    const list = needs(
      profileWith(
        {
          ...building,
          'storeys_above_ground@bldg1': 2,
          'gfa_above_ground@bldg1': 300,
          'building_position@bldg1': 'attached',
        },
        { 'escape_level_m@bldg1': 6 }
      )
    )
    // FN ≤ 7 with 300 m²: GK 2 whatever the units, so nothing is decisive any more.
    expect(list.filter((need) => need.decisive)).toEqual([])
    expect(byKey(list).get('escape_level_m@bldg1')).toMatchObject({
      state: 'suggested',
      decisive: false,
    })
  })

  it('has nothing decisive for a Hochhaus', () => {
    const list = needs(profileWith({ ...building, 'escape_level_m@bldg1': 25 }))
    expect(list.some((need) => need.key === 'storeys_above_ground@bldg1')).toBe(true)
    expect(list.filter((need) => need.decisive)).toEqual([])
  })

  it('has nothing decisive when closing a project', () => {
    const list = needs(emptyProjectProfile(), { mode: 'closing' })
    expect(list.length).toBeGreaterThan(0)
    expect(list.filter((need) => need.decisive)).toEqual([])
  })

  it('scopes each building’s keys to it', () => {
    const list = needs(
      profileWith({ ...building, 'building_type@bldg2': 'other', 'building_name@bldg2': 'Flugdach' })
    )
    const found = byKey(list)
    expect(found.get('storeys_above_ground@bldg1')).toMatchObject({
      bauwerkId: 'bldg1',
      decisive: true,
    })
    expect(found.has('storeys_above_ground@bldg2')).toBe(false)
    expect(found.get('uses@bldg2')).toMatchObject({
      baseKey: 'uses',
      bauwerkId: 'bldg2',
      decisive: false,
    })
    expect(list.filter((need) => need.bauwerkId === 'bldg2').every((need) => !need.decisive)).toBe(
      true
    )
  })
})

describe('questionForKey', () => {
  const question = (key: string) => questionForKey(projectIntakeDefinitionV1, key)

  it('resolves a key to the question that writes it, in the scope it is asked in', () => {
    expect(question('federal_state')).toMatchObject({ baseKey: 'federal_state', buildingId: null, zone: null, type: 'single_select' })
    expect(question('storeys_above_ground@bldg2')).toMatchObject({ buildingId: 'bldg2', zone: null, type: 'number_tri' })
    expect(question('zone_area@bldg1@garage')).toMatchObject({ buildingId: 'bldg1', zone: 'garage' })
    expect(question('dwelling_units@bldg1@residential')).toMatchObject({ baseKey: 'dwelling_units', zone: 'residential' })
  })

  it('knows no key outside the questions or the scope they are asked in', () => {
    for (const key of [
      'nicht_im_assistenten',
      'building_class@bldg1',
      'building_name@bldg1',
      'federal_state@bldg1',
      'storeys_above_ground',
      'storeys_above_ground@bldg1@residential',
      'storeys_above_ground@haus',
      'dwelling_units@bldg1@office',
      'zone_area@bldg1@keine_nutzung',
      'dwelling_units@bldg1',
    ]) {
      expect(question(key), key).toBeNull()
    }
  })

  it('writes each key from one question only, so a key has one question', () => {
    const keys = projectIntakeDefinitionV1.stages.flatMap((stage) =>
      [...stage.questions, ...(stage.zoneCommon ?? []), ...Object.values(stage.zoneDefinitions ?? {}).flatMap((zone) => zone.questions)]
        .map((entry) => /^\/(?:facts|goals)\/([^/]+)/.exec(entry.writesTo ?? '')?.[1])
        .filter((key): key is string => Boolean(key))
    )
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('recordableKey', () => {
  it('takes a building the profile describes and no other', () => {
    expect(recordableKey(projectIntakeDefinitionV1, 'storeys_above_ground@bldg1', ['bldg1'])).not.toBeNull()
    expect(recordableKey(projectIntakeDefinitionV1, 'storeys_above_ground@bldg2', ['bldg1'])).toBeNull()
    expect(recordableKey(projectIntakeDefinitionV1, 'federal_state', [])).not.toBeNull()
  })
})

describe('gebaeudeklasseInputsFor', () => {
  it('reads one building’s inputs, facts over suggestions, every input a key', () => {
    const profile = profileWith(
      { ...building, 'storeys_above_ground@bldg1': 3 },
      { 'storeys_above_ground@bldg1': 9, 'escape_level_m@bldg1': 6.5 }
    )
    const inputs = buildingClassInputsFor(profile, projectIntakeDefinitionV1, 'bldg1')
    expect(inputs).toMatchObject({ building_type: 'building', storeys_above_ground: 3, escape_level_m: 6.5 })
    expect('gfa_above_ground' in inputs && inputs.bgf_oberirdisch === undefined).toBe(true)
  })
})
