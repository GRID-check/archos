/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { flattenIntakeQuestions } from '@/lib/project-profile/intake-conditions'
import { projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import type { ProjectPrimitiveValue } from '@/lib/project-profile/types'
import {
  decisiveInputs,
  deriveBuildingClass,
  BUILDING_CLASS_DERIVATION,
  BUILDING_CLASS_INPUTS,
  type BuildingClassResult,
  possibleBuildingClasses,
} from './derivations'

type Inputs = Record<string, ProjectPrimitiveValue | undefined>

const building = (inputs: Inputs): Inputs => ({ building_type: 'building', ...inputs })

const singleFamilyHouse: Inputs = building({
  building_position: 'freestanding',
  access_three_sides: true,
  storeys_above_ground: 2,
  escape_level_m: 3.2,
  gfa_above_ground: 180,
  use_units: 1,
  uses: ['residential'],
})

const multiFamilyHouse: Inputs = building({
  building_position: 'freestanding',
  access_three_sides: true,
  storeys_above_ground: 3,
  escape_level_m: 6.5,
  gfa_above_ground: 900,
  use_units: 6,
  units_over_400: false,
  uses: ['residential'],
})

const known = (value: BuildingClassResult['value']) => ({
  value,
  hochhaus: false,
  applicable: true,
  missing: [],
})

describe('deriveGebaeudeklasse', () => {
  it.each<[string, Inputs, BuildingClassResult]>([
    // Every GK 1 condition holds; the units >400 and the uses do not matter once it is GK 1.
    ['an EFH, freistehend and reachable from three sides, is GK 1', singleFamilyHouse, known(1)],
    // No longer GK 1 (no three-side access), but 180 m² ≤ 400 m² makes it GK 2 by the first branch.
    [
      'the same EFH without three-side access is GK 2',
      { ...singleFamilyHouse, access_three_sides: 'no' },
      known(2),
    ],
    // Angebaut excludes GK 1; 300 m² ≤ 400 m² gives GK 2.
    [
      'a Doppelhaus half, angebaut, 2 oG, 300 m², is GK 2',
      building({
        building_position: 'attached',
        storeys_above_ground: 2,
        escape_level_m: 6,
        gfa_above_ground: 300,
        use_units: 1,
      }),
      known(2),
    ],
    // 900 m² is past both area branches; the Reihenhaus branch holds because no unit exceeds 400 m².
    [
      'a Reihenhaus of three units of at most 400 m², 900 m² in all, is GK 2',
      building({
        building_position: 'terraced',
        storeys_above_ground: 2,
        escape_level_m: 6,
        gfa_above_ground: 900,
        use_units: 3,
        units_over_400: false,
      }),
      known(2),
    ],
    // Low (3 oG, 6.5 m) but 900 m² > 800 m² for the residential branch, and not a Reihenhaus: GK 3.
    ['an MFH of 3 oG, FN 6.5 m, 900 m², six units, is GK 3', multiFamilyHouse, known(3)],
    // 4 oG is past GK 1–3; FN 10 ≤ 11 and no unit above 400 m²: GK 4 a).
    [
      'four storeys, FN 10 m, 1600 m², twelve units none above 400 m², is GK 4',
      {
        ...multiFamilyHouse,
        storeys_above_ground: 4,
        escape_level_m: 10,
        gfa_above_ground: 1600,
        use_units: 12,
      },
      known(4),
    ],
    // Several units and one above 400 m²: neither GK 4 a) nor b), so GK 5.
    [
      'four storeys, FN 10 m, one of three units above 400 m², is GK 5',
      {
        ...multiFamilyHouse,
        storeys_above_ground: 4,
        escape_level_m: 10,
        gfa_above_ground: 1600,
        use_units: 3,
        units_over_400: true,
      },
      known(5),
    ],
    // 6 oG rules out GK 1–4 whatever else holds, and FN 18 ≤ 22: GK 5 with nothing else known.
    [
      'six storeys at FN 18 m is GK 5, and nothing else matters',
      building({ storeys_above_ground: 6, escape_level_m: 18 }),
      known(5),
    ],
    // Above 22 m there is no class at all.
    [
      'FN 25 m is a Hochhaus',
      building({ escape_level_m: 25 }),
      { value: null, hochhaus: true, applicable: true, missing: [] },
    ],
    // One Betriebseinheit of 2000 m²: GK 4 b) has no area limit.
    [
      'an office of one unit, 4 oG, FN 10.5 m, 2000 m², is GK 4',
      building({
        building_position: 'freestanding',
        access_three_sides: true,
        storeys_above_ground: 4,
        escape_level_m: 10.5,
        gfa_above_ground: 2000,
        use_units: 1,
        uses: ['office'],
      }),
      known(4),
    ],
    // FN ≤ 7 gives GK 2; FN in (7, 11] gives GK 4 or GK 5 depending on the units; above 22 m a Hochhaus.
    [
      'without the Fluchtniveau, an angebaut 2-storey 300 m² building is open, and the units matter too',
      building({ building_position: 'attached', storeys_above_ground: 2, gfa_above_ground: 300 }),
      {
        value: null,
        hochhaus: false,
        applicable: true,
        missing: ['escape_level_m', 'use_units', 'units_over_400'],
      },
    ],
    // With the units known not to exceed 400 m², only the Fluchtniveau is left to decide.
    [
      'and with the units known, only the Fluchtniveau is missing',
      building({
        building_position: 'attached',
        storeys_above_ground: 2,
        gfa_above_ground: 300,
        use_units: 2,
        units_over_400: false,
      }),
      { value: null, hochhaus: false, applicable: true, missing: ['escape_level_m'] },
    ],
    [
      'a Kleinstgebäude is not classified',
      { building_type: 'small', escape_level_m: 3 },
      { value: null, hochhaus: false, applicable: false, missing: [] },
    ],
    [
      'nothing known: the Bauwerkstyp is the first thing that matters',
      {},
      { value: null, hochhaus: false, applicable: true, missing: [...BUILDING_CLASS_INPUTS] },
    ],
  ])('%s', (_name, inputs, expected) => {
    expect(deriveBuildingClass(inputs)).toEqual(expected)
  })

  it('reads the values as the wizard and the profile store them', () => {
    expect(
      deriveBuildingClass({
        ...singleFamilyHouse,
        access_three_sides: 'yes',
        storeys_above_ground: '2',
        escape_level_m: '3.2',
      }).value
    ).toBe(1)
    // `offen` is no answer: GK 1 or GK 2 is then open on the access alone.
    expect(deriveBuildingClass({ ...singleFamilyHouse, access_three_sides: 'open' })).toEqual({
      value: null,
      hochhaus: false,
      applicable: true,
      missing: ['access_three_sides'],
    })
  })

  it('needs the Bauwerkstyp before it names a class', () => {
    expect(deriveBuildingClass({ ...singleFamilyHouse, building_type: undefined })).toEqual({
      value: null,
      hochhaus: false,
      applicable: true,
      missing: ['building_type'],
    })
  })
})

describe('boundaries', () => {
  const low = (escape_level_m: number, extra: Inputs = {}) =>
    deriveBuildingClass({ ...multiFamilyHouse, gfa_above_ground: 300, escape_level_m, ...extra }).value

  it('holds „höchstens" at exactly 7, 11 and 22 m', () => {
    expect(low(7)).toBe(2) // 6 units: not GK 1; 300 m² ≤ 400 m²: GK 2
    expect(low(7.01)).toBe(4) // 3 oG, ≤ 11 m, no unit above 400 m²
    expect(low(11)).toBe(4)
    expect(low(11.01)).toBe(5)
    expect(low(22)).toBe(5)
    expect(deriveBuildingClass({ ...multiFamilyHouse, escape_level_m: 22.01 })).toMatchObject({
      value: null,
      hochhaus: true,
    })
  })

  it('holds „höchstens" at exactly 400 and 800 m²', () => {
    const area = (gfa_above_ground: number, extra: Inputs = {}) =>
      deriveBuildingClass({ ...singleFamilyHouse, gfa_above_ground, ...extra }).value
    expect(area(400)).toBe(1)
    expect(area(400.5)).toBe(2) // freistehend, three sides, rein Wohnen, ≤ 800 m²
    expect(area(800)).toBe(2)
    expect(area(800.5)).toBe(3)
    // A garage in the house is no reines Wohngebäude: the 800 m² branch closes.
    expect(area(600, { uses: ['residential', 'garage'] })).toBe(3)
  })

  it('holds „höchstens" at exactly 3 and 4 oberirdische Geschoße', () => {
    const storeys = (storeys_above_ground: number) =>
      deriveBuildingClass({ ...singleFamilyHouse, escape_level_m: 6, storeys_above_ground }).value
    expect(storeys(3)).toBe(1)
    expect(storeys(4)).toBe(4) // one unit: GK 4 b)
    expect(storeys(5)).toBe(5)
  })

  it('counts the building with two units as GK 1 and with three as no longer', () => {
    expect(deriveBuildingClass({ ...singleFamilyHouse, use_units: 2 }).value).toBe(1)
    expect(deriveBuildingClass({ ...singleFamilyHouse, use_units: 3 }).value).toBe(2)
  })
})

describe('possibleGebaeudeklassen', () => {
  it('lists what the building can still turn out to be', () => {
    const open = building({
      building_position: 'attached',
      storeys_above_ground: 2,
      gfa_above_ground: 300,
    })
    expect(possibleBuildingClasses(open)).toEqual(new Set([2, 4, 5, 'hochhaus']))
    expect(
      possibleBuildingClasses({ ...open, use_units: 2, units_over_400: false })
    ).toEqual(new Set([2, 4, 5, 'hochhaus']))
    expect(possibleBuildingClasses(singleFamilyHouse)).toEqual(new Set([1]))
    expect(possibleBuildingClasses({ building_type: 'other' })).toEqual(new Set())
  })
})

describe('decisiveInputs', () => {
  it('names an open input only when one of its bands can flip the outcome', () => {
    expect(decisiveInputs(building({ storeys_above_ground: 6, escape_level_m: 18 }))).toEqual([])
    expect(decisiveInputs(building({ escape_level_m: 25 }))).toEqual([])
    // Angebaut: the three-side access and the uses only matter for a freistehend building.
    expect(
      decisiveInputs(
        building({ building_position: 'attached', storeys_above_ground: 2, gfa_above_ground: 300 })
      )
    ).toEqual(['escape_level_m', 'use_units', 'units_over_400'])
  })

  it('names at least one input whenever more than one outcome is possible, and none otherwise', () => {
    const samples: Inputs[] = [
      {},
      building({}),
      building({ escape_level_m: 9 }),
      building({ storeys_above_ground: 2, escape_level_m: 5 }),
      { ...singleFamilyHouse, access_three_sides: undefined, use_units: undefined },
      { ...multiFamilyHouse, building_position: undefined },
      singleFamilyHouse,
      multiFamilyHouse,
    ]
    for (const inputs of samples) {
      const outcomes =
        possibleBuildingClasses(inputs).size + (inputs.building_type === undefined ? 1 : 0)
      expect(decisiveInputs(inputs).length > 0, JSON.stringify(inputs)).toBe(outcomes > 1)
    }
  })

  it('agrees with deriveBuildingClass’s missing', () => {
    const inputs = { ...multiFamilyHouse, building_position: undefined, uses: undefined }
    // A Reihenhaus of units ≤ 400 m² would be GK 2; any other Stellung leaves GK 3. The uses only
    // matter for the 800 m² branch, which 900 m² misses.
    expect(decisiveInputs(inputs)).toEqual(['building_position'])
    expect(deriveBuildingClass(inputs).missing).toEqual(['building_position'])
  })
})

describe('the definition', () => {
  it('cites the Begriffsbestimmungen it encodes', () => {
    expect(BUILDING_CLASS_DERIVATION.citation).toBe(
      'OIB-Richtlinien, Begriffsbestimmungen (Ausgabe Mai 2023), Gebäudeklassen'
    )
    expect(BUILDING_CLASS_DERIVATION.inputs).toEqual(BUILDING_CLASS_INPUTS)
  })

  it('reads only keys the wizard writes, and every question that feeds it is one of its inputs', () => {
    const questions = flattenIntakeQuestions(projectIntakeDefinitionV1)
    const written = new Set(
      questions.map((question) => question.writesTo?.match(/^\/facts\/([^/]+)/)?.[1])
    )
    for (const input of BUILDING_CLASS_INPUTS) expect(written.has(input), input).toBe(true)
    const inputs: readonly string[] = BUILDING_CLASS_INPUTS
    for (const question of questions.filter((item) => item.feeds === 'building_class')) {
      expect(inputs, question.id).toContain(question.writesTo?.match(/^\/facts\/([^/]+)/)?.[1])
    }
  })
})
