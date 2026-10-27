/**
 * The four named rules behind `FormulaCard` (ADR-0143), compiled to a Rechenweg.
 *
 * The model names a rule and the case it asks for (the stair type, the
 * component, where the route starts) and fills the inputs from cited sources. It
 * writes no result, no unit, no expression and no limit. This module turns the
 * inputs, as the source gives them or as the reader has changed them, into
 * `CalculationStepData` — the same steps a `calculation` card carries — so they
 * are evaluated by `calculate.ts`'s `evaluate` and judged by its `verdictFor`,
 * one arithmetic and one verdict rule for both cards.
 *
 * The BOUNDS are this module's, not the model's: typed tables transcribed from
 * the Mai 2023 Richtlinien, keyed by the case the model named. A rule is here
 * only where its arithmetic and its bound can be cited exactly. The lichte
 * Raumhöhe was drafted and withdrawn: the subtraction it needs is defined in the
 * OIB Begriffsbestimmungen, not in a Punkt this card could name.
 *
 * Hand-computed cases live in `formula-cases.json` beside this file, validated
 * as cards by `tests/aiq_agent/cards/test_formula_card.py` and evaluated here by
 * `formulas.spec.ts`.
 */

import type { GridCard } from '@/shared/cards/schemas'
import type { CalculationLimitData, CalculationStepData, DimStatus, NormReferenceData } from '../schematics/types'
import { evaluate, resultDecimals, verdictFor, type Derivation, type StepDisplay, type StepResult } from './calculate'

export type FormulaCardData = Extract<GridCard, { type: 'formula' }>
export type FormulaSpec = FormulaCardData['formula']
export type FormulaName = FormulaSpec['name']
type Rule<N extends FormulaName> = Extract<FormulaSpec, { name: N }>
export type FormulaInputData = Rule<'stair_step_rule'>['riser']
export type StairType = Rule<'stair_step_rule'>['stair_type']
export type Component = Rule<'u_value'>['component']
export type RouteStart = Rule<'escape_route_length'>['start']
export type Measure = NonNullable<Rule<'u_value'>['measure']>
type HeatFlow = 'horizontal' | 'upward' | 'downward'

/** The value of every input, by slot key; null is "not known", or not a number the reader typed. */
export type FormulaValues = Record<string, number | null>

export type InputLabel =
  | 'riser'
  | 'going'
  | 'thickness'
  | 'conductivity'
  | 'length'
  | 'openingArea'
  | 'floorArea'
  | 'roomDepth'
  | 'overhangDepth'

/**
 * One input of a formula, as the card lays it out. `key` is its address in
 * the surface's data model (`riser`, `layers.1.thickness`); `group` is the
 * model's own name for the layer or leg it belongs to.
 */
export interface InputSlot {
  key: string
  input: FormulaInputData
  unit: string
  labelKey: InputLabel
  group: string | null
  /** Bounds the field accepts, already reconciled with the source's value (see {@link inputSlots}). */
  min: number | null
  max: number | null
  step: number | null
  /** 0 is not a value this quantity can have (λ, a Bodenfläche): the rule would divide by it. */
  positive: boolean
  editable: boolean
}

/* ── the Richtlinien, transcribed ──────────────────────────────────────────── */

const EDITION = 'Ausgabe Mai 2023'
const oib = (guideline: string, section: string): NormReferenceData => ({
  document: `OIB-Richtlinie ${guideline}`,
  section,
  edition: EDITION,
  excerpt: null,
})

/** OIB-RL 4 Pkt. 3.2.1: „2 × Stufenhöhe + Stufenauftritt = 62 cm ± 3 cm“, for every stair. */
export const STEP_RULE = { lower: 59, upper: 65 } as const

/** OIB-RL 4 Pkt. 3.2.1, Tabelle 3: Stufenhöhe Höchstmaß and Stufenauftritt Mindestmaß, in cm, by stair type. */
export const STAIR_TABLE: Record<StairType, { riserMax: number; goingMin: number; row: string }> = {
  main: { riserMax: 18, goingMin: 27, row: 'Haupttreppen, ausgenommen Wohnungstreppen' },
  dwelling: { riserMax: 20, goingMin: 24, row: 'Wohnungstreppen' },
  secondary: { riserMax: 21, goingMin: 21, row: 'Nebentreppen' },
}

