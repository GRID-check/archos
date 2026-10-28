/**
 * Where a document states a fact the project's profile (the Steckbrief) holds
 * otherwise: the `profile_contradiction` finding (`./findings`,
 * `docs/architecture/document-dossier.md`, „Findings“). Pure: no I/O.
 *
 * Conservative by design. A dossier fact is compared with a profile key only
 * where both mean the same thing, and only with what a person confirmed
 * (`profile.facts`): a suggestion Piloti read from the documents is no
 * yardstick for those documents. A value either side cannot read for certain is
 * no contradiction, it is silence:
 *
 *  - the Gebäudeklasse as its number (`GK 4`, `Gebäudeklasse 4`, `4`);
 *  - storeys as a whole number, as the document writes it alone („4“, not
 *    „4 + DG“);
 *  - the plot area in m² (a German number, 1 % apart before it differs);
 *  - Bauweise, Nutzung and Bundesland as the intake's tokens, through a small
 *    table of words that name exactly one of them; „Massivbau“ is the intake's
 *    own label for masonry, „Mischbauweise“ names nothing.
 *
 * A project of several buildings stores a building's answer as
 * `storeys_above_ground@bldg1`: a document that names any building's value
 * agrees, because nothing says which building it speaks of. A key that lives
 * per use zone (dwelling units, parking spaces) is not compared at all.
 */

import { flattenIntakeQuestions } from '@/lib/project-profile/intake-conditions'
import { projectIntakeDefinitionV1 } from '@/lib/project-profile/intake-definition'
import type { ProjectIntakeQuestion } from '@/lib/project-profile/intake-types'
import { formatIntakeAnswer } from '@/lib/project-profile/intake-vocabulary'
import { normalizeProfileToken } from '@/lib/project-profile/legacy-names'
import type { Dossier, DossierFactKey } from './dossier'

/** What a document can state that the Steckbrief holds too. */
export const PROFILE_COMPARED_KEYS = [
  'building_class',
  'storeys_above_ground',
  'storeys_below_ground',
  'plot_area',
  'construction_method',
  'use',
  'federal_state',
] as const
export type ProfileComparedKey = (typeof PROFILE_COMPARED_KEYS)[number]

type Reading = 'class' | 'count' | 'area' | 'construction' | 'use' | 'state'

/** Each compared key: the profile key it is held under, and how its values are read. */
const COMPARISONS: Readonly<Record<ProfileComparedKey, { profileKey: string; reading: Reading }>> = {
  building_class: { profileKey: 'building_class', reading: 'class' },
  storeys_above_ground: { profileKey: 'storeys_above_ground', reading: 'count' },
  storeys_below_ground: { profileKey: 'storeys_below_ground', reading: 'count' },
  plot_area: { profileKey: 'plot_area', reading: 'area' },
  construction_method: { profileKey: 'construction_method', reading: 'construction' },
  use: { profileKey: 'uses', reading: 'use' },
  federal_state: { profileKey: 'federal_state', reading: 'state' },
}

/** The profile as this module reads it: the confirmed facts only. */
export interface ProfileFacts {
  facts?: Readonly<Record<string, { value?: unknown } | undefined>> | null
}

/** One document's statement that disagrees with the profile. */
export interface ProfileDisagreement {
  /** The value as the document writes it. */
  value: string
  unit: string | null
  /** 1-based; empty when the document does not say (the place has no page). */
  pages: number[]
}

/** The profile's side of one compared key, as a person reads it. */
export interface ProfileSide {
  key: ProfileComparedKey
  /** The profile key it is stored under (`uses`, `federal_state`). */
  profileKey: string
  /**
   * The confirmed value as the intake shows it („Holzbau“, „4“, „1.250 m²“);
   * for the Gebäudeklasse the bare number(s), the copy writes „GK“.
   */
  display: string
}

const valuesOf = (value: unknown): unknown[] =>
  value === null || value === undefined ? [] : Array.isArray(value) ? (value as unknown[]) : [value]

/**
 * Every confirmed value of a profile key: the project-wide key and each
 * building's copy (`storeys_above_ground@bldg1`). A use zone's copy
 * (`x@bldg1@residential`) is the zone's, not the building's, and is not read.
 */
