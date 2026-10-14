/**
 * The information need (`docs/design/agentic-project-intake.md`, „The
 * information need"): which profile keys the project still needs, computed
 * from the wizard's questions, their conditions and the profile as it stands.
 * Pure. The agent's `intake_needs` tool returns its result.
 *
 * Also the two readings of a key the rest of the intake shares: which question
 * a profile key answers ({@link questionForKey}, the record gate's vocabulary),
 * and a Bauwerk's Gebäudeklasse inputs as the wizard's answers hold them
 * ({@link gebaeudeklasseInputsFor}, the derivation and the decisive needs).
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
  type NeedState,
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

/**
 * The options a reading may record for `key`: the question's own, without
 * „noch offen" and without the values a person dismissed for that key.
 * Undefined for a question without options.
 */
export function needOptionsFor(
  question: ProjectIntakeQuestion,
  key: string,
  dismissed: ComputeNeedsOptions['dismissed']
): NeedOption[] | undefined {
  if (!question.options) return undefined
  const refused = new Set(
    dismissed.filter((entry) => entry.key === key).map((entry) => String(entry.value))
  )
  return question.options
    .filter((option) => !isUndecidedOption(option) && !refused.has(option.value))
    .map((option) => ({ token: option.value, label: option.label }))
}

/** The D0 uses a Bauwerk can have: each opens its Nutzungszone (`key@bwN@use`). */
function zoneUses(definition: ProjectIntakeDefinition): Array<{ value: string; label: string }> {
  return (
    definition.stages.flatMap((stage) => stage.questions).find((question) => question.id === 'D0')
      ?.options ?? []
  )
}

/** The zone's use label beside the question's, so two zones' „Fläche der Zone" stay apart. */
function labelFor(candidate: Candidate, definition: ProjectIntakeDefinition): string {
  if (!candidate.zone) return candidate.question.label
  const use =
    zoneUses(definition).find((option) => option.value === candidate.zone)?.label ?? candidate.zone
  return `${candidate.question.label} (${use})`
}

/** A known answer as the derivation reads it: `offen` and a number_tri left open are missing. */
function knownAnswer(answers: Answers, answerKey: string): ProjectPrimitiveValue | undefined {
  if (answers[modeKeyFor(answerKey)] === 'offen') return undefined
  const value = answers[answerKey]
  return value === 'offen' ? undefined : value
}

/** Which Bauwerk question writes each Gebäudeklasse input, in the wizard's order. */
function gebaeudeklasseReaders(
  definition: ProjectIntakeDefinition
): Array<{ questionId: string; input: string }> {
  const inputs: readonly string[] = GEBAEUDEKLASSE_DERIVATION.inputs
  return definition.stages
    .filter((stage) => stage.scope === 'bauwerk')
    .flatMap((stage) => stage.questions)
    .map((question) => ({ questionId: question.id, input: baseKeyOf(question) ?? '' }))
    .filter(({ input }) => inputs.includes(input))
}

/**
 * One Bauwerk's Gebäudeklasse inputs from the wizard's answers, by base key;
 * undefined where nothing is known. Read through the answers, not the
 * profile, so the wizard's legacy bridges (C8's inverted `ne_unter_400`)
 * reach the derivation too.
 */
function inputsFromAnswers(
  readers: ReadonlyArray<{ questionId: string; input: string }>,
  answers: Answers,
  bauwerkId: string
): Record<string, ProjectPrimitiveValue | undefined> {
  return Object.fromEntries(
    readers.map(({ questionId, input }) => [
      input,
      knownAnswer(answers, answerKeyFor(questionId, bauwerkId)),
    ])
  )
}

/**
 * One Bauwerk's Gebäudeklasse inputs, by base key, as the derivation reads
 * them: facts first and suggestions under them, through the wizard's answers.
 * Every input the definition asks for is a key; undefined where it is unknown.
 */
export function gebaeudeklasseInputsFor(
  profile: ProjectProfile,
  definition: ProjectIntakeDefinition,
  bauwerkId: string
): Record<string, ProjectPrimitiveValue | undefined> {
  const { answers } = answersFromProfile(knownProfile(profile), definition)
  return inputsFromAnswers(gebaeudeklasseReaders(definition), answers, bauwerkId)
}

/** Per Bauwerk, the Gebäudeklasse inputs that are open and could still change the class. */
function decisiveKeysFor(
  definition: ProjectIntakeDefinition,
  answers: Answers,
  bauwerke: BauwerkInstance[]
): Set<string> {
  const readers = gebaeudeklasseReaders(definition)
  const decisive = new Set<string>()
  for (const bauwerk of bauwerke) {
    const known = inputsFromAnswers(readers, answers, bauwerk.id)
    for (const input of decisiveInputs(known)) decisive.add(answerKeyFor(input, bauwerk.id))
  }
  return decisive
}

const GEBAEUDEKLASSE_INPUTS: readonly string[] = GEBAEUDEKLASSE_DERIVATION.inputs

