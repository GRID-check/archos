import { beforeEach, describe, expect, test, vi } from 'vitest'

const reportRequestError = vi.fn()
const shutdownPosthogServer = vi.fn(async () => {})
vi.mock('./lib/analytics/request-error', () => ({
  reportRequestError: (...args: unknown[]) => reportRequestError(...args),
}))
vi.mock('./lib/analytics/posthog-server', () => ({
  shutdownPosthogServer: () => shutdownPosthogServer(),
}))
vi.mock('./lib/boot', () => ({ bootLine: () => 'boot' }))
vi.mock('./lib/model-config/bootstrap-defaults', () => ({ bootstrapPlatformModelDefaults: async () => {} }))

const request = { path: '/app', method: 'GET', headers: {} }
const context = {
  routerKind: 'App Router' as const,
  routePath: '/app',
  routeType: 'render' as const,
  revalidateReason: undefined,
}

describe('instrumentation', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    reportRequestError.mockReset()
    shutdownPosthogServer.mockClear()
    Reflect.deleteProperty(globalThis, '__gridShutdownHooks')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  test('onRequestError hands the error to the PostHog reporter on the node runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    const { onRequestError } = await import('./instrumentation')
    const failure = new Error('boom')

    await onRequestError(failure, request, context)

    expect(reportRequestError).toHaveBeenCalledWith(failure, request, context)
  })

  test('onRequestError does nothing on the edge runtime, where posthog-node cannot run', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge')
    const { onRequestError } = await import('./instrumentation')

    await onRequestError(new Error('boom'), request, context)

    expect(reportRequestError).not.toHaveBeenCalled()
  })

  test('a failing reporter never raises a second error on the request path', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    reportRequestError.mockImplementation(() => {
      throw new Error('reporter down')
    })
    const { onRequestError } = await import('./instrumentation')

    await expect(onRequestError(new Error('boom'), request, context)).resolves.toBeUndefined()
  })

  test('the PostHog flush is registered for shutdown even when no OTLP collector is configured', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
    const { register } = await import('./instrumentation')

    await register()

    const hooks = (globalThis as Record<string, unknown>).__gridShutdownHooks as Array<() => Promise<void>>
    expect(hooks).toHaveLength(1)
    await hooks[0]!()
    expect(shutdownPosthogServer).toHaveBeenCalledTimes(1)
  })
})
