/**
 * The Gebäudeklasse derivation (`docs/design/agentic-project-intake.md`, „The
 * building class derivation"). Pure: values in, a class and the inputs that
 * still matter out.
 *
 * Source of record: OIB-Richtlinien, Begriffsbestimmungen, Ausgabe Mai 2023.
 * The repo holds GK 4 verbatim and the office's published reading of GK 1 to 5
 * („sinngemäß", `frontends/web/src/data/landing/glossar.ts`, „Die fünf
 * Gebäudeklassen in Kürze"). Each rule below names which of the two it
 * encodes. The Richtlinie and the `gebaeudeklasse` skill stay the authority;
 * where this code and the Wortlaut disagree, the Wortlaut wins.
 *
 * Missing inputs are evaluated by bands (design, „Decisions the review
 * settled" 5): metres and m² have infinitely many values, but the rules only
 * compare them with a handful of thresholds, so one value per band stands for
 * the whole band. The class is known when every combination of the missing
 * inputs' bands gives the same outcome.
 */

import type { ProjectPrimitiveValue } from '@/lib/project-profile/types'
import type { DerivationRule } from './types'

export interface DerivationDefinition {
  rule: DerivationRule
  /** The Fundstelle the derivation's evidence names. */
  citation: string
  /** The base keys it reads, per Building. */
  inputs: readonly string[]
}

/** The base keys the derivation reads, per Building, in the order `missing` lists them. */
export const BUILDING_CLASS_INPUTS = [
  'building_type',
  'building_position',
  'access_three_sides',
  'storeys_above_ground',
  'escape_level_m',
  'gfa_above_ground',
  'use_units',
  'units_over_400',
  'uses',
] as const
export type BuildingClassInput = (typeof BUILDING_CLASS_INPUTS)[number]

export const BUILDING_CLASS_DERIVATION: DerivationDefinition = {
  rule: 'building_class',
  citation: 'OIB-Richtlinien, Begriffsbestimmungen (Ausgabe Mai 2023), Gebäudeklassen',
  inputs: BUILDING_CLASS_INPUTS,
}

export type BuildingClass = 1 | 2 | 3 | 4 | 5

/** What a building can turn out to be: a class, or a Hochhaus, which has none. */
export type BuildingClassOutcome = BuildingClass | 'hochhaus'

/** Internally also: the Building is no building, so it has no class at all. */
type Outcome = BuildingClassOutcome | 'no_building'

export interface BuildingClassResult {
  /** The class, or null while an input that matters is missing, for a Hochhaus, or for a Building that is no building. */
  value: BuildingClass | null
  /** Fluchtniveau above 22 m: no building class. */
  hochhaus: boolean
  /** False when the Building is known to be no building (C1 `small` or `other`): nothing is classified. */
  applicable: boolean
  /** The base keys whose value could still change the outcome ({@link decisiveInputs}). Empty once the outcome is known. */
  missing: BuildingClassInput[]
}

export type BuildingClassInputs = Readonly<Record<string, ProjectPrimitiveValue | undefined>>

type Band = string | number | boolean

interface InputDomain {
  /** The value as the rules read it, or undefined when it is missing or unreadable. */
  read: (raw: ProjectPrimitiveValue | undefined) => Band | undefined
  /** One representative per band, used while the input is missing. */
  bands: readonly Band[]
}

/** The D0 tokens that are residential. „Reines Wohngebäude" means every use of the Building is one of these. */
const RESIDENTIAL_USES: readonly string[] = ['residential']

const BUILDING_POSITIONS: readonly string[] = ['freestanding', 'attached', 'terraced']

function readNumber(raw: ProjectPrimitiveValue | undefined): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** `true` / `false` as the profile stores a yes_no_open answer, or `ja` / `nein` as the wizard holds it. `offen` is missing. */
function readBoolean(raw: ProjectPrimitiveValue | undefined): boolean | undefined {
  if (typeof raw === 'boolean') return raw
  if (raw === 'ja') return true
  if (raw === 'nein') return false
  return undefined
}