function confirmedValues(profile: ProfileFacts | null, key: string): unknown[] {
  const facts = profile?.facts ?? {}
  return Object.keys(facts)
    .filter((name) => {
      const [base, , zone] = name.split('@')
      return base === key && zone === undefined
    })
    .sort()
    .flatMap((name) => valuesOf(facts[name]?.value))
}

/** Lower case, umlauts and ß spelled out, single spaces: the intake's way of folding a word. */
function fold(value: string): string {
  return value
    .normalize('NFC')
    .trim()
    .toLocaleLowerCase('de')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ')
}

const CLASS_ALONE = /^(?:gk|geb(?:ae)?udeklasse)?\s*([1-5])$/
const CLASS_NAMED = /\b(?:gk|gebaeudeklasse)\s*([1-5])\b/

/** `4`, `GK 4`, `Gebäudeklasse 4`, „lt. OIB-RL 2 Gebäudeklasse 4“ → 4; anything else → null. */
export function buildingClassNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null
  if (typeof value !== 'string') return null
  const text = fold(value)
  const match = CLASS_ALONE.exec(text) ?? CLASS_NAMED.exec(text)
  return match ? Number(match[1]) : null
}

/** A whole number written alone („4“, „4.0“); anything else → null. */
function wholeNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/,0+$/, '').replace(/\.0+$/, '')
  return /^\d{1,3}$/.test(text) ? Number(text) : null
}

/**
 * A German area figure: „1.245,5“, „1245,5“, „1 245“, „1245.5“ → a number;
 * a range, a sum or words → null. A dot followed by three digits and no comma
 * is a thousands separator („1.245“), as an Austrian document writes it.
 */
export function germanNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/[\s  ]/g, '')
  if (!/^\d[\d.,]*$/.test(text)) return null
  let normalized: string
  if (text.includes(',')) normalized = text.replace(/\./g, '').replace(',', '.')
  else if (/^\d{1,3}(\.\d{3})+$/.test(text)) normalized = text.replace(/\./g, '')
  else normalized = text
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null
  return Number(normalized)
}

/** Units a plot area may carry and still be read as m². */
const SQUARE_METRES = new Set(['m²', 'm2', 'qm', 'm^2'])

/** Words that name exactly one Bauweise of the intake (`construction_method`). */
const CONSTRUCTION_WORDS: ReadonlyArray<[RegExp, string]> = [
  [/stahlbeton|\bbetonbau|\bortbeton/, 'reinforced_concrete'],
  [/holz/, 'timber'],
  [/\bstahlbau|\bstahlskelett|\bstahltragwerk/, 'steel'],
  [/mauerwerk|ziegel|\bmassivbau/, 'masonry_solid'],
]

/** Words that name exactly one use of the intake (`uses`). A garage or a plant room is part of many buildings, and says nothing. */
const USE_WORDS: ReadonlyArray<[RegExp, string]> = [
  [/\bwohn/, 'residential'],
  [/\bbuero|\bverwaltung/, 'office'],
  [/\bhandel|\bverkauf|\bgeschaeftslokal/, 'retail'],
  [/\bgastro|\brestaurant|\bcafe\b/, 'catering'],
  [/\bhotel|\bbeherbergung|\bpension\b/, 'lodging'],
  [/\bversammlung|\bveranstaltung/, 'assembly'],
  [/\bschule|\bkindergarten|\bbildung|\bbetreuung/, 'education'],
  [/\bkrankenhaus|\bpflege|\bklinik|\bgesundheit/, 'healthcare'],
  [/\bproduktion|\bgewerbe|\blager\b|\blagerhalle|\bwerkstatt/, 'production'],
  [/\blandwirtschaft/, 'agriculture'],
]

/** The Länder by their short forms, as letterheads and title blocks write them. */
const STATE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  noe: 'lower_austria',
  ooe: 'upper_austria',
  stmk: 'styria',
  ktn: 'carinthia',
  sbg: 'salzburg',
  vbg: 'vorarlberg',
  bgld: 'burgenland',
}

