import 'server-only'
/**
 * A person saved a new Fassung of a sketch Piloti drew, as a Langfuse score on
 * the trace of the turn that drew it (ADR-0089, ADR-0148).
 *
 * `sketch-revised`, `NUMERIC` ≥ 2, declared in
 * `agent.observability.langfuse_scores.SCORE_DEFINITIONS`: the Fassung number
 * the save reached. The score id is the sketch's document id, so every save
 * upserts the one score and its value is how many Fassungen the sketch has.
 * Read beside `diagram-filed`: how often Piloti's drawing is a document people
 * come back to, not a picture filed once.
 *
 * The turn is found through the sketch's `authored_by_ref`, which filing wrote
 * as `{answer id}-{8 hex}` (`diagramRunId`). A reference of another shape, or
 * an answer with no trace, means no score: a score on a guessed trace attaches
 * to nothing.
 *
 * `sketch-save`, `CATEGORICAL`, one per save attempt on the same trace: what
 * the attempt came to. `saved`; `pdf_stale` (saved, and the PDF beside it could
 * not be drawn again); `conflict` (409, a newer Fassung: the editor merges it
 * and tries again, so a conflict followed by a `saved` is a merge that worked);
 * `refused` (400, the scene or the SVG; the comment names the refusal);
 * `drafted` (saved into the open Freigabe draft, nothing published);
 * `review_open` (409, a version is in review: nothing saved); `render_failed`
 * (503, the server could not draw the scene's picture: the comment names why,
 * `busy`, `timeout`, `crashed`, `failed`, `unavailable` or `too_much_text`; ADR-0149). Metadata
 * `carried` and `lost` count the pinned marks that went onto the Fassung and
 * those of them whose elements are all gone; `render_ms`, `render_elements` and
 * `remeasured` say what drawing the picture cost.
 * `sketch-revised` counts the Fassungen; this is the share of saves that
 * needed a merge or failed, which is what a shared sketch most needs watched.
 */

import { randomUUID } from 'node:crypto'
import type { LangfuseClient } from '@langfuse/client'
import { withTenant } from '@/lib/db/tenant-context'
import { getAnswerTraceId } from '@/lib/feedback/repository'
import { langfuseApiConfig } from './config'
import { upsertScore } from './feedback-score'

/** The score's name in Langfuse. A contract: dashboards and filters select it by name. */
export const SKETCH_REVISED_SCORE_NAME = 'sketch-revised'

type ScoreRequest = Parameters<LangfuseClient['api']['scores']['create']>[0]

export interface SketchRevisedInput {
  organizationId: string
  documentId: string
  /** The sketch's `authored_by_ref`, which names the answer that drew it. */
  answerRef: string
  versionNumber: number
}

/** The answer id inside a diagram's reference (`diagramRunId`), or null for another shape. */
export function answerIdOfDiagramRef(ref: string): string | null {
  return /^(.+)-[0-9a-f]{8}$/.exec(ref)?.[1] ?? null
}

export function sketchRevisedScoreId(documentId: string): string {
  return `${SKETCH_REVISED_SCORE_NAME}-${documentId}`
}

/** The save as a Langfuse score. Pure, so the mapping is tested without a network. */
export function toSketchRevisedScore(input: { traceId: string; documentId: string; versionNumber: number }): ScoreRequest {
  return {
    id: sketchRevisedScoreId(input.documentId),
    traceId: input.traceId,
    name: SKETCH_REVISED_SCORE_NAME,
    dataType: 'NUMERIC',
    value: input.versionNumber,
    metadata: { document_id: input.documentId },
  }
}

/** Write a score on the trace of the turn that drew the sketch. Resolves when done and never rejects. */
async function scoreOnDrawingTurn(
  input: { organizationId: string; documentId: string; answerRef: string },
  scoreId: string,
  build: (traceId: string) => ScoreRequest
): Promise<void> {
  const answerId = answerIdOfDiagramRef(input.answerRef)
  if (answerId) await scoreOnAnswer(input, answerId, scoreId, build)
}

/** Write a score on the trace of one answer message. Resolves when done and never rejects. */
async function scoreOnAnswer(
  input: { organizationId: string; documentId: string },
  answerId: string,
  scoreId: string,
  build: (traceId: string) => ScoreRequest
): Promise<void> {
  const config = langfuseApiConfig()
  if (!config) return
  try {
    const traceId = await withTenant({ organizationId: input.organizationId }, () =>
      getAnswerTraceId(answerId, input.organizationId)
    )
    if (!traceId) return
    await upsertScore(config, scoreId, build(traceId))
  } catch (error) {
    console.warn(`[Langfuse] sketch score failed for ${input.documentId} (non-fatal):`, error)
  }
}