/**
 * OIB-RL 6 Pkt. 4.4.1: the highest U-value at a new build, W/(m²K), by the row
 * of its table, with the heat-flow direction of that component. Only the
 * opaque rows against OUTSIDE AIR: there R_se is the standard's 0,04, which is
 * what this card uses. A renovation by single measures follows Pkt. 4.5, which
 * the card says rather than computes.
 */
export const U_MAX_NEW_BUILD: Record<Component, { value: number; row: number; heatFlow: HeatFlow }> = {
  external_wall: { value: 0.35, row: 1, heatFlow: 'horizontal' },
  roof_or_ceiling_to_outside_air: { value: 0.2, row: 18, heatFlow: 'upward' },
  floor_over_outside_air: { value: 0.2, row: 22, heatFlow: 'downward' },
}

/**
 * OIB-RL 6 Pkt. 4.5 b): at a renovation by single measures or the renewal of a
 * component, without a Sanierungskonzept, the Pkt. 4.4 values „um mindestens
 * 24 % unterschritten“, so the bound is 0,76 × the table's. With a concept
 * (4.5 a) the concept sets the value, and the card says so rather than judge.
 */
export const RENOVATION_FACTOR = 0.76

/** The U-value bound for a component and a measure; null when the measure is not known. */
export const uValueBound = (component: Component, measure: Measure | null | undefined): number | null => {
  const row = U_MAX_NEW_BUILD[component]
  if (measure == null) return null
  // Rounded to the six decimals the table and the factor have, so 0,76 × 0,35 is 0,266 and not 0,26599….
  return measure === 'renovation' ? Number((row.value * RENOVATION_FACTOR).toFixed(6)) : row.value
}

/**
 * The conventional surface resistances, m²K/W, by direction of heat flow
 * (ÖNORM EN ISO 6946:2017, 6.8 and Annex C). Fixed here, not on the wire: they
 * are the standard's statement, and a model that could set them could tune a
 * U-value.
 */
export const SURFACE_RESISTANCE: Record<HeatFlow, { inside: number; outside: number }> = {
  horizontal: { inside: 0.13, outside: 0.04 },
  upward: { inside: 0.1, outside: 0.04 },
  downward: { inside: 0.17, outside: 0.04 },
}

/** OIB-RL 2 Pkt. 5.1.1: at most 40 m Gehweglänge, from the room or (5.1.2) the Wohnungseingangstüre. */
export const ESCAPE_ROUTE_MAX = 40

/** OIB-RL 3 Pkt. 9.1.1, 9.1.3 and 9.1.4: the required Lichteintrittsfläche, as a share of the Bodenfläche. */
export const DAYLIGHT = {
  /** 9.1.1, and 9.1.3 up to an overhang of 1,50 m. */
  base: 12,
  /** 9.1.3, an overhang over 1,50 m. */
  raised: 15,
  raisedFrom: 1.5,
  /** 9.1.3: plus 2 % per started metre of overhang over 3,00 m. */
  perOverhangMetre: 2,
  overhangFrom: 3,
  /** 9.1.4: plus 1 % per started metre of room depth over 5,00 m. */
  perDepthMetre: 1,
  depthFrom: 5,
} as const

/** Where each rule's METHOD is written; each check carries the Punkt of its own bound. */
export const FORMULA_SOURCES: Record<FormulaName, NormReferenceData> = {
  u_value: { document: 'ÖNORM EN ISO 6946', section: 'Abschnitt 6.8, Anhang C', edition: 'EN ISO 6946:2017', excerpt: null },
  stair_step_rule: oib('4', 'Pkt. 3.2.1'),
  escape_route_length: oib('2', 'Pkt. 5.1.1'),
  daylight_ratio: oib('3', 'Pkt. 9.1'),
}

const EPSILON = 1e-9

/**
 * „pro angefangenem Meter“ over `from`: 3,4 m over 3,00 m is one started metre,
 * 4,0 m is one, 4,1 m is two. A residue of floating point at a whole metre does
 * not start another.
 */
export const startedMetres = (value: number, from: number): number => {
  const beyond = value - from
  return beyond <= EPSILON * Math.max(1, from) ? 0 : Math.ceil(beyond - EPSILON)
}

/* ── inputs ───────────────────────────────────────────────────────────────── */

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/**
 * The field's bounds, reconciled with the source's value. Pydantic refuses a
 * value outside its own `min`/`max` and a `min` at or above `max`; the
 * generated Zod schema does not, so a card that arrives that way here drops the
 * bound it breaks rather than showing a source's value as an error. No quantity
 * here is negative, whatever the card says.
 */
