/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  flattenIntakeQuestions,
  projectIntakeDefinitionV1,
} from '@/lib/project-profile/intake-definition'
import type { ProjectPrimitiveValue } from '@/lib/project-profile/types'
import {
  decisiveInputs,
  deriveGebaeudeklasse,
  GEBAEUDEKLASSE_DERIVATION,
  GEBAEUDEKLASSE_INPUTS,
  type GebaeudeklasseResult,
  possibleGebaeudeklassen,
} from './derivations'

type Inputs = Record<string, ProjectPrimitiveValue | undefined>

const gebaeude = (inputs: Inputs): Inputs => ({ bauwerkstyp: 'gebaeude', ...inputs })

const efh: Inputs = gebaeude({
  gebaeudestellung: 'freistehend',
  zugang_drei_seiten: true,
  geschosse_oberirdisch: 2,
  fluchtniveau_m: 3.2,
  bgf_oberirdisch: 180,
  nutzungseinheiten: 1,
  nutzungen: ['wohnen'],
})

const mfh: Inputs = gebaeude({
  gebaeudestellung: 'freistehend',
  zugang_drei_seiten: true,
  geschosse_oberirdisch: 3,
  fluchtniveau_m: 6.5,
  bgf_oberirdisch: 900,
  nutzungseinheiten: 6,
  einheiten_ueber_400: false,
  nutzungen: ['wohnen'],
})

const known = (value: GebaeudeklasseResult['value']) => ({
  value,
  hochhaus: false,
  applicable: true,
  missing: [],
})

describe('deriveGebaeudeklasse', () => {
  it.each<[string, Inputs, GebaeudeklasseResult]>([
    // Every GK 1 condition holds; the units >400 and the uses do not matter once it is GK 1.
    ['an EFH, freistehend and reachable from three sides, is GK 1', efh, known(1)],
    // No longer GK 1 (no three-side access), but 180 m² ≤ 400 m² makes it GK 2 by the first branch.
    [
      'the same EFH without three-side access is GK 2',
      { ...efh, zugang_drei_seiten: 'nein' },
      known(2),
    ],
    // Angebaut excludes GK 1; 300 m² ≤ 400 m² gives GK 2.
    [
      'a Doppelhaus half, angebaut, 2 oG, 300 m², is GK 2',
      gebaeude({
        gebaeudestellung: 'angebaut',
        geschosse_oberirdisch: 2,
        fluchtniveau_m: 6,
        bgf_oberirdisch: 300,
        nutzungseinheiten: 1,
      }),
      known(2),
    ],
    // 900 m² is past both area branches; the Reihenhaus branch holds because no unit exceeds 400 m².
    [
      'a Reihenhaus of three units of at most 400 m², 900 m² in all, is GK 2',
      gebaeude({
        gebaeudestellung: 'reihenhaus',
        geschosse_oberirdisch: 2,
        fluchtniveau_m: 6,
        bgf_oberirdisch: 900,
        nutzungseinheiten: 3,
        einheiten_ueber_400: false,
      }),
      known(2),
    ],
    // Low (3 oG, 6.5 m) but 900 m² > 800 m² for the residential branch, and not a Reihenhaus: GK 3.
    ['an MFH of 3 oG, FN 6.5 m, 900 m², six units, is GK 3', mfh, known(3)],
    // 4 oG is past GK 1–3; FN 10 ≤ 11 and no unit above 400 m²: GK 4 a).
    [
      'four storeys, FN 10 m, 1600 m², twelve units none above 400 m², is GK 4',
      {
        ...mfh,
        geschosse_oberirdisch: 4,
        fluchtniveau_m: 10,
        bgf_oberirdisch: 1600,
        nutzungseinheiten: 12,
      },
      known(4),
    ],
    // Several units and one above 400 m²: neither GK 4 a) nor b), so GK 5.
    [
      'four storeys, FN 10 m, one of three units above 400 m², is GK 5',
      {
        ...mfh,
        geschosse_oberirdisch: 4,
        fluchtniveau_m: 10,
        bgf_oberirdisch: 1600,
        nutzungseinheiten: 3,
        einheiten_ueber_400: true,
      },
      known(5),
    ],
    // 6 oG rules out GK 1–4 whatever else holds, and FN 18 ≤ 22: GK 5 with nothing else known.
    [
      'six storeys at FN 18 m is GK 5, and nothing else matters',
      gebaeude({ geschosse_oberirdisch: 6, fluchtniveau_m: 18 }),
      known(5),
    ],
    // Above 22 m there is no class at all.
    [
      'FN 25 m is a Hochhaus',
      gebaeude({ fluchtniveau_m: 25 }),
      { value: null, hochhaus: true, applicable: true, missing: [] },
    ],
    // One Betriebseinheit of 2000 m²: GK 4 b) has no area limit.
    [
      'an office of one unit, 4 oG, FN 10.5 m, 2000 m², is GK 4',
      gebaeude({
        gebaeudestellung: 'freistehend',
        zugang_drei_seiten: true,
        geschosse_oberirdisch: 4,
        fluchtniveau_m: 10.5,
        bgf_oberirdisch: 2000,
        nutzungseinheiten: 1,
        nutzungen: ['buero'],
      }),
      known(4),
    ],
    // FN ≤ 7 gives GK 2; FN in (7, 11] gives GK 4 or GK 5 depending on the units; above 22 m a Hochhaus.
    [
      'without the Fluchtniveau, an angebaut 2-storey 300 m² building is open, and the units matter too',
      gebaeude({ gebaeudestellung: 'angebaut', geschosse_oberirdisch: 2, bgf_oberirdisch: 300 }),
      {
        value: null,
        hochhaus: false,
        applicable: true,
        missing: ['fluchtniveau_m', 'nutzungseinheiten', 'einheiten_ueber_400'],
      },
    ],
    // With the units known not to exceed 400 m², only the Fluchtniveau is left to decide.
    [
      'and with the units known, only the Fluchtniveau is missing',
      gebaeude({
        gebaeudestellung: 'angebaut',
        geschosse_oberirdisch: 2,
        bgf_oberirdisch: 300,
        nutzungseinheiten: 2,
        einheiten_ueber_400: false,
      }),
      { value: null, hochhaus: false, applicable: true, missing: ['fluchtniveau_m'] },
    ],
    [
      'a Kleinstgebäude is not classified',
      { bauwerkstyp: 'klein', fluchtniveau_m: 3 },
      { value: null, hochhaus: false, applicable: false, missing: [] },
    ],
    [
      'nothing known: the Bauwerkstyp is the first thing that matters',
      {},
      { value: null, hochhaus: false, applicable: true, missing: [...GEBAEUDEKLASSE_INPUTS] },
    ],
  ])('%s', (_name, inputs, expected) => {
    expect(deriveGebaeudeklasse(inputs)).toEqual(expected)
  })

  it('reads the values as the wizard and the profile store them', () => {
    expect(
      deriveGebaeudeklasse({
        ...efh,
        zugang_drei_seiten: 'ja',
        geschosse_oberirdisch: '2',
        fluchtniveau_m: '3.2',
      }).value
    ).toBe(1)
    // `offen` is no answer: GK 1 or GK 2 is then open on the access alone.
    expect(deriveGebaeudeklasse({ ...efh, zugang_drei_seiten: 'offen' })).toEqual({
      value: null,
      hochhaus: false,
      applicable: true,
      missing: ['zugang_drei_seiten'],
    })
  })

  it('needs the Bauwerkstyp before it names a class', () => {
    expect(deriveGebaeudeklasse({ ...efh, bauwerkstyp: undefined })).toEqual({
      value: null,
      hochhaus: false,
      applicable: true,
      missing: ['bauwerkstyp'],
    })
  })
})

