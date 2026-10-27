/**
 * @vitest-environment node
 */

/**
 * The named rules against hand-computed cases, through `calculation`'s own
 * arithmetic.
 *
 * The cases are `formula-cases.json`, the fixture both sides read: the backend
 * validates every card in it against `cards/models.py`, this spec compiles and
 * judges every one. Each case's `work` field is the hand calculation its
 * expected numbers come from.
 */

import { describe, expect, it } from 'vitest'
import { gridCardSchema } from '@/shared/cards/schemas'
import cases from './formula-cases.json'
import {
  DAYLIGHT,
  STAIR_TABLE,
  SURFACE_RESISTANCE,
  U_MAX_NEW_BUILD,
  changedInputs,
  compileFormula,
  inputSlots,
  judgeFormula,
  sourceValues,
  startedMetres,
  type FormulaCardData,
  type FormulaValues,
  type FormulaWords,
  type JudgedFormula,
  type CompiledFormula,
} from './formulas'

interface FormulaCase {
  id: string
  work: string
  card?: unknown
  base?: string
  overrides?: FormulaValues
  expect: {
    quantities: Record<string, number | null>
    undecidable?: Record<string, 'missing' | 'undefined'>
    checks: Record<string, string>
  }
}

const fixture = cases as unknown as { tolerance: number; cases: FormulaCase[] }
const byId = new Map(fixture.cases.map((entry) => [entry.id, entry]))

/** Labels are the keys themselves, so a step can be found by what it computes. */
const words: FormulaWords = {
  line: (key) => key,
  term: (key, params) => [key, params?.group].filter(Boolean).join(' '),
}

const cardOf = (entry: FormulaCase): FormulaCardData =>
  gridCardSchema.parse(entry.card ?? byId.get(entry.base ?? '')?.card) as FormulaCardData

const run = (card: FormulaCardData, overrides: FormulaValues = {}) => {
  const values = { ...sourceValues(card.formula), ...overrides }
  const compiled = compileFormula(card.formula, values, words)
  return { values, compiled, judged: judgeFormula(compiled, values) }
}

const STEP_OF: Record<string, string> = {
  step_measure: 'stepMeasure',
  route_length: 'routeLength',
  daylight_ratio: 'daylightShare',
  u_value: 'uValue',
  total_resistance: 'totalResistance',
}

/** A named quantity off a judged rule; `required_share` is the daylight bound, derived or constant. */
const quantity = (compiled: CompiledFormula, judged: JudgedFormula, name: string) => {
  if (name === 'required_share') {
    const check = judged.checks.find((entry) => entry.spec.id === 'daylightMin')
    return { value: check?.limit?.value ?? null, undecidable: null }
  }
  const index = compiled.steps.findIndex((step) => step.label === STEP_OF[name])
  expect(index, `no step computes ${name}`).toBeGreaterThanOrEqual(0)
  return judged.results[index]
}

describe('the hand-computed cases', () => {
  it.each(fixture.cases.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    const { compiled, judged } = run(cardOf(entry), entry.overrides)
    for (const [name, expected] of Object.entries(entry.expect.quantities)) {
      const actual = quantity(compiled, judged, name)
      if (expected == null) {
        expect(actual.value, `${entry.id}: ${name} must not be computed`).toBeNull()
      } else {
        // Relative, because a U-value of 0,17 and a route of 36,5 m share one tolerance.
        expect(Math.abs((actual.value as number) - expected) / Math.abs(expected)).toBeLessThan(fixture.tolerance)
      }
    }
    for (const [name, why] of Object.entries(entry.expect.undecidable ?? {})) {
      expect(quantity(compiled, judged, name).undecidable).toBe(why)
    }
    expect(Object.fromEntries(judged.checks.map((check) => [check.spec.id, check.status]))).toEqual(entry.expect.checks)
  })

  it('cover every rule and every case of it, each rule with a what-if', () => {
    const cards = fixture.cases.map(cardOf)
    const formulas = new Set(cards.map((card) => card.formula.name))
    expect([...formulas].sort()).toEqual(['daylight_ratio', 'escape_route_length', 'stair_step_rule', 'u_value'])
    const stairs = new Set(cards.flatMap((card) => (card.formula.name === 'stair_step_rule' ? [card.formula.stair_type] : [])))
    expect([...stairs].sort()).toEqual(Object.keys(STAIR_TABLE).sort())
    const components = new Set(cards.flatMap((card) => (card.formula.name === 'u_value' ? [card.formula.component] : [])))
    expect([...components].sort()).toEqual(Object.keys(U_MAX_NEW_BUILD).sort())
    for (const name of formulas) {
      expect(fixture.cases.some((entry) => cardOf(entry).formula.name === name && entry.overrides)).toBe(true)
    }
  })
})

