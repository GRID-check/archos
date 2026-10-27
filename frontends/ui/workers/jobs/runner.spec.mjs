/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { createFailureStreak } from '../failure-streak.js'
import { EventEmitter } from 'node:events'
import { readConfig, startWorkHost, waitForServer } from './index.js'
import { createInProcessSliceRunner, createRunner, createSliceRunner } from './runner.js'

const CONFIG = {
  workerPrefix: 'w',
  concurrency: 1,
  pollMs: 1,
  heartbeatMs: 60_000,
  staleSeconds: 180,
  maxAttempts: 3,
  perLaneCap: 0,
  yieldAfterMs: 0,
  reapEveryMs: 60_000,
  transientBackoffMs: 0,
  retryBackoffSeconds: 30,
  deadRetentionSeconds: 14 * 86_400,
  purgeEveryMs: 600_000,
}

const CLAIM = { jobId: 'job-1', kind: 'reindex_project', lane: 'org-a', priority: 1, payload: {}, attempts: 1 }

function quietLog() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** A queue whose every verb succeeds, recording the calls the loop makes. */
function fakeQueue(overrides = {}) {
  return {
    claimNext: vi.fn().mockResolvedValue(null),
    heartbeat: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(true),
    saveProgress: vi.fn().mockResolvedValue(true),
    defer: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue('queued'),
    reapExhausted: vi.fn().mockResolvedValue([]),
    purgeDead: vi.fn().mockResolvedValue(0),
    ...overrides,
  }
}

function runnerOver(queue, slices, extra = {}) {
  const log = quietLog()
  const streak = createFailureStreak({ label: '[test]', escalateAfter: 5, log })
  const runSlice = vi.fn()
  for (const outcome of slices) runSlice.mockResolvedValueOnce(outcome)
  const runner = createRunner(
    { ...CONFIG, ...extra },
    {
      sql: /** @type {never} */ ({}),
      queue,
      runSlice,
      streak,
      log,
      sleep: () => Promise.resolve(),
      now: extra.now,
      meters: extra.meters,
    },
  )
  return { runner, runSlice, log }
}

