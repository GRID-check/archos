import { beforeEach, describe, expect, test, vi } from 'vitest'

const captureException = vi.fn()
vi.mock('posthog-js', () => ({
  default: { init: vi.fn(), captureException, capture: vi.fn(), identify: vi.fn(), reset: vi.fn() },
}))

/**
 * `initialized` is module state, so each case loads a fresh copy of the
 * facade: the disabled case must not see the enabled one's init.
 */
describe('capturePosthogException', () => {
  beforeEach(() => {
    vi.resetModules()
    captureException.mockClear()
  })

  test('is a silent no-op while analytics is disabled', async () => {
    const { DISABLED_POSTHOG_CONFIG, capturePosthogException, initPosthogClient } = await import('./posthog')
    initPosthogClient(DISABLED_POSTHOG_CONFIG)

    expect(() => capturePosthogException(new Error('boom'), { source: 'x' })).not.toThrow()
    expect(captureException).not.toHaveBeenCalled()
  })

  test('does not report a redirect() a boundary caught', async () => {
    const { capturePosthogException, initPosthogClient } = await import('./posthog')
    initPosthogClient({ host: 'https://eu.i.posthog.com', projectToken: 'phc_test', sessionReplay: false, replaySampleRate: 0, proxy: false })

    capturePosthogException(Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/x;307;' }))

    expect(captureException).not.toHaveBeenCalled()
  })

  test('forwards the error and its properties once the client is initialized', async () => {
    const { capturePosthogException, initPosthogClient } = await import('./posthog')
    initPosthogClient({ host: 'https://eu.i.posthog.com', projectToken: 'phc_test', sessionReplay: false, replaySampleRate: 0, proxy: false })
    const failure = new Error('boom')

    capturePosthogException(failure, { source: 'route-error-boundary' })

    expect(captureException).toHaveBeenCalledWith(failure, { source: 'route-error-boundary' })
  })
})
