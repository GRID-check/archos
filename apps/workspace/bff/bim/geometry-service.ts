/**
 * Geometry of one model, for a person or an agent acting for one: the service behind
 * `POST /api/bim/models/{modelId}/geometry` and the door's `bim-model-geometry`.
 *
 * Access is the model's document read gate, the one `bim-model-get` and `bim-model-query` pass
 * (`getAccessibleModel`: the ifc-models flag, then the document's shelf rule); a `diff` passes it
 * for its base model too. Only then is the geometry service called (`geometry-client.ts`), with the
 * model's project in the signed envelope. The service decides nothing about access (ADR-0149).
 *
 * An agent never sends a coordinate (VISION: Piloti works from IFC data, never from coordinates
 * it wrote): `within` and `near` from an agent take an element (`aroundGlobalId`, `globalId`).
 * The person's viewer may send a box or a point.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { ApiError, BadRequestError } from '@/lib/api/errors'
import { actingReaderIsAgent } from '@/lib/agent-api/acting-session'
import { recordGeometryTrace } from '@/lib/langfuse/geometry-trace'
import { hexId } from '@/lib/langfuse/tool-call-trace'
import { callGeometry, GeometryServiceError } from './geometry-client'
import { type GeometryRequest, type GeometryResponse, usesRawCoordinates } from './geometry-wire'
import { getInternalModelSource } from './internal-access'
import { getAccessibleModel } from './model-service'
import type { BimModelHeader } from './repository'
import type { ModelSource } from './geometry-client'

export const AGENT_COORDINATES_REFUSAL =
  'An agent searches around an element: use within with aroundGlobalId and margin, or near with globalId. ' +
  'A box or a point is for the person’s viewer.'

/**
 * The bytes of a model this session passed the read gate for, as the service will fetch them: the
 * presigned internal URL and the store's identity. Built here, after the gate, so the service never
 * re-resolves a model with a narrower scope (a restricted folder the person is cleared for, a base
 * model in another project). A model not yet read answers 409 like the query route's.
 */
async function sourceOf(model: BimModelHeader, organizationId: string): Promise<ModelSource> {
  if (model.status !== 'ready') throw new ApiError(409, 'model_not_ready', 'The model is still being read')
  const source = await getInternalModelSource(model, organizationId)
  return { url: source.url, etag: source.etag, bytes: source.bytes, updatedAt: new Date(model.updatedAt).toISOString() }
}

/** The client's refusal as the route's error: its status, and the service's code and retry hint. */
function asApiError(error: GeometryServiceError): ApiError {
  const details = error.retryAfter === undefined ? undefined : { retryAfter: error.retryAfter }
  return new ApiError(error.status, error.code, error.message, details)
}

export async function geometryForAccessibleModel(
  session: AuthorizedSession,
  modelId: string,
  request: GeometryRequest
): Promise<GeometryResponse> {
  const reader = actingReaderIsAgent() ? 'agent' : 'person'
  if (reader === 'agent' && usesRawCoordinates(request)) throw new BadRequestError(AGENT_COORDINATES_REFUSAL)

  const model = await getAccessibleModel(session, modelId)
  // A diff's base model passes its own gate; its source is signed beside the model's.
  const base =
    request.op === 'diff' && request.baseModelId !== model.id ? await getAccessibleModel(session, request.baseModelId) : null
  const sources: Record<string, ModelSource> = { [model.id]: await sourceOf(model, session.organizationId) }
  if (base) sources[base.id] = await sourceOf(base, session.organizationId)

  const startedAt = Date.now()
  const traceId = hexId()
  const trace = { op: request.op, reader, startedAt, organizationId: session.organizationId, userId: session.userId, traceId } as const
  try {
    const response = await callGeometry(model.id, request, {
      organizationId: session.organizationId,
      userId: session.userId,
      projectId: model.projectId,
      traceId,
      sources,
    })
    void recordGeometryTrace({
      ...trace,
      status: 200,
      code: null,
      cacheTier: response.meta.cacheTier,
      elements: response.meta.elements,
      serviceMs: response.meta.ms,
      truncated: response.meta.truncated,
      endedAt: Date.now(),
    })
    return response
  } catch (error) {
    if (!(error instanceof GeometryServiceError)) throw error
    void recordGeometryTrace({
      ...trace,
      status: error.status,
      code: error.code,
      cacheTier: null,
      elements: null,
      serviceMs: null,
      truncated: null,
      endedAt: Date.now(),
    })
    throw asApiError(error)
  }
}