const boundsOf = (input: FormulaInputData): { min: number | null; max: number | null } => {
  const value = finite(input.value)
  let min = finite(input.min)
  let max = finite(input.max)
  if (min != null && max != null && min >= max) {
    min = null
    max = null
  }
  if (value != null && min != null && value < min) min = null
  if (value != null && max != null && value > max) max = null
  const lowest = Math.max(0, min ?? 0)
  return { min: value != null && value < lowest ? null : lowest, max }
}

const slot = (
  key: string,
  input: FormulaInputData,
  unit: string,
  labelKey: InputLabel,
  group: string | null = null,
  positive = false
): InputSlot => {
  const step = finite(input.step)
  return {
    key,
    input,
    unit,
    labelKey,
    group,
    ...boundsOf(input),
    step: step != null && step > 0 ? step : null,
    positive,
    editable: input.editable !== false,
  }
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
      return [slot('riser', formula.riser, CM, 'riser'), slot('going', formula.going, CM, 'going')]
    case 'escape_route_length':
      return formula.segments.map((segment, index) =>
        slot(`segments.${index}.length`, segment.length, M, 'length', segment.label)
      )
    case 'daylight_ratio':
      return [
        slot('opening_area', formula.opening_area, M2, 'openingArea'),
        slot('floor_area', formula.floor_area, M2, 'floorArea', null, true),
        slot('room_depth', formula.room_depth, M, 'roomDepth'),
        slot('overhang_depth', formula.overhang_depth, M, 'overhangDepth'),
      ]
    case 'u_value':
      return formula.layers.flatMap((layer, index) => [
        slot(`layers.${index}.thickness`, layer.thickness, CM, 'thickness', layer.label),
        slot(`layers.${index}.conductivity`, layer.conductivity, LAMBDA, 'conductivity', layer.label, true),
      ])
  }
}

/** The values as the source gives them: what „Zurücksetzen“ restores. */
export function sourceValues(formula: FormulaSpec): FormulaValues {
  return Object.fromEntries(inputSlots(formula).map((entry) => [entry.key, finite(entry.input.value)]))
}

/** Which inputs the reader has changed from the source's value. A cleared field is a change too. */
export function changedInputs(source: FormulaValues, current: FormulaValues): Set<string> {
  return new Set(Object.keys(source).filter((key) => !Object.is(source[key], current[key] ?? null)))
}

/* ── compiling a rule to a Rechenweg ──────────────────────────────────────── */

export type LineKey =
  | 'layerResistance'
  | 'totalResistance'
  | 'uValue'
  | 'stepMeasure'
  | 'routeLength'
  | 'daylightShare'
  | 'requiredShare'

export type TermKey =
  | InputLabel
  | 'surfaceInside'
  | 'surfaceOutside'
  | 'layerResistance'
  | 'totalResistance'
  | 'baseShare'
  | 'raisedShare'
  | 'overhangIncrement'
  | 'depthIncrement'

/** The words a compiled Rechenweg is labelled with, supplied by the card from its dictionary. */
export interface FormulaWords {
  line(key: LineKey, group?: string | null): string
  term(key: TermKey, params?: { group?: string | null; metres?: number }): string
}

export type CheckId = 'stepRule' | 'riserMax' | 'goingMin' | 'uMax' | 'routeMax' | 'daylightMin'

/** One bound the rule holds a quantity against, and where it is written. */
export interface CheckSpec {
  id: CheckId
  /** A step's result (0-based), or an input on its own (Tabelle 3 bounds the riser itself). */
  quantity: { kind: 'step'; index: number } | { kind: 'input'; key: string }
  unit: string
  limit: CalculationLimitData
  /** When the bound is itself derived (the required Lichteintrittsfläche): the step whose result it is. */
  boundStep?: number
  reference: NormReferenceData
  /** The inputs the verdict depends on, for the reader's-assumption marker and for "which value is missing". */
  dependsOn: string[]
  /** The bound depends on a case the card was not told (a U-value's `measure`): no verdict, and it says why. */
  unknownCase?: 'measure'
}

export type CaveatKey =
  | 'uValueNewBuild'
  | 'uValueRenovation'
  | 'uValueMeasureUnknown'
  | 'uValueScope'
  | 'routeFromRoom'
  | 'routeFromDwelling'
  | 'routeOnlyGuideline2'
  | 'daylightRoomsOnly'
  | 'daylightAngle'
  | 'daylightOtherLaw'

