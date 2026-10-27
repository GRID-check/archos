import type { OnRequestErrorBeforeCaptureContext, OnRequestErrorOptions } from '@posthog/next'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// The capture itself is `@posthog/next`'s; what is ours is the options it is
// built with, so the spec records them instead of running the package.
const createOnRequestError = vi.fn((_options: OnRequestErrorOptions) => async () => {})
vi.mock('@posthog/next', () => ({
  createOnRequestError: (options: OnRequestErrorOptions) => createOnRequestError(options),
}))

import {
  REQUEST_ERROR_BURST,
  REQUEST_ERROR_WINDOW_MS,
  beforeCapture,
  requestErrorHandler,
  requestErrorOptions,
  resetRequestErrorHandlerForTests,
} from './request-error'
import { scrubServerEvent } from './scrub-server-event'
import {
  ConflictError,
  ForbiddenError,
  NoOrganizationError,
  NotFoundError,
  SessionRequiredError,
} from '@/lib/api/errors'

const request = { path: '/api/projects/p-1/files', method: 'POST', headers: {} }
const context = {
  routerKind: 'App Router',
  routePath: '/api/projects/[projectId]/files',
  routeType: 'route',
}

const capture = (
  error: unknown,
  routePath = context.routePath
): OnRequestErrorBeforeCaptureContext => ({
  error,
  request,
  context: { ...context, routePath },
  properties: {},
})

describe('request errors through @posthog/next', () => {
  beforeEach(() => {
    resetRequestErrorHandlerForTests()
    createOnRequestError.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://eu.i.posthog.com/')
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  test('is off, and builds nothing, while PostHog is not configured', () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', '')

    expect(requestErrorOptions()).toBeNull()
    expect(requestErrorHandler()).toBeNull()
    expect(createOnRequestError).not.toHaveBeenCalled()
  })

  test('builds one handler from the runtime settings, the scrubber and no GeoIP', () => {
    const first = requestErrorHandler()
    const second = requestErrorHandler()

    expect(first).not.toBeNull()
    expect(second).toBe(first)
    expect(createOnRequestError).toHaveBeenCalledTimes(1)
    expect(createOnRequestError.mock.calls[0]?.[0]).toMatchObject({
      apiKey: 'phc_test',
      host: 'https://eu.i.posthog.com',
      serverOptions: { disableGeoip: true, before_send: scrubServerEvent },
      beforeCapture,
    })
  })

  test.each([
    ['NotFoundError', () => new NotFoundError()],
    ['ForbiddenError', () => new ForbiddenError('This project is closed')],
    ['SessionRequiredError', () => new SessionRequiredError()],
    ['NoOrganizationError', () => new NoOrganizationError()],
  ])('an authorization denial (%s) is not an exception', (_name, denial) => {
    expect(beforeCapture(capture(denial()))).toBe(false)
  })

  test('another API error, and a plain Error that only reads like a denial, still are', () => {
    // Typed, not matched by message: a server error says "forbidden" in its
    // text as easily as a denial does.
    expect(beforeCapture(capture(new ConflictError('Conflict')))).not.toBe(false)
    expect(beforeCapture(capture(new Error('Forbidden'), '/elsewhere'))).not.toBe(false)
  })

  test('a post naming a server action this build lacks is not an exception', () => {
    // Next's own message (action-handler, E975), verbatim.
    const unknownAction = new Error(
      'Failed to find Server Action. This request might be from an older or newer deployment.\n' +
        'Read more: https://nextjs.org/docs/messages/failed-to-find-server-action'
    )

    expect(beforeCapture(capture(unknownAction, '/app/projects'))).toBe(false)
    expect(beforeCapture(capture(new Error('Failed to find the project'), '/app/projects'))).not.toBe(false)
  })

  test('adds where it came from, and takes a thrown non-Error value', () => {
    vi.stubEnv('OTEL_SERVICE_NAME', 'grid-ui')

    expect(beforeCapture(capture('plain string'))).toMatchObject({
      source: 'bff-on-request-error',
      service: 'grid-ui',
    })
  })

  test('one fingerprint gets a burst per window, then nothing until the window ends', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const failure = new Error('database is down')

    const admitted = Array.from({ length: REQUEST_ERROR_BURST + 20 }, () =>
      beforeCapture(capture(failure))
    ).filter((result) => result !== false)
    expect(admitted).toHaveLength(REQUEST_ERROR_BURST)
    expect(console.warn).toHaveBeenCalledTimes(1)

    vi.setSystemTime(1_000_000 + REQUEST_ERROR_WINDOW_MS)
    expect(beforeCapture(capture(failure))).not.toBe(false)
  })

  test('another route or another message has its own budget', () => {
    for (let i = 0; i < REQUEST_ERROR_BURST + 5; i += 1) beforeCapture(capture(new Error('a')))

    expect(beforeCapture(capture(new Error('b')))).not.toBe(false)
    expect(beforeCapture(capture(new Error('a'), '/other'))).not.toBe(false)
  })
})
