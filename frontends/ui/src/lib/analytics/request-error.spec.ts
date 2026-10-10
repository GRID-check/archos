import { beforeEach, describe, expect, test, vi } from 'vitest'

const captureServerException = vi.fn(() => true)
vi.mock('./posthog-server', () => ({
  captureServerException: (...args: unknown[]) => captureServerException(...(args as [])),
}))

import {
  REQUEST_ERROR_BURST,
  REQUEST_ERROR_WINDOW_MS,
  reportRequestError,
  resetRequestErrorLimiterForTests,
} from './request-error'

const request = { path: '/api/projects/p-1/files?token=secret&q=Brandschutz', method: 'POST', headers: {} }
const context = {
  routerKind: 'App Router' as const,
  routePath: '/api/projects/[projectId]/files',
  routeType: 'route' as const,
  revalidateReason: undefined,
}

describe('reportRequestError', () => {
  beforeEach(() => {
    resetRequestErrorLimiterForTests()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  test('sends route, method and type, with no query string and no user lookup', () => {
    const failure = Object.assign(new Error('boom'), { digest: 'abc123' })

    expect(reportRequestError(failure, request, context)).toBe(true)

    expect(captureServerException).toHaveBeenCalledTimes(1)
    const [sent, distinctId, properties] = captureServerException.mock.calls[0] as unknown as [
      unknown,
      string | null,
      Record<string, unknown>,
    ]
    expect(sent).toBe(failure)
    expect(distinctId).toBeNull()
    expect(properties).toMatchObject({
      source: 'bff-on-request-error',
      route_path: '/api/projects/[projectId]/files',
      route_type: 'route',
      router_kind: 'App Router',
      request_method: 'POST',
      request_path: '/api/projects/p-1/files',
      digest: 'abc123',
    })
    expect(JSON.stringify(properties)).not.toContain('secret')
    expect(JSON.stringify(properties)).not.toContain('Brandschutz')
  })

  test.each(['Not found', 'Not found: project', 'Forbidden', 'Unauthorized access'])(
    'an authorization denial (%s) is not an exception',
    (message) => {
      expect(reportRequestError(new Error(message), request, context)).toBe(false)
      expect(captureServerException).not.toHaveBeenCalled()
    },
  )

  test('one fingerprint gets a burst per window, then nothing until the window ends', () => {
    const failure = new Error('database is down')
    const start = 1_000_000

    const sent = Array.from({ length: REQUEST_ERROR_BURST + 20 }, () =>
      reportRequestError(failure, request, context, start),
    ).filter(Boolean)
    expect(sent).toHaveLength(REQUEST_ERROR_BURST)
    expect(console.warn).toHaveBeenCalledTimes(1)

    expect(reportRequestError(failure, request, context, start + REQUEST_ERROR_WINDOW_MS)).toBe(true)
  })

  test('another route or another message has its own budget', () => {
    const now = 1_000_000
    for (let i = 0; i < REQUEST_ERROR_BURST + 5; i += 1) {
      reportRequestError(new Error('a'), request, context, now)
    }
    expect(reportRequestError(new Error('b'), request, context, now)).toBe(true)
    expect(reportRequestError(new Error('a'), request, { ...context, routePath: '/other' }, now)).toBe(true)
  })

  test('reports a thrown non-Error value', () => {
    expect(reportRequestError('plain string', request, context)).toBe(true)
  })
})
