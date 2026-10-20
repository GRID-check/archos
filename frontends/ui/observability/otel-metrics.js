/**
 * The process's one MeterProvider for the Node tiers (the gateway in
 * `server.js`, bff-jobs, the scheduler and the purger). It exports OTLP to the
 * collector, which forwards the readings to PostHog Metrics beside the Python
 * tiers' `grid.*` meters and the cluster's own.
 *
 * Installed on the OpenTelemetry API's global (`Symbol.for` on `globalThis`),
 * so it is one per process however many copies of this module are loaded, and
 * never shut down before exit: a stopped provider records nothing again.
 *
 * Every process reports how it is running: the event loop's delay, because a
 * BFF that stalls shows it there before it shows it as latency, and its memory.
 * What a tier measures on top is its own module (`http-metrics.js`).
 *
 * Capability doctrine: no collector endpoint (local dev, compose) => no
 * provider, and every instrument stays the API's no-op.
 */

const { monitorEventLoopDelay } = require('node:perf_hooks')
const { collectorEndpoint, resourceAttributes, signalUrl } = require('./otlp')

const PROVIDER_KEY = Symbol.for('grid.otel.meterProvider')
/** How often readings leave the process; PostHog charts at minute resolution. */
const EXPORT_INTERVAL_MS = 30_000

/** Install the process's MeterProvider. Returns true when this call enabled export. */
function initOtelMetrics(env = process.env) {
  if (globalThis[PROVIDER_KEY]) return false
  const endpoint = collectorEndpoint(env)
  if (!endpoint) return false

  const { metrics } = require('@opentelemetry/api')
  const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http')
  const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics')
  const { defaultResource, resourceFromAttributes } = require('@opentelemetry/resources')

  const provider = new MeterProvider({
    resource: defaultResource().merge(resourceFromAttributes(resourceAttributes(env))),
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: signalUrl(endpoint, 'metrics') }),
        exportIntervalMillis: EXPORT_INTERVAL_MS,
      }),
    ],
  })
  globalThis[PROVIDER_KEY] = provider
  metrics.setGlobalMeterProvider(provider)
  observeRuntime(metrics.getMeter('grid.runtime'))
  return true
}

/** Flush and stop the provider. The exit path only. */
async function shutdownOtelMetrics() {
  await globalThis[PROVIDER_KEY]?.shutdown()
}

function observeRuntime(meter) {
  const delay = monitorEventLoopDelay({ resolution: 20 })
  delay.enable()
  meter
    .createObservableGauge('nodejs.eventloop.delay.p99', {
      unit: 's',
      description: 'The 99th percentile of event loop delay since the previous reading',
    })
    .addCallback((result) => {
      result.observe(delay.percentile(99) / 1e9)
      delay.reset()
    })
  meter
    .createObservableGauge('process.memory.usage', { unit: 'By', description: 'Memory the process holds, by kind' })
    .addCallback((result) => {
      const { rss, heapUsed } = process.memoryUsage()
      result.observe(rss, { 'process.memory.type': 'rss' })
      result.observe(heapUsed, { 'process.memory.type': 'heap_used' })
    })
}

module.exports = { initOtelMetrics, shutdownOtelMetrics }