/**
 * What the project still needs: every question whose conditions hold for what
 * is known and that writes a profile key, minus keys a person marked unknown
 * and minus confirmed keys, except a confirmed Gebäudeklasse input: that one
 * stays as `confirmed`, never decisive, so a reading can corroborate it or
 * contradict it from a newer Stand. A key with only a suggestion stays, as
 * `suggested`. Decisive needs first (filling one could change a Bauwerk's
 * Gebäudeklasse; none in `closing` mode), then the wizard's order, the
 * confirmed ones last; at most {@link MAX_INTAKE_NEEDS}.
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
    .filter((candidate) => !(candidate.key in profile.goals))
    .filter(
      (candidate) =>
        !(candidate.key in profile.facts) || GEBAEUDEKLASSE_INPUTS.includes(candidate.baseKey)
    )
    .filter((candidate) => !unknown.has(candidate.key))
    .map((candidate) =>
      toNeed(candidate, definition, options, decisive.has(candidate.key), profile)
    )
  const ordered = [
    ...needs.filter((need) => need.decisive),
    ...needs.filter((need) => !need.decisive && need.state !== 'confirmed'),
    ...needs.filter((need) => need.state === 'confirmed'),
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
  const state = needState(candidate.key, profile)
  const needOptions = needOptionsFor(question, candidate.key, options.dismissed)
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
    decisive: decisive && state !== 'confirmed',
    state,
  }
}

function needState(key: string, profile: ProjectProfile): NeedState {
  if (key in profile.facts) return 'confirmed'
  return key in profile.assumptions ? 'suggested' : 'open'
}

// ---------------------------------------------------------------------------
// Which question a key answers
// ---------------------------------------------------------------------------

/** The question a profile key answers, read from the key alone. */
export interface KeyQuestion {
  question: ProjectIntakeQuestion
  type: IntakeNeedType
  baseKey: string
  bauwerkId: string | null
  /** The D0 use of a Nutzungszone key, or null. */
  zone: string | null
}

const BAUWERK_ID = /^bw[1-9]\d*$/

/** The key's scope parts, when it has the shape the question's scope asks for. */
function scopedParts(
  scope: 'project' | 'bauwerk' | 'zone',
  parts: string[]
): { bauwerkId: string | null; zone: string | null } | null {
  const [, bauwerkId, zone] = parts
  if (scope === 'project') return parts.length === 1 ? { bauwerkId: null, zone: null } : null
  if (!BAUWERK_ID.test(bauwerkId ?? '')) return null
  if (scope === 'bauwerk') return parts.length === 2 ? { bauwerkId, zone: null } : null
  return parts.length === 3 && zone ? { bauwerkId, zone } : null
}

/** Every question that writes a profile key, with the scope its keys take and the zone uses it is asked for. */
function writers(definition: ProjectIntakeDefinition): Array<{
  question: ProjectIntakeQuestion
  scope: 'project' | 'bauwerk' | 'zone'
  uses: readonly string[] | null
}> {
  const allUses = zoneUses(definition).map((option) => option.value)
  return definition.stages.flatMap((stage) => [
    ...stage.questions.map((question) => ({
      question,
      scope: stage.scope === 'bauwerk' ? ('bauwerk' as const) : ('project' as const),
      uses: null,
    })),
    ...(stage.zoneCommon ?? []).map((question) => ({ question, scope: 'zone' as const, uses: allUses })),
    ...Object.entries(stage.zoneDefinitions ?? {}).flatMap(([use, zone]) =>
      zone.questions.map((question) => ({ question, scope: 'zone' as const, uses: [use] }))
    ),
  ])
}

/**
 * The question `key` answers: its base key is one a question writes, and its
 * `@bwN` / `@bwN@use` suffix is the scope that question is asked in (a
 * project key has none, a Bauwerk key one, a Nutzungszone key a Bauwerk and
 * one of D0's uses). Null for any other key. Whether the question is asked
 * yet, whether its conditions hold, is not consulted: a reading may find a
 * value before the answer that opens its question.
 */
export function questionForKey(
  definition: ProjectIntakeDefinition,
  key: string
): KeyQuestion | null {
  const parts = key.split('@')
  const baseKey = parts[0]
  for (const writer of writers(definition)) {
    if (baseKeyOf(writer.question) !== baseKey) continue
    const scoped = scopedParts(writer.scope, parts)
    if (!scoped || !isNeedType(writer.question.type)) return null
    if (scoped.zone !== null && !writer.uses?.includes(scoped.zone)) return null
    return { question: writer.question, type: writer.question.type, baseKey, ...scoped }
  }
  return null
}

/**
 * The question `key` answers, when a reading may record it on this profile:
 * {@link questionForKey}, and its Bauwerk is one the profile describes
 * (`bauwerkIdsOf` in `derivation-view.ts`: `bw1` when it names none). A
 * reading does not add a Bauwerk; a person does, in the wizard.
 */
export function recordableKey(
  definition: ProjectIntakeDefinition,
  key: string,
  bauwerkIds: readonly string[]
): KeyQuestion | null {
  const found = questionForKey(definition, key)
  if (!found) return null
  return found.bauwerkId === null || bauwerkIds.includes(found.bauwerkId) ? found : null
}
