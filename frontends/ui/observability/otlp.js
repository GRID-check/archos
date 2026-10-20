/**
 * Where a signal goes and who sent it: the two rules every OTLP exporter in a
 * Node tier shares (`otel-logs.js`, `otel-metrics.js`).
 *
 * OTEL_EXPORTER_OTLP_ENDPOINT is the collector's base URL for the Node tiers
 * and its full traces path for the Python ones; either names the collector,
 * and every signal is a sibling path on it.
 *
 * The resource names the tier (`service.name`), the build (`service.version`,
 * the commit the Dockerfile stamps as GRID_GIT_SHA) and the process
 * (`service.instance.id`, the pod; `process.pid`). The process matters most to
 * metrics: bff-jobs runs its claim loop and a `server.js` child in one pod under
 * one service name, and a cumulative counter from two processes under one
 * identity reads as one series jumping between their totals.
 */

const SIGNALS = ['traces', 'logs', 'metrics']

/** The OTLP/HTTP URL for `signal` on the collector `endpoint` names, bare or with a signal path. */
function signalUrl(endpoint, signal) {
  let base = String(endpoint).trim().replace(/\/+$/, '')
  const known = SIGNALS.find((s) => base.endsWith(`/v1/${s}`))
  if (known) base = base.slice(0, -`/v1/${known}`.length)
  return `${base}/v1/${signal}`
}

/** The resource every exported record and reading carries; blank values are left out. */
function resourceAttributes(env, pid = process.pid) {
  const attributes = { 'service.name': String(env.OTEL_SERVICE_NAME ?? '').trim() || 'grid-ui', 'process.pid': pid }
  const sha = String(env.GRID_GIT_SHA ?? '').trim()
  if (sha) attributes['service.version'] = sha
  const instance = String(env.HOSTNAME ?? '').trim()
  if (instance) attributes['service.instance.id'] = instance
  return attributes
}

/** The collector endpoint, or undefined when none is configured (local dev, compose). */
function collectorEndpoint(env) {
  const endpoint = String(env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim()
  return endpoint || undefined
}

module.exports = { collectorEndpoint, resourceAttributes, signalUrl }