export interface CompiledFormula {
  steps: CalculationStepData[]
  display: StepDisplay[]
  checks: CheckSpec[]
  caveats: Array<{ key: CaveatKey; params?: Record<string, string> }>
  /** The check whose verdict colours the Rechenweg's last result. */
  tint: CheckId
  /** The input whose 0 makes the rule divide by zero, for the sentence that says so. */
  zeroInput?: InputLabel
}

const at = (values: FormulaValues, key: string): number | null => finite(values[key])

function compileStair(formula: Rule<'stair_step_rule'>, values: FormulaValues, words: FormulaWords): CompiledFormula {
  const row = STAIR_TABLE[formula.stair_type]
  const table = oib('4', `Pkt. 3.2.1, Tabelle 3: ${row.row}`)
  return {
    steps: [
      {
        label: words.line('stepMeasure'),
        operation: 'sum',
        unit: CM,
        operands: [
          { label: words.term('riser'), value: at(values, 'riser'), unit: CM, factor: 2 },
          { label: words.term('going'), value: at(values, 'going'), unit: CM },
        ],
      },
    ],
    display: [{ decimals: 2 }],
    checks: [
      {
        id: 'stepRule',
        quantity: { kind: 'step', index: 0 },
        unit: CM,
        limit: { comparator: 'between', value: STEP_RULE.lower, upper: STEP_RULE.upper },
        reference: oib('4', 'Pkt. 3.2.1'),
        dependsOn: ['riser', 'going'],
      },
      {
        id: 'riserMax',
        quantity: { kind: 'input', key: 'riser' },
        unit: CM,
        limit: { comparator: '<=', value: row.riserMax },
        reference: table,
        dependsOn: ['riser'],
      },
      {
        id: 'goingMin',
        quantity: { kind: 'input', key: 'going' },
        unit: CM,
        limit: { comparator: '>=', value: row.goingMin },
        reference: table,
        dependsOn: ['going'],
      },
    ],
    caveats: [],
    tint: 'stepRule',
  }
}

function compileRoute(
  formula: Rule<'escape_route_length'>,
  values: FormulaValues,
  words: FormulaWords
): CompiledFormula {
  const keys = formula.segments.map((_, index) => `segments.${index}.length`)
  const fromDwelling = formula.start === 'dwelling_entrance'
  return {
    steps: [
      {
        label: words.line('routeLength'),
        operation: 'sum',
        unit: M,
        operands: formula.segments.map((segment, index) => ({
          label: words.term('length', { group: segment.label }),
          value: at(values, keys[index]),
          unit: M,
        })),
      },
    ],
    display: [{ decimals: 2 }],
    checks: [
      {
        id: 'routeMax',
        quantity: { kind: 'step', index: 0 },
        unit: M,
        limit: { comparator: '<=', value: ESCAPE_ROUTE_MAX },
        reference: oib('2', fromDwelling ? 'Pkt. 5.1.1 und 5.1.2' : 'Pkt. 5.1.1'),
        dependsOn: keys,
      },
    ],
    caveats: [{ key: fromDwelling ? 'routeFromDwelling' : 'routeFromRoom' }, { key: 'routeOnlyGuideline2' }],
    tint: 'routeMax',
  }
}

/**
 * The share 9.1.3 and 9.1.4 require, as the terms of a sum: the base (12 %, or
 * 15 % over an overhang of 1,50 m), 2 % per started metre of overhang over
 * 3,00 m, 1 % per started metre of depth over 5,00 m. A term is null when the
 * input it needs is unknown, so the required share (and the verdict) is then
 * undecidable rather than assumed to be 12 %.
 */
export function requiredShareTerms(
  overhang: number | null,
  depth: number | null
): { base: number | null; raised: boolean; overhangMetres: number | null; depthMetres: number | null } {
  const raised = overhang != null && overhang > DAYLIGHT.raisedFrom + EPSILON
  return {
    base: overhang == null ? null : raised ? DAYLIGHT.raised : DAYLIGHT.base,
    raised,
    overhangMetres: overhang == null ? null : startedMetres(overhang, DAYLIGHT.overhangFrom),
    depthMetres: depth == null ? null : startedMetres(depth, DAYLIGHT.depthFrom),
  }
}

