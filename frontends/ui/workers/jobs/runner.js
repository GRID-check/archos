// @ts-check
/**
 * The claim loop of the `bff-jobs` pool (ADR-0079).
 *
 * A replica claims jobs from `bff_job_queue` fairly across organizations
 * (`../job-queue.js`) and runs each one slice at a time, through one of the two
 * doors below. The loop owns the claim: the heartbeat, the release, the failure
 * and the finish. The BFF's services own the work: which kind does what, and
 * the progress a slice leaves behind in the job's payload.
 *
 * WHAT COSTS AN ATTEMPT. Only a clean give-back is free: a drain, a claim over
 * its lane's cap, a long claim yielding its slot (`runClaim`), or a slice that
 * says it is waiting (`defer`: not done, and nothing to do before `notBefore`)
 * gives the job back WITHOUT spending an attempt. Everything
 * else spends one and the job waits out a backoff before its next: a handler
 * that threw, a slice that timed out, a BFF that answered 5xx or not at all. A
 * job that always times out, or always takes the BFF down, is therefore dead
 * after `maxAttempts` claims, with the reason kept, instead of cycling for ever.
 * (A BFF that was merely briefly unavailable costs the jobs in flight an
 * attempt too; the backoff and the attempts left are what absorb it.)
 *
 * A SLICE IS THE UNIT OF DRAINING. A job is not one long request. Each POST
 * does a bounded step (a page of documents, say) and answers `done: false` with
 * where it got to, which this loop saves as the job's progress, until the job
 * is finished. So a SIGTERM never has to
 * cut a request off or ask the BFF to stop: the loop stops asking for the next
 * slice, gives the claim back WITHOUT spending an attempt, and the next worker
 * resumes from the saved progress. A slice that outlives the drain budget is
 * abandoned the same way (the claim is released, so the progress the slice
 * would have saved is refused: the write is conditional on the claim).
 *
 * TWO DOORS TO THE WORK. The claim loop is plain Node with no build step, like
 * the purger and the scheduler, so it cannot import the TypeScript services
 * from source. By default they run behind the internal route, in a BFF the pod
 * spawns ({@link createSliceRunner}). With `GRID_BFF_JOBS_MODE=inprocess` they
 * run in this process from `dist-jobs/slice.mjs`, the services bundled at image
 * build ({@link createInProcessSliceRunner}, ADR-0079 amendment 1), and no
 * server is spawned. Either way the heavy work lands on `bff-jobs` pods and
 * never on the user-facing frontend pods that proxy chat, and either way a
 * slice comes back as the same {@link SliceOutcome}.
 *
 * The functions here take their collaborators as arguments, so the specs drive
 * a whole claim without a database or a server.
 */

const { databaseOutage, describeTransportError, describeFailedResponse, isTransientStatus } = require('../failure-streak')
const { NO_QUEUE_METERS } = require('./queue-metrics')

/** @typedef {import('../job-queue').Claim} Claim */

/**
 * @typedef {object} RunnerConfig
 * @property {string} workerPrefix  worker ids are `<prefix>-<slot>`
 * @property {number} concurrency   jobs this replica runs at once
 * @property {number} pollMs        idle wait between claims
 * @property {number} heartbeatMs   how often a running claim is refreshed
 * @property {number} staleSeconds  a claim silent this long is claimed again
 * @property {number} maxAttempts   a job is claimed at most this many times
 * @property {number} perLaneCap    most live claims one organization may hold; 0 is no cap
 * @property {number} yieldAfterMs  a claim running this long gives its slot back after its next slice; 0 never
 * @property {number} reapEveryMs   how often exhausted claims are marked dead
 * @property {number} transientBackoffMs  wait after the BFF was briefly unavailable
 * @property {number} retryBackoffSeconds  wait before a failed job's next attempt (doubles per attempt)
 * @property {number} deadRetentionSeconds  how long a dead row is kept before it is deleted
 * @property {number} purgeEveryMs  how often dead rows past their retention are deleted
 */

/**
 * What one slice came to, from the loop's point of view.
 *
 * @typedef {{ kind: 'done' } | { kind: 'more', payload: Record<string, unknown> } | { kind: 'lost' }
 *   | { kind: 'defer', payload: Record<string, unknown>, notBefore: Date }
 *   | { kind: 'transient', failure: { kind: string, detail?: string } }
 *   | { kind: 'error', message: string }} SliceOutcome
 */

