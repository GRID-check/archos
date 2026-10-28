/**
 * @vitest-environment node
 */
import { EventEmitter } from 'node:events'
import { metrics } from '@opentelemetry/api'
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { afterAll, describe, expect, it } from 'vitest'
import { measureRequest, requestAttributes, routeClass } from './http-metrics.js'

describe('routeClass', () => {
  it.each([
    ['/api/healthz', 'health'],
    ['/_next/static/chunks/app.js', 'static'],
    ['/api', 'api'],
    ['/api/projects/0193f5a6/documents', 'api'],
    ['/apiary', 'page'],
    ['/projects/0193f5a6', 'page'],
    [undefined, 'page'],
  ])('%s is %s', (path, expected) => {
    expect(routeClass(path)).toBe(expected)
  })
})

describe('requestAttributes', () => {
  it('folds a method nobody routes into _OTHER, so a scanner cannot mint series', () => {
    expect(requestAttributes({ method: 'PROPFIND', pathname: '/x', statusCode: 405 })).toEqual({
      'http.request.method': '_OTHER',
      'http.response.status_code': 405,
      'grid.route.class': 'page',
    })
  })
})

describe('measureRequest', () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })
  const provider = new MeterProvider({ readers: [reader] })
  metrics.setGlobalMeterProvider(provider)
  afterAll(async () => {
    await provider.shutdown()
    metrics.disable()
  })

  it('records a request when its response closes, at the status it closed with', async () => {
    const res = Object.assign(new EventEmitter(), { statusCode: 200 })
    measureRequest({ method: 'POST' }, res, '/api/chat')
    res.statusCode = 499
    res.emit('close')

    await reader.forceFlush()
    const metric = exporter
      .getMetrics()
      .flatMap((m) => m.scopeMetrics)
      .flatMap((s) => s.metrics)
      .find((m) => m.descriptor.name === 'http.server.request.duration')
    expect(metric?.descriptor.unit).toBe('s')
    expect(metric?.dataPoints).toHaveLength(1)
    expect(metric?.dataPoints[0].attributes).toEqual({
      'http.request.method': 'POST',
      'http.response.status_code': 499,
      'grid.route.class': 'api',
    })
  })
})
