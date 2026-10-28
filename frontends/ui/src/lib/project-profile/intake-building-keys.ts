/**
 * How an answer is keyed: building ids, the per-building and per-zone answer keys, and the mode keys beside them.
 */

import { projectIntakeDefinitionV1 } from './intake-definition'
import type { ProjectIntakeScope } from './intake-types'

// ---------------------------------------------------------------------------
// Scope helpers — the four-scope model layered onto the flat profile store.
// ---------------------------------------------------------------------------

/** A building's instance id is this prefix and its number: `bldg1`, `bldg2`. */
export const BUILDING_ID_PREFIX = 'bldg'

/** The instance id in an answer or storage key: `…@bldg2`, at the end, before another `@` or before `__`. */
export const BUILDING_ID_IN_KEY = new RegExp(`@(${BUILDING_ID_PREFIX}\\d+)(?:@|$)`)

export const BUILDING_ID_IN_ANSWER_KEY = new RegExp(`@(${BUILDING_ID_PREFIX}\\d+)(?:@|$|__)`)

/** The number in an instance id, to put buildings in the order they were added. */
export function buildingNumber(id: string): number {
  return Number(id.slice(BUILDING_ID_PREFIX.length))
}

const BUILDING_ID = new RegExp(`^${BUILDING_ID_PREFIX}[1-9]\\d*$`)

/** Whether `id` is a building instance id (`bldg1`). */
export function isBuildingId(id: string): boolean {
  return BUILDING_ID.test(id)
}

/** The short tag a person sees for a building without a name: „BW1" (Bauwerk 1), whatever the stored id is. */
export function buildingTag(id: string): string {
  return `BW${buildingNumber(id)}`
}

/** A repeatable building instance. */
export interface BuildingInstance {
  id: string
  name: string
}

export function defaultBuildings(): BuildingInstance[] {
  return [{ id: `${BUILDING_ID_PREFIX}1`, name: 'Bauwerk 1' }]
}

/** The wizard's answer-state key for a question in a given scope instance. */
export function answerKeyFor(questionId: string, buildingId?: string, zoneKey?: string): string {
  let key = questionId
  if (buildingId) key += `@${buildingId}`
  if (zoneKey) key += `@${zoneKey}`
  return key
}

/**
 * The building an answer key belongs to, or null for a project-scope one.
 *
 * The inverse of {@link answerKeyFor}, kept beside it so the two cannot drift
 * about what the separator means. A document-role question needs this: a
 * `building` role has to name its building, and the wizard only knows which
 * building it is rendering through the key.
 */
export function buildingIdFromAnswerKey(answerKey: string): string | null {
  const [, buildingId] = answerKey.split('@')
  return buildingId ?? null
}

/** A building's name in the wizard's answer state (the browser draft); the profile keeps it as the `building_name` fact. */
export const BUILDING_NAME_ANSWER_PREFIX = '__building_name@'

/** The sibling key under which a number_tri question stores its answer mode. */
export function modeKeyFor(answerKey: string): string {
  return `${answerKey}__mode`
}

/** Map a question id to its module scope (project/plot/building). */
export function scopeOfQuestion(questionId: string): ProjectIntakeScope | null {
  for (const stage of projectIntakeDefinitionV1.stages) {
    if (stage.questions.some((q) => q.id === questionId)) return stage.scope
    if (stage.zoneCommon?.some((q) => q.id === questionId)) return 'building'
    for (const def of Object.values(stage.zoneDefinitions ?? {})) {
      if (def.questions.some((q) => q.id === questionId)) return 'building'
    }
  }
  return null
}
