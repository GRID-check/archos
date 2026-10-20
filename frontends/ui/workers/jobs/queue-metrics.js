/**
 * The `grid.queue.*` meters for the BFF's job queue (ADR-0079), under the names
 * and attributes the Python queues report (`src/aiq_agent/common/claim_queue.py`),
 * with `queue="bff"`. One chart in PostHog then shows every queue the platform
 * runs.
 *
 * Depth and the oldest job's age are read from the table on each export, so
 * every replica reports the same numbers: chart them with `max`, not `sum`.
 * Records into the process's global MeterProvider (`observability/otel-metrics.js`),
 * so all of it is the API's no-op without a collector.
 */

const { metrics } = require('@opentelemetry/api')

const QUEUE = 'bff'

/**
 * @typedef {object} QueueMeters
 * @property {(milliseconds: number) => void} claimed       one claim round trip
 * @property {(kind: string, seconds: number) => void} ran  one claim's run, to its end or its give-back
 * @property {(count: number) => void} died                 jobs moved to dead
 */

/**
 * Create the instruments and register the gauges that read `stats`. Call once
 * per process, after `initOtelMetrics`: the JS API has no proxy meter, so
 * instruments made before the provider stay no-ops.
 *
 * @param {() => Promise<{ counts: Record<string, number>, oldestQueuedSeconds: number | null }>} stats
 * @param {(message: string) => void} warn
 * @returns {QueueMeters}
 */
function createQueueMeters(stats, warn) {
  const meter = metrics.getMeter('grid.bff_jobs')
  const claimLatency = meter.createHistogram('grid.queue.claim_latency_ms', {
    unit: 'ms',
    description: 'Time one claim round trip took',
  })
  const jobDuration = meter.createHistogram('grid.queue.job_duration_seconds', {
    unit: 's',
    description: 'Time a claimed job took to run',
  })
  const dead = meter.createCounter('grid.queue.dead_total', { description: 'Jobs moved to dead' })
  const depth = meter.createObservableGauge('grid.queue.depth', { description: 'Rows in the queue by status' })
  const oldest = meter.createObservableGauge('grid.queue.oldest_age_seconds', {
    unit: 's',
    description: 'Age of the oldest queued job',
  })

  // One read for both gauges: a batch callback sees them in the same export.
  meter.addBatchObservableCallback(
    async (result) => {
      let snapshot
      try {
        snapshot = await stats()
      } catch (error) {
        // An unreadable queue is a gap in the chart, never a failed export.
        warn(`[bff-jobs] could not read the queue for its meters: ${error instanceof Error ? error.message : error}`)
        return
      }
      for (const [status, count] of Object.entries(snapshot.counts)) {
        result.observe(depth, count, { queue: QUEUE, status })
      }
      if (snapshot.oldestQueuedSeconds !== null) result.observe(oldest, snapshot.oldestQueuedSeconds, { queue: QUEUE })
    },
    [depth, oldest],
  )

  return {
    claimed: (milliseconds) => claimLatency.record(milliseconds, { queue: QUEUE }),
    ran: (kind, seconds) => jobDuration.record(Math.max(0, seconds), { queue: QUEUE, kind }),
    died: (count) => dead.add(count, { queue: QUEUE }),
  }
}

/** Meters that record nothing: what a runner built without any (its tests) uses. */
const NO_QUEUE_METERS = { claimed: () => {}, ran: () => {}, died: () => {} }

module.exports = { NO_QUEUE_METERS, createQueueMeters }