const AUSTRIAN_STATES: ReadonlySet<string> = new Set([
  'vienna',
  'lower_austria',
  'upper_austria',
  'styria',
  'carinthia',
  'salzburg',
  'tyrol',
  'vorarlberg',
  'burgenland',
])

function tokensOf(text: string, words: ReadonlyArray<[RegExp, string]>): string[] {
  const folded = fold(text)
  return [...new Set(words.filter(([pattern]) => pattern.test(folded)).map(([, token]) => token))]
}

/** A Land as the intake's token: „Niederösterreich“, „NÖ“, „Bundesland Salzburg“ → its token; anything else → null. */
export function federalStateToken(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const folded = fold(value).replace(/^bundesland /, '').replace(/\.$/, '')
  const token = STATE_ABBREVIATIONS[folded] ?? normalizeProfileToken('federal_state', folded.replace(/ /g, '_'))
  return AUSTRIAN_STATES.has(token) ? token : null
}

/** A profile value as the token the intake stores, legacy German tokens included. */
function profileTokens(values: readonly unknown[], profileKey: string): string[] {
  return values
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map((value) => normalizeProfileToken(profileKey, fold(value)))
    .filter((token) => token !== 'open')
}

/** How one compared key reads a value: a set of comparable tokens, or null when it cannot be read. */
interface Reader {
  document(value: string, unit: string | null): string[] | null
  profile(values: readonly unknown[], profileKey: string): string[]
  /** Does the document's reading disagree with the profile's? Both non-empty. */
  disagrees(document: readonly string[], profile: readonly string[]): boolean
}

const noOverlap = (a: readonly string[], b: readonly string[]): boolean => !a.some((value) => b.includes(value))

const numbers = (values: readonly unknown[], read: (value: unknown) => number | null): string[] =>
  [...new Set(values.map(read).filter((value): value is number => value !== null))].map(String)

const READERS: Readonly<Record<Reading, Reader>> = {
  class: {
    document: (value) => {
      const number = buildingClassNumber(value)
      return number === null ? null : [String(number)]
    },
    profile: (values) => numbers(values, buildingClassNumber),
    disagrees: noOverlap,
  },
  count: {
    document: (value) => {
      const number = wholeNumber(value)
      return number === null ? null : [String(number)]
    },
    profile: (values) => numbers(values, wholeNumber),
    disagrees: noOverlap,
  },
  area: {
    document: (value, unit) => {
      if (unit !== null && !SQUARE_METRES.has(unit.trim().toLowerCase())) return null
      const number = germanNumber(value)
      return number === null || number <= 0 ? null : [String(number)]
    },
    profile: (values) => numbers(values, germanNumber),
    // A rounded figure is the same plot: 1 % apart before it differs.
    disagrees: (document, profile) =>
      !document.some((a) => profile.some((b) => Math.abs(Number(a) - Number(b)) <= 0.01 * Math.max(Number(a), Number(b)))),
  },
  construction: {
    document: (value) => {
      const tokens = tokensOf(value, CONSTRUCTION_WORDS)
      return tokens.length > 0 ? tokens : null
    },
    profile: profileTokens,
    disagrees: noOverlap,
  },
  use: {
    document: (value) => {
      const tokens = tokensOf(value, USE_WORDS)
      return tokens.length > 0 ? tokens : null
    },
    profile: profileTokens,
    disagrees: noOverlap,
  },
  state: {
    document: (value) => {
      const token = federalStateToken(value)
      return token ? [token] : null
    },
    // Only a Land: a site abroad, or „offen“, is no answer to compare with.
    profile: (values) => [...new Set(values.map(federalStateToken).filter((token): token is string => token !== null))],
    disagrees: noOverlap,
  },
}

let questionsByKey: Map<string, ProjectIntakeQuestion> | null = null

/** The intake question that writes a profile key, for its option labels and unit. */
function questionFor(profileKey: string): ProjectIntakeQuestion | null {
  if (!questionsByKey) {
    questionsByKey = new Map()
    for (const question of flattenIntakeQuestions(projectIntakeDefinitionV1)) {
      const match = /^\/facts\/([a-z_]+)\/value$/.exec(question.writesTo ?? '')
      if (match && !questionsByKey.has(match[1])) questionsByKey.set(match[1], question)
    }
  }
  return questionsByKey.get(profileKey) ?? null
}

