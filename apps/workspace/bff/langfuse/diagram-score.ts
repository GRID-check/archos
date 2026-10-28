import 'server-only'
/**
 * A drawing Piloti made, filed into a project, as a Langfuse score on the trace
 * of the turn that drew it (ADR-0089, ADR-0141).
 *
 * `diagram-filed`, `CATEGORICAL`, value `as_drawn | edited`, declared in
 * `agent.observability.langfuse_scores.SCORE_DEFINITIONS`. `as_drawn` is
 * the drawing kept as Piloti made it; `edited` is the same drawing reworked in
 * the sketch editor first. The share of `edited` is how often Piloti's drawing
 * was a starting point rather than the result, which is what decides whether
 * reopening a filed sketch is worth building.
 *
 * The score id is the filed SVG's document id, so filing the same drawing
 * again (idempotent per answer and source) upserts instead of counting twice.
 * Like `piloti-decision` it says what happened, never who did it.
 *
 * No answer id, or no trace on that answer, means no score: a score on a
 * guessed trace attaches to nothing.
 */

import type { LangfuseClient } from '@langfuse/client'
import { withTenant } from '@/lib/db/tenant-context'
import { getAnswerTraceId } from '@/lib/feedback/repository'
import { langfuseApiConfig } from './config'
import { upsertScore } from './feedback-score'

/** The score's name in Langfuse. A contract: dashboards and filters select it by name. */
export const DIAGRAM_SCORE_NAME = 'diagram-filed'

type ScoreRequest = Parameters<LangfuseClient['api']['scores']['create']>[0]

export interface DiagramScoreInput {
  organizationId: string
  /** The chat message the diagram was drawn in; null when the surface did not say. */
  answerId: string | null
  /** The filed SVG. */
  documentId: string
  edited: boolean
}

export function diagramScoreId(documentId: string): string {
  return `${DIAGRAM_SCORE_NAME}-${documentId}`
}

/** The filing as a Langfuse score. Pure, so the mapping is tested without a network. */
export function toDiagramScore(input: { traceId: string; documentId: string; edited: boolean }): ScoreRequest {
  return {
    id: diagramScoreId(input.documentId),
    traceId: input.traceId,
    name: DIAGRAM_SCORE_NAME,
    dataType: 'CATEGORICAL',
    value: input.edited ? 'edited' : 'as_drawn',
    metadata: { document_id: input.documentId },
  }
}

/** Record one filing. Resolves when done and never rejects. */
export async function recordDiagramScore(input: DiagramScoreInput): Promise<void> {
  const config = langfuseApiConfig()
  if (!config || !input.answerId) return
  const answerId = input.answerId
  try {
    const traceId = await withTenant({ organizationId: input.organizationId }, () =>
      getAnswerTraceId(answerId, input.organizationId)
    )
    if (!traceId) return
    await upsertScore(config, diagramScoreId(input.documentId), toDiagramScore({ ...input, traceId }))
  } catch (error) {
    console.warn(`[Langfuse] diagram score failed for ${input.documentId} (non-fatal):`, error)
  }
}