describe('boundaries', () => {
  const low = (fluchtniveau_m: number, extra: Inputs = {}) =>
    deriveGebaeudeklasse({ ...mfh, bgf_oberirdisch: 300, fluchtniveau_m, ...extra }).value

  it('holds „höchstens" at exactly 7, 11 and 22 m', () => {
    expect(low(7)).toBe(2) // 6 units: not GK 1; 300 m² ≤ 400 m²: GK 2
    expect(low(7.01)).toBe(4) // 3 oG, ≤ 11 m, no unit above 400 m²
    expect(low(11)).toBe(4)
    expect(low(11.01)).toBe(5)
    expect(low(22)).toBe(5)
    expect(deriveGebaeudeklasse({ ...mfh, fluchtniveau_m: 22.01 })).toMatchObject({
      value: null,
      hochhaus: true,
    })
  })

  it('holds „höchstens" at exactly 400 and 800 m²', () => {
    const area = (bgf_oberirdisch: number, extra: Inputs = {}) =>
      deriveGebaeudeklasse({ ...efh, bgf_oberirdisch, ...extra }).value
    expect(area(400)).toBe(1)
    expect(area(400.5)).toBe(2) // freistehend, three sides, rein Wohnen, ≤ 800 m²
    expect(area(800)).toBe(2)
    expect(area(800.5)).toBe(3)
    // A garage in the house is no reines Wohngebäude: the 800 m² branch closes.
    expect(area(600, { nutzungen: ['wohnen', 'garage'] })).toBe(3)
  })

  it('holds „höchstens" at exactly 3 and 4 oberirdische Geschoße', () => {
    const storeys = (geschosse_oberirdisch: number) =>
      deriveGebaeudeklasse({ ...efh, fluchtniveau_m: 6, geschosse_oberirdisch }).value
    expect(storeys(3)).toBe(1)
    expect(storeys(4)).toBe(4) // one unit: GK 4 b)
    expect(storeys(5)).toBe(5)
  })

  it('counts the Gebäude with two units as GK 1 and with three as no longer', () => {
    expect(deriveGebaeudeklasse({ ...efh, nutzungseinheiten: 2 }).value).toBe(1)
    expect(deriveGebaeudeklasse({ ...efh, nutzungseinheiten: 3 }).value).toBe(2)
  })
})

