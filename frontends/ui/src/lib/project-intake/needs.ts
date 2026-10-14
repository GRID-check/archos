/**
 * The information need (`docs/design/agentic-project-intake.md`, „The
 * information need"): which profile keys the project still needs, computed
 * from the wizard's questions, their conditions and the profile as it stands.
 * Pure. The agent's `intake_needs` tool returns its result.
 *
 * The wizard's walk, replayed: project and Grundstück questions once, Bauwerk
 * questions per Bauwerk (`key@bwN`), and the Nutzungszonen of each selected
 * D0 use (`key@bwN@use`). Conditions are evaluated on what is known, facts
 * first and suggestions under them, so a suggested `bauwerkstyp = gebaeude`
 * already opens the Gebäude questions the reading should look for.
 */

import {
  answerKeyFor,
  answersFromProfile,
  evaluateIntakeCondition,
  modeKeyFor,
  type BauwerkInstance,
  type ProjectIntakeDefinition,
  type ProjectIntakeQuestion,
  type ProjectIntakeStage,
} from '@/lib/project-profile/intake-definition'
import type {
  ProjectFact,
  ProjectPrimitiveValue,
  ProjectProfile,
} from '@/lib/project-profile/types'
import { decisiveInputs, GEBAEUDEKLASSE_DERIVATION } from './derivations'
import {
  INTAKE_NEED_TYPES,
  MAX_INTAKE_NEEDS,
  type IntakeMode,
  type IntakeNeedType,
  type Need,
  type NeedOption,
} from './types'

export interface ComputeNeedsOptions {
  mode: IntakeMode
  /** Values a person dismissed, per key; never suggested again, so a select need does not offer them. */
  dismissed: ReadonlyArray<{ key: string; value: ProjectPrimitiveValue }>
  /** Keys a person marked „nicht bekannt"; not a need. Defaults to the profile's `unknowns`. */
  unknownKeys?: ReadonlyArray<string>
}

type Answers = Record<string, ProjectPrimitiveValue>

/** A question that holds for one scope instance, before the profile is consulted. */
interface Candidate {
  question: ProjectIntakeQuestion
  type: IntakeNeedType
  /** The profile key (`geschosse_oberirdisch@bw1`). */
  key: string
  baseKey: string
  bauwerkId: string | null
  /** The D0 use of a Nutzungszone question, or null. */
  zone: string | null
}

const NEED_TYPES: readonly string[] = INTAKE_NEED_TYPES

function isNeedType(type: string): type is IntakeNeedType {
  return NEED_TYPES.includes(type)
}

/** The fact or goal key a question writes, as the wizard's `resolveWriteTarget` reads `writesTo`. */
function baseKeyOf(question: ProjectIntakeQuestion): string | null {
  const match = question.writesTo?.match(/^\/(?:facts|goals)\/([^/]+)/)
  return match ? match[1] : null
}

/**
 * The profile with every suggestion read as if it were answered, under the
 * facts. `answersFromProfile` reads assumptions only for number_tri; a
 * suggested select or yes/no answer must open its follow-up questions too.
 */
function knownProfile(profile: ProjectProfile): ProjectProfile {
  const suggested: Record<string, ProjectFact> = {}
  for (const [key, assumption] of Object.entries(profile.assumptions)) {
    suggested[key] = {
      value: assumption.value,
      confidence: 'confirmed',
      source: 'onboarding',
      updatedAt: assumption.updatedAt,
    }
  }
  return { ...profile, facts: { ...suggested, ...profile.facts } }
}

function candidateFor(
  question: ProjectIntakeQuestion,
  answers: Answers,
  scope: { bauwerk?: BauwerkInstance; zone?: string }
): Candidate | null {
  const baseKey = baseKeyOf(question)
  if (!baseKey || !isNeedType(question.type)) return null
  if (!evaluateIntakeCondition(question, answers, scope.bauwerk?.id)) return null
  const bauwerkId = scope.bauwerk?.id ?? null
  return {
    question,
    type: question.type,
    key: answerKeyFor(baseKey, bauwerkId ?? undefined, scope.zone),
    baseKey,
    bauwerkId,
    zone: scope.zone ?? null,
  }
}

function zoneQuestions(stage: ProjectIntakeStage, use: string): ProjectIntakeQuestion[] {
  return [...(stage.zoneCommon ?? []), ...(stage.zoneDefinitions?.[use]?.questions ?? [])]
}

function bauwerkCandidates(
  stage: ProjectIntakeStage,
  bauwerk: BauwerkInstance,
  answers: Answers
): Candidate[] {
  const own = stage.questions.map((question) => candidateFor(question, answers, { bauwerk }))
  const uses = answers[answerKeyFor('D0', bauwerk.id)]
  const zones = Array.isArray(uses)
    ? uses.flatMap((zone) =>
        zoneQuestions(stage, zone).map((question) =>
          candidateFor(question, answers, { bauwerk, zone })
        )
      )
    : []
  return [...own, ...zones].filter((candidate): candidate is Candidate => candidate !== null)
}

