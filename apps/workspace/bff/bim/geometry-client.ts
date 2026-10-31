/**
 * The BFF's client of the geometry service's MCP server (`apps/geometry`, ADR-0149): one `tools/call`
 * of the tool named by the operation, for the person `session` names.
 *
 * The BFF is the service's gateway and only caller, and it decides all access first
 * (`geometry-service.ts`). The service decides none: it takes the internal token (the caller is the
 * BFF), the envelope (whom the work is for) and the already-authorized sources, whose signature is
 * input integrity, so it fetches nothing else.
 *
 * Shaped like `bff/ris/document.ts`: `redirect: 'error'` (a redirect would replay the token at
 * whatever host the response names), a timeout, and the service's statuses mapped to one error
 * the route answers with.
 */

import 'server-only'
import { getGeometryServiceUrl } from '@/lib/backend-url'
import { InternalServiceUnavailableError, internalServiceHeaders } from '@/lib/internal-auth'
import { createHmac } from 'node:crypto'
import { buildRequestContextEnvelopeHeaders } from '@/lib/request-context'
import type { GeometryOp, GeometryRequest, GeometryResponse } from './geometry-wire'

/**
 * The service answers within its own request budget (40 s: at most 20 s waiting for a cold build,
 * the rest for the operation, `operations.REQUEST_BUDGET_SECONDS`); this leaves it room to say so.
 */
export const GEOMETRY_TIMEOUT_MS = 45_000

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
  | 'geometry_busy'
  | 'geometry_source_unavailable'
  | 'build_failed'
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

/** One model's bytes as the service fetches them, after the BFF's read gate let the caller through. */
export interface ModelSource {
  /** Presigned GET against the internal store endpoint, short-lived. */
  url: string
  /** The store's content identity; with `updatedAt`, the service's cache key. */
  etag: string | null
  bytes: number | null
  updatedAt: string
}

/**
 * The header pair carrying the already-authorized sources. Input integrity, not a permission: it
 * says these are the bytes the BFF handed over, so the service fetches nothing else
 * (`geometry_service/signed_sources.py`). HMAC-SHA256 over the raw JSON with a key derived from
 * the internal token ({@link sourcesKey}), of kind `model-sources`, so it never verifies as a
 * request-context envelope or the other way round; bound to the envelope's organization, user and
 * `issuedAt`, to this request's model and op, and valid for {@link SOURCES_TTL_MS}.
 */
export const SOURCES_HEADER = 'x-model-sources'
export const SOURCES_SIG_HEADER = 'x-model-sources-sig'
export const SOURCES_KIND = 'model-sources'
export const SOURCES_TTL_MS = 60_000

/** `HMAC(INTERNAL_API_TOKEN, "geometry-sources/v1")`: the sources' own key. */
export function sourcesKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('geometry-sources/v1', 'utf8').digest()
}

export interface SourcesPayload {
  organizationId: string
  userId: string
  issuedAt: number
  modelId: string
  op: GeometryOp
  sources: Record<string, ModelSource>
}

/** The signed sources headers. Pure. */
export function signedSourcesHeaders(payload: SourcesPayload, secret: string): Record<string, string> {
  const json = JSON.stringify({ kind: SOURCES_KIND, ...payload, exp: payload.issuedAt + SOURCES_TTL_MS })
  return {
    [SOURCES_HEADER]: Buffer.from(json, 'utf8').toString('base64url'),
    [SOURCES_SIG_HEADER]: createHmac('sha256', sourcesKey(secret)).update(json, 'utf8').digest('hex'),
  }
}

export interface GeometryCaller {
  organizationId: string
  userId: string
  /** Each model's bytes, by model id: the model's, and a diff's base model's. */
  sources: Record<string, ModelSource>
  /** The `bim-geometry` trace this call is recorded on; the service scores a cold build there. */
  traceId?: string
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
    case status === 503 && isRecord(body) && body.code === 'geometry_busy': {
      const retry = isRecord(body) && typeof body.retryAfter === 'number' ? body.retryAfter : DEFAULT_RETRY_AFTER_SECONDS
      return new GeometryServiceError('The geometry service is busy; ask again shortly', 503, 'geometry_busy', retry)
    }
    case status === 503 && isRecord(body) && body.code === 'geometry_source_unavailable':
      return new GeometryServiceError('The model file could not be read right now', 503, 'geometry_source_unavailable')
    case status === 504:
      return new GeometryServiceError(said ?? 'The geometry operation ran out of time', 504, 'geometry_timeout')
    case status === 502 && isRecord(body) && body.code === 'build_failed':
      return new GeometryServiceError(said ?? 'The model’s geometry could not be built', 502, 'build_failed')
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
  const issuedAt = Date.now()
  const envelope = buildRequestContextEnvelopeHeaders(
    // Who asked, and nothing about projects or folders: the service decides no access.
    { organizationId: caller.organizationId, userId: caller.userId, issuedAt },
    secret
  )
  const signedSources = signedSourcesHeaders(
    {
      organizationId: caller.organizationId,
      userId: caller.userId,
      issuedAt,
      modelId,
      op: operation.op,
      sources: caller.sources,
    },
    secret
  )

  let response: Response
  try {
    response = await fetch(`${base}${GEOMETRY_MCP_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Streamable HTTP: the client accepts both; the service answers stateless calls as JSON.
        accept: 'application/json, text/event-stream',
        ...(caller.traceId ? { 'x-trace-id': caller.traceId } : {}),
        ...envelope,
        ...signedSources,
        ...tokenHeaders,
      },
      body: JSON.stringify(toolCall(modelId, operation)),
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
  // Refused before MCP (the internal token): an HTTP status, mapped like any other.
  if (!response.ok) throw geometryError(response.status, body)
  return toolAnswer(body)
}

/** The service's MCP endpoint: streamable HTTP, stateless, one JSON-RPC request per call. */
export const GEOMETRY_MCP_PATH = '/mcp/'

/** The `tools/call` request for one operation: the tool is the op, the arguments the rest plus `modelId`. Pure. */
export function toolCall(modelId: string, operation: GeometryRequest): Record<string, unknown> {
  const { op, ...rest } = operation
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: op, arguments: { modelId, ...rest } } }
}

/**
 * A `tools/call` answer as the gateway's: the result's `structuredContent` (`{op, result, meta}`),
 * or, for an error result, its `{status, code, error, retryAfter?}` mapped like an HTTP refusal. Pure.
 */
export function toolAnswer(body: unknown): GeometryResponse {
  const result = isRecord(body) && isRecord(body.result) ? body.result : null
  const structured = result && isRecord(result.structuredContent) ? result.structuredContent : null
  if (!structured) {
    throw new GeometryServiceError('The geometry service answered an unexpected body', 502, 'geometry_unavailable')
  }
  if (result?.isError === true) {
    throw geometryError(typeof structured.status === 'number' ? structured.status : 502, structured)
  }
  if (!isRecord(structured.result) || !isRecord(structured.meta)) {
    throw new GeometryServiceError('The geometry service answered an unexpected body', 502, 'geometry_unavailable')
  }
  return structured as unknown as GeometryResponse
}
