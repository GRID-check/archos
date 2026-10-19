/**
 * The Gebäudeklasse derivation (`docs/design/agentic-project-intake.md`, „The
 * Gebäudeklasse derivation"). Pure: values in, a class and the inputs that
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
  /** The base keys it reads, per Bauwerk. */
  inputs: readonly string[]
}

/** The base keys the derivation reads, per Bauwerk, in the order `missing` lists them. */
export const GEBAEUDEKLASSE_INPUTS = [
  'bauwerkstyp',
  'gebaeudestellung',
  'zugang_drei_seiten',
  'geschosse_oberirdisch',
  'fluchtniveau_m',
  'bgf_oberirdisch',
  'nutzungseinheiten',
  'einheiten_ueber_400',
  'nutzungen',
] as const
export type GebaeudeklasseInput = (typeof GEBAEUDEKLASSE_INPUTS)[number]

export const GEBAEUDEKLASSE_DERIVATION: DerivationDefinition = {
  rule: 'gebaeudeklasse',
  citation: 'OIB-Richtlinien, Begriffsbestimmungen (Ausgabe Mai 2023), Gebäudeklassen',
  inputs: GEBAEUDEKLASSE_INPUTS,
}

export type Gebaeudeklasse = 1 | 2 | 3 | 4 | 5

/** What a Gebäude can turn out to be: a class, or a Hochhaus, which has none. */
export type GebaeudeklasseOutcome = Gebaeudeklasse | 'hochhaus'

/** Internally also: the Bauwerk is no Gebäude, so it has no class at all. */
type Outcome = GebaeudeklasseOutcome | 'kein_gebaeude'

export interface GebaeudeklasseResult {
  /** The class, or null while an input that matters is missing, for a Hochhaus, or for a Bauwerk that is no Gebäude. */
  value: Gebaeudeklasse | null
  /** Fluchtniveau above 22 m: no Gebäudeklasse. */
  hochhaus: boolean
  /** False when the Bauwerk is known to be no Gebäude (C1 `klein` or `sonstig`): nothing is classified. */
  applicable: boolean
  /** The base keys whose value could still change the outcome ({@link decisiveInputs}). Empty once the outcome is known. */
  missing: GebaeudeklasseInput[]
}

export type GebaeudeklasseInputs = Readonly<Record<string, ProjectPrimitiveValue | undefined>>

type Band = string | number | boolean

interface InputDomain {
  /** The value as the rules read it, or undefined when it is missing or unreadable. */
  read: (raw: ProjectPrimitiveValue | undefined) => Band | undefined
  /** One representative per band, used while the input is missing. */
  bands: readonly Band[]
}

/** The D0 tokens that are residential. „Reines Wohngebäude" means every use of the Bauwerk is one of these. */
const RESIDENTIAL_USES: readonly string[] = ['wohnen']

const GEBAEUDESTELLUNGEN: readonly string[] = ['freistehend', 'angebaut', 'reihenhaus']

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
function readReinesWohnen(raw: ProjectPrimitiveValue | undefined): boolean | undefined {
  const uses = Array.isArray(raw) ? raw : typeof raw === 'string' && raw !== '' ? [raw] : []
  if (uses.length === 0) return undefined
  return uses.every((use) => RESIDENTIAL_USES.includes(use))
}

/**
 * Each input, how it is read, and its bands. The representatives sit on the
 * upper edge of each band where the band is closed („höchstens"), so a
 * boundary value and its band always classify the same way.
 */
const INPUT_DOMAINS: Record<GebaeudeklasseInput, InputDomain> = {
  // Only a Gebäude has a class; any other C1 token stands for „no Gebäude".
  bauwerkstyp: { read: readToken, bands: ['gebaeude', 'sonstig'] },
  gebaeudestellung: {
    read: (raw) => {
      const token = readToken(raw)
      return token && GEBAEUDESTELLUNGEN.includes(token) ? token : undefined
    },
    bands: GEBAEUDESTELLUNGEN,
  },
  zugang_drei_seiten: { read: readBoolean, bands: [true, false] },
  // ≤ 3, 4, ≥ 5
  geschosse_oberirdisch: { read: readNumber, bands: [3, 4, 5] },
  // ≤ 7, (7, 11], (11, 22], > 22
  fluchtniveau_m: { read: readNumber, bands: [7, 11, 22, 23] },
  // ≤ 400, (400, 800], > 800
  bgf_oberirdisch: { read: readNumber, bands: [400, 800, 801] },
  // 1, 2, ≥ 3
  nutzungseinheiten: { read: readNumber, bands: [1, 2, 3] },
  einheiten_ueber_400: { read: readBoolean, bands: [false, true] },
  // rein Wohnen, or not
  nutzungen: { read: readReinesWohnen, bands: [true, false] },
}