/** Record one save. Resolves when done and never rejects. */
export function recordSketchRevisedScore(input: SketchRevisedInput): Promise<void> {
  return scoreOnDrawingTurn(input, sketchRevisedScoreId(input.documentId), (traceId) =>
    toSketchRevisedScore({ ...input, traceId })
  )
}

/** The name of the per-attempt score. A contract, as above. */
export const SKETCH_SAVE_SCORE_NAME = 'sketch-save'

export const SKETCH_SAVE_OUTCOMES = ['saved', 'drafted', 'pdf_stale', 'conflict', 'review_open', 'refused', 'render_failed'] as const
export type SketchSaveOutcome = (typeof SKETCH_SAVE_OUTCOMES)[number]

export interface SketchSaveInput {
  organizationId: string
  documentId: string
  answerRef: string
  outcome: SketchSaveOutcome
  /** For `refused`: which rule, e.g. `unsupported-element`. */
  refusal?: string
  /** Facts of the attempt, snake_case: `version_number`, `bumped`, `tombstoned`, `pdf`. */
  metadata?: Record<string, string | number>
}

/** One save attempt as a Langfuse score. Pure. */
export function toSketchSaveScore(input: SketchSaveInput & { traceId: string; id: string }): ScoreRequest {
  return {
    id: input.id,
    traceId: input.traceId,
    name: SKETCH_SAVE_SCORE_NAME,
    dataType: 'CATEGORICAL',
    value: input.outcome,
    ...(input.refusal ? { comment: input.refusal } : {}),
    metadata: { document_id: input.documentId, ...input.metadata },
  }
}

/** Record one save attempt, whatever it came to. Resolves when done and never rejects. */
export function recordSketchSaveScore(input: SketchSaveInput): Promise<void> {
  const id = `${SKETCH_SAVE_SCORE_NAME}-${randomUUID()}`
  return scoreOnDrawingTurn(input, id, (traceId) => toSketchSaveScore({ ...input, traceId, id }))
}

/** The name of the carry-forward score. A contract, as above. */
export const SKETCH_PINS_KEPT_SCORE_NAME = 'sketch-pins-kept'

export interface SketchPinsKeptInput {
  organizationId: string
  documentId: string
  answerRef: string
  /** The Fassung the pins went onto. */
  versionId: string
  moved: number
  /** Of those, the pins whose elements are all gone. */
  lost: number
  /** How the Fassung became current: a sketch save, or a Freigabe or upload (`lib/documents/current-version.ts`). */
  path: 'save' | 'publish'
}

/**
 * The carry as a Langfuse score: the share of the moved pins still on an
 * element. Pure. One per Fassung (the id names it), so a retry upserts.
 */
export function toSketchPinsKeptScore(input: SketchPinsKeptInput & { traceId: string }): ScoreRequest {
  return {
    id: `${SKETCH_PINS_KEPT_SCORE_NAME}-${input.versionId}`,
    traceId: input.traceId,
    name: SKETCH_PINS_KEPT_SCORE_NAME,
    dataType: 'NUMERIC',
    value: (input.moved - input.lost) / input.moved,
    metadata: { document_id: input.documentId, moved: input.moved, lost: input.lost, path: input.path },
  }
}

/** Record a carry that moved at least one pin. Resolves when done and never rejects. */
export function recordSketchPinsKeptScore(input: SketchPinsKeptInput): Promise<void> {
  if (input.moved <= 0) return Promise.resolve()
  return scoreOnDrawingTurn(input, `${SKETCH_PINS_KEPT_SCORE_NAME}-${input.versionId}`, (traceId) =>
    toSketchPinsKeptScore({ ...input, traceId })
  )
}

/** The name of the release score. A contract, as above. */
export const SKETCH_RELEASED_SCORE_NAME = 'sketch-released'

/** What the step after a Freigabe came to: the PDF's outcome (`CompanionPdfOutcome`), or `unreadable` when the bytes could not be read. */
export const SKETCH_RELEASED_OUTCOMES = ['redrawn', 'none', 'superseded', 'confined', 'failed', 'unreadable'] as const
export type SketchReleasedOutcome = (typeof SKETCH_RELEASED_OUTCOMES)[number]

