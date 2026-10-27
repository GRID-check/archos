/**
 * The named formulas behind `FormulaCard` — a closed, tested set, evaluated HERE.
 *
 * The model names a rule (`formula.name`) and fills its inputs from cited
 * sources; it never states a result and never writes an expression (ADR-0141).
 * This module turns the inputs, as the source gives them or as the reader has
 * changed them, into the derivation lines the card prints and the quantities its
 * cited limits are checked against. It is pure and deterministic: the same
 * inputs always give the same numbers, in the browser, with no model call.
 *
 * Every rule carries where it is written (`FORMULA_SOURCES`). A rule whose
 * arithmetic nobody could cite is not here: the lichte Raumhöhe was drafted and
 * withdrawn, because the subtraction it needs is defined in the OIB
 * Begriffsbestimmungen and that text is not in the corpus to cite exactly.
 *
 * Units are the formula's, never the wire's. A thickness is in cm because the
 * rule says so, and the conversion to metres for d/λ happens once, here.
 *
 * Hand-computed cases live in `shared/cards/formula-cases.json`, shared with the
 * backend's tests, and `formulas.spec.ts` runs every one of them through this
 * module.
 */

import type { GridCard } from '@/shared/cards/schemas'
import type { CalculationLimitData, DimStatus, NormReferenceData } from '../schematics/types'
import { verdictFor, resultDecimals, type StepResult } from './calculate'

export type FormulaCardData = Extract<GridCard, { type: 'formula' }>
export type FormulaSpec = FormulaCardData['formula']
export type FormulaName = FormulaSpec['name']
export type FormulaLimitData = NonNullable<FormulaCardData['limits']>[number]
export type FormulaInputData = Extract<FormulaSpec, { name: 'stair_step_rule' }>['riser']

/** The value of every input, by slot key; null is "not known" (or not a number the reader typed). */
export type FormulaValues = Record<string, number | null>

/**
 * One input of a formula, as the card lays it out.
 *
 * `key` is stable for the card's lifetime (`riser`, `layers.1.thickness`): it is
 * the reader's input's address in the surface's data model. `labelKey` names the
 * quantity in the dictionary; `group` is the model's own label for the layer or
 * leg it belongs to, when it belongs to one.
 */
export interface InputSlot {
  key: string
  input: FormulaInputData
  unit: string
  labelKey: FormulaInputLabel
  group: string | null
  /** The lowest value the rule admits, whatever the card's own `min`: no thickness is negative. */
  floor: number
}

export type FormulaInputLabel =
  | 'riser'
  | 'going'
  | 'thickness'
  | 'conductivity'
  | 'length'
  | 'glazingArea'
  | 'floorArea'

/** A quantity a limit can be held against. */
export interface Quantity {
  value: number | null
  unit: string
  /** Why there is no value: an input is missing, or the rule divides by zero. */
  undecidable: 'missing' | 'undefined' | null
}

/** One term of a derivation line: a number, its unit, and the rule's own multiplier. */
export interface Term {
  value: number | null
  unit: string
  factor?: number
  /** What the term is, for the reader: an input's dictionary key, or a constant's. */
  labelKey: FormulaInputLabel | 'surfaceInside' | 'surfaceOutside' | 'layerResistance' | 'totalResistance' | 'one'
  /** The layer or leg the term belongs to, in the model's own words. */
  group?: string | null
  /** A term that is an earlier line's result prints as that line did, not to an input's precision. */
  decimals?: number
}

export type LineOperation = 'sum' | 'quotient' | 'percent_ratio'

/** One printed line of the derivation: `label = term op term … = result`. */
export interface DerivationLine {
  id: string
  labelKey: 'layerResistance' | 'totalResistance' | 'uValue' | 'stepMeasure' | 'routeLength' | 'daylightRatio'
  group: string | null
  operation: LineOperation
  terms: Term[]
  result: Quantity
}

export interface FormulaOutcome {
  lines: DerivationLine[]
  /** Every quantity a limit may name (`FORMULA_TARGETS`), inputs included. */
  quantities: Record<string, Quantity>
}

