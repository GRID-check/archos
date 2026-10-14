/**
 * What a recorded value becomes (`docs/design/agentic-project-intake.md`,
 * „The BFF decides what a value becomes"). Pure: the service loads the
 * profile, the needs and the readable files, masks the quotes, and hands them
 * here; this answers one result per value and the profile after them.
 *
 * In order, for each value:
 *
 *  1. refused `vocabulary`: a token outside the question's options, a value
 *     of the wrong kind, or an empty one;
 *  2. refused `dismissed`: a value a person dismissed for that key;
 *  3. refused `unreadable-file`: evidence from a file outside the project's
 *     main collection (`extractableFileNames`);
 *  4. refused `unknown-key`: a key no wizard question writes, in the scope
 *     that question is asked in (`questionForKey`), or on a Bauwerk the
 *     profile does not describe. Whether the question is asked yet is not
 *     consulted: a reading may find the Wohnungen before the Nutzungen that
 *     open their question, and the values of one batch do not depend on their
 *     order. A key with a confirmed fact is never refused here: the reading
 *     may corroborate or contradict it. The derived `gebaeudeklasse@bwN` is
 *     always refused, a confirmed one included: it is derived from its inputs
 *     and proposed, and a class taken from a document would skip the inputs a
 *     person checks (and is what an injected line asks for). Checked against
 *     the profile at the write, the first three before (they do not move);
 *  5. equal to the confirmed fact: `corroborated`, its evidence grows;
 *     different: `contradiction`, an alternative on the FACT, which is never
 *     overwritten;
 *  6. equal to the suggestion there: `corroborated`; different: `contradiction`,
 *     an alternative on the suggestion;
 *  7. otherwise a new suggestion (`agent_suggested`), with its evidence.
 *
 * Then the class of every Bauwerk whose inputs moved is derived again and
 * written (`withDerivedClass`).
 */

import {
  validateProfilePatchVocabulary,
  type ProjectIntakeDefinition,
} from '@/lib/project-profile/intake-definition'
import type { DocumentEvidence } from '@/lib/project-profile/evidence-schema'
import type { ProjectPrimitiveValue, ProjectProfile } from '@/lib/project-profile/types'
import {
  bauwerkeTouchedBy,
  bauwerkIdsOf,
  gebaeudeklasseKey,
  isGebaeudeklasseKey,
  withDerivedClass,
} from './derivation-view'
import {
  isMeaningfulValue,
  pointerSegment,
  sameProfileValue,
  suggestedAssumption,
  withAlternative,
  withEvidence,
} from './profile-edits'
import { needOptionsFor, questionForKey, recordableKey } from './needs'
import type { DismissedValue, RecordRefusalReason, RecordResult, RecordValue } from './types'

/** What the screen of one value needs to know besides the value. */
export interface RecordScreen {
  definition: ProjectIntakeDefinition
  dismissed: readonly DismissedValue[]
  readableFiles: ReadonlySet<string>
}

/**
 * The question's vocabulary, as the profile's one door checks it, and the
 * tokens a reading may record for it (never „noch offen", which defers an
 * answer and is no value a document states).
 */
function outsideVocabulary(value: RecordValue, definition: ProjectIntakeDefinition): boolean {
  if (!isMeaningfulValue(value.value)) return true
  try {
    validateProfilePatchVocabulary([
      { op: 'add', path: `/assumptions/${pointerSegment(value.key)}`, value: value.value },
    ])
  } catch {
    return true
  }
  const found = questionForKey(definition, value.key)
  const options = found ? needOptionsFor(found.question, value.key, []) : undefined
  if (!options || options.length === 0) return false
  const tokens = new Set(options.map((option) => option.token))
  const given = Array.isArray(value.value) ? value.value : [value.value]
  return !given.every((token) => typeof token === 'string' && tokens.has(token))
}

/**
 * The refusals that do not depend on the profile as it stands at the write:
 * vocabulary, dismissed, unreadable file. Null when none applies.
 */
