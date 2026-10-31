/**
 * The typed client of the geometry service (`apps/geometry`, ADR-0149): one operation on one
 * model, for the person `session` names.
 *
 * The BFF is the service's only caller, and it decides access first (`geometry-service.ts`, the
 * model's document read gate). The service holds no access rules of its own: it takes the internal
 * token, which says the caller is the BFF, and the signed request-context envelope, which says who
 * asked and in which organization and project, and resolves the model with exactly that scope.
 *
 * Shaped like `bff/ris/document.ts`: `redirect: 'error'` (a redirect would replay the token at
 * whatever host the response names), a timeout, and the service's statuses mapped to one error
 * the route answers with.
 */

import 'server-only'
import { getGeometryServiceUrl } from '@/lib/backend-url'
import { InternalServiceUnavailableError, internalServiceHeaders } from '@/lib/internal-auth'
import { buildRequestContextEnvelopeHeaders } from '@/lib/request-context'
import type { GeometryRequest, GeometryResponse } from './geometry-wire'

/** The service waits 20 s for a cold build before it answers 409; this leaves it room to say so. */
export const GEOMETRY_TIMEOUT_MS = 25_000

/** Seconds a caller is told to wait when the service did not say. */
const DEFAULT_RETRY_AFTER_SECONDS = 10

export type GeometryErrorCode =
  | 'invalid_request'
  | 'forbidden'
  | 'model_not_found'
  | 'geometry_warming'
  | 'model_not_ready'
  | 'model_too_large'
  | 'geometry_timeout'
  | 'geometry_unavailable'

/** A refusal the route answers with: its status, a stable code and, when warming, when to ask again. */
export class GeometryServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: GeometryErrorCode,
    readonly retryAfter?: number
  ) {
    super(message)
    this.name = 'GeometryServiceError'
  }
}

export interface GeometryCaller {
  organizationId: string
  userId: string
  /** The model's project; null for an office-shelf model. Rides in the signed envelope. */
  projectId: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The service's status and body as the error the route answers with. Pure. */
export function geometryError(status: number, body: unknown): GeometryServiceError {
  const said = isRecord(body) && typeof body.error === 'string' ? body.error : null
  switch (true) {
    case status === 400 || status === 422:
      return new GeometryServiceError(said ?? 'The geometry request is not valid', 400, 'invalid_request')
    case status === 401 || status === 403:
      // The BFF signed the call; a refusal is the deployment's fault, never the caller's.
      return new GeometryServiceError('The geometry service refused the call', 503, 'geometry_unavailable')
    case status === 404:
      return new GeometryServiceError('Model not found', 404, 'model_not_found')
    case status === 409 && isRecord(body) && body.code === 'model_not_ready':
      return new GeometryServiceError('The model is still being read', 409, 'model_not_ready')
    case status === 409: {
      const retry = isRecord(body) && typeof body.retryAfter === 'number' ? body.retryAfter : DEFAULT_RETRY_AFTER_SECONDS
      return new GeometryServiceError('The model’s geometry is being prepared; ask again shortly', 409, 'geometry_warming', retry)
    }
    case status === 413:
      return new GeometryServiceError(said ?? 'The model is too large for the geometry service', 422, 'model_too_large')
    default:
      return new GeometryServiceError('The geometry service is not reachable right now', 502, 'geometry_unavailable')
  }
}

/** Run one geometry operation on `modelId` for `caller`. Throws {@link GeometryServiceError}. */
export async function callGeometry(
  modelId: string,
  operation: GeometryRequest,
  caller: GeometryCaller
): Promise<GeometryResponse> {
  const base = getGeometryServiceUrl()
  const secret = process.env.INTERNAL_API_TOKEN
  if (!base || !secret) {
    throw new GeometryServiceError('The geometry service is not configured', 503, 'geometry_unavailable')
  }
  let tokenHeaders: Record<string, string>
  try {
    tokenHeaders = internalServiceHeaders(base)
  } catch (error) {
    if (!(error instanceof InternalServiceUnavailableError)) throw error
    console.warn(`[geometry] ${error.message}`)
    throw new GeometryServiceError('The geometry service is not configured', 503, 'geometry_unavailable')
  }
  const envelope = buildRequestContextEnvelopeHeaders(
    { organizationId: caller.organizationId, userId: caller.userId, projectId: caller.projectId, issuedAt: Date.now() },
    secret
  )

  let response: Response
  try {
    response = await fetch(`${base}/v1/internal/bim/geometry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...envelope, ...tokenHeaders },
      body: JSON.stringify({ modelId, operation }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(GEOMETRY_TIMEOUT_MS),
    })
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    throw timedOut
      ? new GeometryServiceError('The geometry service did not answer in time', 504, 'geometry_timeout')
      : new GeometryServiceError('The geometry service is not reachable right now', 502, 'geometry_unavailable')
  }
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw geometryError(response.status, body)
  if (!isRecord(body) || !isRecord(body.result) || !isRecord(body.meta)) {
    throw new GeometryServiceError('The geometry service answered an unexpected body', 502, 'geometry_unavailable')
  }
  return body as unknown as GeometryResponse
}