describe('the bounds are the Richtlinien’s, transcribed', () => {
  it('OIB-RL 4 Tabelle 3, by stair type', () => {
    expect(STAIR_TABLE).toEqual({
      main: { riserMax: 18, goingMin: 27, row: 'Haupttreppen, ausgenommen Wohnungstreppen' },
      dwelling: { riserMax: 20, goingMin: 24, row: 'Wohnungstreppen' },
      secondary: { riserMax: 21, goingMin: 21, row: 'Nebentreppen' },
    })
  })

  it('OIB-RL 6 Pkt. 4.4.1, rows 1, 18 and 22, with their heat flow', () => {
    expect(U_MAX_NEW_BUILD).toEqual({
      external_wall: { value: 0.35, row: 1, heatFlow: 'horizontal' },
      roof_or_ceiling_to_outside_air: { value: 0.2, row: 18, heatFlow: 'upward' },
      floor_over_outside_air: { value: 0.2, row: 22, heatFlow: 'downward' },
    })
    expect(SURFACE_RESISTANCE).toEqual({
      horizontal: { inside: 0.13, outside: 0.04 },
      upward: { inside: 0.1, outside: 0.04 },
      downward: { inside: 0.17, outside: 0.04 },
    })
  })

  it('OIB-RL 3 Pkt. 9.1.3 and 9.1.4 count started metres', () => {
    expect(DAYLIGHT).toMatchObject({ base: 12, raised: 15, raisedFrom: 1.5, perOverhangMetre: 2, overhangFrom: 3, perDepthMetre: 1, depthFrom: 5 })
    expect([3, 3.0000000000001, 3.1, 4, 4.1].map((value) => startedMetres(value, 3))).toEqual([0, 0, 1, 1, 2])
  })

  it('names the case’s row in the reference, so the bound can be looked up', () => {
    const dwelling = run(cardOf(byId.get('stair-dwelling') as FormulaCase))
    const riser = dwelling.judged.checks.find((check) => check.spec.id === 'riserMax')
    expect(riser?.spec.reference.section).toBe('Pkt. 3.2.1, Tabelle 3: Wohnungstreppen')
    expect(riser?.limit?.value).toBe(20)
    const roof = run(cardOf(byId.get('u-value-roof') as FormulaCase))
    expect(roof.judged.checks[0].spec.reference.section).toBe('Pkt. 4.4.1, Zeile 18')
  })
})

describe('a Rechenweg that reads the way it adds up', () => {
  const wall = cardOf(byId.get('u-value-external-wall') as FormulaCase)

  it('compiles to calculation steps: a line per layer, then R_T, then U, d in metres', () => {
    const { compiled } = run(wall)
    expect(compiled.steps.map((step) => [step.label, step.operation])).toEqual([
      ['layerResistance', 'quotient'],
      ['layerResistance', 'quotient'],
      ['layerResistance', 'quotient'],
      ['layerResistance', 'quotient'],
      ['totalResistance', 'sum'],
      ['uValue', 'quotient'],
    ])
    expect(compiled.steps[2].operands[0]).toMatchObject({ value: 0.2, unit: 'm' })
    expect(compiled.steps[4].operands.slice(1, 5).map((operand) => operand.step)).toEqual([1, 2, 3, 4])
  })

  it('prints the resistances and their sum at one fixed precision', () => {
    const { judged } = run(wall)
    expect(judged.display.slice(0, 5)).toEqual(Array(5).fill({ decimals: 4, fixed: true }))
    expect(judged.display[5].decimals).toBeGreaterThanOrEqual(3)
  })

  it('derives the required daylight share as a step of its own when the case raises it', () => {
    const { compiled } = run(cardOf(byId.get('daylight-deep-room-under-a-loggia') as FormulaCase))
    expect(compiled.steps[0].label).toBe('requiredShare')
    expect(compiled.steps[0].operands.map((operand) => operand.value)).toEqual([15, 2, 2])
    expect(compiled.caveats.map((caveat) => caveat.key)).toEqual(['daylightAngle', 'daylightOtherLaw'])
  })

  it('states the 45° precondition on every daylight card, raised or not', () => {
    const { compiled } = run(cardOf(byId.get('daylight-above-12-percent') as FormulaCase))
    expect(compiled.steps.map((step) => step.label)).toEqual(['daylightShare'])
    expect(compiled.caveats.map((caveat) => caveat.key)).toEqual(['daylightAngle'])
  })
})

describe('inputs and their source values', () => {
  const stair = cardOf(byId.get('stair-main-within') as FormulaCase)

  it('lays the inputs out in reading order, with the formula’s units', () => {
    expect(inputSlots(stair.formula).map((slot) => [slot.key, slot.unit, slot.min, slot.max, slot.step])).toEqual([
      ['riser', 'cm', 10, 25, 0.5],
      ['going', 'cm', 20, 40, 0.5],
    ])
  })

  it('drops a bound the source value breaks, which the TS schema does not refuse', () => {
    const raw = {
      type: 'formula',
      title: 'Stiege',
      formula: {
        name: 'stair_step_rule',
        stair_type: 'main',
        riser: { value: 30, min: 10, max: 25 },
        going: { value: 29, min: 40, max: 20 },
      },
    }
    const card = gridCardSchema.parse(raw) as FormulaCardData
    const [riser, going] = inputSlots(card.formula)
    expect([riser.min, riser.max]).toEqual([10, null])
    expect([going.min, going.max]).toEqual([0, null])
  })

  it('marks λ and the Bodenfläche as quantities that cannot be 0', () => {
    const wall = cardOf(byId.get('u-value-external-wall') as FormulaCase)
    expect(inputSlots(wall.formula).filter((slot) => slot.positive).map((slot) => slot.labelKey)).toEqual(Array(4).fill('conductivity'))
  })

  it('restores exactly the source values, and knows which inputs the reader changed', () => {
    const source = sourceValues(stair.formula)
    expect(source).toEqual({ riser: 17, going: 29 })
    expect([...changedInputs(source, { ...source, riser: 19 })]).toEqual(['riser'])
    expect(changedInputs(source, { ...source }).size).toBe(0)
    expect([...changedInputs(source, { ...source, going: null })]).toEqual(['going'])
  })

  it('is deterministic: the same inputs give the same numbers', () => {
    const wall = cardOf(byId.get('u-value-external-wall') as FormulaCase)
    expect(run(wall).judged).toEqual(run(wall).judged)
  })
})
