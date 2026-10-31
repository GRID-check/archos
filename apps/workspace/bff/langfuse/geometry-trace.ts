import 'server-only'
/**
 * One geometry call the BFF made (`bff/bim/geometry-service.ts`) as a Langfuse trace: the trace
 * `bim-geometry` holding one SPAN of the same name, with the shape of the call and never the
 * building: operation, status, which cache answered (`A` a resident parse, `B` the shared element
 * index, `cold` a download and build), element count, milliseconds, truncation, and whether an
 * agent or a person asked. The geometry service returns those facts in its `meta`
 * (`apps/geometry/src/geometry_service/trace.py`, the `record_ifc_call` facts).
 *
 * The trace id is chosen before the call and sent to the service (`x-trace-id`): the service writes
 * `geometry-cold-ms` on this trace when a cold build it started completes, whether this call waited
 * for it or was answered 409 (ADR-0149), so the score is not biased toward the fast builds.
 *
 * Best-effort like `tool-call-trace.ts`: posted without waiting, never fails the call, and nothing
 * is sent with Langfuse unconfigured.
 */

import type { LangfuseClient } from '@langfuse/client'
import type { GeometryCacheTier, GeometryOp } from '@/lib/bim/geometry-wire'
import { langfuseApiConfig } from './config'
import { clientFor, environment, identityOn, release } from './tool-call-trace'

export const GEOMETRY_TRACE_NAME = 'bim-geometry'

export interface GeometryCallRecord {
  op: GeometryOp
  status: number
  /** The service's code on a refusal (`geometry_warming`, `model_not_found`, …), else null. */
  code: string | null
  cacheTier: GeometryCacheTier | null
  elements: number | null
  /** The service's own milliseconds, when it answered. */
  serviceMs: number | null
  truncated: boolean | null
  reader: 'agent' | 'person'
  startedAt: number
  endedAt: number
  organizationId: string
  userId: string
  /** Chosen before the call and sent to the service, which scores a cold build on it. */
  traceId: string
}

type IngestionBatch = Parameters<LangfuseClient['api']['ingestion']['batch']>[0]

/** The ingestion batch for one call. Pure, so the mapping is tested without a network. */
export function geometryBatch(
  call: GeometryCallRecord,
  ids: { observationId: string; eventIds: [string, string] }
): IngestionBatch {
  const env = environment()
  const rel = release()
  const startTime = new Date(call.startedAt).toISOString()
  const endTime = new Date(call.endedAt).toISOString()
  const metadata = {
    ifc_op: `geometry:${call.op}`,
    ifc_outcome: call.status < 400 ? 'ok' : (call.code ?? `http_${call.status}`),
    ifc_cache_tier: call.cacheTier,
    ifc_elements: call.elements,
    ifc_ms: call.serviceMs,
    ifc_truncated: call.truncated,
    status: call.status,
    duration_ms: call.endedAt - call.startedAt,
    reader: call.reader,
  }
  const identity = identityOn()
  const batch: IngestionBatch['batch'] = [
    {
      type: 'trace-create',
      id: ids.eventIds[0],
      timestamp: startTime,
      body: {
        id: call.traceId,
        timestamp: startTime,
        name: GEOMETRY_TRACE_NAME,
        metadata,
        tags: [
          'feature:ifc',
          `reader:${call.reader}`,
          ...(call.cacheTier ? [`cache:${call.cacheTier}`] : []),
          ...(call.status >= 400 ? [`error:${call.status}`] : []),
          ...(identity ? [`org:${call.organizationId}`] : []),
        ],
        ...(identity ? { userId: call.userId } : {}),
        ...(env ? { environment: env } : {}),
        ...(rel ? { release: rel } : {}),
      },
    },
    {
      type: 'span-create',
      id: ids.eventIds[1],
      timestamp: startTime,
      body: {
        id: ids.observationId,
        traceId: call.traceId,
        name: GEOMETRY_TRACE_NAME,
        startTime,
        endTime,
        metadata,
        level: call.status >= 500 ? 'ERROR' : call.status >= 400 ? 'WARNING' : 'DEFAULT',
        ...(call.status >= 400 ? { statusMessage: call.code ?? `HTTP ${call.status}` } : {}),
        ...(env ? { environment: env } : {}),
      },
    },
  ]
  return { batch }
}

/** Post `call` as its trace. Resolves when sent (or skipped) and never rejects; callers do not await it. */
export async function recordGeometryTrace(call: GeometryCallRecord): Promise<void> {
  const config = langfuseApiConfig()
  if (!config) return
  try {
    const batch = geometryBatch(call, {
      observationId: crypto.randomUUID(),
      eventIds: [crypto.randomUUID(), crypto.randomUUID()],
    })
    await clientFor(config).api.ingestion.batch(batch, { timeoutInSeconds: 5, maxRetries: 1 })
  } catch (error) {
    console.warn('[Langfuse] geometry trace failed (non-fatal):', error)
  }
}
