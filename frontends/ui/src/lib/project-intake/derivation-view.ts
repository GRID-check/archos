/**
 * The Gebäudeklasse per Bauwerk, as the review shows it and as a reading
 * writes it (ADR-0111, „The Gebäudeklasse derivation"). Pure.
 *
 * The inputs are read the way `computeNeeds` reads them: through the wizard's
 * answers (`answersFromProfile`), facts first and suggestions under them, so
 * the wizard's legacy bridges reach the derivation and the class the review
 * shows is the class the needs were computed against. Each input says whether
 * it is only suggested.
 *
 * Writing: when every input that matters has a value, the class is written as
 * the suggestion `gebaeudeklasse@bwN` with `derivation` evidence. It is never
 * written over a confirmed class: a different one becomes an alternative on
 * the fact, as a document's would. A Hochhaus, or a Bauwerk that is no
 * Gebäude, gets nothing.
 */

import {
  answerKeyFor,
  answersFromProfile,
  modeKeyFor,
  type ProjectIntakeDefinition,
} from '@/lib/project-profile/intake-definition'
import type { DerivationEvidence, DerivationInput, ProfileAlternative } from '@/lib/project-profile/evidence-schema'
import type { ProjectFact, ProjectPrimitiveValue, ProjectProfile } from '@/lib/project-profile/types'
import { deriveGebaeudeklasse, GEBAEUDEKLASSE_DERIVATION } from './derivations'
import { sameProfileValue, suggestedAssumption, withAlternative } from './profile-edits'
import type { DerivationView } from './types'

/** The profile key the class of one Bauwerk is stored under. */
export const gebaeudeklasseKey = (bauwerkId: string): string => `gebaeudeklasse@${bauwerkId}`

/** The reason a derived suggestion carries, beside its evidence. Read by a person and by the agent's prompt view. */
export const DERIVED_REASON = `Abgeleitet: ${GEBAEUDEKLASSE_DERIVATION.citation}`

/** Every suggestion read as if it were answered, under the facts (as `computeNeeds` reads them). */
function knownProfile(profile: ProjectProfile): ProjectProfile {
  const suggested: Record<string, ProjectFact> = {}
  for (const [key, assumption] of Object.entries(profile.assumptions)) {
    suggested[key] = { value: assumption.value, confidence: 'confirmed', source: 'onboarding', updatedAt: assumption.updatedAt }
  }
  return { ...profile, facts: { ...suggested, ...profile.facts } }
}

/** Which Bauwerk question writes each derivation input: `[questionId, baseKey]`. */
function inputQuestions(definition: ProjectIntakeDefinition): Array<{ questionId: string; input: string }> {
  const inputs: readonly string[] = GEBAEUDEKLASSE_DERIVATION.inputs
  return definition.stages
    .filter((stage) => stage.scope === 'bauwerk')
    .flatMap((stage) => stage.questions)
    .map((question) => ({ questionId: question.id, input: /^\/(?:facts|goals)\/([^/]+)/.exec(question.writesTo ?? '')?.[1] ?? '' }))
    .filter(({ input }) => inputs.includes(input))
}

function knownAnswer(answers: Record<string, ProjectPrimitiveValue>, answerKey: string): ProjectPrimitiveValue | undefined {
  if (answers[modeKeyFor(answerKey)] === 'offen') return undefined
  const value = answers[answerKey]
  return value === 'offen' ? undefined : value
}

/** The Bauwerke the profile describes, in order (`bw1` when it names none). */
export function bauwerkIdsOf(profile: ProjectProfile, definition: ProjectIntakeDefinition): string[] {
  return answersFromProfile(profile, definition).bauwerke.map((bauwerk) => bauwerk.id)
}

/** The class of one Bauwerk and what it read. */
export function deriveForBauwerk(
  profile: ProjectProfile,
  definition: ProjectIntakeDefinition,
  bauwerkId: string
): DerivationView {
  const { answers } = answersFromProfile(knownProfile(profile), definition)
  const known: Record<string, ProjectPrimitiveValue | undefined> = {}
  const inputs: DerivationInput[] = []
  for (const { questionId, input } of inputQuestions(definition)) {
    const value = knownAnswer(answers, answerKeyFor(questionId, bauwerkId))
    known[input] = value
    if (value === undefined) continue
    const key = `${input}@${bauwerkId}`
    inputs.push({ key, value, suggested: !(key in profile.facts) })
  }
  const result = deriveGebaeudeklasse(known)
  return {
    bauwerkId,
    rule: GEBAEUDEKLASSE_DERIVATION.rule,
    citation: GEBAEUDEKLASSE_DERIVATION.citation,
    value: result.value,
    hochhaus: result.hochhaus,
    inputs,
    missing: [...result.missing],
  }
}

/** Every Bauwerk's class. */
export function deriveAll(profile: ProjectProfile, definition: ProjectIntakeDefinition): DerivationView[] {
  return bauwerkIdsOf(profile, definition).map((bauwerkId) => deriveForBauwerk(profile, definition, bauwerkId))
}

/** The Bauwerke whose class may have moved when these keys changed: a project-wide input moves every one. */
export function bauwerkeTouchedBy(keys: Iterable<string>, allBauwerke: readonly string[]): string[] {
  const inputs: readonly string[] = GEBAEUDEKLASSE_DERIVATION.inputs
  const touched = new Set<string>()
  for (const key of keys) {
    const [base, scope] = key.split('@')
    if (!inputs.includes(base)) continue
    if (!scope) return [...allBauwerke]
    if (allBauwerke.includes(scope)) touched.add(scope)
  }
  return allBauwerke.filter((bauwerkId) => touched.has(bauwerkId))
}

function derivationEvidence(view: DerivationView): DerivationEvidence {
  return { kind: 'derivation', rule: view.rule, citation: view.citation, inputs: view.inputs }
}

const isDerived = (alternative: ProfileAlternative) => alternative.evidence.some((entry) => entry.kind === 'derivation')

/**
 * The profile with the class of `bauwerkId` written as the derivation says,
 * and whether it changed. Nothing changes while the class is unknown.
 */
export function withDerivedClass(
  profile: ProjectProfile,
  definition: ProjectIntakeDefinition,
  bauwerkId: string,
  now: string
): { profile: ProjectProfile; changed: boolean } {
  const view = deriveForBauwerk(profile, definition, bauwerkId)
  if (view.value === null) return { profile, changed: false }
  const key = gebaeudeklasseKey(bauwerkId)
  const evidence = derivationEvidence(view)

  const fact = profile.facts[key]
  if (fact) {
    if (sameProfileValue(fact.value, view.value)) return { profile, changed: false }
    // A derived alternative replaces the one an earlier derivation left: the inputs moved, the class with them.
    const alternatives = withAlternative((fact.alternatives ?? []).filter((entry) => !isDerived(entry)), view.value, evidence, now)
    return { profile: { ...profile, facts: { ...profile.facts, [key]: { ...fact, alternatives } } }, changed: true }
  }

  const current = profile.assumptions[key]
  if (current && sameProfileValue(current.value, view.value) && JSON.stringify(current.evidence) === JSON.stringify([evidence])) {
    return { profile, changed: false }
  }
  const next = {
    ...suggestedAssumption(view.value, DERIVED_REASON, [evidence], now),
    ...(current?.alternatives?.length ? { alternatives: current.alternatives } : {}),
  }
  return { profile: { ...profile, assumptions: { ...profile.assumptions, [key]: next } }, changed: true }
}