function readToken(raw: ProjectPrimitiveValue | undefined): string | undefined {
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

/** D0's uses, reduced to the one thing the rules ask of them: is every use residential? */
function readPurelyResidential(raw: ProjectPrimitiveValue | undefined): boolean | undefined {
  const uses = Array.isArray(raw) ? raw : typeof raw === 'string' && raw !== '' ? [raw] : []
  if (uses.length === 0) return undefined
  return uses.every((use) => RESIDENTIAL_USES.includes(use))
}

/**
 * Each input, how it is read, and its bands. The representatives sit on the
 * upper edge of each band where the band is closed („höchstens"), so a
 * boundary value and its band always classify the same way.
 */
const INPUT_DOMAINS: Record<BuildingClassInput, InputDomain> = {
  // Only a Gebäude has a class; any other C1 token stands for „no Gebäude".
  building_type: { read: readToken, bands: ['building', 'other'] },
  building_position: {
    read: (raw) => {
      const token = readToken(raw)
      return token && BUILDING_POSITIONS.includes(token) ? token : undefined
    },
    bands: BUILDING_POSITIONS,
  },
  access_three_sides: { read: readBoolean, bands: [true, false] },
  // ≤ 3, 4, ≥ 5
  storeys_above_ground: { read: readNumber, bands: [3, 4, 5] },
  // ≤ 7, (7, 11], (11, 22], > 22
  escape_level_m: { read: readNumber, bands: [7, 11, 22, 23] },
  // ≤ 400, (400, 800], > 800
  gfa_above_ground: { read: readNumber, bands: [400, 800, 801] },
  // 1, 2, ≥ 3
  use_units: { read: readNumber, bands: [1, 2, 3] },
  units_over_400: { read: readBoolean, bands: [false, true] },
  // rein Wohnen, or not
  uses: { read: readPurelyResidential, bands: [true, false] },
}

/** One combination of bands, as the rules read it. */
interface Building {
  isBuilding: boolean
  position: string
  threeSidedAccess: boolean
  storeys: number
  escapeLevel: number
  grossFloorArea: number
  units: number
  unitOver400: boolean
  purelyResidential: boolean
}

function valueOf(values: readonly Band[], input: BuildingClassInput): Band {
  return values[BUILDING_CLASS_INPUTS.indexOf(input)]
}

function buildingFrom(values: readonly Band[]): Building {
  return {
    isBuilding: valueOf(values, 'building_type') === 'building',
    position: String(valueOf(values, 'building_position')),
    threeSidedAccess: valueOf(values, 'access_three_sides') === true,
    storeys: Number(valueOf(values, 'storeys_above_ground')),
    escapeLevel: Number(valueOf(values, 'escape_level_m')),
    grossFloorArea: Number(valueOf(values, 'gfa_above_ground')),
    units: Number(valueOf(values, 'use_units')),
    unitOver400: valueOf(values, 'units_over_400') === true,
    purelyResidential: valueOf(values, 'uses') === true,
  }
}

/**
 * The common frame of GK 1 to 3, sinngemäß: „Höchstens drei oberirdische
 * Geschoße und Fluchtniveau höchstens 7,00 m".
 */
function isLow(b: Building): boolean {
  return b.storeys <= 3 && b.escapeLevel <= 7
}

/** „Freistehend, an mindestens drei Seiten … für die Feuerwehr zugänglich" (GK 1, GK 2), sinngemäß. */
function isDetachedAccessible(b: Building): boolean {
  return b.position === 'freestanding' && b.threeSidedAccess
}

/**
 * GK 1, sinngemäß: „Freistehend, an mindestens drei Seiten auf eigenem Grund
 * oder von Verkehrsflächen für die Feuerwehr zugänglich. Höchstens drei
 * oberirdische Geschoße, Fluchtniveau höchstens 7,00 m, insgesamt höchstens
 * 400 m² Brutto-Grundfläche der oberirdischen Geschoße, höchstens zwei
 * Wohnungen oder eine Betriebseinheit."
 *
 * Approximation: the wizard counts Wohnungen and Betriebseinheiten together
 * (C7), so „höchstens zwei Wohnungen oder eine Betriebseinheit" is read as at
 * most two units. Two Betriebseinheiten therefore read as GK 1 where the
 * Wortlaut gives GK 2.
 */
function isBuildingClass1(b: Building): boolean {
  return isLow(b) && isDetachedAccessible(b) && b.grossFloorArea <= 400 && b.units <= 2
}

/**
 * GK 2, sinngemäß: „Höchstens drei oberirdische Geschoße und Fluchtniveau
 * höchstens 7,00 m, und dazu entweder insgesamt höchstens 400 m²
 * Brutto-Grundfläche, oder ein Reihenhaus mit Einheiten von je höchstens
 * 400 m², oder ein freistehendes, von drei Seiten zugängliches reines
 * Wohngebäude mit insgesamt höchstens 800 m²."
 *
 * Reihenhaus: the per-unit limit is read from C8 (any unit above 400 m² BGF).
 * The Reihenhaus definition has each unit's own Fluchtniveau count; the wizard
 * holds one Fluchtniveau per Building, which is used instead. „Reines
 * Wohngebäude": every D0 use is `residential`; a garage in the house disqualifies
 * the 800 m² branch, which errs towards the higher class.
 */
function isBuildingClass2(b: Building): boolean {
  if (!isLow(b)) return false
  const terracedHouse = b.position === 'terraced' && !b.unitOver400
  const detachedHouse = isDetachedAccessible(b) && b.purelyResidential && b.grossFloorArea <= 800
  return b.grossFloorArea <= 400 || terracedHouse || detachedHouse
}

/**
 * GK 4, verbatim: „a) Gebäude mit nicht mehr als vier oberirdischen Geschoßen
 * und mit einem Fluchtniveau von nicht mehr als 11 m, bestehend aus mehreren
 * Wohnungen bzw. mehreren Betriebseinheiten von jeweils nicht mehr als 400 m²
 * Nutzfläche der einzelnen Wohnungen bzw. Betriebseinheiten in den
 * oberirdischen Geschoßen, b) building mit nicht mehr als vier oberirdischen
 * Geschoßen und mit einem Fluchtniveau von nicht mehr als 11 m, bestehend aus
 * einer Wohnung bzw. einer Betriebseinheit ohne Begrenzung der
 * Brutto-Grundfläche der oberirdischen Geschoße."
 *
 * Approximation: (a) limits each unit's Nutzfläche; the wizard asks C8 on
 * Brutto-Grundfläche, which is never smaller, so a unit „über 400 m² BGF" may
 * still meet (a). That errs towards GK 5. Zero units counts as one.
 */
function isBuildingClass4(b: Building): boolean {
  if (b.storeys > 4 || b.escapeLevel > 11) return false
  return b.units <= 1 || !b.unitOver400
}

/**
 * GK 3, sinngemäß: „Höchstens drei oberirdische Geschoße und Fluchtniveau
 * höchstens 7,00 m, soweit das building nicht in GK 1 oder GK 2 fällt."
 * GK 5, sinngemäß: „Fluchtniveau höchstens 22 m, soweit das Gebäude nicht in
 * GK 1 bis 4 fällt. Ein höheres building fällt in keine der fünf Klassen."
 */
function classify(values: readonly Band[]): Outcome {
  const b = buildingFrom(values)
  if (!b.isBuilding) return 'no_building'
  if (b.escapeLevel > 22) return 'hochhaus'
  if (isBuildingClass1(b)) return 1
  if (isBuildingClass2(b)) return 2
  if (isLow(b)) return 3
  if (isBuildingClass4(b)) return 4
  return 5
}

interface Scenario {
  /** One band per input, in {@link BUILDING_CLASS_INPUTS} order. */
  values: readonly Band[]
  outcome: Outcome
}

interface OutcomeSpace {
  open: BuildingClassInput[]
  scenarios: Scenario[]
}

/** Every combination of the open inputs' bands, the known inputs held at their values. */
function outcomeSpace(inputs: BuildingClassInputs): OutcomeSpace {
  const open: BuildingClassInput[] = []
  let combinations: Band[][] = [[]]
  for (const input of BUILDING_CLASS_INPUTS) {
    const domain = INPUT_DOMAINS[input]
    const known = domain.read(inputs[input])
    if (known === undefined) open.push(input)
    const choices = known === undefined ? domain.bands : [known]
    combinations = combinations.flatMap((prefix) => choices.map((choice) => [...prefix, choice]))
  }
  return { open, scenarios: combinations.map((values) => ({ values, outcome: classify(values) })) }
}

/**
 * An open input is decisive when some assignment of bands to the OTHER open
 * inputs exists under which two of its own bands give different outcomes. A
 * known input is never decisive. Every open input whose value can still flip
 * the outcome is listed, so the outcome is known exactly when none is.
 */
function isDecisive(space: OutcomeSpace, input: BuildingClassInput): boolean {
  const index = BUILDING_CLASS_INPUTS.indexOf(input)
  const outcomeByRest = new Map<string, Outcome>()
  for (const { values, outcome } of space.scenarios) {
    const rest = values.map((value, at) => (at === index ? '*' : String(value))).join('|')
    const seen = outcomeByRest.get(rest)
    if (seen === undefined) outcomeByRest.set(rest, outcome)
    else if (seen !== outcome) return true
  }
  return false
}

/** The classes (and Hochhaus) the Building can still turn out to be. Empty when it is known to be no building. */
export function possibleBuildingClasses(inputs: BuildingClassInputs): Set<BuildingClassOutcome> {
  const outcomes = new Set<BuildingClassOutcome>()
  for (const { outcome } of outcomeSpace(inputs).scenarios) {
    if (outcome !== 'no_building') outcomes.add(outcome)
  }
  return outcomes
}

/**
 * The missing inputs whose value could still change the outcome, in
 * {@link BUILDING_CLASS_INPUTS} order. „Outcome" includes being no Gebäude, so
 * an open `building_type` is decisive until the class is fixed either way.
 */
export function decisiveInputs(inputs: BuildingClassInputs): BuildingClassInput[] {
  const space = outcomeSpace(inputs)
  return space.open.filter((input) => isDecisive(space, input))
}

/**
 * The building class of one Building from its inputs, keyed by base key.
 * Numbers may be numbers or numeric strings; yes/no inputs `true`/`false` or
 * `ja`/`nein` (`offen` is missing); `uses` the D0 tokens.
 */
export function deriveBuildingClass(inputs: BuildingClassInputs): BuildingClassResult {
  const space = outcomeSpace(inputs)
  const outcomes = new Set(space.scenarios.map((scenario) => scenario.outcome))
  const missing = space.open.filter((input) => isDecisive(space, input))
  if (outcomes.size !== 1) return { value: null, hochhaus: false, applicable: true, missing }
  const [outcome] = outcomes
  return {
    value: typeof outcome === 'number' ? outcome : null,
    hochhaus: outcome === 'hochhaus',
    applicable: outcome !== 'no_building',
    missing,
  }
}
