/**
 * Where each sentence of an answer comes from (`TurnResult.claim_stamps`,
 * `src/aiq_agent/common/claim_provenance.py`, ADR-0125, ADR-0139), made durable.
 *
 * One stamp per sentence, in document order: its provenance class (a quoted or
 * cited passage, a workspace record, an action, a measurement, an
 * Einschätzung, the model's own knowledge, or a citation that did not hold),
 * its claim type (law, value, description), and whether the answer's
 * confidence rests on it. The confidence chip explains its level as the mix of
 * these; a later view tints each sentence by its class.
 *
 * Like the quote stamps it lands in message provenance (jsonb, written by the
 * browser and by the agent tier), so the key set is closed and every string is
 * capped on write and again on read. Wire names are snake_case; the stored and
 * client shape is camelCase.
 */

export const CLAIM_PROVENANCES = [
  'quoted',
  'cited',
  'cited_dropped',
  'record',
  'action',
  'measured',
  'observed',
  'reasoning',
  'model_knowledge',
] as const
export type ClaimProvenance = (typeof CLAIM_PROVENANCES)[number]

export const CLAIM_TYPES = ['normative', 'value', 'descriptive'] as const
export type ClaimType = (typeof CLAIM_TYPES)[number]

export interface ClaimStamp {
  /** The sentence as the final text writes it, capped. */
  text: string
  provenance: ClaimProvenance
  claimType: ClaimType
  /** Whether the answer's confidence is held to this sentence. */
  loadBearing: boolean
  /** For a record or an action: the workspace operation it came from. */
  operation?: string
  /**
   * What the sentence contributes to the answer's evidence share (rule 3,
   * ADR-0139): 1 evidence of its own, 0.5 an Einschätzung or a hedge, 0
   * nothing. Computed by the agent, never here; absent on older answers.
   */
  support?: 0 | 0.5 | 1
}

/** A long answer is a few dozen sentences; more is a runaway producer. */
const MAX_STAMPS = 120
const MAX_TEXT_CHARS = 300
const MAX_OPERATION_CHARS = 128

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined

const cap = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : undefined

/** One stamp in either spelling (wire `claim_type`, stored `claimType`), or undefined. */
function sanitizeStamp(input: unknown): ClaimStamp | undefined {
  if (!isRecord(input)) return undefined
  const text = cap(input.text, MAX_TEXT_CHARS)
  const provenance = oneOf(input.provenance, CLAIM_PROVENANCES)
  const claimType = oneOf(input.claimType ?? input.claim_type, CLAIM_TYPES)
  if (!text || !provenance || !claimType) return undefined
  const stamp: ClaimStamp = {
    text,
    provenance,
    claimType,
    loadBearing: (input.loadBearing ?? input.load_bearing) === true,
  }
  const operation = cap(input.operation, MAX_OPERATION_CHARS)
  if (operation) stamp.operation = operation
  if (input.support === 0 || input.support === 0.5 || input.support === 1) stamp.support = input.support
  return stamp
}

/** How many load-bearing sentences the answer has, and how many carry evidence of their own. */
export interface ClaimEvidenceCount {
  backed: number
  claims: number
}

/**
 * The count the confidence chip leads with under rule 3 („12 von 14 Aussagen
 * belegt"): the load-bearing sentences, and those whose `support` the agent
 * computed as whole. Null when the stamps carry no support (an answer stored
 * before rule 3) or nothing bears load.
 */
export function claimEvidenceCount(stamps: readonly ClaimStamp[]): ClaimEvidenceCount | null {
  const bearing = stamps.filter((stamp) => stamp.loadBearing)
  if (bearing.length === 0 || bearing.some((stamp) => stamp.support === undefined)) return null
  return { backed: bearing.filter((stamp) => stamp.support === 1).length, claims: bearing.length }
}

/** The stamps, bounded, or null when none survive. */
export function sanitizeClaimStamps(input: unknown): ClaimStamp[] | null {
  if (!Array.isArray(input)) return null
  const stamps: ClaimStamp[] = []
  for (const raw of input) {
    if (stamps.length >= MAX_STAMPS) break
    const stamp = sanitizeStamp(raw)
    if (stamp) stamps.push(stamp)
  }
  return stamps.length > 0 ? stamps : null
}

/** The evidence classes: a passage, a record, an action or a measurement stands behind the sentence. */
const SUPPORTED: ReadonlySet<ClaimProvenance> = new Set([
  'quoted',
  'cited',
  'record',
  'action',
  'measured',
])
const PASSAGE: ReadonlySet<ClaimProvenance> = new Set(['quoted', 'cited'])

/**
 * How the confidence chip says what the answer rests on, one count per bucket,
 * each sentence in exactly one:
 *
 * - `dropped`: it cited something that did not hold;
 * - `normativeUncited`: it states the law with no quoted or cited passage
 *   (a record or a measurement beside it does not count);
 * - `supported`: a passage, a record, an action or a measurement stands behind it;
 * - `observed`: it repeats a value a look read off a drawing (never grounds the law);
 * - `reasoning`: an Einschätzung drawn from a cited sentence near it;
 * - `modelKnowledge`: the model's own knowledge, nothing in the answer behind it.
 */
export interface ClaimMix {
  supported: number
  observed: number
  reasoning: number
  modelKnowledge: number
  normativeUncited: number
  dropped: number
}

export function claimMix(stamps: readonly ClaimStamp[]): ClaimMix {
  const mix: ClaimMix = {
    supported: 0,
    observed: 0,
    reasoning: 0,
    modelKnowledge: 0,
    normativeUncited: 0,
    dropped: 0,
  }
  for (const stamp of stamps) {
    if (stamp.provenance === 'cited_dropped') mix.dropped += 1
    else if (stamp.claimType === 'normative' && !PASSAGE.has(stamp.provenance))
      mix.normativeUncited += 1
    else if (SUPPORTED.has(stamp.provenance)) mix.supported += 1
    else if (stamp.provenance === 'observed') mix.observed += 1
    else if (stamp.provenance === 'reasoning') mix.reasoning += 1
    else mix.modelKnowledge += 1
  }
  return mix
}