describe('a claimed job', () => {
  it('runs slice after slice until the BFF says it is done, then leaves the queue', async () => {
    const queue = fakeQueue()
    const { runner, runSlice } = runnerOver(queue, [
      { kind: 'more', payload: { cursor: 1 } },
      { kind: 'more', payload: { cursor: 2 } },
      { kind: 'done' },
    ])

    await runner.runClaim(CLAIM, 'w-0')

    expect(runSlice).toHaveBeenCalledTimes(3)
    expect(queue.saveProgress.mock.calls.map((call) => call[3])).toEqual([{ cursor: 1 }, { cursor: 2 }])
    expect(queue.complete).toHaveBeenCalledWith(expect.anything(), 'job-1', 'w-0')
    expect(queue.fail).not.toHaveBeenCalled()
    expect(queue.release).not.toHaveBeenCalled()
    expect(runner.inFlight()).toBe(0)
  })

  it('gives a waiting job back without spending an attempt, with its progress, not before the time it named', async () => {
    const queue = fakeQueue()
    const notBefore = new Date('2026-10-13T10:00:30Z')
    const { runner, runSlice } = runnerOver(queue, [{ kind: 'defer', payload: { waits: 1 }, notBefore }])

    await runner.runClaim(CLAIM, 'w-0')

    // One slice: a wake whose person's thread runs another turn asks again later, not now.
    expect(runSlice).toHaveBeenCalledTimes(1)
    expect(queue.defer).toHaveBeenCalledWith(expect.anything(), 'job-1', 'w-0', { waits: 1 }, notBefore)
    expect(queue.fail).not.toHaveBeenCalled()
    expect(queue.complete).not.toHaveBeenCalled()
    expect(queue.saveProgress).not.toHaveBeenCalled()
  })

  it('gives a long claim its slot back between slices, keeping its progress and its attempt', async () => {
    const queue = fakeQueue()
    let clock = 0
    const { runner, runSlice } = runnerOver(queue, [], { yieldAfterMs: 600_000, now: () => clock })
    // Five minutes a slice: the second one reaches the ten-minute mark.
    runSlice
      .mockImplementationOnce(async () => ((clock += 300_000), { kind: 'more', payload: { cursor: 1 } }))
      .mockImplementationOnce(async () => ((clock += 300_000), { kind: 'more', payload: { cursor: 2 } }))

    await runner.runClaim(CLAIM, 'w-0')

    expect(runSlice).toHaveBeenCalledTimes(2)
    expect(queue.saveProgress.mock.calls.map((call) => call[3])).toEqual([{ cursor: 1 }, { cursor: 2 }])
    expect(queue.release).toHaveBeenCalledWith(expect.anything(), 'job-1', 'w-0')
    expect(queue.fail).not.toHaveBeenCalled()
    expect(queue.complete).not.toHaveBeenCalled()
  })

  it('does not yield a claim whose progress could not be saved: it is lost, not given back', async () => {
    const queue = fakeQueue({ saveProgress: vi.fn().mockResolvedValue(false) })
    let clock = 0
    const { runner, runSlice } = runnerOver(queue, [], { yieldAfterMs: 1, now: () => clock })
    runSlice.mockImplementationOnce(async () => ((clock += 10), { kind: 'more', payload: { cursor: 1 } }))

    await runner.runClaim(CLAIM, 'w-0')

    expect(queue.release).not.toHaveBeenCalled()
  })

  it('records a failed attempt with its reason, and says when the last one made it dead', async () => {
    const queue = fakeQueue({ fail: vi.fn().mockResolvedValue('dead') })
    const { runner, log } = runnerOver(queue, [{ kind: 'error', message: 'HTTP 500 boom' }])

    await runner.runClaim({ ...CLAIM, attempts: 3 }, 'w-0')

    expect(queue.fail).toHaveBeenCalledWith(expect.anything(), 'job-1', 'w-0', 'HTTP 500 boom', 3, 30)
    expect(queue.complete).not.toHaveBeenCalled()
    expect(log.error.mock.calls.map((c) => c[0]).join('\n')).toMatch(/now dead: job-1/)
  })

  it('spends the attempt when the BFF did not answer, so a job that always kills it ends dead', async () => {
    const queue = fakeQueue()
    const { runner, log } = runnerOver(queue, [{ kind: 'transient', failure: { kind: 'HTTP 503', detail: 'HTTP 503 unavailable' } }])

    await runner.runClaim(CLAIM, 'w-0')

    expect(queue.fail).toHaveBeenCalledWith(expect.anything(), 'job-1', 'w-0', 'HTTP 503 unavailable', 3, 30)
    expect(queue.release).not.toHaveBeenCalled()
    expect(log.warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/HTTP 503/)
  })

  it('spends the attempt on a slice that timed out, and says the job is dead when it was the last', async () => {
    const queue = fakeQueue({ fail: vi.fn().mockResolvedValue('dead') })
    const failure = { kind: 'transport error (TimeoutError)', detail: 'The operation was aborted due to timeout' }
    const { runner, log } = runnerOver(queue, [{ kind: 'transient', failure }])

    await runner.runClaim({ ...CLAIM, attempts: 3 }, 'w-0')

    expect(queue.fail).toHaveBeenCalledTimes(1)
    expect(log.error.mock.calls.map((c) => c[0]).join('\n')).toMatch(/now dead: job-1/)
  })

  it('gives the claim back free when the BFF went away because the pod is shutting down', async () => {
    const queue = fakeQueue()
    const { runner, runSlice } = runnerOver(queue, [])
    runSlice.mockImplementationOnce(async () => {
      void runner.drain(1_000)
      return { kind: 'transient', failure: { kind: 'transport error (ECONNRESET)' } }
    })

    await runner.runClaim(CLAIM, 'w-0')

    expect(queue.release).toHaveBeenCalledWith(expect.anything(), 'job-1', 'w-0')
    expect(queue.fail).not.toHaveBeenCalled()
  })

  it('stops when the progress cannot be saved, because the claim is gone', async () => {
    const queue = fakeQueue({ saveProgress: vi.fn().mockResolvedValue(false) })
    const { runner, runSlice } = runnerOver(queue, [{ kind: 'more', payload: {} }])

    await runner.runClaim(CLAIM, 'w-0')

    expect(runSlice).toHaveBeenCalledTimes(1)
    expect(queue.complete).not.toHaveBeenCalled()
    expect(queue.release).not.toHaveBeenCalled()
  })

  it('stops quietly when the BFF says the claim is no longer this worker’s', async () => {
    const queue = fakeQueue()
    const { runner } = runnerOver(queue, [{ kind: 'lost' }])

    await runner.runClaim(CLAIM, 'w-0')

    expect(queue.complete).not.toHaveBeenCalled()
    expect(queue.fail).not.toHaveBeenCalled()
    expect(queue.release).not.toHaveBeenCalled()
  })

  it('stops before the next slice when a heartbeat finds the claim lost', async () => {
    vi.useFakeTimers()
    try {
      const queue = fakeQueue({ heartbeat: vi.fn().mockResolvedValue(false) })
      const { runner, runSlice } = runnerOver(queue, [], { heartbeatMs: 10 })
      runSlice.mockImplementationOnce(async () => {
        await vi.advanceTimersByTimeAsync(25)
        return { kind: 'more', payload: {} }
      })

      await runner.runClaim(CLAIM, 'w-0')

      expect(runSlice).toHaveBeenCalledTimes(1)
      expect(queue.complete).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('draining', () => {
  it('lets the slice in hand finish, then gives the claim back without spending an attempt', async () => {
    const queue = fakeQueue()
    const { runner, runSlice } = runnerOver(queue, [])
    let finishSlice = () => {}
    runSlice.mockImplementationOnce(() => new Promise((resolve) => (finishSlice = () => resolve({ kind: 'more', payload: { cursor: 1 } }))))
    queue.claimNext.mockResolvedValueOnce(CLAIM)

    runner.start()
    await vi.waitFor(() => expect(runner.inFlight()).toBe(1))
    const draining = runner.drain(5_000)
    finishSlice()
    const released = await draining

    expect(released).toBe(0)
    expect(runSlice).toHaveBeenCalledTimes(1) // no second slice once draining
    expect(queue.saveProgress).toHaveBeenCalledTimes(1) // what the slice got to is kept
    expect(queue.release).toHaveBeenCalledWith(expect.anything(), 'job-1', expect.stringMatching(/^w-/))
    expect(queue.fail).not.toHaveBeenCalled()
    expect(queue.complete).not.toHaveBeenCalled()
  })

  it('releases a slice that outlives the drain budget as it stands', async () => {
    const queue = fakeQueue()
    const { runner, runSlice } = runnerOver(queue, [])
    runSlice.mockImplementationOnce(() => new Promise(() => {})) // never answers
    queue.claimNext.mockResolvedValueOnce(CLAIM)

    runner.start()
    await vi.waitFor(() => expect(runner.inFlight()).toBe(1))
    const released = await runner.drain(20)

    expect(released).toBe(1)
    expect(queue.release).toHaveBeenCalledTimes(1)
    expect(queue.fail).not.toHaveBeenCalled()
  })

  it('claims nothing once draining', async () => {
    const queue = fakeQueue()
    const { runner } = runnerOver(queue, [])

    await runner.drain(10)
    runner.start()

    expect(queue.claimNext).not.toHaveBeenCalled()
  })
})

describe('the claim loop', () => {
  it('marks exhausted claims dead, at most once per interval', async () => {
    const queue = fakeQueue({ reapExhausted: vi.fn().mockResolvedValue(['dead-1']) })
    const { runner, log } = runnerOver(queue, [])

    await runner.step('w-0')
    await runner.step('w-0')

    expect(queue.reapExhausted).toHaveBeenCalledTimes(1)
    expect(log.error.mock.calls.map((c) => c[0]).join('\n')).toMatch(/1 job\(s\) lost their worker/)
  })

  it('deletes dead rows past their retention, at most once per interval, and never lets that stop a claim', async () => {
    const queue = fakeQueue({ purgeDead: vi.fn().mockResolvedValue(2) })
    const { runner, log } = runnerOver(queue, [])

    await runner.step('w-0')
    await runner.step('w-0')

    expect(queue.purgeDead).toHaveBeenCalledTimes(1)
    expect(queue.purgeDead).toHaveBeenCalledWith(expect.anything(), { olderThanSeconds: 14 * 86_400 })
    expect(log.log.mock.calls.map((c) => c[0]).join('\n')).toMatch(/deleted 2 dead job/)

    const broken = fakeQueue({ purgeDead: vi.fn().mockRejectedValue(new Error('deadlock')) })
    const second = runnerOver(broken, [])
    await second.runner.step('w-0')
    expect(broken.claimNext).toHaveBeenCalledTimes(1)
    expect(second.log.error).not.toHaveBeenCalled()
  })

  it('treats a database outage as a warning to retry, not an error', async () => {
    const down = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const queue = fakeQueue({ claimNext: vi.fn().mockRejectedValue(down) })
    const { runner, log } = runnerOver(queue, [])

    expect(await runner.step('w-0')).toBe(false)

    expect(log.error).not.toHaveBeenCalled()
    expect(log.warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/database unavailable \(ECONNREFUSED\)/)
  })

  it('logs any other claim failure at error and keeps going', async () => {
    const queue = fakeQueue({ claimNext: vi.fn().mockRejectedValue(new Error('syntax error')) })
    const { runner, log } = runnerOver(queue, [])

    expect(await runner.step('w-0')).toBe(false)

    expect(log.error).toHaveBeenCalledTimes(1)
  })
})

describe('the queue meters', () => {
  const meters = () => ({ claimed: vi.fn(), ran: vi.fn(), died: vi.fn() })

  it('times every claim, and every run by its kind', async () => {
    const m = meters()
    let clock = 0
    const queue = fakeQueue({ claimNext: vi.fn().mockResolvedValue(CLAIM) })
    const { runner } = runnerOver(queue, [{ kind: 'done' }], { meters: m, now: () => (clock += 1000) })
    await runner.step('w-0')
    expect(m.claimed).toHaveBeenCalledWith(1000)
    expect(m.ran).toHaveBeenCalledWith('reindex_project', expect.any(Number))
  })

  it('counts a job that failed its last attempt, and the exhausted claims a reap marks dead', async () => {
    const m = meters()
    const queue = fakeQueue({
      claimNext: vi.fn().mockResolvedValue(CLAIM),
      fail: vi.fn().mockResolvedValue('dead'),
      reapExhausted: vi.fn().mockResolvedValue(['job-2', 'job-3']),
    })
    const { runner } = runnerOver(queue, [{ kind: 'error', message: 'boom' }], { meters: m, reapEveryMs: 0 })
    await runner.step('w-0')
    expect(m.died.mock.calls).toEqual([[2], [1]])
  })

  it('counts nothing for an attempt that leaves the job queued', async () => {
    const m = meters()
    const queue = fakeQueue({ claimNext: vi.fn().mockResolvedValue(CLAIM) })
    const { runner } = runnerOver(queue, [{ kind: 'error', message: 'boom' }], { meters: m })
    await runner.step('w-0')
    expect(m.died).not.toHaveBeenCalled()
  })
})

describe('the slice request', () => {
  const respond = (status, body = {}) =>
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    )
  const sliceOver = (fetchImpl) =>
    createSliceRunner({ url: 'http://127.0.0.1:3000', token: 't', timeoutMs: 1000, fetchImpl })

  it('names only the job and the worker, with the internal token', async () => {
    const fetchImpl = respond(200, { done: true })

    expect(await sliceOver(fetchImpl)(CLAIM, 'w-0')).toEqual({ kind: 'done' })

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:3000/api/internal/jobs/run')
    expect(init.headers['x-grid-internal-token']).toBe('t')
    expect(JSON.parse(init.body)).toEqual({ jobId: 'job-1', worker: 'w-0' })
  })

  it('reads done: false as another slice to run, with the progress to save', async () => {
    const outcome = await sliceOver(respond(200, { done: false, payload: { cursor: 'p2' } }))(CLAIM, 'w-0')
    expect(outcome).toEqual({ kind: 'more', payload: { cursor: 'p2' } })
  })

  it('reads done: false with a notBefore as a job that waits until then', async () => {
    const outcome = await sliceOver(
      respond(200, { done: false, payload: { waits: 1 }, notBefore: '2026-10-13T10:00:30.000Z' })
    )(CLAIM, 'w-0')
    expect(outcome).toEqual({ kind: 'defer', payload: { waits: 1 }, notBefore: new Date('2026-10-13T10:00:30.000Z') })
    // A date it cannot read is no wait.
    expect(await sliceOver(respond(200, { done: false, payload: {}, notBefore: 'bald' }))(CLAIM, 'w-0')).toEqual({
      kind: 'more',
      payload: {},
    })
  })

  it('reads a 409 as a lost claim', async () => {
    expect(await sliceOver(respond(409, { error: 'not claimed' }))(CLAIM, 'w-0')).toEqual({ kind: 'lost' })
  })

  it('reads a gateway or outage status as transient, and any other status as the job’s failure', async () => {
    expect((await sliceOver(respond(503))(CLAIM, 'w-0')).kind).toBe('transient')
    expect((await sliceOver(respond(502))(CLAIM, 'w-0')).kind).toBe('transient')
    const failed = await sliceOver(respond(500, { error: 'the handler threw' }))(CLAIM, 'w-0')
    expect(failed.kind).toBe('error')
    expect(failed.message).toMatch(/HTTP 500/)
  })

  it('reads a refused connection as transient', async () => {
    const refused = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) })
    const outcome = await sliceOver(vi.fn().mockRejectedValue(refused))(CLAIM, 'w-0')
    expect(outcome.kind).toBe('transient')
  })
})

describe('the slice in process', () => {
  const sliceIn = (runSlice, timeoutMs = 1000) => createInProcessSliceRunner({ bundle: { runSlice }, timeoutMs })

  it('asks the bundle for the job and the worker, and passes its outcome through', async () => {
    const runSlice = vi.fn().mockResolvedValue({ kind: 'more', payload: { cursor: 2 } })

    expect(await sliceIn(runSlice)(CLAIM, 'w-0')).toEqual({ kind: 'more', payload: { cursor: 2 } })
    expect(runSlice).toHaveBeenCalledWith('job-1', 'w-0')
  })

  it('reads a wait as a date, and a date it cannot read as no wait, as over HTTP', async () => {
    const waits = vi.fn().mockResolvedValue({ kind: 'defer', payload: { waits: 1 }, notBefore: '2026-10-13T10:00:30.000Z' })
    const garbled = vi.fn().mockResolvedValue({ kind: 'defer', payload: {}, notBefore: 'bald' })

    expect(await sliceIn(waits)(CLAIM, 'w-0')).toEqual({
      kind: 'defer',
      payload: { waits: 1 },
      notBefore: new Date('2026-10-13T10:00:30.000Z'),
    })
    expect(await sliceIn(garbled)(CLAIM, 'w-0')).toEqual({ kind: 'more', payload: {} })
  })

  it('reads a slice that outlives its timeout as transient, as an aborted request', async () => {
    const outcome = await sliceIn(() => new Promise(() => {}), 5)(CLAIM, 'w-0')

    expect(outcome).toMatchObject({ kind: 'transient', failure: { kind: 'slice timeout' } })
  })

  it('reads a bundle that rejects as the job’s failure', async () => {
    const outcome = await sliceIn(vi.fn().mockRejectedValue(new Error('boom')))(CLAIM, 'w-0')

    expect(outcome).toEqual({ kind: 'error', message: 'boom' })
  })
})

describe('the host the slices run in', () => {
  const bundle = () => ({
    initSliceHost: vi.fn().mockResolvedValue(undefined),
    shutdownSliceHost: vi.fn().mockResolvedValue(undefined),
    runSlice: vi.fn().mockResolvedValue({ kind: 'done' }),
  })
  const fakeServer = () => Object.assign(new EventEmitter(), { kill: vi.fn() })

  it('in process: imports the bundle, starts it, answers the probes, and spawns no server', async () => {
    const loaded = bundle()
    const spawnServer = vi.fn()
    const health = { close: vi.fn() }
    const serveHealth = vi.fn().mockResolvedValue(health)
    const config = readConfig({ GRID_BFF_JOBS_MODE: 'inprocess', PORT: '4000' })

    const proc = new EventEmitter()
    const host = await startWorkHost(config, {
      spawnServer,
      importBundle: async () => loaded,
      serveHealth,
      process: proc,
      onServerExit: vi.fn(),
    })

    expect(spawnServer).not.toHaveBeenCalled()
    // A late rejection in a service is logged, as the Next server logs it, not fatal.
    expect(proc.listenerCount('unhandledRejection')).toBe(1)
    expect(proc.listenerCount('uncaughtException')).toBe(1)
    expect(loaded.initSliceHost).toHaveBeenCalledTimes(1)
    expect(serveHealth).toHaveBeenCalledWith(4000)
    expect(await host.runSlice(CLAIM, 'w-0')).toEqual({ kind: 'done' })
    expect(loaded.runSlice).toHaveBeenCalledWith('job-1', 'w-0')

    await host.stop()
    expect(health.close).toHaveBeenCalledTimes(1)
    expect(loaded.shutdownSliceHost).toHaveBeenCalledTimes(1)
  })

  it('in process: needs no internal token, because nothing is asked over HTTP', async () => {
    const config = readConfig({ GRID_BFF_JOBS_MODE: 'inprocess' })

    await expect(
      startWorkHost(config, {
        importBundle: async () => bundle(),
        serveHealth: async () => ({ close() {} }),
        process: new EventEmitter(),
        onServerExit: vi.fn(),
      })
    ).resolves.not.toBeNull()
  })

  it('by default: spawns the BFF, waits for it, and stops it after the drain', async () => {
    const server = fakeServer()
    const spawnServer = vi.fn().mockReturnValue(server)
    const importBundle = vi.fn()
    const config = readConfig({ GRID_INTERNAL_API_TOKEN: 't' })

    const host = await startWorkHost(config, {
      spawnServer,
      importBundle,
      waitForServer: async () => true,
      onServerExit: vi.fn(),
    })

    expect(config.mode).toBe('http')
    expect(spawnServer).toHaveBeenCalledTimes(1)
    expect(importBundle).not.toHaveBeenCalled()
    await host.stop()
    expect(server.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('by default: reports a BFF that dies, and gives up on one that never answers', async () => {
    const server = fakeServer()
    const onServerExit = vi.fn()
    const config = readConfig({ GRID_INTERNAL_API_TOKEN: 't' })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const host = await startWorkHost(config, { spawnServer: () => server, waitForServer: async () => false, onServerExit })
    server.emit('exit', 1, null)

    expect(host).toBeNull()
    expect(server.kill).toHaveBeenCalledWith('SIGTERM')
    expect(onServerExit).toHaveBeenCalledWith(1, null)
  })

  it('by default: refuses to start without the internal token', async () => {
    await expect(startWorkHost(readConfig({}), { spawnServer: vi.fn(), onServerExit: vi.fn() })).rejects.toThrow(
      /GRID_INTERNAL_API_TOKEN/
    )
  })

  it('refuses a mode it does not know, rather than guessing one', () => {
    expect(() => readConfig({ GRID_BFF_JOBS_MODE: 'in-process' })).toThrow(/GRID_BFF_JOBS_MODE/)
  })
})

describe('configuration', () => {
  it('has defaults a pod can run on', () => {
    const config = readConfig({ HOSTNAME: 'pod-1' })

    expect(config.url).toBe('http://127.0.0.1:3000')
    expect(config.runner).toMatchObject({
      workerPrefix: 'bff-jobs-pod-1',
      concurrency: 2,
      maxAttempts: 3,
      perLaneCap: 0,
      yieldAfterMs: 600_000,
      retryBackoffSeconds: 30,
      deadRetentionSeconds: 14 * 86_400,
    })
    expect(config.drainMs).toBe(60_000)
  })

  it('reads the knobs and ignores nonsense', () => {
    const config = readConfig({
      PORT: '4000',
      GRID_BFF_JOBS_CONCURRENCY: '5',
      GRID_BFF_JOBS_MAX_PER_ORG: '2',
      GRID_BFF_JOBS_DRAIN_SECONDS: 'soon',
    })

    expect(config.url).toBe('http://127.0.0.1:4000')
    expect(config.runner.concurrency).toBe(5)
    expect(config.runner.perLaneCap).toBe(2)
    expect(config.drainMs).toBe(60_000)
  })

  it('reads the retry backoff (0 retries at once) and the dead-row retention, and never retains for less than a day', () => {
    const runner = readConfig({ GRID_BFF_JOBS_RETRY_BACKOFF_SECONDS: '0', GRID_BFF_JOBS_DEAD_RETENTION_DAYS: '0' }).runner

    expect(runner.retryBackoffSeconds).toBe(0)
    expect(runner.deadRetentionSeconds).toBe(14 * 86_400)
    expect(readConfig({ GRID_BFF_JOBS_DEAD_RETENTION_DAYS: '3' }).runner.deadRetentionSeconds).toBe(3 * 86_400)
  })

  it('never lets the stale window shrink below a few heartbeats', () => {
    expect(readConfig({ GRID_BFF_JOBS_STALE_SECONDS: '5' }).runner.staleSeconds).toBe(60)
  })

  it('waits for the BFF to answer its health route', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('refused'))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const up = await waitForServer('http://x', { fetchImpl, sleep: () => Promise.resolve(), intervalMs: 0 })

    expect(up).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('gives up when the BFF never answers', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('refused'))

    expect(await waitForServer('http://x', { attempts: 3, fetchImpl, sleep: () => Promise.resolve() })).toBe(false)
  })
})
