// @ts-check
/**
 * GRID BFF job runner — the entry point of the `bff-jobs` pool (ADR-0079).
 *
 * Dedicated pod (frontend image, `node workers/jobs/index.js`), internal only:
 * no Service, no HTTPRoute. One process runs the claim loop (`./runner.js`),
 * which takes jobs from `bff_job_queue` fairly across organizations, and the
 * host the slices run in, so the heavy work a job does (walking ten thousand
 * documents, converting an office file, parsing an IFC) runs in THIS pod and
 * never in a user-facing frontend pod that also proxies chat. The host is one
 * of two, by `BFF_JOBS_MODE`:
 *
 *   http (default) - the BFF itself (`node server.js`, a child process), asked
 *      for one slice at a time over `POST /api/internal/jobs/run`;
 *   inprocess - the BFF's services bundled at image build into
 *      `dist-jobs/slice.mjs` (`scripts/build-jobs-bundle.ts`), imported into
 *      this process. No server is spawned (ADR-0079 amendment 1).
 *
 * ONE PROCESS, NOT TWO CONTAINERS, because shutdown has an order. On SIGTERM
 * the loop stops claiming and lets the slices in hand finish, and only THEN may
 * the host go away: two containers in a pod are signalled at the same moment,
 * so the BFF would be gone under the slice that is still using it. Here the BFF
 * gets its SIGTERM after the drain; in process, the bundle flushes after it.
 *
 * Environment (the BFF's own, `frontendEnv`, plus):
 *   APP_DATABASE_URL            - grid_app Postgres DSN (the queue lives there)
 *   BFF_JOBS_MODE               - `http` (default) or `inprocess`: where a slice runs
 *   INTERNAL_API_TOKEN          - shared token for the internal run route (http mode)
 *   BFF_JOBS_URL                - the pod's own BFF (http mode; default http://127.0.0.1:$PORT)
 *   BFF_JOBS_CONCURRENCY        - jobs one replica runs at once (default 2)
 *   BFF_JOBS_POLL_MS            - idle wait between claims (default 2000)
 *   BFF_JOBS_DRAIN_SECONDS      - SIGTERM budget to finish a slice (default 60)
 *   BFF_JOBS_STALE_SECONDS      - a claim silent this long is claimed again (default 180)
 *   BFF_JOBS_MAX_ATTEMPTS       - claims one job gets before it is dead (default 3)
 *   BFF_JOBS_RETRY_BACKOFF_SECONDS - wait before a failed job's second attempt, doubling per attempt, at most 15 min; 0 retries at once (default 30)
 *   BFF_JOBS_DEAD_RETENTION_DAYS - how long a dead job is kept before it is deleted (default 14)
 *   BFF_JOBS_MAX_PER_ORG        - most jobs one organization runs fleet-wide; 0 = no cap (default 0)
 *   BFF_JOBS_SLICE_TIMEOUT_MS   - ceiling on one slice's request (default 300000)
 */

const { spawn } = require('node:child_process')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const postgres = require('postgres')
const queue = require('../job-queue')
const { createFailureStreak, escalationTicks } = require('../failure-streak')
const { createInProcessSliceRunner, createRunner, createSliceRunner } = require('./runner')
const { createQueueMeters } = require('./queue-metrics')
const { initOtelLogs } = require('../../observability/otel-logs')
const { initOtelMetrics, shutdownOtelMetrics } = require('../../observability/otel-metrics')

const LOG = '[bff-jobs]'

/** Where a slice runs; `http` until the in-process host has run in every environment. */
const MODES = /** @type {const} */ (['http', 'inprocess'])
/** The bundle `scripts/build-jobs-bundle.ts` writes, beside `workers/` in the image. */
const SLICE_BUNDLE = path.join(__dirname, '..', '..', 'dist-jobs', 'slice.mjs')
/** What the in-process host gets to flush after the drain, as `server.js` gives its hooks. */
const HOST_SHUTDOWN_MS = 2000

/**
 * @param {string | undefined} raw
 * @returns {(typeof MODES)[number]}
 */
function readMode(raw) {
  const mode = (raw ?? '').trim() || 'http'
  const known = MODES.find((candidate) => candidate === mode)
  if (!known) throw new Error(`BFF_JOBS_MODE must be one of ${MODES.join(', ')}, not "${mode}"`)
  return known
}

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 * @param {{ min?: number }} [bounds]
 */
function toInt(raw, fallback, bounds = {}) {
  const n = parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n >= (bounds.min ?? 1) ? n : fallback
}

