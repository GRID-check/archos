/**
 * Which questions apply: the condition evaluator, the question lookups, and pruning answers a changed condition made stale.
 */

import type { ProjectPrimitiveValue } from './types'
import { BUILDING_ID_IN_ANSWER_KEY, BUILDING_NAME_ANSWER_PREFIX, type BuildingInstance, answerKeyFor, buildingNumber, defaultBuildings, modeKeyFor, scopeOfQuestion } from './intake-building-keys'
import { projectIntakeDefinitionV1 } from './intake-definition'
import type { ProjectIntakeCondition, ProjectIntakeDefinition, ProjectIntakeQuestion } from './intake-types'

// ---------------------------------------------------------------------------
// Shared intake helpers — pure and isomorphic; used by the wizard and server.
// ---------------------------------------------------------------------------

/**
 * The validated `federal_state` token vocabulary, read straight off the A2_land
 * question's own options so it can never drift from what the wizard offers.
 * (Backlog T3-9: mirrored, not shared, by the Python backend's
 * `project_context._FEDERAL_STATE_TOKENS`.)
 */
export const FEDERAL_STATE_TOKENS: readonly string[] = (() => {
  const question = flattenIntakeQuestions(projectIntakeDefinitionV1).find((q) => q.id === 'A2_land')
  return question?.options?.map((option) => option.value) ?? []
})()

/** Whether `token` is a recognized `federal_state` (A2_land) intake answer. */
export function isValidFederalStateToken(token: string): boolean {
  return FEDERAL_STATE_TOKENS.includes(token)
}

export const COUNTRY_TOKENS: readonly string[] = (() => {
  const question = flattenIntakeQuestions(projectIntakeDefinitionV1).find(
    (q) => q.id === 'A2_country'
  )
  return question?.options?.map((option) => option.value) ?? []
})()

export function isValidCountryToken(token: string): boolean {
  return COUNTRY_TOKENS.includes(token)
}

/**
 * Whether a question is currently relevant given the answers collected so far.
 * Conditions are AND-combined. `param` is resolved within `instanceId`'s scope
 * (a building question's condition on a building param reads that building's
 * answer), falling back to the project-global answer for non-building params.
 */
export function evaluateIntakeCondition(
  question: ProjectIntakeQuestion,
  answers: Record<string, ProjectPrimitiveValue>,
  instanceId?: string
): boolean {
  return evaluateIntakeConditions(question.conditions, answers, instanceId)
}

/**
 * The same evaluation, given the conditions directly rather than a question.
 *
 * Exported because conditions are no longer only a question's: document roles
 * (`document-roles.ts`) carry a `recommendedWhen` list in this language so the
 * Modul I checklist is data rather than bespoke UI code. Sharing the evaluator
 * is what stops the checklist and the questions ever disagreeing about what a
 * project is.
 *
 * An empty or absent list means "always", which is what a question with no
 * conditions means.
 */
export function evaluateIntakeConditions(
  conditions: ProjectIntakeCondition[] | undefined,
  answers: Record<string, ProjectPrimitiveValue>,
  instanceId?: string
): boolean {
  if (!conditions || conditions.length === 0) return true
  return conditions.every((cond) => evaluateSingleCondition(cond, answers, instanceId))
}

function answerIncludesAny(
  answer: ProjectPrimitiveValue | undefined,
  value: ProjectIntakeCondition['value']
): boolean {
  const needles = Array.isArray(value) ? value : value !== undefined ? [String(value)] : []
  if (Array.isArray(answer)) return answer.some((v) => needles.includes(String(v)))
  return typeof answer === 'string' && needles.includes(answer)
}

function evaluateSingleCondition(
  cond: ProjectIntakeCondition,
  answers: Record<string, ProjectPrimitiveValue>,
  instanceId?: string
): boolean {
  // Resolve which answer key this param lives under: a building-scope param is
  // read from the current building instance; everything else is project-global.
  const paramScope = scopeOfQuestion(cond.param)
  const key = paramScope === 'building' && instanceId ? `${cond.param}@${instanceId}` : cond.param
  const answer = answers[key]

  switch (cond.op) {
    case 'not_empty':
      return isIntakeAnswerProvided(answer)
    case 'includes_any':
      return answerIncludesAny(answer, cond.value)
    case 'excludes_any':
      return !answerIncludesAny(answer, cond.value)
    case 'lte': {
      // Only a PRESENT, non-'open' value can satisfy a numeric bound: a
      // question gated on "höchstens 4 Geschoße" must not appear while the
      // storey count is unknown or explicitly left open (spec conventions).
      if (!isIntakeAnswerProvided(answer)) return false
      if (answers[modeKeyFor(key)] === 'open') return false
      const numeric = typeof answer === 'number' ? answer : Number(answer)
      return typeof cond.value === 'number' && Number.isFinite(numeric) && numeric <= cond.value
    }
    case 'equals':
    default: {
      if (Array.isArray(answer))
        return cond.value !== undefined && answer.includes(cond.value as string)
      return answer === cond.value
    }
  }
}

