/**
 * How alike two projects are, for the office's reference projects
 * (docs/design/cross-project-escalation.md): which past projects the agent is
 * told about at the start of a turn, and the order a `similar` search walks.
 *
 * Read off the confirmed profile facts in the shape the intake wizard stores
 * them (where a key has no fact, off the suggestion read from the project's
 * documents, `docs/design/closed-project-experience.md`): a building's
 * answers carry its instance (`construction_method@bldg1`), and a project
 * of several buildings is read as all of them, so a GK 4 timber house with a
 * masonry annex resembles both a timber and a masonry project. Weighted by what decides whether a past
 * solution carries over: the Bundesland outweighs any single trait (it decides
 * which OIB edition and which Bauordnung apply), then the Gebäudeklasse, the
 * Bauweise, the uses and the kind of work; a building that matches in class,
 * construction and use in another Land still outranks a mere neighbour. A project with no facts in common scores 0 and is ordered
 * by recency alone. Pure: no I/O, no clock.
 */

import type { Project } from '@/lib/db/schema/projects'
import { normalizeProfileToken } from '@/lib/project-profile/legacy-names'

/** The facts the ranking reads, by profile key. */
export interface SimilarityFacts {
  federal_state: string | null
  /** Every building's class, ascending; one per building that has one. */
  building_class: readonly number[]
  /** A multi-select in the intake (a hybrid is „holzbau" and „stahlbeton"). */
  construction_method: readonly string[]
  uses: readonly string[]
  /** A multi-select too (Neubau and Zubau); an older profile may hold one token. */
  work_type: readonly string[]
}

type Profile = Pick<Project, 'profile'>['profile']

/** A stored value as the list the ranking reads: a multi-select's entries, a single value as one, nothing for null. */
function valuesOf(value: unknown): unknown[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? (value as unknown[]) : [value]
}

/**
 * Every stored value of a fact: the project-wide key and each building's copy
 * (`construction_method@bldg1`), multi-selects flattened, in key order. A use zone's copy
 * (`x@bldg1@residential`) is that zone's detail, not the building's, and is not read.
 */
function factValues(profile: Profile | null, key: string): unknown[] {
  const facts = profile?.facts ?? {}
  return Object.keys(facts)
    .filter((name) => {
      const [base, , zone] = name.split('@')
      return base === key && zone === undefined
    })
    .sort()
    .flatMap((name) => valuesOf(facts[name]?.value))
}

/**
 * What the ranking reads for one fingerprint key: its confirmed facts when they
 * hold any value, else the agent's suggestion from the project's documents (an
 * unconfirmed assumption with source `agent_suggested`). A wizard default
 * (`onboarding_default`) is no evidence and is never read. A confirmed fact
 * wins even where it says „offen": the person decided, and a suggestion does not
 * overrule that.
 */
function readKey(profile: Profile | null, key: string): unknown[] {
  const confirmed = factValues(profile, key)
  if (confirmed.length > 0) return confirmed
  const suggestion = profile?.assumptions?.[key]
  return suggestion?.source === 'agent_suggested' ? valuesOf(suggestion.value) : []
}

/**
 * A value as the intake's token: lower case, umlauts and ß spelled out, so a
 * label („Niederösterreich") and its token („niederoesterreich") are one value.
 */
function token(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  return value
    .trim()
    .toLocaleLowerCase('de')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
}

/** The intake's answer for a site abroad: no Land, so two such projects share no jurisdiction. */
const ABROAD = 'outside_austria'

/** The project's Bundesland as the intake stores it, folded to its token; `outside_austria` is kept as the answer it is. */
export function federalStateOf(profile: Profile | null): string | null {
  return tokens(factValues(profile, 'federal_state'), 'federal_state')[0] ?? null
}

/** The Land the ranking compares: a site abroad has none, so two such projects share no jurisdiction. */
function comparedState(profile: Profile | null): string | null {
  const found = tokens(readKey(profile, 'federal_state'), 'federal_state')[0] ?? null
  return found === ABROAD ? null : found
}

/** The classes the OIB-RL defines, and all `ProjectFacts.building_class` in `models/requests.py` accepts. */
const LOWEST_CLASS = 1
const HIGHEST_CLASS = 5

/** A class on its own: `4`, `GK4`, `GK 4`, `Gebäudeklasse 4`. */
const CLASS_ALONE = /^(?:gk|geb(?:ä|ae)udeklasse)?\s*([1-5])$/i
/** A class a longer note names: „Fluchtniveau 8 m → GK4" is GK 4, not 8. */
const CLASS_NAMED = /\bgk\s*([1-5])\b/i

/**
 * `4`, `"4"`, `"GK4"`, `"GK 4"`, `"Fluchtniveau 8 m → GK4"` → 4; anything that
 * names no class from 1 to 5 → null. A class outside that range is no
 * Gebäudeklasse, and the Python tier refuses it (a 422 on the upload).
 */
function buildingClassOf(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= LOWEST_CLASS && value <= HIGHEST_CLASS ? value : null
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  const match = CLASS_ALONE.exec(text) ?? CLASS_NAMED.exec(text)
  return match ? Number(match[1]) : null
}