export interface SketchReleasedInput {
  organizationId: string
  documentId: string
  answerRef: string
  /** The Fassung the Freigabe made current. */
  versionId: string
  outcome: SketchReleasedOutcome
  /** 1 for the release itself, then the `sketch_rendition` job's attempts. */
  attempt: number
  /** Whether a retry is queued after this attempt. */
  queued: boolean
}

/**
 * A Skizze's Fassung made current by Freigabe, and what became of its PDF and
 * marks once the release committed (`lib/diagrams/sketch-promoted.ts`). Pure.
 * One per Fassung (the id names it): a retry upserts, so the value is the
 * latest attempt's and `attempt` says how many it took.
 */
export function toSketchReleasedScore(input: SketchReleasedInput & { traceId: string }): ScoreRequest {
  return {
    id: `${SKETCH_RELEASED_SCORE_NAME}-${input.versionId}`,
    traceId: input.traceId,
    name: SKETCH_RELEASED_SCORE_NAME,
    dataType: 'CATEGORICAL',
    value: input.outcome,
    metadata: { document_id: input.documentId, attempt: input.attempt, queued: input.queued ? 1 : 0 },
  }
}

/** Record one attempt of the step after a Freigabe. Resolves when done and never rejects. */
export function recordSketchReleasedScore(input: SketchReleasedInput): Promise<void> {
  return scoreOnDrawingTurn(input, `${SKETCH_RELEASED_SCORE_NAME}-${input.versionId}`, (traceId) =>
    toSketchReleasedScore({ ...input, traceId })
  )
}

/** The name of the edit score. A contract, as above. */
export const SKETCH_EDIT_SCORE_NAME = 'sketch-edit'

/**
 * What became of one edit Piloti (or an agent) made to a Skizze through
 * `document-sketch-edit` (S4): `proposed` (it passed the check and became a
 * proposal), `declined` (no operations, only a note: nothing proposed),
 * `refused` (an operation the sketch cannot take; the comment names the rule,
 * e.g. `unknown-id`, or `sketch_changed` when a rebase found an id gone),
 * `accepted` (applied on the Fassung it was made for), `rebased` (applied on a
 * newer one, every id it names still drawn), `undone` (the Fassung an edit or
 * a save made was taken back with document-sketch-revert), `failed` (a
 * preview or an undo that could not be done; metadata `step` says which,
 * the comment why).
 *
 * On the trace of the turn that proposed the edit when it is known (the
 * check's turn, or the applied proposal's origin, `proposing-turn.ts`),
 * otherwise on the trace of the turn that drew the sketch.
 */
export const SKETCH_EDIT_OUTCOMES = ['proposed', 'declined', 'refused', 'accepted', 'rebased', 'undone', 'failed'] as const
export type SketchEditOutcome = (typeof SKETCH_EDIT_OUTCOMES)[number]

export interface SketchEditScoreInput {
  organizationId: string
  documentId: string
  /** The sketch's `authored_by_ref`: the drawing turn, where the score goes when no proposing turn is known. */
  answerRef: string | null
  /** The answer message of the turn that proposed the edit; wins over `answerRef`. */
  proposingMessageId?: string | null
  outcome: SketchEditOutcome
  refusal?: string
  /** `ops`, the operation kinds (`kinds`, comma-separated), `warnings`, `added`, `removed`, `changed`. */
  metadata?: Record<string, string | number>
}

/** One edit's outcome as a Langfuse score. Pure. */
export function toSketchEditScore(input: SketchEditScoreInput & { traceId: string; id: string }): ScoreRequest {
  return {
    id: input.id,
    traceId: input.traceId,
    name: SKETCH_EDIT_SCORE_NAME,
    dataType: 'CATEGORICAL',
    value: input.outcome,
    ...(input.refusal ? { comment: input.refusal } : {}),
    metadata: { document_id: input.documentId, ...input.metadata },
  }
}

/** Record one edit's outcome on the trace of the turn that proposed it, else the one that drew the sketch. Resolves when done and never rejects. */
export function recordSketchEditScore(input: SketchEditScoreInput): Promise<void> {
  const answerId = input.proposingMessageId ?? (input.answerRef ? answerIdOfDiagramRef(input.answerRef) : null)
  if (!answerId) return Promise.resolve()
  const id = `${SKETCH_EDIT_SCORE_NAME}-${randomUUID()}`
  return scoreOnAnswer(input, answerId, id, (traceId) => toSketchEditScore({ ...input, traceId, id }))
}
