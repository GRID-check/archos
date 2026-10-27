/**
 * @vitest-environment node
 */

/**
 * The named formulas against hand-computed cases.
 *
 * The cases are `shared/cards/formula-cases.json`, the one fixture both sides
 * read: the backend validates every card in it against `cards/models.py`, and
 * this spec evaluates every one through `formulas.ts`. Each case's `work`
 * field is the hand calculation its expected numbers come from.
 */

import { describe, expect, it } from 'vitest'
import { gridCardSchema } from '@/shared/cards/schemas'
import { loadSharedCardFile } from '@/test-utils/card-json-schema'
import {
  FORMULA_SOURCES,
  FORMULA_TARGETS,
  SURFACE_RESISTANCE,
  changedInputs,
  checkLimits,
  evaluateFormula,
  inputSlots,
  sourceValues,
  type FormulaCardData,
  type FormulaValues,
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
    checks: string[]
  }
}

interface FormulaCases {
  tolerance: number
  targets: Record<string, string[]>
  cases: FormulaCase[]
}

const fixture = loadSharedCardFile('formula-cases.json') as FormulaCases
const byId = new Map(fixture.cases.map((entry) => [entry.id, entry]))

const cardOf = (entry: FormulaCase): FormulaCardData => {
  const raw = entry.card ?? byId.get(entry.base ?? '')?.card
  return gridCardSchema.parse(raw) as FormulaCardData
}

describe('the hand-computed cases', () => {
  it.each(fixture.cases.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    const card = cardOf(entry)
    const values = { ...sourceValues(card.formula), ...(entry.overrides ?? {}) }
    const outcome = evaluateFormula(card.formula, values)

    for (const [name, expected] of Object.entries(entry.expect.quantities)) {
      const actual = outcome.quantities[name]
      expect(actual, `${entry.id}: quantity ${name}`).toBeDefined()
      if (expected == null) {
        expect(actual.value, `${entry.id}: ${name} must not be computed`).toBeNull()
      } else {
        // Relative, because a U-value of 0,17 and a route of 36,5 m share one tolerance.
        expect(Math.abs((actual.value as number) - expected) / Math.abs(expected)).toBeLessThan(fixture.tolerance)
      }
    }
    for (const [name, why] of Object.entries(entry.expect.undecidable ?? {})) {
      expect(outcome.quantities[name].undecidable).toBe(why)
    }
    expect(checkLimits(card.limits, outcome).map((check) => check.status)).toEqual(entry.expect.checks)
  })

  it('cover every formula, each with a what-if case', () => {
    const named = (entry: FormulaCase) => cardOf(entry).formula.name
    const formulas = new Set(fixture.cases.map(named))
    expect([...formulas].sort()).toEqual(Object.keys(FORMULA_TARGETS).sort())
    for (const name of formulas) {
      expect(fixture.cases.some((entry) => named(entry) === name && entry.overrides)).toBe(true)
    }
  })
})

describe('the contract both sides hold', () => {
  it('names the same checkable quantities as cards/models.py (through the shared fixture)', () => {
    expect(Object.fromEntries(Object.entries(FORMULA_TARGETS).map(([k, v]) => [k, [...v].sort()]))).toEqual(
      Object.fromEntries(Object.entries(fixture.targets).map(([k, v]) => [k, [...v].sort()]))
    )
  })

  it('cites every formula with a document and a Punkt or Tabelle', () => {
    for (const source of Object.values(FORMULA_SOURCES)) {
      expect(source.document).toBeTruthy()
      expect(source.section).toBeTruthy()
    }
  })

  it('keeps the conventional surface resistances of ÖNORM EN ISO 6946', () => {
    expect(SURFACE_RESISTANCE).toEqual({
      horizontal: { inside: 0.13, outside: 0.04 },
      upward: { inside: 0.1, outside: 0.04 },
      downward: { inside: 0.17, outside: 0.04 },
    })
  })
})

describe('inputs and their source values', () => {
  const stair = cardOf(byId.get('stair-within-the-rule') as FormulaCase)
  const wall = cardOf(byId.get('u-value-wall-20-cm-eps') as FormulaCase)

  it('lays the inputs out in reading order, with the formula’s units', () => {
    expect(inputSlots(stair.formula).map((slot) => [slot.key, slot.unit])).toEqual([
      ['riser', 'cm'],
      ['going', 'cm'],
    ])
    expect(inputSlots(wall.formula).slice(0, 2).map((slot) => [slot.key, slot.unit, slot.group])).toEqual([
      ['layers.0.thickness', 'cm', 'Innenputz'],
      ['layers.0.conductivity', 'W/(m·K)', 'Innenputz'],
    ])
  })

  it('restores exactly the source values, and knows which inputs the reader changed', () => {
    const source = sourceValues(stair.formula)
    expect(source).toEqual({ riser: 17, going: 29 })
    expect([...changedInputs(source, { ...source, riser: 19 })]).toEqual(['riser'])
    expect(changedInputs(source, { ...source }).size).toBe(0)
    // A cleared field is a change too: the reader removed the source's value.
    expect([...changedInputs(source, { ...source, going: null })]).toEqual(['going'])
  })

  it('prints a U-value line per layer, then R_T, then U — d converted to metres once', () => {
    const outcome = evaluateFormula(wall.formula, sourceValues(wall.formula))
    expect(outcome.lines.map((line) => line.id)).toEqual([
      'layers.0.resistance',
      'layers.1.resistance',
      'layers.2.resistance',
      'layers.3.resistance',
      'total_resistance',
      'u_value',
    ])
    const insulation = outcome.lines[2]
    expect(insulation.terms[0]).toMatchObject({ value: 0.2, unit: 'm' })
    expect(insulation.result.value).toBeCloseTo(5.714286, 6)
  })

  it('is deterministic: the same inputs give the same numbers', () => {
    const values = sourceValues(wall.formula)
    expect(evaluateFormula(wall.formula, values)).toEqual(evaluateFormula(wall.formula, { ...values }))
  })
})