/** The profile's confirmed values as a person reads them, or null when the key holds nothing comparable. */
function profileSide(profile: ProfileFacts | null, key: ProfileComparedKey): { side: ProfileSide; tokens: string[] } | null {
  const { profileKey, reading } = COMPARISONS[key]
  const raw = confirmedValues(profile, profileKey)
  const tokens = READERS[reading].profile(raw, profileKey)
  if (tokens.length === 0) return null
  const question = questionFor(profileKey)
  let display: string
  if (reading === 'class') display = tokens.join(', ')
  else if (reading === 'state' || reading === 'construction' || reading === 'use')
    display = tokens
      .map((token) =>
        question ? formatIntakeAnswer(question, question.type === 'multi_select' ? [token] : token) : token
      )
      .join(', ')
  else
    display = tokens
      .map((token) => (question ? formatIntakeAnswer(question, Number(token)) : token))
      .join(', ')
  return { side: { key, profileKey, display }, tokens }
}

/** What one document states for each compared key: its facts, and the Land of its place. */
function statementsOf(dossier: Dossier | null): Map<ProfileComparedKey, ProfileDisagreement[]> {
  const statements = new Map<ProfileComparedKey, ProfileDisagreement[]>()
  const add = (key: ProfileComparedKey, statement: ProfileDisagreement) =>
    statements.set(key, [...(statements.get(key) ?? []), statement])
  for (const fact of dossier?.facts ?? []) {
    if (!(PROFILE_COMPARED_KEYS as readonly string[]).includes(fact.key)) continue
    add(fact.key as ProfileComparedKey & DossierFactKey, {
      value: fact.value,
      unit: fact.unit,
      pages: fact.page === null ? [] : [fact.page],
    })
  }
  if (dossier?.place?.state) add('federal_state', { value: dossier.place.state, unit: null, pages: [] })
  return statements
}

/** One compared key on which a document disagrees with the profile. */
export interface DocumentProfileDisagreement {
  profile: ProfileSide
  /** The document's statements of the key that agree with no profile value; values merged, pages joined. */
  statements: ProfileDisagreement[]
}

/**
 * The compared keys on which one document's dossier disagrees with the
 * profile. A document that states a key more than once (a storey count per
 * building) disagrees only when none of its statements agrees: it may be
 * speaking of another building.
 */
export function profileDisagreements(dossier: Dossier | null, profile: ProfileFacts | null): DocumentProfileDisagreement[] {
  if (!dossier || !profile?.facts) return []
  const found: DocumentProfileDisagreement[] = []
  for (const [key, statements] of statementsOf(dossier)) {
    const side = profileSide(profile, key)
    if (!side) continue
    const reader = READERS[COMPARISONS[key].reading]
    const read = statements
      .map((statement) => ({ statement, tokens: reader.document(statement.value, statement.unit) }))
      .filter((entry): entry is { statement: ProfileDisagreement; tokens: string[] } => entry.tokens !== null)
    if (read.length === 0) continue
    if (read.some(({ tokens }) => !reader.disagrees(tokens, side.tokens))) continue
    found.push({ profile: side.side, statements: mergeStatements(read.map(({ statement }) => statement)) })
  }
  return found.sort((a, b) => PROFILE_COMPARED_KEYS.indexOf(a.profile.key) - PROFILE_COMPARED_KEYS.indexOf(b.profile.key))
}

/** One statement per value as written, its pages joined and ascending. */
function mergeStatements(statements: readonly ProfileDisagreement[]): ProfileDisagreement[] {
  const byValue = new Map<string, ProfileDisagreement>()
  for (const statement of statements) {
    const identity = fold(statement.value)
    const known = byValue.get(identity)
    if (!known) {
      byValue.set(identity, { ...statement, pages: [...statement.pages] })
      continue
    }
    known.pages = [...new Set([...known.pages, ...statement.pages])].sort((a, b) => a - b)
  }
  return [...byValue.values()]
}
