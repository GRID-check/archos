/**
 * What step 5 shows of the review, worked out from the view alone. Pure.
 *
 * The findings table shows a handful of rows up front (the values that decide
 * the Gebäudeklasse first) and folds the rest by topic. A contested value is
 * not a row: its contradiction is decided in the Rückfragen.
 */

import type { DerivationReview, IntakeDecision, IntakeView, Suggestion, SuggestionGroup } from '@/lib/project-intake/types'

/** How many rows the table shows before „Alle … ansehen". */
export const TOP_FINDINGS = 5

/** Every value the table can show: suggested or confirmed, never contested. */
export function findings(groups: readonly SuggestionGroup[]): Suggestion[] {
  return groups.flatMap((group) => group.items).filter((item) => item.state !== 'contested')
}

/** The keys the Gebäudeklasse was computed from, for every Bauwerk. */
function classInputKeys(derivations: readonly DerivationReview[]): Set<string> {
  return new Set(derivations.flatMap((derivation) => derivation.inputs.map((input) => input.key)))
}

/**
 * How much a row matters, lower first: a suggestion that decides the class, a
 * value the class was computed from, a value read from a document, the rest.
 */
function rank(item: Suggestion, inputs: Set<string>): number {
  if (item.decisive && item.state === 'suggested') return 0
  if (inputs.has(item.key)) return 1
  if (item.evidence.some((entry) => entry.kind === 'document')) return 2
  return 3
}

/** The rows shown up front: the most decisive few, in the wizard's order within a rank. */
export function topFindings(
  groups: readonly SuggestionGroup[],
  derivations: readonly DerivationReview[],
  limit: number = TOP_FINDINGS
): Suggestion[] {
  const inputs = classInputKeys(derivations)
  return findings(groups)
    .map((item, index) => ({ item, index, rank: rank(item, inputs) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map(({ item }) => item)
}

/** The other rows, by the wizard's modules; a module left empty is left out. */
export function restByTopic(groups: readonly SuggestionGroup[], shown: readonly Suggestion[]): SuggestionGroup[] {
  const apart = new Set(shown.map((item) => item.key))
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.state !== 'contested' && !apart.has(item.key)),
    }))
    .filter((group) => group.items.length > 0)
}

/** Every open suggestion the table shows, taken in one call. */
export function takeAllDecisions(groups: readonly SuggestionGroup[]): IntakeDecision[] {
  return findings(groups)
    .filter((item) => item.state === 'suggested')
    .map((item): IntakeDecision => ({ key: item.key, action: 'confirm' }))
}

/** „Anzahl Nutzungseinheiten (Wohnungen + Betriebseinheiten, Zielzustand)" → „Anzahl Nutzungseinheiten". */
export function shortLabel(label: string): string {
  const short = label.replace(/\s*\([^()]*\)\s*$/u, '').trim()
  return short.length > 0 ? short : label
}

/** „E-02 Schnitt A-A.pdf" → „E-02 Schnitt A-A": the table names a document, not a file type. */
export function documentName(fileName: string): string {
  const trimmed = fileName.trim()
  const dot = trimmed.lastIndexOf('.')
  return dot > 0 && trimmed.length - dot <= 5 ? trimmed.slice(0, dot) : trimmed
}

/**
 * The derivation the class card opens on: the first Bauwerk with a class to
 * take, else the first with a class or a Hochhaus, else the first.
 */
export function leadDerivation(derivations: readonly DerivationReview[]): DerivationReview | null {
  return (
    derivations.find((derivation) => derivation.suggestion?.state === 'suggested') ??
    derivations.find((derivation) => derivation.value !== null || derivation.hochhaus) ??
    derivations[0] ??
    null
  )
}

/** The inputs the one-line reason names, in the order a reader weighs them. */
export const REASON_INPUTS = [
  'fluchtniveau_m',
  'geschosse_oberirdisch',
  'nutzungseinheiten',
  'einheiten_ueber_400',
  'bgf_oberirdisch',
] as const
export type ReasonInput = (typeof REASON_INPUTS)[number]

/** Up to three inputs of a derivation for its one-line reason, each with its base key. */
export function reasonInputs(
  derivation: DerivationReview,
  limit = 3
): Array<{ base: ReasonInput; key: string; value: DerivationReview['inputs'][number]['value'] }> {
  const byBase = new Map(derivation.inputs.map((input) => [input.key.split('@')[0], input]))
  return REASON_INPUTS.flatMap((base) => {
    const input = byBase.get(base)
    return input ? [{ base, key: input.key, value: input.value }] : []
  }).slice(0, limit)
}

/** The values a person has confirmed: what the rule set is computed from. The class counts once per Bauwerk. */
export function confirmedCount(view: Pick<IntakeView, 'groups' | 'derivations'>): number {
  const values = view.groups.flatMap((group) => group.items).filter((item) => item.state === 'confirmed').length
  const classes = view.derivations.filter((derivation) => derivation.suggestion?.state === 'confirmed').length
  return values + classes
}
