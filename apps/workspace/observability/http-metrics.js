/**
 * The gateway's request histogram: every HTTP request `server.js` answers.
 *
 * `http.server.request.duration` and its attribute names are the OpenTelemetry
 * semantic conventions, so PostHog reads them without a mapping. The route is
 * a class of four, never a path: a path segment as an attribute would let a
 * scanner probing `/api/<anything>` mint a series per probe, and PostHog
 * stores and charts per series.
 *
 * Records into whatever MeterProvider is global (`otel-metrics.js`), so it is
 * the API's no-op without a collector.
 */

const { metrics } = require('@opentelemetry/api')

/** Seconds, from a static file to a streamed answer. */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]
const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

/**
 * Created on the first request, not at load: the JS API has no proxy meter, so
 * an instrument made before `initOtelMetrics` would stay a no-op for good.
 */
let requestDuration

/** @returns {'health' | 'static' | 'api' | 'page'} */
function routeClass(pathname) {
  const path = String(pathname ?? '/')
  if (path === '/api/healthz') return 'health'
  if (path.startsWith('/_next/')) return 'static'
  if (path === '/api' || path.startsWith('/api/')) return 'api'
  return 'page'
}

/** The attributes one request is recorded under. */
function requestAttributes({ method, pathname, statusCode }) {
  return {
    'http.request.method': KNOWN_METHODS.has(method) ? method : '_OTHER',
    'http.response.status_code': statusCode,
    'grid.route.class': routeClass(pathname),
  }
}

/**
 * Measure `res` from now until it closes. `close` fires for a finished response
 * and for one the client abandoned, so a stream the browser left is measured
 * too, at the status it had.
 */
function measureRequest(req, res, pathname) {
  const startedAt = process.hrtime.bigint()
  res.once('close', () => {
    requestDuration ??= metrics.getMeter('grid.gateway').createHistogram('http.server.request.duration', {
      unit: 's',
      description: 'Time the gateway took to answer a request',
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    })
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9
    requestDuration.record(seconds, requestAttributes({ method: req.method, pathname, statusCode: res.statusCode }))
  })
}

module.exports = { measureRequest, requestAttributes, routeClass }