/** One combination of bands, as the rules read it. */
interface Bauwerk {
  gebaeude: boolean
  stellung: string
  zugangDreiSeiten: boolean
  geschosse: number
  fluchtniveau: number
  bgf: number
  einheiten: number
  einheitUeber400: boolean
  reinesWohnen: boolean
}

function valueOf(values: readonly Band[], input: GebaeudeklasseInput): Band {
  return values[GEBAEUDEKLASSE_INPUTS.indexOf(input)]
}

function bauwerkFrom(values: readonly Band[]): Bauwerk {
  return {
    gebaeude: valueOf(values, 'bauwerkstyp') === 'gebaeude',
    stellung: String(valueOf(values, 'gebaeudestellung')),
    zugangDreiSeiten: valueOf(values, 'zugang_drei_seiten') === true,
    geschosse: Number(valueOf(values, 'geschosse_oberirdisch')),
    fluchtniveau: Number(valueOf(values, 'fluchtniveau_m')),
    bgf: Number(valueOf(values, 'bgf_oberirdisch')),
    einheiten: Number(valueOf(values, 'nutzungseinheiten')),
    einheitUeber400: valueOf(values, 'einheiten_ueber_400') === true,
    reinesWohnen: valueOf(values, 'nutzungen') === true,
  }
}

/**
 * The common frame of GK 1 to 3, sinngemäß: „Höchstens drei oberirdische
 * Geschoße und Fluchtniveau höchstens 7,00 m".
 */
function isNiedrig(b: Bauwerk): boolean {
  return b.geschosse <= 3 && b.fluchtniveau <= 7
}

