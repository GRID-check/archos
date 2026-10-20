/**
 * How the setup page words a profile value and a key, from the intake
 * definition the wizard asks with, so a value reads on both as it does in the
 * other. Pure.
 */

import {
  flattenIntakeQuestions,
  formatIntakeAnswer,
  labelForProfileKey,
  projectIntakeDefinitionV1,
  type ProjectIntakeQuestion,
} from '@/lib/project-profile/intake-definition'
import type { ProjectPrimitiveValue } from '@/lib/project-profile/types'
import { OIB_EDITIONS } from '@/lib/project-experience/vocabulary'
import type { Need } from '@/lib/project-intake/types'

const WRITTEN_KEY = /^\/(?:facts|goals)\/([^/]+)/

let questionsByKey: Map<string, ProjectIntakeQuestion> | null = null

/** The wizard question that writes a base key (`storeys_above_ground`), once per page load. */
function questionFor(baseKey: string): ProjectIntakeQuestion | undefined {
  if (!questionsByKey) {
    questionsByKey = new Map()
    for (const question of flattenIntakeQuestions(projectIntakeDefinitionV1)) {
      const written = WRITTEN_KEY.exec(question.writesTo ?? '')?.[1]
      if (written && !questionsByKey.has(written)) questionsByKey.set(written, question)
    }
  }
  return questionsByKey.get(baseKey)
}

export const baseKeyOf = (key: string): string => key.split('@')[0]

/**
 * The wizard's question for a profile key, asked the way the setup asks it
 * (as {@link questionOfNeed} does): a plain number, a Ja or Nein. Undefined
 * for a key no wizard question writes.
 */
export function questionForKey(key: string): ProjectIntakeQuestion | undefined {
  if (baseKeyOf(key) === 'oib_edition') return oibEditionQuestion(key)
  const question = questionFor(baseKeyOf(key))
  if (!question) return undefined
  const type = question.type === 'number_tri' ? 'number' : question.type === 'yes_no_open' ? 'boolean' : question.type
  return {
    id: key,
    label: question.label,
    type,
    ...(question.unit ? { unit: question.unit } : {}),
    ...(question.placeholder ? { placeholder: question.placeholder } : {}),
    ...(question.options ? { options: question.options } : {}),
  }
}

/**
 * The OIB edition is read off a Bescheid or a Baubeschreibung and no wizard
 * question writes it, yet it decides which Richtlinien apply: a person picks
 * it from the editions the cross-project vocabulary knows.
 */
function oibEditionQuestion(key: string): ProjectIntakeQuestion {
  return {
    id: key,
    label: labelForProfileKey(projectIntakeDefinitionV1, key),
    type: 'single_select',
    options: OIB_EDITIONS.map((year) => ({ value: year, label: year })),
  }
}

/** A value as a person reads it: the option's label, the unit, Ja and Nein. */
export function displayValue(key: string, value: ProjectPrimitiveValue): string {
  const baseKey = baseKeyOf(key)
  if (baseKey === 'building_class') return `GK ${String(value)}`
  const question = questionFor(baseKey)
  return question ? formatIntakeAnswer(question, value) : String(value)
}

/** What the wizard calls a key, per building or not. */
export const keyLabel = (key: string): string => labelForProfileKey(projectIntakeDefinitionV1, key)

/** `bldg3` → 3, for „Bauwerk 3". */
export function buildingNumber(buildingId: string): string {
  return /\d+/.exec(buildingId)?.[0] ?? buildingId
}

/**
 * A Need as the wizard's own question, so the wizard's control can ask it. The
 * id is the profile key and `writesTo` is left out: nothing here writes
 * through the question, the decision does. A `number_tri` is a plain number
 * (the page answers with a value; „Nicht bekannt" is its own button), and a
 * `yes_no_open` is a Ja or Nein, stored as the boolean the wizard stores.
 */
export function questionOfNeed(need: Need): ProjectIntakeQuestion {
  const type = need.type === 'number_tri' ? 'number' : need.type === 'yes_no_open' ? 'boolean' : need.type
  return {
    id: need.key,
    label: need.label,
    type,
    ...(need.why ? { why: need.why } : {}),
    ...(need.unit ? { unit: need.unit } : {}),
    ...(need.options ? { options: need.options.map((option) => ({ value: option.token, label: option.label })) } : {}),
  }
}
