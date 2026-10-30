import 'server-only'
/**
 * What became of a page traced into a Skizze (S6, ADR-0150), as a Langfuse
 * trace `sketch-underlay` holding the score `sketch-underlay` (ADR-0089).
 *
 * `CATEGORICAL`, declared in `agent.observability.langfuse_scores.SCORE_DEFINITIONS`:
 * `created` (a Skizze started on a page), `moved` (its page swapped for the
 * base's newer Fassung), or `refused:<reason>`, one of
 * {@link UNDERLAY_REFUSALS}. A person starts most of these, so there is no
 * chat turn to score on: each event is its own trace, posted with its score in
 * one ingestion batch. Ids and reasons only, never a name or a page: the
 * document ids are in the metadata, the person only under
 * `TRACE_IDENTITY_ATTRIBUTES=true`, as on every trace.
 *
 * Read for: how often a page is held by screening when someone wants to draw on
 * it (`refused:underlay_held`), how often the folder rule stops a move
 * (`refused:underlay_wider`, `refused:traced_sketches_wider`), and how often a
 * newer Fassung's labels fail to name the page (`refused:label_ambiguous`,
 * `refused:page_gone`).
 *
 * Best-effort: never awaited by a request, never rejects, nothing sent while
 * Langfuse is unconfigured.
 */

import { LangfuseClient } from '@langfuse/client'
import { type LangfuseApiConfig, langfuseApiConfig } from './config'

export const SKETCH_UNDERLAY_SCORE_NAME = 'sketch-underlay'

/** The refusals a value names; anything else is not scored. */
export const UNDERLAY_REFUSALS = [
  'underlay_held',
  'underlay_wider',
  'underlay_other_project',
  'underlay_unavailable',
  'traced_sketches_wider',
  'label_ambiguous',
  'page_gone',
] as const
export type UnderlayRefusal = (typeof UNDERLAY_REFUSALS)[number]

export const SKETCH_UNDERLAY_VALUES = ['created', 'moved', ...UNDERLAY_REFUSALS.map((reason) => `refused:${reason}` as const)] as const
export type SketchUnderlayValue = (typeof SKETCH_UNDERLAY_VALUES)[number]

export const isUnderlayRefusal = (reason: unknown): reason is UnderlayRefusal => (UNDERLAY_REFUSALS as readonly unknown[]).includes(reason)

export interface SketchUnderlayEvent {
  organizationId: string
  userId: string
  value: SketchUnderlayValue
  /** The Skizze, when there is one yet. */
  sketchId?: string | null
  /** The document the page is of. */
  baseId?: string | null
  /** How the moved page was found: `label`, `index` or `chosen`. */
  matchedBy?: string | null
}

type IngestionBatch = Parameters<LangfuseClient['api']['ingestion']['batch']>[0]

const identityOn = () => process.env.TRACE_IDENTITY_ATTRIBUTES?.trim().toLowerCase() === 'true'

/** The ingestion batch for one event: its trace and its score. Pure. */
export function underlayScoreBatch(event: SketchUnderlayEvent, ids: { traceId: string; scoreId: string; eventIds: [string, string] }, now = new Date()): IngestionBatch {
  const timestamp = now.toISOString()
  const metadata = {
    ...(event.sketchId ? { sketch_id: event.sketchId } : {}),
    ...(event.baseId ? { base_id: event.baseId } : {}),
    ...(event.matchedBy ? { matched_by: event.matchedBy } : {}),
  }
  const identity = identityOn()
  return {
    batch: [
      {
        type: 'trace-create',
        id: ids.eventIds[0],
        timestamp,
        body: {
          id: ids.traceId,
          timestamp,
          name: SKETCH_UNDERLAY_SCORE_NAME,
          metadata,
          tags: ['feature:sketch-underlay', ...(identity ? [`org:${event.organizationId}`] : [])],
          ...(identity ? { userId: event.userId } : {}),
        },
      },
      {
        type: 'score-create',
        id: ids.eventIds[1],
        timestamp,
        body: { id: ids.scoreId, traceId: ids.traceId, name: SKETCH_UNDERLAY_SCORE_NAME, dataType: 'CATEGORICAL', value: event.value, metadata },
      },
    ],
  }
}

let cached: { key: string; client: LangfuseClient } | null = null

function clientFor(config: LangfuseApiConfig): LangfuseClient {
  const key = `${config.baseUrl}\u0000${config.publicKey}\u0000${config.secretKey}`
  if (cached?.key !== key) {
    cached = { key, client: new LangfuseClient({ publicKey: config.publicKey, secretKey: config.secretKey, baseUrl: config.baseUrl, timeout: 5 }) }
  }
  return cached.client
}

const hexId = () => crypto.randomUUID().replace(/-/g, '')

/** Post one event. Resolves when sent or skipped, never rejects; callers do not await it. */
export async function recordSketchUnderlayScore(event: SketchUnderlayEvent): Promise<void> {
  const config = langfuseApiConfig()
  if (!config) return
  try {
    const batch = underlayScoreBatch(event, { traceId: hexId(), scoreId: crypto.randomUUID(), eventIds: [crypto.randomUUID(), crypto.randomUUID()] })
    await clientFor(config).api.ingestion.batch(batch, { timeoutInSeconds: 5, maxRetries: 1 })
  } catch (error) {
    console.warn('[Langfuse] sketch underlay score failed (non-fatal):', error)
  }
}

/** The refusal an error names, as the value it is scored by, or null for any other failure. */
export function underlayRefusalValue(error: unknown): SketchUnderlayValue | null {
  const details = (error as { details?: { reason?: unknown } } | null)?.details
  return isUnderlayRefusal(details?.reason) ? `refused:${details.reason}` : null
}
