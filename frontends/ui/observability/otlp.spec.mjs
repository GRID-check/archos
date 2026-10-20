/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { collectorEndpoint, resourceAttributes, signalUrl } from './otlp.js'

describe('signalUrl', () => {
  it.each([
    'http://otel-collector:4318',
    'http://otel-collector:4318/',
    ' http://otel-collector:4318/v1/traces ', // the Python tiers' full path
    'http://otel-collector:4318/v1/logs',
    'http://otel-collector:4318/v1/metrics/',
  ])('puts every signal beside the others on the collector %s names', (endpoint) => {
    for (const signal of ['traces', 'logs', 'metrics']) {
      expect(signalUrl(endpoint, signal)).toBe(`http://otel-collector:4318/v1/${signal}`)
    }
  })
})

describe('resourceAttributes', () => {
  it('names the tier, the build and the process', () => {
    // The process keeps bff-jobs' claim loop and its server.js child, one pod
    // and one service name, from merging into one series.
    const env = { OTEL_SERVICE_NAME: 'grid-bff-jobs', GRID_GIT_SHA: ' abc123 ', HOSTNAME: 'bff-jobs-7f9c-x2' }
    expect(resourceAttributes(env, 42)).toEqual({
      'service.name': 'grid-bff-jobs',
      'service.version': 'abc123',
      'service.instance.id': 'bff-jobs-7f9c-x2',
      'process.pid': 42,
    })
  })

  it('leaves blank values out and falls back to grid-ui', () => {
    expect(resourceAttributes({ OTEL_SERVICE_NAME: ' ', GRID_GIT_SHA: '', HOSTNAME: '' }, 42)).toEqual({
      'service.name': 'grid-ui',
      'process.pid': 42,
    })
  })
})

describe('collectorEndpoint', () => {
  it('is undefined without a collector, so nothing is exported', () => {
    expect(collectorEndpoint({})).toBeUndefined()
    expect(collectorEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: '  ' })).toBeUndefined()
    expect(collectorEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: ' http://otel-collector:4318 ' })).toBe(
      'http://otel-collector:4318',
    )
  })
})
