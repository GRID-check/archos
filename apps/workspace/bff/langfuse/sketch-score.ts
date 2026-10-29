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
 */

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

/** Record one save. Resolves when done and never rejects. */
export async function recordSketchRevisedScore(input: SketchRevisedInput): Promise<void> {
  const config = langfuseApiConfig()
  const answerId = answerIdOfDiagramRef(input.answerRef)
  if (!config || !answerId) return
  try {
    const traceId = await withTenant({ organizationId: input.organizationId }, () =>
      getAnswerTraceId(answerId, input.organizationId)
    )
    if (!traceId) return
    await upsertScore(config, sketchRevisedScoreId(input.documentId), toSketchRevisedScore({ ...input, traceId }))
  } catch (error) {
    console.warn(`[Langfuse] sketch score failed for ${input.documentId} (non-fatal):`, error)
  }
}