export function staticRefusal(value: RecordValue, screen: RecordScreen): RecordRefusalReason | null {
  if (outsideVocabulary(value, screen.definition)) return 'vocabulary'
  const dismissed = screen.dismissed.some(
    (entry) => entry.key === value.key && sameProfileValue(entry.value, value.value)
  )
  if (dismissed) return 'dismissed'
  if (!screen.readableFiles.has(value.evidence.fileName)) return 'unreadable-file'
  return null
}

/** One value that passed the static screen, with its evidence masked and its reason worded. */
export interface ScreenedValue {
  key: string
  value: ProjectPrimitiveValue
  evidence: DocumentEvidence
  reason: string
}

/** Write one value onto the profile, or say why not. */
function applyValue(
  profile: ProjectProfile,
  item: ScreenedValue,
  recordable: (key: string) => boolean,
  now: string
): { profile: ProjectProfile; result: RecordResult } {
  const { key, value, evidence } = item
  if (isGebaeudeklasseKey(key)) return { profile, result: { key, outcome: 'refused', reason: 'unknown-key' } }
  const fact = profile.facts[key]
  if (fact) {
    const corroborates = sameProfileValue(fact.value, value)
    const next = corroborates
      ? { ...fact, evidence: withEvidence(fact.evidence, evidence) }
      : { ...fact, alternatives: withAlternative(fact.alternatives, value, evidence, now) }
    return {
      profile: { ...profile, facts: { ...profile.facts, [key]: next } },
      result: { key, outcome: corroborates ? 'corroborated' : 'contradiction' },
    }
  }
  if (!recordable(key)) return { profile, result: { key, outcome: 'refused', reason: 'unknown-key' } }

  const assumption = profile.assumptions[key]
  if (assumption) {
    const corroborates = sameProfileValue(assumption.value, value)
    const next = corroborates
      ? { ...assumption, evidence: withEvidence(assumption.evidence, evidence) }
      : { ...assumption, alternatives: withAlternative(assumption.alternatives, value, evidence, now) }
    return {
      profile: { ...profile, assumptions: { ...profile.assumptions, [key]: next } },
      result: { key, outcome: corroborates ? 'corroborated' : 'contradiction' },
    }
  }
  const created = suggestedAssumption(value, item.reason, [evidence], now)
  return {
    profile: { ...profile, assumptions: { ...profile.assumptions, [key]: created } },
    result: { key, outcome: 'suggested' },
  }
}

export interface RecordPlan {
  /** One per value, in request order. */
  results: RecordResult[]
  profile: ProjectProfile
  /** The keys whose entries changed, the derived classes included. */
  changedKeys: string[]
}

/**
 * The profile after these values, and what each became. `refusals` holds the
 * static refusals the service already found, by the value's position; those
 * values are not applied.
 */
export function planRecord(
  profile: ProjectProfile,
  definition: ProjectIntakeDefinition,
  values: ReadonlyArray<{ key: string; screened: ScreenedValue | null; refusal: RecordRefusalReason | null }>,
  now: string
): RecordPlan {
  // The Bauwerke as the profile describes them before the batch: no value of it can add one.
  const bauwerkIds = bauwerkIdsOf(profile, definition)
  const recordable = (key: string) => recordableKey(definition, key, bauwerkIds) !== null
  let current = profile
  const results: RecordResult[] = []
  const changed = new Set<string>()
  for (const entry of values) {
    if (entry.refusal || !entry.screened) {
      results.push({ key: entry.key, outcome: 'refused', reason: entry.refusal ?? 'vocabulary' })
      continue
    }
    const applied = applyValue(current, entry.screened, recordable, now)
    current = applied.profile
    results.push(applied.result)
    if (applied.result.outcome !== 'refused') changed.add(entry.key)
  }
  for (const bauwerkId of bauwerkeTouchedBy(changed, bauwerkIdsOf(current, definition))) {
    const derived = withDerivedClass(current, definition, bauwerkId, now)
    current = derived.profile
    if (derived.changed) changed.add(gebaeudeklasseKey(bauwerkId))
  }
  return { results, profile: current, changedKeys: [...changed] }
}