/** „Freistehend, an mindestens drei Seiten … für die Feuerwehr zugänglich" (GK 1, GK 2), sinngemäß. */
function isFreistehendZugaenglich(b: Bauwerk): boolean {
  return b.stellung === 'freistehend' && b.zugangDreiSeiten
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
function isGk1(b: Bauwerk): boolean {
  return isNiedrig(b) && isFreistehendZugaenglich(b) && b.bgf <= 400 && b.einheiten <= 2
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
 * holds one Fluchtniveau per Bauwerk, which is used instead. „Reines
 * Wohngebäude": every D0 use is `wohnen`; a garage in the house disqualifies
 * the 800 m² branch, which errs towards the higher class.
 */
function isGk2(b: Bauwerk): boolean {
  if (!isNiedrig(b)) return false
  const reihenhaus = b.stellung === 'reihenhaus' && !b.einheitUeber400
  const freistehendesWohnhaus = isFreistehendZugaenglich(b) && b.reinesWohnen && b.bgf <= 800
  return b.bgf <= 400 || reihenhaus || freistehendesWohnhaus
}

/**
 * GK 4, verbatim: „a) Gebäude mit nicht mehr als vier oberirdischen Geschoßen
 * und mit einem Fluchtniveau von nicht mehr als 11 m, bestehend aus mehreren
 * Wohnungen bzw. mehreren Betriebseinheiten von jeweils nicht mehr als 400 m²
 * Nutzfläche der einzelnen Wohnungen bzw. Betriebseinheiten in den
 * oberirdischen Geschoßen, b) Gebäude mit nicht mehr als vier oberirdischen
 * Geschoßen und mit einem Fluchtniveau von nicht mehr als 11 m, bestehend aus
 * einer Wohnung bzw. einer Betriebseinheit ohne Begrenzung der
 * Brutto-Grundfläche der oberirdischen Geschoße."
 *
 * Approximation: (a) limits each unit's Nutzfläche; the wizard asks C8 on
 * Brutto-Grundfläche, which is never smaller, so a unit „über 400 m² BGF" may
 * still meet (a). That errs towards GK 5. Zero units counts as one.
 */
function isGk4(b: Bauwerk): boolean {
  if (b.geschosse > 4 || b.fluchtniveau > 11) return false
  return b.einheiten <= 1 || !b.einheitUeber400
}

/**
 * GK 3, sinngemäß: „Höchstens drei oberirdische Geschoße und Fluchtniveau
 * höchstens 7,00 m, soweit das Gebäude nicht in GK 1 oder GK 2 fällt."
 * GK 5, sinngemäß: „Fluchtniveau höchstens 22 m, soweit das Gebäude nicht in
 * GK 1 bis 4 fällt. Ein höheres Gebäude fällt in keine der fünf Klassen."
 */
function classify(values: readonly Band[]): Outcome {
  const b = bauwerkFrom(values)
  if (!b.gebaeude) return 'kein_gebaeude'
  if (b.fluchtniveau > 22) return 'hochhaus'
  if (isGk1(b)) return 1
  if (isGk2(b)) return 2
  if (isNiedrig(b)) return 3
  if (isGk4(b)) return 4
  return 5
}

interface Scenario {
  /** One band per input, in {@link GEBAEUDEKLASSE_INPUTS} order. */
  values: readonly Band[]
  outcome: Outcome
}

interface OutcomeSpace {
  open: GebaeudeklasseInput[]
  scenarios: Scenario[]
}

/** Every combination of the open inputs' bands, the known inputs held at their values. */
function outcomeSpace(inputs: GebaeudeklasseInputs): OutcomeSpace {
  const open: GebaeudeklasseInput[] = []
  let combinations: Band[][] = [[]]
  for (const input of GEBAEUDEKLASSE_INPUTS) {
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
function isDecisive(space: OutcomeSpace, input: GebaeudeklasseInput): boolean {
  const index = GEBAEUDEKLASSE_INPUTS.indexOf(input)
  const outcomeByRest = new Map<string, Outcome>()
  for (const { values, outcome } of space.scenarios) {
    const rest = values.map((value, at) => (at === index ? '*' : String(value))).join('|')
    const seen = outcomeByRest.get(rest)
    if (seen === undefined) outcomeByRest.set(rest, outcome)
    else if (seen !== outcome) return true
  }
  return false
}

/** The classes (and Hochhaus) the Bauwerk can still turn out to be. Empty when it is known to be no Gebäude. */
export function possibleGebaeudeklassen(inputs: GebaeudeklasseInputs): Set<GebaeudeklasseOutcome> {
  const outcomes = new Set<GebaeudeklasseOutcome>()
  for (const { outcome } of outcomeSpace(inputs).scenarios) {
    if (outcome !== 'kein_gebaeude') outcomes.add(outcome)
  }
  return outcomes
}

/**
 * The missing inputs whose value could still change the outcome, in
 * {@link GEBAEUDEKLASSE_INPUTS} order. „Outcome" includes being no Gebäude, so
 * an open `bauwerkstyp` is decisive until the class is fixed either way.
 */
export function decisiveInputs(inputs: GebaeudeklasseInputs): GebaeudeklasseInput[] {
  const space = outcomeSpace(inputs)
  return space.open.filter((input) => isDecisive(space, input))
}

/**
 * The Gebäudeklasse of one Bauwerk from its inputs, keyed by base key.
 * Numbers may be numbers or numeric strings; yes/no inputs `true`/`false` or
 * `ja`/`nein` (`offen` is missing); `nutzungen` the D0 tokens.
 */
export function deriveGebaeudeklasse(inputs: GebaeudeklasseInputs): GebaeudeklasseResult {
  const space = outcomeSpace(inputs)
  const outcomes = new Set(space.scenarios.map((scenario) => scenario.outcome))
  const missing = space.open.filter((input) => isDecisive(space, input))
  if (outcomes.size !== 1) return { value: null, hochhaus: false, applicable: true, missing }
  const [outcome] = outcomes
  return {
    value: typeof outcome === 'number' ? outcome : null,
    hochhaus: outcome === 'hochhaus',
    applicable: outcome !== 'kein_gebaeude',
    missing,
  }
}
