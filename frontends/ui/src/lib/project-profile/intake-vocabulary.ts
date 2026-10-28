/**
 * The words of the profile: labels for keys, the vocabulary a patch is checked against, and formatting an answer for display.
 */

import { normalizeProfilePatchOperation } from './legacy-names'
import type { ProjectPrimitiveValue, ProjectProfilePatchOperation } from './types'
import { flattenIntakeQuestions, isIntakeAnswerProvided } from './intake-conditions'
import { projectIntakeDefinitionV1 } from './intake-definition'
import { resolveWriteTarget } from './intake-profile'
import type { ProjectIntakeDefinition, ProjectIntakeQuestion } from './intake-types'

/**
 * Title-case a raw snake_case/space-separated profile key as a last-resort human
 * label (e.g. `high_rise_details` -> "High Rise Details").
 */
export function humanizeProfileKey(key: string): string {
  return key
    .split('@')[0]
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Resolve a human label for a raw profile fact/goal key (e.g. `escape_level_m`,
 * or a scoped `escape_level_m@bldg1`) from the intake question that writes it.
 */
export function labelForProfileKey(definition: ProjectIntakeDefinition, key: string): string {
  const base = key.split('@')[0]
  for (const question of flattenIntakeQuestions(definition)) {
    const target = resolveWriteTarget(question.writesTo)
    if (target?.key === base) return question.label
  }
  return humanizeProfileKey(key)
}

/**
 * Server-side vocabulary validation (defense-in-depth for the profile-patch
 * flow): reject add/replace operations whose value violates the intake question
 * that owns the key. Scoped keys (`<base>@bldg1`) resolve to their base question.
 */
export function validateProfilePatchVocabulary(patch: ProjectProfilePatchOperation[]): void {
  for (const operation of patch.map(normalizeProfilePatchOperation)) {
    if (operation.op === 'remove') continue
    const key = extractVocabKey(operation.path)
    if (!key) continue
    const question = questionForKey(key)
    if (!question) continue
    assertVocabulary(question, unwrapPatchValue(operation.value))
  }
}

function extractVocabKey(path: string): string | null {
  const parts = path.split('/')
  const section = parts[1]
  if (section === 'facts' || section === 'assumptions' || section === 'goals') {
    if (parts.length === 3 && parts[2] && parts[2] !== '-') return decodeVocabSegment(parts[2])
    if (
      section !== 'goals' &&
      parts.length === 4 &&
      parts[3] === 'value' &&
      parts[2] &&
      parts[2] !== '-'
    ) {
      return decodeVocabSegment(parts[2])
    }
  }
  return null
}

function questionForKey(key: string): ProjectIntakeQuestion | undefined {
  const base = decodeVocabSegment(key).split('@')[0]
  return flattenIntakeQuestions(projectIntakeDefinitionV1).find(
    (question) => resolveWriteTarget(question.writesTo)?.key === base
  )
}

function unwrapPatchValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return (value as Record<string, unknown>).value
  }
  return value
}

function assertVocabulary(question: ProjectIntakeQuestion, value: unknown): void {
  const label = question.label
  const shown = JSON.stringify(value)
  switch (question.type) {
    case 'single_select': {
      if (
        typeof value !== 'string' ||
        !question.options?.some((option) => option.value === value)
      ) {
        throw new Error(`Invalid value for "${label}": ${shown} is not an allowed option.`)
      }
      return
    }
    case 'multi_select': {
      const allowed = new Set(question.options?.map((option) => option.value) ?? [])
      if (
        !Array.isArray(value) ||
        !value.every((item) => typeof item === 'string' && allowed.has(item))
      ) {
        throw new Error(
          `Invalid value for "${label}": ${shown} is not a subset of the allowed options.`
        )
      }
      return
    }
    case 'yes_no_open':
    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw new Error(`Invalid value for "${label}": expected true or false, got ${shown}.`)
      }
      return
    }
    case 'number_tri':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Invalid value for "${label}": expected a number, got ${shown}.`)
      }
      return
    }
    case 'text':
    case 'textarea': {
      if (typeof value !== 'string') {
        throw new Error(`Invalid value for "${label}": expected text, got ${shown}.`)
      }
      return
    }
    default:
      return
  }
}

function decodeVocabSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~')
}

/** Human-readable rendering of a single answer, using option labels where available. */
export function formatIntakeAnswer(
  question: ProjectIntakeQuestion,
  answer: ProjectPrimitiveValue | undefined
): string {
  // yes_no_open facts persist as booleans; render them like a boolean here.
  if (
    question.type === 'boolean' ||
    (question.type === 'yes_no_open' && typeof answer === 'boolean')
  ) {
    return answer ? 'Ja' : answer === false ? 'Nein' : '—'
  }
  if (!isIntakeAnswerProvided(answer)) return '—'

  const optionLabel = (value: string): string =>
    question.options?.find((option) => option.value === value)?.label ?? value

  if (question.type === 'multi_select' && Array.isArray(answer)) {
    return answer.map(optionLabel).join(', ')
  }
  if (
    (question.type === 'single_select' || question.type === 'yes_no_open') &&
    typeof answer === 'string'
  ) {
    return optionLabel(answer)
  }
  if (typeof answer === 'number') {
    // German like the rest of this answer: „18,4 m“, „1.250 m²“.
    const number = GERMAN_NUMBER.format(answer)
    return question.unit ? `${number} ${question.unit}` : number
  }
  return String(answer)
}

const GERMAN_NUMBER = new Intl.NumberFormat('de-AT', { maximumFractionDigits: 2 })
