/**
 * @vitest-environment node
 */
import { metrics } from '@opentelemetry/api'
import { afterEach, describe, expect, it, vi } from 'vitest'

const PROVIDER_KEY = Symbol.for('app.otel.meterProvider')

async function freshModule() {
  vi.resetModules()
  return import('./otel-metrics.js')
}

afterEach(async () => {
  await globalThis[PROVIDER_KEY]?.shutdown()
  delete globalThis[PROVIDER_KEY]
  metrics.disable()
})

describe('initOtelMetrics', () => {
  it('installs nothing without a collector', async () => {
    const { initOtelMetrics } = await freshModule()
    expect(initOtelMetrics({})).toBe(false)
    expect(globalThis[PROVIDER_KEY]).toBeUndefined()
  })

  it('installs one provider per process, however many copies of the module load', async () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318' }
    const first = await freshModule()
    expect(first.initOtelMetrics(env)).toBe(true)
    const provider = globalThis[PROVIDER_KEY]
    const second = await freshModule()
    expect(second.initOtelMetrics(env)).toBe(false)
    expect(globalThis[PROVIDER_KEY]).toBe(provider)
  })
})
