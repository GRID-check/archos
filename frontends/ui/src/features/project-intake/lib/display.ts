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
import type { Need } from '@/lib/project-intake/types'

const WRITTEN_KEY = /^\/(?:facts|goals)\/([^/]+)/

let questionsByKey: Map<string, ProjectIntakeQuestion> | null = null

/** The wizard question that writes a base key (`geschosse_oberirdisch`), once per page load. */
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

/** A value as a person reads it: the option's label, the unit, Ja and Nein. */
export function displayValue(key: string, value: ProjectPrimitiveValue): string {
  const baseKey = baseKeyOf(key)
  if (baseKey === 'gebaeudeklasse') return `GK ${String(value)}`
  const question = questionFor(baseKey)
  return question ? formatIntakeAnswer(question, value) : String(value)
}

/** What the wizard calls a key, per building or not. */
export const keyLabel = (key: string): string => labelForProfileKey(projectIntakeDefinitionV1, key)

/** `bw3` → 3, for „Bauwerk 3". */
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