describe('possibleGebaeudeklassen', () => {
  it('lists what the building can still turn out to be', () => {
    const open = gebaeude({
      gebaeudestellung: 'angebaut',
      geschosse_oberirdisch: 2,
      bgf_oberirdisch: 300,
    })
    expect(possibleGebaeudeklassen(open)).toEqual(new Set([2, 4, 5, 'hochhaus']))
    expect(
      possibleGebaeudeklassen({ ...open, nutzungseinheiten: 2, einheiten_ueber_400: false })
    ).toEqual(new Set([2, 4, 5, 'hochhaus']))
    expect(possibleGebaeudeklassen(efh)).toEqual(new Set([1]))
    expect(possibleGebaeudeklassen({ bauwerkstyp: 'sonstig' })).toEqual(new Set())
  })
})

describe('decisiveInputs', () => {
  it('names an open input only when one of its bands can flip the outcome', () => {
    expect(decisiveInputs(gebaeude({ geschosse_oberirdisch: 6, fluchtniveau_m: 18 }))).toEqual([])
    expect(decisiveInputs(gebaeude({ fluchtniveau_m: 25 }))).toEqual([])
    // Angebaut: the three-side access and the uses only matter for a freistehend building.
    expect(
      decisiveInputs(
        gebaeude({ gebaeudestellung: 'angebaut', geschosse_oberirdisch: 2, bgf_oberirdisch: 300 })
      )
    ).toEqual(['fluchtniveau_m', 'nutzungseinheiten', 'einheiten_ueber_400'])
  })

  it('names at least one input whenever more than one outcome is possible, and none otherwise', () => {
    const samples: Inputs[] = [
      {},
      gebaeude({}),
      gebaeude({ fluchtniveau_m: 9 }),
      gebaeude({ geschosse_oberirdisch: 2, fluchtniveau_m: 5 }),
      { ...efh, zugang_drei_seiten: undefined, nutzungseinheiten: undefined },
      { ...mfh, gebaeudestellung: undefined },
      efh,
      mfh,
    ]
    for (const inputs of samples) {
      const outcomes =
        possibleGebaeudeklassen(inputs).size + (inputs.bauwerkstyp === undefined ? 1 : 0)
      expect(decisiveInputs(inputs).length > 0, JSON.stringify(inputs)).toBe(outcomes > 1)
    }
  })

  it('agrees with deriveGebaeudeklasse’s missing', () => {
    const inputs = { ...mfh, gebaeudestellung: undefined, nutzungen: undefined }
    // A Reihenhaus of units ≤ 400 m² would be GK 2; any other Stellung leaves GK 3. The uses only
    // matter for the 800 m² branch, which 900 m² misses.
    expect(decisiveInputs(inputs)).toEqual(['gebaeudestellung'])
    expect(deriveGebaeudeklasse(inputs).missing).toEqual(['gebaeudestellung'])
  })
})

describe('the definition', () => {
  it('cites the Begriffsbestimmungen it encodes', () => {
    expect(GEBAEUDEKLASSE_DERIVATION.citation).toBe(
      'OIB-Richtlinien, Begriffsbestimmungen (Ausgabe Mai 2023), Gebäudeklassen'
    )
    expect(GEBAEUDEKLASSE_DERIVATION.inputs).toEqual(GEBAEUDEKLASSE_INPUTS)
  })

  it('reads only keys the wizard writes, and every question that feeds it is one of its inputs', () => {
    const questions = flattenIntakeQuestions(projectIntakeDefinitionV1)
    const written = new Set(
      questions.map((question) => question.writesTo?.match(/^\/facts\/([^/]+)/)?.[1])
    )
    for (const input of GEBAEUDEKLASSE_INPUTS) expect(written.has(input), input).toBe(true)
    const inputs: readonly string[] = GEBAEUDEKLASSE_INPUTS
    for (const question of questions.filter((item) => item.feeds === 'gebaeudeklasse')) {
      expect(inputs, question.id).toContain(question.writesTo?.match(/^\/facts\/([^/]+)/)?.[1])
    }
  })
})