/** The quantities a limit may target, per formula. Mirrors `FORMULA_TARGETS` in `cards/models.py`. */
export const FORMULA_TARGETS: Record<FormulaName, readonly string[]> = {
  u_value: ['u_value'],
  stair_step_rule: ['step_measure', 'riser', 'going'],
  escape_route_length: ['route_length'],
  daylight_ratio: ['daylight_ratio'],
}

/**
 * Where each rule is written. Shown in the card's footer, so the reader can
 * check the method as well as the limit. The OIB Punkte were read off the
 * Mai 2023 PDFs (`frontends/benchmarks/oib_retrieval/fixtures/
 * oib_retrieval_golden.json` records each page). ÖNORM EN ISO 6946 is a paid
 * standard and not in the corpus: its conventional surface resistances agree
 * across published secondary sources, and its table number is the 2017
 * edition's.
 */
export const FORMULA_SOURCES: Record<FormulaName, NormReferenceData> = {
  u_value: {
    document: 'ÖNORM EN ISO 6946',
    section: 'Tabelle 7',
    edition: 'EN ISO 6946:2017',
    excerpt: null,
  },
  stair_step_rule: {
    document: 'OIB-Richtlinie 4',
    section: 'Pkt. 3.2.1',
    edition: 'Ausgabe Mai 2023',
    excerpt: null,
  },
  escape_route_length: {
    document: 'OIB-Richtlinie 2',
    section: 'Pkt. 5.1.1',
    edition: 'Ausgabe Mai 2023',
    excerpt: null,
  },
  daylight_ratio: {
    document: 'OIB-Richtlinie 3',
    section: 'Pkt. 9.1.1',
    edition: 'Ausgabe Mai 2023',
    excerpt: null,
  },
}

/**
 * The conventional surface resistances, m²K/W, by direction of heat flow
 * (ÖNORM EN ISO 6946, Tabelle 7). Fixed here, not on the wire: they are the
 * standard's statement, and a model that could set them could tune a U-value.
 */
export const SURFACE_RESISTANCE: Record<'horizontal' | 'upward' | 'downward', { inside: number; outside: number }> = {
  horizontal: { inside: 0.13, outside: 0.04 },
  upward: { inside: 0.1, outside: 0.04 },
  downward: { inside: 0.17, outside: 0.04 },
}

const CM = 'cm'
const M = 'm'
const M2 = 'm²'
const LAMBDA = 'W/(m·K)'
const RESISTANCE = 'm²K/W'
const U = 'W/(m²K)'
const PERCENT = '%'

/** Every input of a formula, in reading order. */
export function inputSlots(formula: FormulaSpec): InputSlot[] {
  switch (formula.name) {
    case 'stair_step_rule':
      return [
        { key: 'riser', input: formula.riser, unit: CM, labelKey: 'riser', group: null, floor: 0 },
        { key: 'going', input: formula.going, unit: CM, labelKey: 'going', group: null, floor: 0 },
      ]
    case 'escape_route_length':
      return formula.segments.map((segment, index) => ({
        key: `segments.${index}.length`,
        input: segment.length,
        unit: M,
        labelKey: 'length' as const,
        group: segment.label,
        floor: 0,
      }))
    case 'daylight_ratio':
      return [
        { key: 'glazing_area', input: formula.glazing_area, unit: M2, labelKey: 'glazingArea', group: null, floor: 0 },
        { key: 'floor_area', input: formula.floor_area, unit: M2, labelKey: 'floorArea', group: null, floor: 0 },
      ]
    case 'u_value':
      return formula.layers.flatMap((layer, index) => [
        {
          key: `layers.${index}.thickness`,
          input: layer.thickness,
          unit: CM,
          labelKey: 'thickness' as const,
          group: layer.label,
          floor: 0,
        },
        {
          key: `layers.${index}.conductivity`,
          input: layer.conductivity,
          unit: LAMBDA,
          labelKey: 'conductivity' as const,
          group: layer.label,
          floor: 0,
        },
      ])
  }
}

/**
 * Whether the reader may change this input. `editable` defaults to true on the
 * wire, and a card drawn from props A2UI did not run through the schema's
 * defaults may arrive without it, so only an explicit `false` fixes a value.
 */
