import 'server-only'
/**
 * What one notice of a new Fassung left (ADR-0130), as a Langfuse score on the
 * trace of the vision call that looked: `revision-notice`, NUMERIC, the number
 * of marks it proposed. Zero is an answer („compared, nothing visible"), so it
 * is written too. With `piloti-decision` on each of those marks (taken over or
 * dismissed, `./decision-score.ts`), it is the precision of noticing: of the
 * marks proposed, how many a person stood behind.
 *
 * Declared in `agent.observability.langfuse_scores.SCORE_DEFINITIONS`.
 * The id is derived from the notice, so a retried job upserts. Best-effort:
 * never throws into the job, and without a trace (a cached comparison, tracing
 * off) there is no score, because a score on a guessed trace attaches to
 * nothing.
 */

import { langfuseApiConfig } from './config'
import { upsertScore } from './feedback-score'

/** The score's name in Langfuse. A contract: dashboards select it by name. */
export const REVISION_NOTICE_SCORE_NAME = 'revision-notice'

type ScoreRequest = Parameters<typeof upsertScore>[2]

/** The score as Langfuse takes it. Pure. */
export function toRevisionNoticeScore(input: {
  noticeId: string
  traceId: string
  proposed: number
  pagesCompared: number
  pagesChanged: number
}): ScoreRequest {
  return {
    id: `${REVISION_NOTICE_SCORE_NAME}-${input.noticeId}`,
    traceId: input.traceId,
    name: REVISION_NOTICE_SCORE_NAME,
    dataType: 'NUMERIC',
    value: input.proposed,
    metadata: {
      notice_id: input.noticeId,
      pages_compared: input.pagesCompared,
      pages_changed: input.pagesChanged,
    },
  }
}

/** Record what a notice left. Resolves when done and never rejects. */
export async function recordRevisionNoticeScore(input: {
  noticeId: string
  traceId: string | null
  proposed: number
  pagesCompared: number
  pagesChanged: number
}): Promise<void> {
  const config = langfuseApiConfig()
  if (!config || !input.traceId) return
  const score = toRevisionNoticeScore({ ...input, traceId: input.traceId })
  try {
    await upsertScore(config, String(score.id), score)
  } catch (error) {
    console.warn(`[Langfuse] revision-notice score failed for ${input.noticeId} (non-fatal):`, error)
  }
}
