/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import { emptyProjectProfile } from '@/lib/project-profile/patch-engine'
import type { ProjectPrimitiveValue, ProjectProfile } from '@/lib/project-profile/types'
import {
  computeNeeds,
  gebaeudeklasseInputsFor,
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

const gebaeude = { 'bauwerkstyp@bw1': 'gebaeude' }

describe('computeNeeds', () => {
  it('asks an empty project for its A module and its first Bauwerk', () => {
    const list = needs(emptyProjectProfile())
    const found = byKey(list)
    expect(found.get('project_name')).toMatchObject({
      baseKey: 'project_name',
      bauwerkId: null,
      type: 'text',
      state: 'open',
    })
    expect(found.get('vorhabensart')).toMatchObject({ type: 'multi_select', bauwerkId: null })
    expect(found.get('bauwerkstyp@bw1')).toMatchObject({
      baseKey: 'bauwerkstyp',
      bauwerkId: 'bw1',
      decisive: true,
    })
    // The Gebäude questions wait for C1. The Bundesland does not wait for the
    // country: Piloti is Austria's, and a document names the Land first.
    expect(found.has('geschosse_oberirdisch@bw1')).toBe(false)
    expect(found.get('bundesland')).toMatchObject({ type: 'single_select', state: 'open' })
    // Only questions that write a value; every need is one the contract accepts.
    for (const need of list) expect(() => needSchema.parse(need), need.key).not.toThrow()
    expect(
      list.every((need) => !need.options?.some((option) => option.label.startsWith('noch offen')))
    ).toBe(true)
  })

  it('asks for the Bundesland unless another country was chosen', () => {
    expect(byKey(needs(profileWith({ country: 'at' }))).has('bundesland')).toBe(true)
    expect(byKey(needs(profileWith({}, { country: 'at' }))).has('bundesland')).toBe(true)
    expect(byKey(needs(profileWith({ country: 'de' }))).has('bundesland')).toBe(false)
    expect(byKey(needs(profileWith({ country: 'other' }))).has('bundesland')).toBe(false)
  })

  it('names the documents a value is usually in', () => {
    const found = byKey(needs(profileWith(gebaeude)))
    expect(found.get('geschosse_oberirdisch@bw1')?.foundIn).toContain('Einreichplan (Schnitt)')
    expect(found.get('fluchtniveau_m@bw1')).toMatchObject({ unit: 'm', type: 'number_tri' })
  })

  it('opens the Nutzungszonen of each use: Wohnungen for Wohnen, the garage area for a garage', () => {
    const wohnen = byKey(needs(profileWith({ ...gebaeude, 'nutzungen@bw1': ['wohnen'] })))
    expect(wohnen.get('wohneinheiten@bw1@wohnen')).toMatchObject({
      baseKey: 'wohneinheiten',
      bauwerkId: 'bw1',
      label: 'Anzahl Wohneinheiten (Wohnen)',
    })
    expect(wohnen.has('wohnform@bw1@wohnen')).toBe(true)
    expect(wohnen.get('zone_flaeche@bw1@wohnen')?.label).toBe('Fläche der Zone (BGF) (Wohnen)')
    expect(wohnen.has('garagenflaeche@bw1@garage')).toBe(false)

    const mitGarage = byKey(
      needs(profileWith({ ...gebaeude, 'nutzungen@bw1': ['wohnen', 'garage'] }))
    )
    expect(mitGarage.get('garagenflaeche@bw1@garage')).toMatchObject({
      unit: 'm²',
      bauwerkId: 'bw1',
    })
    expect(mitGarage.has('stellplaetze@bw1@garage')).toBe(true)
    expect(mitGarage.has('zone_flaeche@bw1@garage')).toBe(true)
  })

  it('drops a confirmed key, keeps a suggested one as suggested', () => {
    const found = byKey(
      needs(
        profileWith(
          { ...gebaeude, 'geschosse_oberirdisch@bw1': 3, 'bauweise@bw1': ['holzbau'] },
          { 'fluchtniveau_m@bw1': 6.5 }
        )
      )
    )
    expect(found.has('bauweise@bw1')).toBe(false)
    expect(found.get('fluchtniveau_m@bw1')?.state).toBe('suggested')
    expect(found.get('bgf_oberirdisch@bw1')?.state).toBe('open')
  })

  it('keeps a confirmed Gebäudeklasse input as confirmed, never decisive, after every other need', () => {
    const list = needs(profileWith({ ...gebaeude, 'geschosse_oberirdisch@bw1': 3 }))
    const found = byKey(list)
    expect(found.get('geschosse_oberirdisch@bw1')).toMatchObject({ state: 'confirmed', decisive: false })
    expect(found.get('bauwerkstyp@bw1')).toMatchObject({ state: 'confirmed', decisive: false })
    const confirmed = list.filter((need) => need.state === 'confirmed').map((need) => need.key)
    expect(confirmed).toEqual(['bauwerkstyp@bw1', 'geschosse_oberirdisch@bw1'])
    expect(list.slice(-confirmed.length).map((need) => need.key)).toEqual(confirmed)
    for (const need of list) expect(() => needSchema.parse(need), need.key).not.toThrow()
  })

  it('opens follow-up questions on a suggested answer, as on a confirmed one', () => {
    const found = byKey(
      needs(
        profileWith({}, { 'bauwerkstyp@bw1': 'gebaeude', 'gebaeudestellung@bw1': 'freistehend' })
      )
    )
    expect(found.get('bauwerkstyp@bw1')?.state).toBe('suggested')
    expect(found.has('geschosse_oberirdisch@bw1')).toBe(true)
    expect(found.has('zugang_drei_seiten@bw1')).toBe(true)
  })

  it('leaves out a key a person marked unknown', () => {
    expect(
      byKey(needs(profileWith(gebaeude), { unknownKeys: ['fluchtniveau_m@bw1'] })).has(
        'fluchtniveau_m@bw1'
      )
    ).toBe(false)
    expect(
      byKey(needs(profileWith(gebaeude, {}, ['fluchtniveau_m@bw1']))).has('fluchtniveau_m@bw1')
    ).toBe(false)
    // An explicit list replaces the profile's.
    expect(
      byKey(needs(profileWith(gebaeude, {}, ['fluchtniveau_m@bw1']), { unknownKeys: [] })).has(
        'fluchtniveau_m@bw1'
      )
    ).toBe(true)
  })

  it('does not offer a value a person dismissed, nor „noch offen"', () => {
    const found = byKey(
      needs(profileWith({ ...gebaeude, bebauungsplan: true }), {
        dismissed: [{ key: 'gebaeudestellung@bw1', value: 'freistehend' }],
      })
    )
    expect(found.get('gebaeudestellung@bw1')?.options?.map((option) => option.token)).toEqual([
      'angebaut',
      'reihenhaus',
    ])
    // B3_weise: `offen` is the offene Bebauungsweise, `noch_offen` the deferral.
    expect(found.get('bebauungsweise')?.options?.map((option) => option.token)).toEqual([
      'offen',
      'gekuppelt',
      'geschlossen',
    ])
  })

  it('marks what could change the Gebäudeklasse, first', () => {
    const list = needs(
      profileWith({
        ...gebaeude,
        'geschosse_oberirdisch@bw1': 2,
        'bgf_oberirdisch@bw1': 300,
        'gebaeudestellung@bw1': 'angebaut',
      })
    )
    const decisive = list.filter((need) => need.decisive).map((need) => need.key)
    expect(decisive).toEqual([
      'fluchtniveau_m@bw1',
      'nutzungseinheiten@bw1',
      'einheiten_ueber_400@bw1',
    ])
    expect(list.slice(0, 3).map((need) => need.key)).toEqual(decisive)
    // Open and read by the derivation, but no value of them changes the class here.
    expect(byKey(list).get('nutzungen@bw1')?.decisive).toBe(false)
    expect(byKey(list).has('zugang_drei_seiten@bw1')).toBe(false)
  })

  it('weighs a v1.0 answer through the wizard’s bridge (C8’s inverted ne_unter_400)', () => {
    const list = needs(
      profileWith({
        ...gebaeude,
        'geschosse_oberirdisch@bw1': 2,
        'bgf_oberirdisch@bw1': 300,
        'gebaeudestellung@bw1': 'angebaut',
        'ne_unter_400@bw1': true,
      })
    )
    // No unit above 400 m²: at 7 to 11 m it is GK 4 whatever the count, so only the Fluchtniveau decides.
    expect(list.filter((need) => need.decisive).map((need) => need.key)).toEqual([
      'fluchtniveau_m@bw1',
    ])
  })

  it('counts a suggestion as known when it weighs what is decisive', () => {
    const list = needs(
      profileWith(
        {
          ...gebaeude,
          'geschosse_oberirdisch@bw1': 2,
          'bgf_oberirdisch@bw1': 300,
          'gebaeudestellung@bw1': 'angebaut',
        },
        { 'fluchtniveau_m@bw1': 6 }
      )
    )
    // FN ≤ 7 with 300 m²: GK 2 whatever the units, so nothing is decisive any more.
    expect(list.filter((need) => need.decisive)).toEqual([])
    expect(byKey(list).get('fluchtniveau_m@bw1')).toMatchObject({
      state: 'suggested',
      decisive: false,
    })
  })

  it('has nothing decisive for a Hochhaus', () => {
    const list = needs(profileWith({ ...gebaeude, 'fluchtniveau_m@bw1': 25 }))
    expect(list.some((need) => need.key === 'geschosse_oberirdisch@bw1')).toBe(true)
    expect(list.filter((need) => need.decisive)).toEqual([])
  })

  it('has nothing decisive when closing a project', () => {
    const list = needs(emptyProjectProfile(), { mode: 'closing' })
    expect(list.length).toBeGreaterThan(0)
    expect(list.filter((need) => need.decisive)).toEqual([])
  })

  it('scopes each Bauwerk’s keys to it', () => {
    const list = needs(
      profileWith({ ...gebaeude, 'bauwerkstyp@bw2': 'sonstig', 'bauwerk_name@bw2': 'Flugdach' })
    )
    const found = byKey(list)
    expect(found.get('geschosse_oberirdisch@bw1')).toMatchObject({
      bauwerkId: 'bw1',
      decisive: true,
    })
    expect(found.has('geschosse_oberirdisch@bw2')).toBe(false)
    expect(found.get('nutzungen@bw2')).toMatchObject({
      baseKey: 'nutzungen',
      bauwerkId: 'bw2',
      decisive: false,
    })
    expect(list.filter((need) => need.bauwerkId === 'bw2').every((need) => !need.decisive)).toBe(
      true
    )
  })
})

describe('questionForKey', () => {
  const question = (key: string) => questionForKey(projectIntakeDefinitionV1, key)

  it('resolves a key to the question that writes it, in the scope it is asked in', () => {
    expect(question('bundesland')).toMatchObject({ baseKey: 'bundesland', bauwerkId: null, zone: null, type: 'single_select' })
    expect(question('geschosse_oberirdisch@bw2')).toMatchObject({ bauwerkId: 'bw2', zone: null, type: 'number_tri' })
    expect(question('zone_flaeche@bw1@garage')).toMatchObject({ bauwerkId: 'bw1', zone: 'garage' })
    expect(question('wohneinheiten@bw1@wohnen')).toMatchObject({ baseKey: 'wohneinheiten', zone: 'wohnen' })
  })

  it('knows no key outside the questions or the scope they are asked in', () => {
    for (const key of [
      'nicht_im_assistenten',
      'gebaeudeklasse@bw1',
      'bauwerk_name@bw1',
      'bundesland@bw1',
      'geschosse_oberirdisch',
      'geschosse_oberirdisch@bw1@wohnen',
      'geschosse_oberirdisch@haus',
      'wohneinheiten@bw1@buero',
      'zone_flaeche@bw1@keine_nutzung',
      'wohneinheiten@bw1',
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
  it('takes a Bauwerk the profile describes and no other', () => {
    expect(recordableKey(projectIntakeDefinitionV1, 'geschosse_oberirdisch@bw1', ['bw1'])).not.toBeNull()
    expect(recordableKey(projectIntakeDefinitionV1, 'geschosse_oberirdisch@bw2', ['bw1'])).toBeNull()
    expect(recordableKey(projectIntakeDefinitionV1, 'bundesland', [])).not.toBeNull()
  })
})

describe('gebaeudeklasseInputsFor', () => {
  it('reads one Bauwerk’s inputs, facts over suggestions, every input a key', () => {
    const profile = profileWith(
      { ...gebaeude, 'geschosse_oberirdisch@bw1': 3 },
      { 'geschosse_oberirdisch@bw1': 9, 'fluchtniveau_m@bw1': 6.5 }
    )
    const inputs = gebaeudeklasseInputsFor(profile, projectIntakeDefinitionV1, 'bw1')
    expect(inputs).toMatchObject({ bauwerkstyp: 'gebaeude', geschosse_oberirdisch: 3, fluchtniveau_m: 6.5 })
    expect('bgf_oberirdisch' in inputs && inputs.bgf_oberirdisch === undefined).toBe(true)
  })
})