export const isEditable = (slot: InputSlot): boolean => slot.input.editable !== false

/** The values as the source gives them: what „Zurücksetzen" restores. */
export function sourceValues(formula: FormulaSpec): FormulaValues {
  return Object.fromEntries(inputSlots(formula).map((slot) => [slot.key, finite(slot.input.value)]))
}

const finite = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const quantity = (value: number | null, unit: string, undecidable: Quantity['undecidable'] = null): Quantity => ({
  value,
  unit,
  undecidable: value == null ? (undecidable ?? 'missing') : null,
})

const missing = (unit: string): Quantity => quantity(null, unit, 'missing')
const undefinedResult = (unit: string): Quantity => quantity(null, unit, 'undefined')

/** Σ factor · value over the terms; missing when any term is. */
const sumOf = (terms: Term[], unit: string): Quantity => {
  if (terms.some((term) => term.value == null)) return missing(unit)
  return quantity(
    terms.reduce((total, term) => total + (term.factor ?? 1) * (term.value as number), 0),
    unit
  )
}

/** first ÷ second; undefined at a zero divisor. */
const quotientOf = (numerator: number | null, denominator: number | null, unit: string): Quantity => {
  if (numerator == null || denominator == null) return missing(unit)
  if (denominator === 0) return undefinedResult(unit)
  return quantity(numerator / denominator, unit)
}

const at = (values: FormulaValues, key: string): number | null => finite(values[key])

function stairStepRule(values: FormulaValues): FormulaOutcome {
  const riser = at(values, 'riser')
  const going = at(values, 'going')
  const terms: Term[] = [
    { value: riser, unit: CM, factor: 2, labelKey: 'riser' },
    { value: going, unit: CM, labelKey: 'going' },
  ]
  const stepMeasure = sumOf(terms, CM)
  return {
    lines: [{ id: 'step_measure', labelKey: 'stepMeasure', group: null, operation: 'sum', terms, result: stepMeasure }],
    quantities: { step_measure: stepMeasure, riser: quantity(riser, CM), going: quantity(going, CM) },
  }
}

function escapeRouteLength(formula: Extract<FormulaSpec, { name: 'escape_route_length' }>, values: FormulaValues) {
  const terms: Term[] = formula.segments.map((segment, index) => ({
    value: at(values, `segments.${index}.length`),
    unit: M,
    labelKey: 'length',
    group: segment.label,
  }))
  const routeLength = sumOf(terms, M)
  return {
    lines: [{ id: 'route_length', labelKey: 'routeLength', group: null, operation: 'sum', terms, result: routeLength }],
    quantities: { route_length: routeLength },
  } satisfies FormulaOutcome
}

function daylightRatio(values: FormulaValues): FormulaOutcome {
  const glazing = at(values, 'glazing_area')
  const floor = at(values, 'floor_area')
  const fraction = quotientOf(glazing, floor, PERCENT)
  const ratio = fraction.value == null ? fraction : quantity(fraction.value * 100, PERCENT)
  return {
    lines: [
      {
        id: 'daylight_ratio',
        labelKey: 'daylightRatio',
        group: null,
        operation: 'percent_ratio',
        terms: [
          { value: glazing, unit: M2, labelKey: 'glazingArea' },
          { value: floor, unit: M2, labelKey: 'floorArea' },
        ],
        result: ratio,
      },
    ],
    quantities: { daylight_ratio: ratio },
  }
}

/**
 * U = 1 / R_T, R_T = R_si + Σ dᵢ/λᵢ + R_se, for homogeneous layers.
 *
 * One line per layer (its resistance), one for R_T and one for U, so the reader
 * sees which layer carries the resistance — the line that answers „wie viel
 * Dämmung brauche ich". The thickness is entered in cm and divided by 100 once,
 * here, for d/λ in m ÷ W/(m·K).
 */