function compileDaylight(formula: Rule<'daylight_ratio'>, values: FormulaValues, words: FormulaWords): CompiledFormula {
  const terms = requiredShareTerms(at(values, 'overhang_depth'), at(values, 'room_depth'))
  const steps: CalculationStepData[] = [
    {
      label: words.line('daylightShare'),
      operation: 'percent_ratio',
      unit: PERCENT,
      operands: [
        { label: words.term('openingArea'), value: at(values, 'opening_area'), unit: M2 },
        { label: words.term('floorArea'), value: at(values, 'floor_area'), unit: M2 },
      ],
    },
  ]
  const display: StepDisplay[] = [{ decimals: 2 }]

  const known = terms.base != null && terms.depthMetres != null && terms.overhangMetres != null
  const increments = (terms.overhangMetres ?? 0) + (terms.depthMetres ?? 0)
  let boundStep: number | undefined
  if (!known || increments > 0) {
    const operands: CalculationStepData['operands'] = [
      { label: words.term(terms.raised ? 'raisedShare' : 'baseShare'), value: terms.base, unit: PERCENT },
    ]
    if (terms.overhangMetres == null || terms.overhangMetres > 0) {
      operands.push({
        label: words.term('overhangIncrement', { metres: terms.overhangMetres ?? undefined }),
        value: terms.overhangMetres == null ? null : terms.overhangMetres * DAYLIGHT.perOverhangMetre,
        unit: PERCENT,
      })
    }
    if (terms.depthMetres == null || terms.depthMetres > 0) {
      operands.push({
        label: words.term('depthIncrement', { metres: terms.depthMetres ?? undefined }),
        value: terms.depthMetres == null ? null : terms.depthMetres * DAYLIGHT.perDepthMetre,
        unit: PERCENT,
      })
    }
    steps.unshift({ label: words.line('requiredShare'), operation: 'sum', unit: PERCENT, operands })
    display.unshift({ decimals: 2 })
    boundStep = 0
  }
  const shareIndex = steps.length - 1
  return {
    steps,
    display,
    checks: [
      {
        id: 'daylightMin',
        quantity: { kind: 'step', index: shareIndex },
        unit: PERCENT,
        limit: { comparator: '>=', value: terms.base ?? DAYLIGHT.base },
        boundStep,
        reference: oib('3', 'Pkt. 9.1.1, 9.1.3 und 9.1.4'),
        dependsOn: ['opening_area', 'floor_area', 'room_depth', 'overhang_depth'],
      },
    ],
    caveats: [
      { key: 'daylightRoomsOnly' },
      { key: 'daylightAngle' },
      ...((terms.depthMetres ?? 0) > 0 ? [{ key: 'daylightOtherLaw' as const }] : []),
    ],
    tint: 'daylightMin',
    zeroInput: 'floorArea',
  }
}

/**
 * U = 1 / R_T, R_T = R_si + Σ dᵢ/λᵢ + R_se: a step per layer (its resistance),
 * one for R_T and one for U, so the reader sees which layer carries the
 * resistance — the line that answers „wie viel Dämmung brauche ich“. The
 * thickness is entered in cm and divided by 100 once, here. The resistances
 * print at four FIXED decimals, so the terms of R_T and their sum are at one
 * precision.
 */
