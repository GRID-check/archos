/**
 * @vitest-environment node
 */
/** The geometry service's client: what it sends, and how each answer becomes the route's error. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { callGeometry, GeometryServiceError, geometryError } from './geometry-client'

const MODEL = '11111111-1111-4111-8111-111111111111'
const caller = { organizationId: 'org_1', userId: 'user_1', projectId: 'project_1' }
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
    const answer = await callGeometry(MODEL, { op: 'warm' }, caller)
    expect(answer.result).toEqual({ status: 'warming' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe('http://geometry:8100/v1/internal/bim/geometry')
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(String(init.body))).toEqual({ modelId: MODEL, operation: { op: 'warm' } })
    expect(init.headers['x-internal-token']).toBe('test-token')
    const envelope = JSON.parse(Buffer.from(init.headers['X-Request-Context'] as string, 'base64url').toString())
    expect(envelope).toMatchObject({ organizationId: 'org_1', userId: 'user_1', projectId: 'project_1' })
    expect(init.headers['X-Request-Context-Sig']).toMatch(/^[0-9a-f]{64}$/)
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
    [500, {}, 502, 'geometry_unavailable'],
  ])('%i %j → %i %s', (status, body, expected, code) => {
    const error = geometryError(status, body)
    expect(error).toBeInstanceOf(GeometryServiceError)
    expect([error.status, error.code]).toEqual([expected, code])
  })

  it('tells a warming caller when to come back, defaulting when the service did not say', () => {
    expect(geometryError(409, { code: 'geometry_warming', retryAfter: 3 }).retryAfter).toBe(3)
    expect(geometryError(409, {}).retryAfter).toBe(10)
  })
})
