/**
 * Where each sentence of an answer comes from (`TurnResult.claim_stamps`,
 * `src/aiq_agent/common/claim_provenance.py`, ADR-0125), made durable.
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
  return stamp
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
 * - `reasoning`: an Einschätzung drawn from a cited sentence near it;
 * - `modelKnowledge`: the model's own knowledge, nothing in the answer behind it.
 */
export interface ClaimMix {
  supported: number
  reasoning: number
  modelKnowledge: number
  normativeUncited: number
  dropped: number
}

export function claimMix(stamps: readonly ClaimStamp[]): ClaimMix {
  const mix: ClaimMix = {
    supported: 0,
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
    else if (stamp.provenance === 'reasoning') mix.reasoning += 1
    else mix.modelKnowledge += 1
  }
  return mix
}
