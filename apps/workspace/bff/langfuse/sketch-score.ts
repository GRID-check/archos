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
 * `refused` (400, the scene or the SVG; the comment names the refusal).
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
  const config = langfuseApiConfig()
  const answerId = answerIdOfDiagramRef(input.answerRef)
  if (!config || !answerId) return
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

export const SKETCH_SAVE_OUTCOMES = ['saved', 'pdf_stale', 'conflict', 'refused'] as const
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