function uValue(formula: Extract<FormulaSpec, { name: 'u_value' }>, values: FormulaValues): FormulaOutcome {
  const surface = SURFACE_RESISTANCE[formula.heat_flow]
  const layerLines: DerivationLine[] = formula.layers.map((layer, index) => {
    const thickness = at(values, `layers.${index}.thickness`)
    const conductivity = at(values, `layers.${index}.conductivity`)
    const resistance = quotientOf(thickness == null ? null : thickness / 100, conductivity, RESISTANCE)
    return {
      id: `layers.${index}.resistance`,
      labelKey: 'layerResistance',
      group: layer.label,
      operation: 'quotient',
      terms: [
        { value: thickness == null ? null : thickness / 100, unit: M, labelKey: 'thickness', group: layer.label },
        { value: conductivity, unit: LAMBDA, labelKey: 'conductivity', group: layer.label },
      ],
      result: resistance,
    }
  })
  const totalTerms: Term[] = [
    { value: surface.inside, unit: RESISTANCE, labelKey: 'surfaceInside' },
    ...layerLines.map((line) => ({
      value: line.result.value,
      unit: RESISTANCE,
      labelKey: 'layerResistance' as const,
      group: line.group,
      decimals: 3,
    })),
    { value: surface.outside, unit: RESISTANCE, labelKey: 'surfaceOutside' },
  ]
  const layerFailure = layerLines.find((line) => line.result.undecidable === 'undefined')
  const total = layerFailure ? undefinedResult(RESISTANCE) : sumOf(totalTerms, RESISTANCE)
  const transmittance =
    total.value == null ? quantity(null, U, total.undecidable) : quotientOf(1, total.value, U)
  return {
    lines: [
      ...layerLines,
      { id: 'total_resistance', labelKey: 'totalResistance', group: null, operation: 'sum', terms: totalTerms, result: total },
      {
        id: 'u_value',
        labelKey: 'uValue',
        group: null,
        operation: 'quotient',
        terms: [
          { value: 1, unit: '', labelKey: 'one' },
          { value: total.value, unit: RESISTANCE, labelKey: 'totalResistance', decimals: 3 },
        ],
        result: transmittance,
      },
    ],
    quantities: { u_value: transmittance },
  }
}

/** The derivation and every checkable quantity for these input values. Pure. */
export function evaluateFormula(formula: FormulaSpec, values: FormulaValues): FormulaOutcome {
  switch (formula.name) {
    case 'stair_step_rule':
      return stairStepRule(values)
    case 'escape_route_length':
      return escapeRouteLength(formula, values)
    case 'daylight_ratio':
      return daylightRatio(values)
    case 'u_value':
      return uValue(formula, values)
  }
}

/** One cited limit, judged against the quantity it names. */
export interface LimitCheck {
  limit: FormulaLimitData
  quantity: Quantity
  status: DimStatus
  /** Decimals the quantity is printed to, so the printed number and the verdict cannot disagree. */
  decimals: number
}

const asStep = (q: Quantity): StepResult => ({ value: q.value, tolerance: null, unit: q.unit, undecidable: q.undecidable })

const asLimit = (limit: FormulaLimitData): CalculationLimitData => ({
  comparator: limit.comparator,
  value: limit.value,
  upper: limit.upper,
  label: limit.label,
  reference: limit.reference,
})

/**
 * Every limit judged: `pass`, `fail`, or `needs_input` when the quantity cannot
 * be computed from the inputs at hand. The verdict rule is `calculation`'s
 * (`verdictFor`), so a card of either kind judges a bound the same way.
 */
export function checkLimits(limits: FormulaLimitData[] | undefined, outcome: FormulaOutcome): LimitCheck[] {
  return (limits ?? []).map((limit) => {
    const q = outcome.quantities[limit.target] ?? missing('')
    const step = asStep(q)
    const bound = asLimit(limit)
    return {
      limit,
      quantity: q,
      status: verdictFor(step, bound) ?? 'needs_input',
      decimals: resultDecimals(step, bound),
    }
  })
}

/** Which inputs the reader has changed from the source's value. */
export function changedInputs(source: FormulaValues, current: FormulaValues): Set<string> {
  return new Set(Object.keys(source).filter((key) => !Object.is(source[key], current[key] ?? null)))
}