/**
 * @typedef {object} RunnerDeps
 * @property {import('postgres').Sql} sql
 * @property {typeof import('../job-queue')} queue
 * @property {(claim: Claim, worker: string) => Promise<SliceOutcome>} runSlice
 * @property {import('../failure-streak').FailureStreak} streak
 * @property {Pick<Console, 'log' | 'warn' | 'error'>} [log]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [now]
 * @property {import('./queue-metrics').QueueMeters} [meters]
 */

/** @param {number} ms */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Ask the pod's BFF to run one slice of a claimed job.
 *
 * The request names the job and the worker and nothing else: the BFF reads the
 * row itself and refuses a job that is not claimed by that worker, so the route
 * cannot be made to run work the queue never handed out.
 *
 * @param {{ url: string, token: string, timeoutMs: number, fetchImpl?: typeof fetch }} options
 * @returns {(claim: Claim, worker: string) => Promise<SliceOutcome>}
 */
function createSliceRunner({ url, token, timeoutMs, fetchImpl = fetch }) {
  return async (claim, worker) => {
    try {
      const res = await fetchImpl(`${url}/api/internal/jobs/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-grid-internal-token': token },
        body: JSON.stringify({ jobId: claim.jobId, worker }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 409) return { kind: 'lost' }
      if (!res.ok) {
        const failure = await describeFailedResponse(res)
        return isTransientStatus(res.status) ? { kind: 'transient', failure } : { kind: 'error', message: failure.detail ?? failure.kind }
      }
      const body = /** @type {{ done?: unknown, payload?: Record<string, unknown>, notBefore?: unknown }} */ (await res.json())
      if (body.done === true) return { kind: 'done' }
      // A job waiting on something outside it (a wake whose person's thread is
      // busy) names when to look again; a date it cannot read is no wait.
      const notBefore = typeof body.notBefore === 'string' ? new Date(body.notBefore) : null
      if (notBefore && !Number.isNaN(notBefore.getTime())) {
        return { kind: 'defer', payload: body.payload ?? {}, notBefore }
      }
      return { kind: 'more', payload: body.payload ?? {} }
    } catch (error) {
      return { kind: 'transient', failure: describeTransportError(error) }
    }
  }
}

/**
 * What `dist-jobs/slice.mjs` exports (`src/lib/jobs-queue/slice-entry.ts`).
 *
 * @typedef {object} SliceBundle
 * @property {() => Promise<void>} initSliceHost
 * @property {() => Promise<void>} shutdownSliceHost
 * @property {(jobId: string, worker: string) => Promise<
 *   | { kind: 'done' } | { kind: 'more', payload: Record<string, unknown> } | { kind: 'lost' }
 *   | { kind: 'defer', payload: Record<string, unknown>, notBefore: string }
 *   | { kind: 'transient', failure: { kind: string, detail?: string } }
 *   | { kind: 'error', message: string }>} runSlice
 */

/**
 * Run one slice of a claimed job in this process, through the bundled services.
 *
 * The same question {@link createSliceRunner} asks over HTTP, with the same
 * reading of the answer: the bundle maps what a request would have answered
 * as a status (409 lost, a database outage transient) to the outcome itself.
 * A slice that outlives `timeoutMs` is reported transient exactly as an aborted
 * request is; like the request, the work it started is not cut off, and the
 * claim it no longer holds refuses whatever it would have saved.
 *
 * @param {{ bundle: Pick<SliceBundle, 'runSlice'>, timeoutMs: number }} options
 * @returns {(claim: Claim, worker: string) => Promise<SliceOutcome>}
 */
function createInProcessSliceRunner({ bundle, timeoutMs }) {
  return async (claim, worker) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs)
      timer.unref?.()
    })
    try {
      const outcome = await Promise.race([bundle.runSlice(claim.jobId, worker), timedOut])
      if (!outcome) return { kind: 'transient', failure: { kind: 'slice timeout', detail: `no answer in ${timeoutMs}ms` } }
      if (outcome.kind !== 'defer') return outcome
      const notBefore = new Date(outcome.notBefore)
      // A date it cannot read is no wait, as over HTTP.
      if (Number.isNaN(notBefore.getTime())) return { kind: 'more', payload: outcome.payload }
      return { kind: 'defer', payload: outcome.payload, notBefore }
    } catch (error) {
      // The entry answers every failure as an outcome, so a rejection is its bug.
      return { kind: 'error', message: describe(error) }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * @param {RunnerConfig} config
 * @param {RunnerDeps} deps
 */
function createRunner(config, deps) {
  const { sql, queue, runSlice, streak } = deps
  const log = deps.log ?? console
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const meters = deps.meters ?? NO_QUEUE_METERS
  const options = { staleSeconds: config.staleSeconds, maxAttempts: config.maxAttempts, perLaneCap: config.perLaneCap }

  let stopping = false
  /** @type {Map<string, { claim: Claim, worker: string, lost: boolean }>} */
  const inFlight = new Map()
  /** @type {Promise<void>[]} */
  const slots = []
  let lastReapAt = 0
  let lastPurgeAt = 0

  /**
   * Keep the claim alive while a slice runs. A heartbeat that says the claim is
   * no longer ours marks it lost; the loop stops after the slice in hand.
   *
   * @param {{ claim: Claim, worker: string, lost: boolean }} held
   */
  function startHeartbeat(held) {
    const timer = setInterval(async () => {
      try {
        if (!(await queue.heartbeat(sql, held.claim.jobId, held.worker))) held.lost = true
      } catch (error) {
        // A missed beat is not a lost claim: the stale window is several beats wide.
        log.warn(`[bff-jobs] heartbeat for job ${held.claim.jobId} failed: ${describe(error)}`)
      }
    }, config.heartbeatMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  /**
   * Run one claimed job a slice at a time, to its end or until it has held the
   * slot for `yieldAfterMs`.
   *
   * A job that runs for hours (an archive import) would otherwise keep its slot
   * for all of them, and two such jobs on a replica of two slots would hold
   * every other organization's work back until they finished. So a long claim
   * is given back between slices, WITHOUT spending an attempt, exactly as a
   * drain gives it back, and the fair claim (`../job-queue.js`) decides who
   * runs next. With nothing else queued, the same job is claimed again at once.
   *
   * @param {Claim} claim
   * @param {string} worker
   */
  async function runClaim(claim, worker) {
    const held = { claim, worker, lost: false }
    const claimedAt = now()
    inFlight.set(claim.jobId, held)
    const stopHeartbeat = startHeartbeat(held)
    try {
      for (;;) {
        if (held.lost) return log.warn(`[bff-jobs] job ${claim.jobId} (${claim.kind}) lost its claim; stopping`)
        if (stopping) return await giveBack(held, 'draining')
        const outcome = await runSlice(claim, worker)
        if (outcome.kind === 'defer') return await defer(held, outcome)
        if (outcome.kind !== 'more') return await settle(held, outcome)
        // The slice's progress is what the next worker resumes from, so a
        // claim that cannot save it has been lost and must stop here.
        if (!(await queue.saveProgress(sql, claim.jobId, worker, outcome.payload))) held.lost = true
        else if (config.yieldAfterMs > 0 && now() - claimedAt >= config.yieldAfterMs) {
          return await giveBack(held, 'yielding its slot to the queue')
        }
      }
    } finally {
      stopHeartbeat()
      inFlight.delete(claim.jobId)
      meters.ran(claim.kind, (now() - claimedAt) / 1000)
    }
  }

  /**
   * A slice that waits: its progress is saved and the claim given back without
   * spending an attempt, not to be claimed before `notBefore`.
   *
   * @param {{ claim: Claim, worker: string }} held
   * @param {{ payload: Record<string, unknown>, notBefore: Date }} outcome
   */
  async function defer(held, outcome) {
    const deferred = await queue.defer(sql, held.claim.jobId, held.worker, outcome.payload, outcome.notBefore)
    if (deferred) {
      log.log(`[bff-jobs] job ${held.claim.jobId} (${held.claim.kind}) waits until ${outcome.notBefore.toISOString()}`)
    }
  }

  /**
   * @param {{ claim: Claim, worker: string, lost: boolean }} held
   * @param {Exclude<SliceOutcome, { kind: 'more' | 'defer' }>} outcome
   */
  async function settle(held, outcome) {
    const { claim, worker } = held
    if (outcome.kind === 'done') {
      streak.succeeded()
      if (await queue.complete(sql, claim.jobId, worker)) log.log(`[bff-jobs] job ${claim.jobId} (${claim.kind}) done`)
      return
    }
    if (outcome.kind === 'lost') return log.warn(`[bff-jobs] job ${claim.jobId} (${claim.kind}) is no longer this worker's`)
    if (outcome.kind === 'transient') {
      // The BFF did not answer (it is booting or restarting, the slice outlived
      // its timeout, a request met a database outage). Whether the job caused it
      // cannot be told from here, and a job that always causes it must still end,
      // so the attempt is spent, behind a backoff. A shutdown is the exception:
      // the BFF going away under the slice is the drain's doing, not the job's.
      streak.failed(outcome.failure)
      if (stopping) return giveBack(held, 'draining')
      await failAttempt(held, outcome.failure.detail ?? outcome.failure.kind)
      return sleep(config.transientBackoffMs)
    }
    await failAttempt(held, outcome.message)
  }

  /**
   * Spend the attempt: the job is queued again after its backoff, or dead when
   * it was the last.
   *
   * @param {{ claim: Claim, worker: string }} held
   * @param {string} message
   */
  async function failAttempt(held, message) {
    const { claim, worker } = held
    const verdict = await queue.fail(sql, claim.jobId, worker, message, config.maxAttempts, config.retryBackoffSeconds)
    log.error(`[bff-jobs] job ${claim.jobId} (${claim.kind}) attempt ${claim.attempts} failed: ${message}`)
    if (verdict !== 'dead') return
    meters.died(1)
    log.error(`[bff-jobs] a job failed every attempt and is now dead: ${claim.jobId} (${claim.kind})`)
  }

  /**
   * Hand a claim back without spending an attempt.
   *
   * @param {{ claim: Claim, worker: string }} held
   * @param {string} why
   */
  async function giveBack(held, why) {
    const gave = await queue.release(sql, held.claim.jobId, held.worker)
    if (gave) log.log(`[bff-jobs] job ${held.claim.jobId} (${held.claim.kind}) released (${why}); its progress is kept`)
  }

  /** Mark claims dead whose worker vanished on their last attempt. At most once per `reapEveryMs`. */
  async function reapIfDue() {
    const now = Date.now()
    if (now - lastReapAt < config.reapEveryMs) return
    lastReapAt = now
    const dead = await queue.reapExhausted(sql, options)
    if (dead.length === 0) return
    meters.died(dead.length)
    log.error(`[bff-jobs] ${dead.length} job(s) lost their worker on their last attempt and are now dead`)
    log.warn(`[bff-jobs] dead jobs: ${dead.join(', ')}`)
  }

  /**
   * Delete dead rows past their retention. At most once per `purgeEveryMs`, and
   * a failure only costs the next pass: it must never keep a worker from claiming.
   */
  async function purgeIfDue() {
    const now = Date.now()
    if (now - lastPurgeAt < config.purgeEveryMs) return
    lastPurgeAt = now
    try {
      const purged = await queue.purgeDead(sql, { olderThanSeconds: config.deadRetentionSeconds })
      if (purged > 0) log.log(`[bff-jobs] deleted ${purged} dead job(s) past their retention`)
    } catch (error) {
      log.warn(`[bff-jobs] could not purge dead jobs: ${describe(error)}`)
    }
  }

  /**
   * One pass of one slot: reap and purge if due, claim, run. True when it ran a job.
   *
   * @param {string} worker
   */
  async function step(worker) {
    try {
      await reapIfDue()
      await purgeIfDue()
      const claimStartedAt = now()
      const claim = await queue.claimNext(sql, worker, options)
      meters.claimed(now() - claimStartedAt)
      if (!claim) {
        streak.succeeded()
        return false
      }
      await runClaim(claim, worker)
      return true
    } catch (error) {
      const outage = databaseOutage(error)
      if (outage) streak.failed(outage)
      else log.error('[bff-jobs] a claim failed, retrying on the next poll:', error)
      return false
    }
  }

  /** @param {number} index */
  async function slot(index) {
    const worker = `${config.workerPrefix}-${index}`
    while (!stopping) {
      if (!(await step(worker))) await sleep(config.pollMs)
    }
  }

  return {
    /** Start `concurrency` slots. They run until {@link drain}. */
    start() {
      for (let index = 0; index < config.concurrency; index += 1) slots.push(slot(index))
    },

    /**
     * Stop claiming, let every running job finish the slice it is in, and give
     * its claim back. After `timeoutMs` whatever is still running is released
     * as it stands. Resolves with the number of claims given back.
     *
     * @param {number} timeoutMs
     */
    async drain(timeoutMs) {
      stopping = true
      const timedOut = Symbol('timeout')
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs)
      })
      const result = await Promise.race([Promise.allSettled(slots), deadline])
      clearTimeout(timer)
      if (result !== timedOut) return 0
      const stranded = [...inFlight.values()]
      for (const held of stranded) await giveBack(held, 'drain budget spent').catch(() => {})
      return stranded.length
    },

    /** The claims this runner holds right now. */
    inFlight: () => inFlight.size,
    step,
    runClaim,
  }
}

/** @param {unknown} error */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

module.exports = { createInProcessSliceRunner, createRunner, createSliceRunner }
