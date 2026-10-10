import { beforeEach, describe, expect, test, vi } from 'vitest'

const reportRequestError = vi.fn(async (..._args: unknown[]) => {})
let posthogConfigured = true
const shutdownPosthogServer = vi.fn(async () => {})
vi.mock('./lib/analytics/request-error', () => ({
  requestErrorHandler: () => (posthogConfigured ? reportRequestError : null),
}))
vi.mock('./lib/analytics/posthog-server', () => ({
  shutdownPosthogServer: () => shutdownPosthogServer(),
}))
const initOtelLogs = vi.fn()
vi.mock('../observability/otel-logs.js', () => ({ initOtelLogs: () => initOtelLogs() }))
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
    posthogConfigured = true
    shutdownPosthogServer.mockClear()
    initOtelLogs.mockClear()
    Reflect.deleteProperty(globalThis, '__gridShutdownHooks')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  test("onRequestError hands the error to @posthog/next's handler on the node runtime", async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    const { onRequestError } = await import('./instrumentation')
    const failure = new Error('boom')

    await onRequestError(failure, request, context)

    expect(reportRequestError).toHaveBeenCalledWith(failure, request, context)
  })

  test('onRequestError does nothing while PostHog is off', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    posthogConfigured = false
    const { onRequestError } = await import('./instrumentation')

    await expect(onRequestError(new Error('boom'), request, context)).resolves.toBeUndefined()
    expect(reportRequestError).not.toHaveBeenCalled()
  })

  test('onRequestError does nothing on the edge runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge')
    const { onRequestError } = await import('./instrumentation')

    await onRequestError(new Error('boom'), request, context)

    expect(reportRequestError).not.toHaveBeenCalled()
  })

  test('a failing reporter never raises a second error on the request path', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    reportRequestError.mockImplementation(async () => {
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

  test('with a collector it bridges logs', async () => {
    // No trace provider: the BFF's root spans were all dropped at creation, so
    // `@vercel/otel` recorded nothing, and it is no longer a dependency at all.
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://otel-collector:4318')
    const { register } = await import('./instrumentation')

    await register()

    expect(initOtelLogs).toHaveBeenCalledTimes(1)
  })

  test('without a collector it bridges nothing', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
    const { register } = await import('./instrumentation')

    await register()

    expect(initOtelLogs).not.toHaveBeenCalled()
  })
})