/** The intake's „noch offen": an answer that says nothing about the building. */
export const UNDECIDED = 'open'

/**
 * Values of `key` as distinct tokens, „offen" left out. A label folds to the
 * German token it spelled out (`Niederösterreich` → `niederoesterreich`), which
 * the key's legacy table then names in English: one value however it was written.
 */
function tokens(values: readonly unknown[], key: string): string[] {
  const found = values
    .map(token)
    .filter((entry): entry is string => entry !== null)
    .map((entry) => normalizeProfileToken(key, entry))
    .filter((entry) => entry !== UNDECIDED)
  return [...new Set(found)]
}

function overlap(a: readonly string[], b: readonly string[]): string[] {
  return a.filter((entry) => b.includes(entry))
}

/**
 * The facts of one profile the ranking reads; missing or malformed facts read
 * as unknown, and a suggestion stands in where no fact does.
 */
export function similarityFacts(profile: Profile | null): SimilarityFacts {
  return {
    federal_state: comparedState(profile),
    building_class: [
      ...new Set(
        readKey(profile, 'building_class')
          .map(buildingClassOf)
          .filter((value): value is number => value !== null)
      ),
    ].sort((a, b) => a - b),
    construction_method: tokens(readKey(profile, 'construction_method'), 'construction_method'),
    uses: tokens(readKey(profile, 'uses'), 'uses'),
    work_type: tokens(readKey(profile, 'work_type'), 'work_type'),
  }
}

/** The facts a person confirmed, suggestions left out: what {@link similarityFacts} reads with no document reading. */
export function confirmedSimilarityFacts(profile: Profile | null): SimilarityFacts {
  return similarityFacts(profile ? { ...profile, assumptions: {} } : null)
}

/** The weights, exported so the spec states the order they produce. */
export const SIMILARITY_WEIGHTS = {
  federalState: 4,
  buildingClass: 3,
  buildingClassAdjacent: 1,
  constructionMethod: 2,
  use: 1,
  useMax: 2,
  workType: 1,
} as const

/** The smallest class distance between any building of one and any of the other; null when either knows none. */
function closestClass(a: readonly number[], b: readonly number[]): number | null {
  const distances = a.flatMap((x) => b.map((y) => Math.abs(x - y)))
  return distances.length > 0 ? Math.min(...distances) : null
}

/** How alike `candidate` is to `current`; 0 when either side knows nothing. */
export function similarity(current: SimilarityFacts, candidate: SimilarityFacts): number {
  const w = SIMILARITY_WEIGHTS
  let score = 0
  if (current.federal_state && current.federal_state === candidate.federal_state) score += w.federalState
  const distance = closestClass(current.building_class, candidate.building_class)
  if (distance === 0) score += w.buildingClass
  else if (distance === 1) score += w.buildingClassAdjacent
  if (overlap(current.construction_method, candidate.construction_method).length > 0) score += w.constructionMethod
  const shared = overlap(current.uses, candidate.uses).length
  score += Math.min(shared * w.use, w.useMax)
  if (overlap(current.work_type, candidate.work_type).length > 0) score += w.workType
  return score
}

/** A fact two projects share, by profile key and token (the Gebäudeklasse as its number). */
export interface SharedTrait {
  key: keyof SimilarityFacts
  value: string
}

/**
 * What the facts have in common, in the order the ranking weighs them: every
 * fact that scored, so a reader is never shown a project ranked up for a reason
 * the list leaves out. A neighbouring Gebäudeklasse scores a little but is not
 * shared, and is not named.
 */
export function sharedTraits(current: SimilarityFacts, candidate: SimilarityFacts): SharedTrait[] {
  const traits: SharedTrait[] = []
  if (current.federal_state && current.federal_state === candidate.federal_state) {
    traits.push({ key: 'federal_state', value: candidate.federal_state })
  }
  for (const value of current.building_class.filter((gk) => candidate.building_class.includes(gk))) {
    traits.push({ key: 'building_class', value: String(value) })
  }
  for (const value of overlap(current.construction_method, candidate.construction_method)) traits.push({ key: 'construction_method', value })
  for (const value of overlap(current.uses, candidate.uses)) traits.push({ key: 'uses', value })
  for (const value of overlap(current.work_type, candidate.work_type)) traits.push({ key: 'work_type', value })
  return traits
}

/** Whether `facts` hold this trait's value, so a caller can ask it of the confirmed facts alone. */
export function holdsTrait(trait: SharedTrait, facts: SimilarityFacts): boolean {
  if (trait.key === 'federal_state') return facts.federal_state === trait.value
  if (trait.key === 'building_class') return facts.building_class.includes(Number(trait.value))
  return facts[trait.key].includes(trait.value)
}

/**
 * `projects` ordered by likeness to `current`, most alike first; ties keep the
 * given order (the caller passes newest first). With no current profile (a chat
 * outside every project) the given order stands.
 */
export function rankBySimilarity<P extends Pick<Project, 'profile'>>(current: Profile | null, projects: readonly P[]): P[] {
  if (!current) return [...projects]
  const facts = similarityFacts(current)
  return projects
    .map((project, index) => ({ project, index, score: similarity(facts, similarityFacts(project.profile)) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.project)
}