/** @param {NodeJS.ProcessEnv} env */
function readConfig(env) {
  const port = toInt(env.PORT, 3000)
  const heartbeatMs = 15_000
  return {
    mode: readMode(env.BFF_JOBS_MODE),
    port,
    url: (env.BFF_JOBS_URL || `http://127.0.0.1:${port}`).replace(/\/$/, ''),
    internalToken: env.INTERNAL_API_TOKEN || '',
    drainMs: toInt(env.BFF_JOBS_DRAIN_SECONDS, 60) * 1000,
    sliceTimeoutMs: toInt(env.BFF_JOBS_SLICE_TIMEOUT_MS, 300_000),
    runner: {
      workerPrefix: `bff-jobs-${env.HOSTNAME || os.hostname()}`,
      concurrency: toInt(env.BFF_JOBS_CONCURRENCY, 2),
      pollMs: toInt(env.BFF_JOBS_POLL_MS, 2000),
      heartbeatMs,
      // Never shorter than a few beats, or a healthy slice's claim would look dead.
      staleSeconds: Math.max(toInt(env.BFF_JOBS_STALE_SECONDS, 180), (heartbeatMs / 1000) * 4),
      maxAttempts: toInt(env.BFF_JOBS_MAX_ATTEMPTS, 3),
      perLaneCap: toInt(env.BFF_JOBS_MAX_PER_ORG, 0, { min: 0 }),
      // A claim gives its slot back between slices after this long (runner.js, runClaim).
      yieldAfterMs: 10 * 60_000,
      reapEveryMs: 60_000,
      transientBackoffMs: 5_000,
      retryBackoffSeconds: toInt(env.BFF_JOBS_RETRY_BACKOFF_SECONDS, queue.DEFAULT_RETRY_BACKOFF_SECONDS, { min: 0 }),
      deadRetentionSeconds: toInt(env.BFF_JOBS_DEAD_RETENTION_DAYS, 14) * 86_400,
      purgeEveryMs: 600_000,
    },
  }
}

/**
 * Wait until the pod's BFF answers its health route, so the first claims do not
 * meet a server that is still booting.
 *
 * @param {string} url
 * @param {{ attempts?: number, intervalMs?: number, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<boolean>}
 */
async function waitForServer(url, { attempts = 120, intervalMs = 1000, fetchImpl = fetch, sleep } = {}) {
  const wait = sleep ?? ((/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const res = await fetchImpl(`${url}/api/healthz`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) return true
    } catch {
      /* not listening yet */
    }
    await wait(intervalMs)
  }
  return false
}

/**
 * @typedef {object} WorkHost
 * @property {(claim: import('../job-queue').Claim, worker: string) => Promise<import('./runner').SliceOutcome>} runSlice
 * @property {() => Promise<void>} stop  after the drain: end the host
 */

/**
 * @typedef {object} WorkHostDeps
 * @property {() => import('node:child_process').ChildProcess} [spawnServer]
 * @property {() => Promise<import('./runner').SliceBundle>} [importBundle]
 * @property {typeof waitForServer} [waitForServer]
 * @property {(port: number) => Promise<Pick<import('node:http').Server, 'close'>>} [serveHealth]
 * @property {Pick<NodeJS.Process, 'on'>} [process]
 * @property {(code: number | null, signal: NodeJS.Signals | null) => void} onServerExit
 */

/**
 * The probes' `/api/healthz` when no BFF answers it: the pod's probes stay the
 * ones the http mode needs (`deploy/pulumi/src/app/bff-jobs.ts`), and an answer
 * means this process's event loop is turning, which is what a liveness probe
 * of a claim loop can honestly say.
 *
 * @param {number} port
 * @returns {Promise<import('node:http').Server>}
 */
function serveHealth(port) {
  const server = http.createServer((req, res) => {
    const ok = req.method === 'GET' && (req.url ?? '').split('?')[0] === '/api/healthz'
    res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify(ok ? { status: 'ok' } : { error: 'Not found' }))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => resolve(server))
  })
}

/**
 * Start the host the slices run in, by `config.mode`: spawn the BFF and wait
 * for it, or import the bundled services into this process. Resolves null when
 * the BFF did not come up.
 *
 * @param {ReturnType<typeof readConfig>} config
 * @param {WorkHostDeps} deps
 * @returns {Promise<WorkHost | null>}
 */
