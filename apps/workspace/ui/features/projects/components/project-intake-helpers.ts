

import { type PendingRoleBind } from '../lib/pending-role-binds'
import { modeKeyFor } from '@/lib/project-profile/intake-building-keys'
import { isIntakeAnswerProvided } from '@/lib/project-profile/intake-conditions'

import type { BuildingInstance } from '@/lib/project-profile/intake-building-keys'
import type { ProjectIntakeQuestion } from '@/lib/project-profile/intake-types'

import type { ProjectPrimitiveValue, ProjectProfile } from '@/lib/project-profile/types'

import type { Translator } from '@/i18n'

export type Answers = Record<string, ProjectPrimitiveValue>

/** Shape of the autosaved intake draft persisted in localStorage. */
export interface IntakeDraft {
  answers?: Answers
  buildings?: BuildingInstance[]
  /** Role bindings held for buildings not saved yet (`pending-role-binds`). */
  pendingBinds?: PendingRoleBind[]
  currentStep?: number
  savedAt?: number
  baseVersion?: number | null
}

export function profileUpdatedAtMs(profile: ProjectProfile | null | undefined): number | null {
  if (!profile) return null
  let latest: number | null = null
  const consider = (iso: string | undefined) => {
    if (!iso) return
    const ms = Date.parse(iso)
    if (!Number.isNaN(ms)) latest = latest === null ? ms : Math.max(latest, ms)
  }
  for (const fact of Object.values(profile.facts ?? {})) consider(fact.updatedAt)
  for (const assumption of Object.values(profile.assumptions ?? {})) consider(assumption.updatedAt)
  return latest
}

export function draftShouldWinInEditMode(
  draft: IntakeDraft,
  profile: ProjectProfile | null,
  profileVersion: number | null
): boolean {
  if (typeof profileVersion === 'number' && typeof draft.baseVersion === 'number') {
    return profileVersion <= draft.baseVersion
  }
  const profileAt = profileUpdatedAtMs(profile)
  if (profileAt !== null && typeof draft.savedAt === 'number') {
    return draft.savedAt >= profileAt
  }
  return false
}

/**
 * May the wizard advance past this question? Non-required questions never block
 * on emptiness, but an ANSWERED numeric field must still be finite — an entered
 * "1e999" (→ Infinity) serializes to null and would corrupt the fact, so it is
 * rejected even when the field is optional.
 */
export function isQuestionSatisfied(
  question: ProjectIntakeQuestion,
  answers: Answers,
  answerKey: string
): boolean {
  const answer = answers[answerKey]
  if (question.type === 'number' || question.type === 'number_tri') {
    if (answers[modeKeyFor(answerKey)] === 'open') return true
    if (!isIntakeAnswerProvided(answer)) return !question.required
    const numeric = typeof answer === 'number' ? answer : Number(answer)
    return Number.isFinite(numeric)
  }
  if (!question.required) return true
  if (question.type === 'multi_select') return Array.isArray(answer) && answer.length > 0
  return isIntakeAnswerProvided(answer)
}

export function validationMessage(question: ProjectIntakeQuestion, t: Translator): string {
  switch (question.type) {
    case 'single_select':
      return t('intake.validation.selectOption')
    case 'multi_select':
      return t('intake.validation.selectAtLeastOne')
    case 'number':
    case 'number_tri':
      return t('intake.validation.enterNumber')
    default:
      return t('intake.validation.required')
  }
}
