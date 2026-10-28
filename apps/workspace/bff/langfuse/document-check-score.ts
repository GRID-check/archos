import 'server-only'
/**
 * What one check of a new document left (ADR-0130, second slice), as a
 * Langfuse score on the trace of the headless turn that ran it:
 * `document-check`, NUMERIC, the number of marks it proposed because a fact
 * disagreed with another document. Zero is an answer („checked, everything
 * agrees"), so it is written too. With `piloti-decision` on each of those marks
 * (`./decision-score.ts`) it is the precision of the check.
 *
 * Declared in `aiq_agent.observability.langfuse_scores.SCORE_DEFINITIONS`. The
 * id is derived from the check, so a retried job upserts. Best-effort: never
 * throws into the job, and without a trace there is no score, because a score
 * on a guessed trace attaches to nothing.
 */

import { langfuseApiConfig } from './config'
import { upsertScore } from './feedback-score'

/** The score's name in Langfuse. A contract: dashboards select it by name. */
export const DOCUMENT_CHECK_SCORE_NAME = 'document-check'

type ScoreRequest = Parameters<typeof upsertScore>[2]

/** The score as Langfuse takes it. Pure. */
export function toDocumentCheckScore(input: { checkId: string; traceId: string; findings: number }): ScoreRequest {
  return {
    id: `${DOCUMENT_CHECK_SCORE_NAME}-${input.checkId}`,
    traceId: input.traceId,
    name: DOCUMENT_CHECK_SCORE_NAME,
    dataType: 'NUMERIC',
    value: input.findings,
    metadata: { check_id: input.checkId },
  }
}

/** Record what a check left. Resolves when done and never rejects. */
export async function recordDocumentCheckScore(input: {
  checkId: string
  traceId: string | null
  findings: number
}): Promise<void> {
  const config = langfuseApiConfig()
  if (!config || !input.traceId) return
  const score = toDocumentCheckScore({ ...input, traceId: input.traceId })
  try {
    await upsertScore(config, String(score.id), score)
  } catch (error) {
    console.warn(`[Langfuse] document-check score failed for ${input.checkId} (non-fatal):`, error)
  }
}
