/**
 * @vitest-environment node
 */
/** The geometry service's client: what it sends, and how each answer becomes the route's error. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { createHmac } from 'node:crypto'
import { callGeometry, GeometryServiceError, geometryError, SOURCES_HEADER, SOURCES_SIG_HEADER } from './geometry-client'

const MODEL = '11111111-1111-4111-8111-111111111111'
const SOURCE = { url: 'http://store.internal/m', etag: 'e1', bytes: 10, updatedAt: '2026-10-01T00:00:00.000Z' }
const caller = { organizationId: 'org_1', userId: 'user_1', sources: { [MODEL]: SOURCE } }
const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubEnv('GEOMETRY_SERVICE_URL', 'http://geometry:8100/')
  vi.stubEnv('INTERNAL_API_TOKEN', 'test-token')
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('callGeometry', () => {
  it('posts the operation with the token and a signed envelope, and refuses redirects', async () => {
    fetchMock.mockResolvedValue(json(200, { op: 'warm', result: { status: 'warming' }, meta: { cacheTier: 'cold', ms: 1, elements: 0, truncated: false } }))
    const answer = await callGeometry(MODEL, { op: 'warm' }, { ...caller, traceId: 'd'.repeat(32) })
    expect(answer.result).toEqual({ status: 'warming' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe('http://geometry:8100/v1/internal/bim/geometry')
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(String(init.body))).toEqual({ modelId: MODEL, operation: { op: 'warm' } })
    expect(init.headers['x-trace-id']).toBe('d'.repeat(32))
    expect(init.headers['x-internal-token']).toBe('test-token')
    const envelope = JSON.parse(Buffer.from(init.headers['X-Request-Context'] as string, 'base64url').toString())
    expect(envelope).toMatchObject({ organizationId: 'org_1', userId: 'user_1' })
    // Who asked, and nothing the service could decide access with.
    expect(envelope.projectId).toBeUndefined()
    expect(init.headers['X-Request-Context-Sig']).toMatch(/^[0-9a-f]{64}$/)
    // The sources ride signed beside the envelope and bound to it: the same person, organization and issuedAt.
    const raw = Buffer.from(init.headers[SOURCES_HEADER] as string, 'base64url').toString()
    const signed = JSON.parse(raw)
    expect(signed).toEqual({
      kind: 'model-sources',
      organizationId: 'org_1',
      userId: 'user_1',
      issuedAt: envelope.issuedAt,
      modelId: MODEL,
      op: 'warm',
      sources: { [MODEL]: SOURCE },
      exp: envelope.issuedAt + 60_000,
    })
    // Its own key, derived from the token: an envelope's signature can never be a sources signature.
    const key = createHmac('sha256', 'test-token').update('geometry-sources/v1').digest()
    expect(init.headers[SOURCES_SIG_HEADER]).toBe(createHmac('sha256', key).update(raw, 'utf8').digest('hex'))
    expect(init.headers[SOURCES_SIG_HEADER]).not.toBe(createHmac('sha256', 'test-token').update(raw, 'utf8').digest('hex'))
  })

  it('answers 503 without a service URL and sends nothing', async () => {
    vi.stubEnv('GEOMETRY_SERVICE_URL', '')
    await expect(callGeometry(MODEL, { op: 'warm' }, caller)).rejects.toMatchObject({ status: 503, code: 'geometry_unavailable' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 504 on a timeout and 502 on a broken connection', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('t'), { name: 'TimeoutError' }))
    await expect(callGeometry(MODEL, { op: 'warm' }, caller)).rejects.toMatchObject({ status: 504, code: 'geometry_timeout' })
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(callGeometry(MODEL, { op: 'warm' }, caller)).rejects.toMatchObject({ status: 502 })
  })

  it('maps a refusal through geometryError', async () => {
    fetchMock.mockResolvedValue(json(409, { code: 'geometry_warming', retryAfter: 7 }))
    await expect(callGeometry(MODEL, { op: 'warm' }, caller)).rejects.toMatchObject({ status: 409, code: 'geometry_warming', retryAfter: 7 })
  })
})

describe('geometryError', () => {
  it.each([
    [400, {}, 400, 'invalid_request'],
    [422, {}, 400, 'invalid_request'],
    [403, {}, 503, 'geometry_unavailable'],
    [404, {}, 404, 'model_not_found'],
    [409, { code: 'model_not_ready' }, 409, 'model_not_ready'],
    [409, { code: 'geometry_warming' }, 409, 'geometry_warming'],
    [413, {}, 422, 'model_too_large'],
    [504, {}, 504, 'geometry_timeout'],
    [503, { code: 'geometry_busy', retryAfter: 30 }, 503, 'geometry_busy'],
    [503, { code: 'geometry_source_unavailable' }, 503, 'geometry_source_unavailable'],
    [502, { code: 'build_failed', error: 'the model file could not be downloaded' }, 502, 'build_failed'],
    [500, {}, 502, 'geometry_unavailable'],
  ])('%i %j → %i %s', (status, body, expected, code) => {
    const error = geometryError(status, body)
    expect(error).toBeInstanceOf(GeometryServiceError)
    expect([error.status, error.code]).toEqual([expected, code])
  })

  it('passes the engine’s own refusal through to the caller', () => {
    expect(geometryError(400, { code: 'invalid_request', error: 'mode must be one of intersect, touch, clearance' }).message).toBe(
      'mode must be one of intersect, touch, clearance'
    )
  })

  it('tells a warming caller when to come back, defaulting when the service did not say', () => {
    expect(geometryError(409, { code: 'geometry_warming', retryAfter: 3 }).retryAfter).toBe(3)
    expect(geometryError(409, {}).retryAfter).toBe(10)
  })
})
