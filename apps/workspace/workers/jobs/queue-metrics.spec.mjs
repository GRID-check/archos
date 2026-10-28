/**
 * @vitest-environment node
 */
import { metrics } from '@opentelemetry/api'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueueMeters } from './queue-metrics.js'

let exporter
let reader
let provider

beforeEach(() => {
  exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })
  provider = new MeterProvider({ readers: [reader] })
  metrics.setGlobalMeterProvider(provider)
})

afterEach(async () => {
  await provider.shutdown()
  metrics.disable()
})

/** Every data point exported so far, by metric name. */
async function exported() {
  await reader.forceFlush()
  const points = {}
  for (const m of exporter.getMetrics().flatMap((r) => r.scopeMetrics).flatMap((s) => s.metrics)) {
    points[m.descriptor.name] = m.dataPoints.map((p) => ({ attributes: p.attributes, value: p.value }))
  }
  return points
}

describe('the BFF queue meters', () => {
  it('report depth by status and the oldest job, under the Python queues’ names, as queue=bff', async () => {
    createQueueMeters(async () => ({ counts: { queued: 4, claimed: 2, dead: 1 }, oldestQueuedSeconds: 90 }), vi.fn())
    const points = await exported()
    expect(points['grid.queue.depth']).toEqual([
      { attributes: { queue: 'bff', status: 'queued' }, value: 4 },
      { attributes: { queue: 'bff', status: 'claimed' }, value: 2 },
      { attributes: { queue: 'bff', status: 'dead' }, value: 1 },
    ])
    expect(points['grid.queue.oldest_age_seconds']).toEqual([{ attributes: { queue: 'bff' }, value: 90 }])
  })

  it('report no age when nothing is queued, rather than a zero that reads as fresh', async () => {
    createQueueMeters(async () => ({ counts: { queued: 0, claimed: 0, dead: 0 }, oldestQueuedSeconds: null }), vi.fn())
    expect((await exported())['grid.queue.oldest_age_seconds']).toBeUndefined()
  })

  it('leave a gap when the queue cannot be read, and say so, without failing the export', async () => {
    const warn = vi.fn()
    createQueueMeters(() => Promise.reject(new Error('connection refused')), warn)
    const points = await exported()
    expect(points['grid.queue.depth']).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('connection refused'))
  })

  it('record claims, runs by kind, and deaths', async () => {
    const meters = createQueueMeters(async () => ({ counts: {}, oldestQueuedSeconds: null }), vi.fn())
    meters.claimed(12)
    meters.ran('reindex_project', 3.5)
    meters.died(2)
    const points = await exported()
    expect(points['grid.queue.dead_total']).toEqual([{ attributes: { queue: 'bff' }, value: 2 }])
    expect(points['grid.queue.job_duration_seconds'][0].attributes).toEqual({ queue: 'bff', kind: 'reindex_project' })
    expect(points['grid.queue.claim_latency_ms'][0].attributes).toEqual({ queue: 'bff' })
  })
})