function compileUValue(formula: Rule<'u_value'>, values: FormulaValues, words: FormulaWords): CompiledFormula {
  const row = U_MAX_NEW_BUILD[formula.component]
  const surface = SURFACE_RESISTANCE[row.heatFlow]
  const layerSteps: CalculationStepData[] = formula.layers.map((layer, index) => {
    const thickness = at(values, `layers.${index}.thickness`)
    return {
      label: words.line('layerResistance', layer.label),
      operation: 'quotient',
      unit: RESISTANCE,
      operands: [
        { label: words.term('thickness', { group: layer.label }), value: thickness == null ? null : thickness / 100, unit: M },
        { label: words.term('conductivity', { group: layer.label }), value: at(values, `layers.${index}.conductivity`), unit: LAMBDA },
      ],
    }
  })
  const total: CalculationStepData = {
    label: words.line('totalResistance'),
    operation: 'sum',
    unit: RESISTANCE,
    operands: [
      { label: words.term('surfaceInside'), value: surface.inside, unit: RESISTANCE },
      ...formula.layers.map((layer, index) => ({
        label: words.term('layerResistance', { group: layer.label }),
        step: index + 1,
      })),
      { label: words.term('surfaceOutside'), value: surface.outside, unit: RESISTANCE },
    ],
  }
  const transmittance: CalculationStepData = {
    label: words.line('uValue'),
    operation: 'quotient',
    unit: U,
    operands: [
      { label: '', value: 1 },
      { label: words.term('totalResistance'), step: formula.layers.length + 1 },
    ],
  }
  const keys = formula.layers.flatMap((_, index) => [`layers.${index}.thickness`, `layers.${index}.conductivity`])
  const measure = formula.measure ?? null
  const bound = uValueBound(formula.component, measure)
  const section =
    measure === 'renovation' ? `Pkt. 4.5 b) mit Pkt. 4.4.1, Zeile ${row.row}` : `Pkt. 4.4.1, Zeile ${row.row}`
  const measureCaveat: CaveatKey =
    measure === 'renovation' ? 'uValueRenovation' : measure === 'new_build' ? 'uValueNewBuild' : 'uValueMeasureUnknown'
  return {
    steps: [...layerSteps, total, transmittance],
    display: [...layerSteps.map(() => ({ decimals: 4, fixed: true })), { decimals: 4, fixed: true }, { decimals: 3 }],
    checks: [
      {
        id: 'uMax',
        quantity: { kind: 'step', index: formula.layers.length + 1 },
        unit: U,
        limit: { comparator: '<=', value: bound ?? row.value },
        reference: oib('6', section),
        dependsOn: keys,
        ...(bound == null ? { unknownCase: 'measure' as const } : {}),
      },
    ],
    caveats: [{ key: measureCaveat, params: { row: String(row.row) } }, { key: 'uValueScope' }],
    tint: 'uMax',
    zeroInput: 'conductivity',
  }
}

/** The rule as a Rechenweg for these input values, with its checks. Pure. */
export function compileFormula(formula: FormulaSpec, values: FormulaValues, words: FormulaWords): CompiledFormula {
  switch (formula.name) {
    case 'stair_step_rule':
      return compileStair(formula, values, words)
    case 'escape_route_length':
      return compileRoute(formula, values, words)
    case 'daylight_ratio':
      return compileDaylight(formula, values, words)
    case 'u_value':
      return compileUValue(formula, values, words)
  }
}

/* ── judging ──────────────────────────────────────────────────────────────── */

/** One bound, judged against the quantity it names. */
export interface LimitCheck {
  spec: CheckSpec
  quantity: StepResult
  /** The bound as judged; null when a derived bound cannot be computed. */
  limit: CalculationLimitData | null
  status: DimStatus
  /** Decimals the quantity is printed to, so the printed number and the verdict cannot disagree. */
  decimals: number
}

export interface JudgedFormula {
  results: Derivation
  checks: LimitCheck[]
  /** `compiled.display`, widened where a check needs more decimals on that step. */
  display: StepDisplay[]
}

const inputResult = (value: number | null, unit: string): StepResult => ({
  value,
  tolerance: null,
  unit,
  undecidable: value == null ? 'missing' : null,
})

/**
 * Evaluate the compiled steps with `calculation`'s own `evaluate` and judge
 * every bound with its `verdictFor`. A bound that cannot be derived (the
 * required share with an unknown depth) is `needs_input`, never the base 12 %.
 */
export function judgeFormula(compiled: CompiledFormula, values: FormulaValues): JudgedFormula {
  const results = evaluate(compiled.steps)
  const checks = compiled.checks.map((spec): LimitCheck => {
    const quantity =
      spec.quantity.kind === 'step' ? results[spec.quantity.index] : inputResult(at(values, spec.quantity.key), spec.unit)
    const derived = spec.boundStep == null ? undefined : results[spec.boundStep]
    const limit = spec.unknownCase
      ? null
      : derived === undefined
        ? spec.limit
        : derived.value == null
          ? null
          : { ...spec.limit, value: derived.value }
    if (limit == null) return { spec, quantity, limit, status: 'needs_input', decimals: 2 }
    return { spec, quantity, limit, status: verdictFor(quantity, limit) ?? 'needs_input', decimals: resultDecimals(quantity, limit) }
  })
  const display = compiled.display.map((entry, index) => {
    const needed = checks
      .filter((check) => check.spec.quantity.kind === 'step' && check.spec.quantity.index === index)
      .map((check) => check.decimals)
    return needed.length > 0 ? { ...entry, decimals: Math.max(entry.decimals, ...needed) } : entry
  })
  return { results, checks, display }
}