async function startWorkHost(config, deps) {
  if (config.mode === 'inprocess') {
    // As the Next server does (`process-error-handlers.js` in next): a promise a
    // service started and did not await, rejecting late, is logged, not fatal.
    // Fatal here would take every claim in the pod down with it.
    const proc = deps.process ?? process
    proc.on('unhandledRejection', (reason) => console.error(`${LOG} unhandledRejection:`, reason))
    proc.on('uncaughtException', (error) => console.error(`${LOG} uncaughtException:`, error))
    const importBundle = deps.importBundle ?? (() => import(pathToFileURL(SLICE_BUNDLE).href))
    const bundle = await importBundle()
    await bundle.initSliceHost()
    const health = await (deps.serveHealth ?? serveHealth)(config.port)
    return {
      runSlice: createInProcessSliceRunner({ bundle, timeoutMs: config.sliceTimeoutMs }),
      stop: async () => {
        health.close()
        // A flush that hangs must not hold the pod past its grace period.
        await Promise.race([
          bundle.shutdownSliceHost().catch((/** @type {unknown} */ error) => console.warn(`${LOG} the slice host did not flush:`, error)),
          new Promise((resolve) => setTimeout(resolve, HOST_SHUTDOWN_MS).unref()),
        ])
      },
    }
  }

  if (!config.internalToken) throw new Error('INTERNAL_API_TOKEN is not defined')
  const spawnServer = deps.spawnServer ?? (() => spawn(process.execPath, ['server.js'], { stdio: 'inherit', env: process.env }))
  const server = spawnServer()
  server.once('exit', deps.onServerExit)
  if (!(await (deps.waitForServer ?? waitForServer)(config.url))) {
    console.error(`${LOG} the BFF did not answer ${config.url}/api/healthz in time; exiting`)
    server.kill('SIGTERM')
    return null
  }
  return {
    runSlice: createSliceRunner({ url: config.url, token: config.internalToken, timeoutMs: config.sliceTimeoutMs }),
    stop: async () => {
      server.kill('SIGTERM')
    },
  }
}

async function main() {
  // No-op without OTEL_EXPORTER_OTLP_ENDPOINT (ADR-0029 capability gate).
  initOtelLogs()
  initOtelMetrics()
  const config = readConfig(process.env)
  const databaseUrl = process.env.APP_DATABASE_URL
  if (!databaseUrl) throw new Error('APP_DATABASE_URL is not defined')

  const sql = postgres(databaseUrl, { prepare: false, max: config.runner.concurrency + 2 })
  let draining = false
  /** @type {WorkHost | null} */
  let host = null
  /** @type {ReturnType<typeof createRunner> | null} */
  let runner = null

  /** @param {string} signal */
  async function shutdown(signal) {
    if (draining) return
    draining = true
    console.log(`${LOG} ${signal}: draining for up to ${config.drainMs}ms`)
    const released = runner ? await runner.drain(config.drainMs) : 0
    if (released > 0) console.warn(`${LOG} drain budget spent; ${released} claim(s) released mid-job`)
    await sql.end({ timeout: 5 }).catch(() => {})
    await host?.stop()
    await shutdownOtelMetrics().catch(() => {})
    // In process nothing else is left to wait for; the BFF child's exit ends an http host.
    if (config.mode === 'inprocess') process.exit(0)
    setTimeout(() => process.exit(0), 10_000).unref()
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))

  host = await startWorkHost(config, {
    onServerExit: async (code, signal) => {
      if (draining) return process.exit(0)
      // The BFF died under us: give the claims back and let Kubernetes restart the pod.
      console.error(`${LOG} the BFF process exited (${signal ?? code}); stopping`)
      await runner?.drain(5_000)
      process.exit(1)
    },
  })
  if (!host) process.exit(1)
  // A SIGTERM while the host was starting has nothing to drain; end the host it missed.
  if (draining) return host.stop()

  runner = createRunner(config.runner, {
    sql,
    queue,
    runSlice: host.runSlice,
    streak: createFailureStreak({ label: `${LOG} queue`, escalateAfter: escalationTicks(config.runner.pollMs) }),
    meters: createQueueMeters(() => queue.stats(sql), console.warn),
  })
  console.log(
    `${LOG} claiming from bff_job_queue as ${config.runner.workerPrefix} ` +
      `(${config.mode}, concurrency ${config.runner.concurrency}, cap ${config.runner.perLaneCap || 'none'})`,
  )
  runner.start()
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`${LOG} failed to start:`, error)
    process.exit(1)
  })
}

module.exports = { readConfig, startWorkHost, waitForServer }