/** Every question that holds for what is known, in the wizard's order. */
function candidatesFor(
  definition: ProjectIntakeDefinition,
  answers: Answers,
  bauwerke: BauwerkInstance[]
): Candidate[] {
  return definition.stages.flatMap((stage) => {
    if (stage.scope === 'bauwerk')
      return bauwerke.flatMap((bauwerk) => bauwerkCandidates(stage, bauwerk, answers))
    return stage.questions
      .map((question) => candidateFor(question, answers, {}))
      .filter((candidate): candidate is Candidate => candidate !== null)
  })
}

/** „noch offen" is the wizard's way to defer an answer, never a value a document states. B3_weise's `offen` is a real Bebauungsweise. */
function isUndecidedOption(option: { value: string; label: string }): boolean {
  return (
    (option.value === 'offen' || option.value === 'noch_offen') && option.label.startsWith('noch')
  )
}

function optionsFor(
  candidate: Candidate,
  dismissed: ComputeNeedsOptions['dismissed']
): NeedOption[] | undefined {
  if (!candidate.question.options) return undefined
  const refused = new Set(
    dismissed.filter((entry) => entry.key === candidate.key).map((entry) => String(entry.value))
  )
  return candidate.question.options
    .filter((option) => !isUndecidedOption(option) && !refused.has(option.value))
    .map((option) => ({ token: option.value, label: option.label }))
}

/** The zone's use label beside the question's, so two zones' „Fläche der Zone" stay apart. */
function labelFor(candidate: Candidate, definition: ProjectIntakeDefinition): string {
  if (!candidate.zone) return candidate.question.label
  const uses = definition.stages
    .flatMap((stage) => stage.questions)
    .find((question) => question.id === 'D0')?.options
  const use = uses?.find((option) => option.value === candidate.zone)?.label ?? candidate.zone
  return `${candidate.question.label} (${use})`
}

/** A known answer as the derivation reads it: `offen` and a number_tri left open are missing. */
function knownAnswer(answers: Answers, answerKey: string): ProjectPrimitiveValue | undefined {
  if (answers[modeKeyFor(answerKey)] === 'offen') return undefined
  const value = answers[answerKey]
  return value === 'offen' ? undefined : value
}

/** Per Bauwerk, the Gebäudeklasse inputs that are open and could still change the class. */
function decisiveKeysFor(
  definition: ProjectIntakeDefinition,
  answers: Answers,
  bauwerke: BauwerkInstance[]
): Set<string> {
  const inputs: readonly string[] = GEBAEUDEKLASSE_DERIVATION.inputs
  // Read through the wizard's answers, not the profile, so its legacy bridges
  // (C8's inverted `ne_unter_400`) reach the derivation too.
  const readers = definition.stages
    .filter((stage) => stage.scope === 'bauwerk')
    .flatMap((stage) => stage.questions)
    .map((question) => ({ questionId: question.id, input: baseKeyOf(question) ?? '' }))
    .filter(({ input }) => inputs.includes(input))
  const decisive = new Set<string>()
  for (const bauwerk of bauwerke) {
    const known = Object.fromEntries(
      readers.map(({ questionId, input }) => [
        input,
        knownAnswer(answers, answerKeyFor(questionId, bauwerk.id)),
      ])
    )
    for (const input of decisiveInputs(known)) decisive.add(answerKeyFor(input, bauwerk.id))
  }
  return decisive
}

/**
 * What the project still needs: every question whose conditions hold for what
 * is known and that writes a profile key, minus confirmed keys and keys a
 * person marked unknown. A key with only a suggestion stays, as `suggested`.
 * Decisive needs first (filling one could change a Bauwerk's Gebäudeklasse;
 * none in `closing` mode), then the wizard's order; at most
 * {@link MAX_INTAKE_NEEDS}.
 */
export function computeNeeds(
  profile: ProjectProfile,
  definition: ProjectIntakeDefinition,
  options: ComputeNeedsOptions
): Need[] {
  const { answers, bauwerke } = answersFromProfile(knownProfile(profile), definition)
  const unknown = new Set(options.unknownKeys ?? profile.unknowns)
  const decisive =
    options.mode === 'closing' ? new Set<string>() : decisiveKeysFor(definition, answers, bauwerke)
  const needs = candidatesFor(definition, answers, bauwerke)
    .filter((candidate) => !(candidate.key in profile.facts) && !(candidate.key in profile.goals))
    .filter((candidate) => !unknown.has(candidate.key))
    .map((candidate) =>
      toNeed(candidate, definition, options, decisive.has(candidate.key), profile)
    )
  const ordered = [
    ...needs.filter((need) => need.decisive),
    ...needs.filter((need) => !need.decisive),
  ]
  return ordered.slice(0, MAX_INTAKE_NEEDS)
}

function toNeed(
  candidate: Candidate,
  definition: ProjectIntakeDefinition,
  options: ComputeNeedsOptions,
  decisive: boolean,
  profile: ProjectProfile
): Need {
  const { question } = candidate
  const needOptions = optionsFor(candidate, options.dismissed)
  return {
    key: candidate.key,
    baseKey: candidate.baseKey,
    bauwerkId: candidate.bauwerkId,
    label: labelFor(candidate, definition),
    type: candidate.type,
    ...(needOptions ? { options: needOptions } : {}),
    ...(question.unit ? { unit: question.unit } : {}),
    ...(question.why ? { why: question.why } : {}),
    foundIn: question.foundIn ?? [],
    decisive,
    state: candidate.key in profile.assumptions ? 'suggested' : 'open',
  }
}
