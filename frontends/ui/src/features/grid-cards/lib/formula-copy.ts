/**
 * The dictionary keys of the formula card, by the union each one names.
 *
 * Typed maps rather than a `switch` per union: `satisfies Record<Union, …>`
 * makes a missing case a compile error, the way the switches did, in a sixth of
 * the lines. `i18n/key-coverage.spec.ts` reads only literal `t('…')` calls and
 * cannot see a key in a map, so `formula-copy.spec.ts` resolves every key here
 * against both dictionaries instead: a typo is a failing test, not a dot-path
 * on screen.
 *
 * Every key is in the `chat` namespace.
 */

import type { CaveatKey, CheckId, Component, InputLabel, LineKey, Measure, StairType, TermKey } from './formulas'

export const INPUT_KEYS = {
  riser: 'cards.formula.input.riser',
  going: 'cards.formula.input.going',
  thickness: 'cards.formula.input.thickness',
  conductivity: 'cards.formula.input.conductivity',
  length: 'cards.formula.input.length',
  openingArea: 'cards.formula.input.openingArea',
  floorArea: 'cards.formula.input.floorArea',
  roomDepth: 'cards.formula.input.roomDepth',
  overhangDepth: 'cards.formula.input.overhangDepth',
} as const satisfies Record<InputLabel, string>

export const TERM_KEYS = {
  riser: 'cards.formula.term.riser',
  going: 'cards.formula.term.going',
  thickness: 'cards.formula.term.thickness',
  conductivity: 'cards.formula.term.conductivity',
  length: 'cards.formula.term.length',
  openingArea: 'cards.formula.term.openingArea',
  floorArea: 'cards.formula.term.floorArea',
  roomDepth: 'cards.formula.term.roomDepth',
  overhangDepth: 'cards.formula.term.overhangDepth',
  surfaceInside: 'cards.formula.term.surfaceInside',
  surfaceOutside: 'cards.formula.term.surfaceOutside',
  layerResistance: 'cards.formula.term.layerResistance',
  totalResistance: 'cards.formula.term.totalResistance',
  baseShare: 'cards.formula.term.baseShare',
  raisedShare: 'cards.formula.term.raisedShare',
  overhangIncrement: 'cards.formula.term.overhangIncrement',
  depthIncrement: 'cards.formula.term.depthIncrement',
} as const satisfies Record<TermKey, string>

/** The terms that name a count of started metres once it is known. */
export const TERM_METRES_KEYS = {
  overhangIncrement: 'cards.formula.term.overhangIncrementMetres',
  depthIncrement: 'cards.formula.term.depthIncrementMetres',
} as const satisfies Partial<Record<TermKey, string>>

export const LINE_KEYS = {
  layerResistance: 'cards.formula.line.layerResistance',
  totalResistance: 'cards.formula.line.totalResistance',
  uValue: 'cards.formula.line.uValue',
  stepMeasure: 'cards.formula.line.stepMeasure',
  routeLength: 'cards.formula.line.routeLength',
  daylightShare: 'cards.formula.line.daylightShare',
  requiredShare: 'cards.formula.line.requiredShare',
} as const satisfies Record<LineKey, string>

export const CHECK_KEYS = {
  stepRule: 'cards.formula.check.stepRule',
  riserMax: 'cards.formula.check.riserMax',
  goingMin: 'cards.formula.check.goingMin',
  uMax: 'cards.formula.check.uMax',
  routeMax: 'cards.formula.check.routeMax',
  daylightMin: 'cards.formula.check.daylightMin',
} as const satisfies Record<CheckId, string>

export const CAVEAT_KEYS = {
  uValueNewBuild: 'cards.formula.caveat.uValueNewBuild',
  uValueRenovation: 'cards.formula.caveat.uValueRenovation',
  uValueMeasureUnknown: 'cards.formula.caveat.uValueMeasureUnknown',
  uValueScope: 'cards.formula.caveat.uValueScope',
  routeFromRoom: 'cards.formula.caveat.routeFromRoom',
  routeFromDwelling: 'cards.formula.caveat.routeFromDwelling',
  routeOnlyGuideline2: 'cards.formula.caveat.routeOnlyGuideline2',
  daylightRoomsOnly: 'cards.formula.caveat.daylightRoomsOnly',
  daylightAngle: 'cards.formula.caveat.daylightAngle',
  daylightOtherLaw: 'cards.formula.caveat.daylightOtherLaw',
} as const satisfies Record<CaveatKey, string>

export const COMPONENT_KEYS = {
  external_wall: 'cards.formula.component.external_wall',
  roof_or_ceiling_to_outside_air: 'cards.formula.component.roof_or_ceiling_to_outside_air',
  floor_over_outside_air: 'cards.formula.component.floor_over_outside_air',
} as const satisfies Record<Component, string>

export const MEASURE_KEYS = {
  new_build: 'cards.formula.measure.new_build',
  renovation: 'cards.formula.measure.renovation',
} as const satisfies Record<Measure, string>

export const STAIR_TYPE_KEYS = {
  main: 'cards.formula.stairType.main',
  dwelling: 'cards.formula.stairType.dwelling',
  secondary: 'cards.formula.stairType.secondary',
} as const satisfies Record<StairType, string>

/** The symbol a „{quantity} = 0 ist nicht möglich." names, for the inputs that cannot be 0. */
export const ZERO_QUANTITY_KEYS = {
  conductivity: 'cards.formula.zeroQuantity.conductivity',
  floorArea: 'cards.formula.zeroQuantity.floorArea',
} as const satisfies Partial<Record<InputLabel, string>>

/** Every map above, for the spec that resolves them. */
export const FORMULA_KEY_MAPS = {
  INPUT_KEYS,
  TERM_KEYS,
  TERM_METRES_KEYS,
  LINE_KEYS,
  CHECK_KEYS,
  CAVEAT_KEYS,
  COMPONENT_KEYS,
  MEASURE_KEYS,
  STAIR_TYPE_KEYS,
  ZERO_QUANTITY_KEYS,
}