/** All questions across every stage (including zone questions), in definition order. */
export function flattenIntakeQuestions(
  definition: ProjectIntakeDefinition
): ProjectIntakeQuestion[] {
  const out: ProjectIntakeQuestion[] = []
  for (const stage of definition.stages) {
    out.push(...stage.questions)
    if (stage.zoneCommon) out.push(...stage.zoneCommon)
    for (const def of Object.values(stage.zoneDefinitions ?? {})) out.push(...def.questions)
  }
  return out
}

/** Look up a question by its stable id anywhere in the definition. */
export function findIntakeQuestion(
  definition: ProjectIntakeDefinition,
  questionId: string
): ProjectIntakeQuestion | undefined {
  return flattenIntakeQuestions(definition).find((q) => q.id === questionId)
}

/**
 * The distinct scope instances (buildings) implied by the current answer state.
 * Reconstructed from `@bldgN`-suffixed keys plus any stored building names, so an
 * edit session can rebuild the building list the same way the wizard held it.
 */
export function buildingsFromAnswers(
  answers: Record<string, ProjectPrimitiveValue>
): BuildingInstance[] {
  const ids = new Set<string>()
  for (const key of Object.keys(answers)) {
    const match = key.match(BUILDING_ID_IN_ANSWER_KEY)
    if (match) ids.add(match[1])
  }
  const sorted = [...ids].sort((a, b) => buildingNumber(a) - buildingNumber(b))
  if (sorted.length === 0) return defaultBuildings()
  return sorted.map((id, i) => {
    const stored = answers[`${BUILDING_NAME_ANSWER_PREFIX}${id}`]
    return { id, name: typeof stored === 'string' && stored ? stored : `Bauwerk ${i + 1}` }
  })
}

/**
 * Remove answers for conditional questions whose visibility condition no longer
 * holds — across every scope instance. Recursive: dropping one answer can turn a
 * chained condition false. Returns the same reference when nothing changed.
 */
export function pruneStaleConditionalAnswers(
  answers: Record<string, ProjectPrimitiveValue>,
  definition: ProjectIntakeDefinition | null | undefined
): Record<string, ProjectPrimitiveValue> {
  if (!definition) return answers
  const buildings = buildingsFromAnswers(answers)
  let current = answers
  let changedAny = false

  for (;;) {
    let changedThisPass = false
    let next: Record<string, ProjectPrimitiveValue> | null = null

    const dropIfOrphaned = (
      question: ProjectIntakeQuestion,
      answerKey: string,
      instanceId?: string
    ) => {
      if (!question.conditions || question.conditions.length === 0) return
      const hasAnswer = answerKey in current || modeKeyFor(answerKey) in current
      if (!hasAnswer) return
      if (evaluateIntakeCondition(question, current, instanceId)) return
      if (!next) next = { ...current }
      delete next[answerKey]
      delete next[modeKeyFor(answerKey)]
      changedThisPass = true
    }

    for (const stage of definition.stages) {
      if (stage.scope === 'building') {
        for (const building of buildings) {
          for (const q of stage.questions) dropIfOrphaned(q, answerKeyFor(q.id, building.id), building.id)
        }
      } else {
        for (const q of stage.questions) dropIfOrphaned(q, q.id)
      }
    }

    if (!changedThisPass) break
    if (next) current = next
    changedAny = true
  }

  return changedAny ? current : answers
}

/** Whether an answer counts as provided (non-empty). */
export function isIntakeAnswerProvided(answer: ProjectPrimitiveValue | undefined): boolean {
  if (answer === undefined || answer === null || answer === '') return false
  if (Array.isArray(answer)) return answer.length > 0
  return true
}

export interface WriteTarget {
  scope: 'facts' | 'goals'
  key: string
}
