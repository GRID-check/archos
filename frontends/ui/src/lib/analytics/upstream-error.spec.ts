import { beforeEach, describe, expect, test, vi } from 'vitest'

const captureException = vi.fn()

vi.mock('server-only', () => ({}))
vi.mock('posthog-node', () => ({
  PostHog: class {
    captureException = captureException
    register = vi.fn(async () => {})
    shutdown = vi.fn(async () => {})
  },
}))

import { UpstreamError } from '@/lib/api/errors'
import { resetPosthogServerForTests } from './posthog-server'
import {
  UPSTREAM_ERROR_BURST,
  captureUpstreamError,
  resetUpstreamErrorLimiterForTests,
} from './upstream-error'

const storeDown = () =>
  new UpstreamError('Object storage is unavailable', { operation: 'ensureTenantBucket', code: 'InternalError' })

describe('captureUpstreamError', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    captureException.mockReset()
    resetPosthogServerForTests()
    resetUpstreamErrorLimiterForTests()
  })

  test('sends nothing while PostHog is not configured', () => {
    expect(captureUpstreamError(storeDown(), 'req_1')).toBe(false)
    expect(captureException).not.toHaveBeenCalled()
  })

  test('sends a personless exception carrying the store operation and code', () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://eu.i.posthog.com')
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test')
    const error = storeDown()

    expect(captureUpstreamError(error, 'req_1')).toBe(true)

    expect(captureException).toHaveBeenCalledWith(error, undefined, {
      source: 'bff-upstream-error',
      request_id: 'req_1',
      operation: 'ensureTenantBucket',
      code: 'InternalError',
    })
  })

  test('an outage every client retries costs one burst per window', () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://eu.i.posthog.com')
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    for (let i = 0; i < UPSTREAM_ERROR_BURST * 3; i += 1) captureUpstreamError(storeDown(), `req_${i}`)

    expect(captureException).toHaveBeenCalledTimes(UPSTREAM_ERROR_BURST)
  })
})
