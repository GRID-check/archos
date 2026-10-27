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

/** What the claim judge found against the sentence's evidence (rule 3, ADR-0139). */
export const CLAIM_JUDGEMENTS = ['supported', 'contradicted', 'not_addressed', 'unavailable'] as const
export type ClaimJudgement = (typeof CLAIM_JUDGEMENTS)[number]

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
   * What the sentence contributes to the answer's count of backed claims
   * (rule 3, ADR-0139): 1 its evidence supports it; 0.5 unchecked or capped (a
   * reading, a pointer that did not hold); 0 nothing behind it, and every
   * verdict on the law without a passage. Computed by the agent, never here;
   * absent on older answers.
   */
  support?: 0 | 0.5 | 1
  /** Rule 3: what the claim judge found; `unavailable` when it could not run. */
  judged?: ClaimJudgement
  /** Rule 3: it concludes something about the law, so only a passage grounds it. */
  verdict?: boolean
  /** Rule 3: it carried a pointer that did not hold (labelled in the text). */
  dropped?: boolean
  /** Rule 3: the table or list under one lead-in it belongs to; the group is one claim. */
  group?: number
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
  const judged = oneOf(input.judged, CLAIM_JUDGEMENTS)
  if (judged) stamp.judged = judged
  if (typeof input.verdict === 'boolean') stamp.verdict = input.verdict
  if (input.dropped === true) stamp.dropped = true
  if (typeof input.group === 'number' && Number.isInteger(input.group) && input.group >= 0 && input.group < 1000)
    stamp.group = input.group
  return stamp
}

/** Whether a stamp states a verdict on the law: the agent's flag, else (older stamps) its claim type. */
const isVerdict = (stamp: ClaimStamp): boolean => stamp.verdict ?? stamp.claimType === 'normative'

/** Whether a stamp carried a pointer that did not hold: the flag, or (older stamps) its class. */
const isDropped = (stamp: ClaimStamp): boolean =>
  stamp.dropped === true || stamp.provenance === 'cited_dropped'

/** The load-bearing stamps as claims: one per sentence, a group (a table under a lead-in) as one. */
function claimsOf(stamps: readonly ClaimStamp[]): ClaimStamp[][] {
  const claims: ClaimStamp[][] = []
  const groups = new Map<number, ClaimStamp[]>()
  for (const stamp of stamps) {
    if (!stamp.loadBearing) continue
    if (stamp.group === undefined) {
      claims.push([stamp])
      continue
    }
    const group = groups.get(stamp.group)
    if (group) group.push(stamp)
    else {
      const members = [stamp]
      groups.set(stamp.group, members)
      claims.push(members)
    }
  }
  return claims
}

/** The answer's claims, those backed whole, those backed in part, and whether the judge could not check some. */
export interface ClaimEvidenceCount {
  backed: number
  partial: number
  claims: number
  unchecked: boolean
}

/**
 * The count the confidence chip leads with under rule 3 („12 von 14 Aussagen
 * belegt · 1 teilweise"): the claims (a load-bearing sentence, or a table
 * under a lead-in as one), those the agent computed as backed whole, and
 * those backed in part (a capped reading, a table whose rows are partly
 * backed, a claim the judge could not check). A partly backed claim is never
 * counted as unbacked. Null when the stamps carry no support (an answer
 * stored before rule 3) or nothing bears load.
 */
export function claimEvidenceCount(stamps: readonly ClaimStamp[]): ClaimEvidenceCount | null {
  const claims = claimsOf(stamps)
  if (claims.length === 0 || claims.some((claim) => claim.some((stamp) => stamp.support === undefined)))
    return null
  // A group's lead-in („Die Grenzwerte lauten [1]:") is no row: the agent scores the rows (claim_supports).
  const rows = (claim: ClaimStamp[]) =>
    claim.length > 1 && claim[0].text.trimEnd().endsWith(':') ? claim.slice(1) : claim
  const mean = (claim: ClaimStamp[]) =>
    rows(claim).reduce((sum, stamp) => sum + (stamp.support ?? 0), 0) / rows(claim).length
  return {
    backed: claims.filter((claim) => mean(claim) === 1).length,
    partial: claims.filter((claim) => mean(claim) > 0 && mean(claim) < 1).length,
    claims: claims.length,
    unchecked: stamps.some((stamp) => stamp.loadBearing && stamp.judged === 'unavailable'),
  }
}

/** What the chip names beside the count under rule 3, read off the stamps alone. */
export type ClaimWarning = 'claimContradicted' | 'normativeClaimUncited' | 'citationUnverified'

/**
 * The warning the stamps themselves call for (ADR-0139), whatever the model
 * said of itself: a verdict on the law its own source contradicts first, then a
 * verdict nothing backs (a next step or a fact is no verdict, and a pure
 * listing names nothing), then a load-bearing pointer that did not hold. Null
 * when none.
 */
export function claimWarning(stamps: readonly ClaimStamp[]): ClaimWarning | null {
  const bearing = stamps.filter((stamp) => stamp.loadBearing)
  if (bearing.some((stamp) => isVerdict(stamp) && stamp.judged === 'contradicted')) return 'claimContradicted'
  if (
    bearing.some(
      (stamp) =>
        isVerdict(stamp) && (stamp.support !== undefined ? stamp.support === 0 : !PASSAGE.has(stamp.provenance)),
    )
  )
    return 'normativeClaimUncited'
  if (bearing.some(isDropped)) return 'citationUnverified'
  return null
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
 * - `normativeUncited`: it concludes something about the law (a verdict) with no quoted or cited passage
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
    if (isDropped(stamp)) mix.dropped += 1
    else if (stamp.claimType === 'normative' && isVerdict(stamp) && !PASSAGE.has(stamp.provenance))
      mix.normativeUncited += 1
    else if (SUPPORTED.has(stamp.provenance)) mix.supported += 1
    else if (stamp.provenance === 'observed') mix.observed += 1
    else if (stamp.provenance === 'reasoning') mix.reasoning += 1
    else mix.modelKnowledge += 1
  }
  return mix
}
