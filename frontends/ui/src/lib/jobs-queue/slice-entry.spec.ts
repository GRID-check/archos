import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConflictError, NotFoundError, ServiceUnavailableError, UpstreamError } from '@/lib/api/errors'
import { getTenantContext, withTenant } from '@/lib/db/tenant-context'

const runJobSlice = vi.fn()
vi.mock('./run', () => ({ runJobSlice: (...args: unknown[]) => runJobSlice(...args) }))
const shutdownPosthogServer = vi.fn()
vi.mock('@/lib/analytics/posthog-server', () => ({ shutdownPosthogServer: () => shutdownPosthogServer() }))
const bootstrapPlatformModelDefaults = vi.fn()
vi.mock('@/lib/model-config/bootstrap-defaults', () => ({
  bootstrapPlatformModelDefaults: () => bootstrapPlatformModelDefaults(),
}))

import { initSliceHost, runSlice, shutdownSliceHost } from './slice-entry'

beforeEach(() => {
  runJobSlice.mockReset()
  shutdownPosthogServer.mockReset()
  bootstrapPlatformModelDefaults.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

/** A connection the database refused, as postgres.js reports it under drizzle. */
const databaseDown = (): Error => new Error('Failed query: select 1', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })

describe('runSlice: what the HTTP door said with a status, said as an outcome', () => {
  it('passes a finished, an unfinished and a waiting slice through', async () => {
    runJobSlice.mockResolvedValueOnce({ done: true, payload: {} })
    runJobSlice.mockResolvedValueOnce({ done: false, payload: { cursor: 3 } })
    runJobSlice.mockResolvedValueOnce({ done: false, payload: { cursor: 4 }, notBefore: '2026-10-27T10:00:00.000Z' })

    expect(await runSlice('job-1', 'w-0')).toEqual({ kind: 'done' })
    expect(await runSlice('job-1', 'w-0')).toEqual({ kind: 'more', payload: { cursor: 3 } })
    expect(await runSlice('job-1', 'w-0')).toEqual({
      kind: 'defer',
      payload: { cursor: 4 },
      notBefore: '2026-10-27T10:00:00.000Z',
    })
    expect(runJobSlice).toHaveBeenCalledWith('job-1', 'w-0')
  })

  it('reads a claim that is no longer the worker’s as lost (the 409)', async () => {
    runJobSlice.mockRejectedValue(new ConflictError('The job is not claimed by this worker'))

    expect(await runSlice('job-1', 'w-0')).toEqual({ kind: 'lost' })
  })

  it('reads a database outage and an upstream that is down as transient (the 503 and the gateway statuses)', async () => {
    runJobSlice.mockRejectedValueOnce(databaseDown())
    runJobSlice.mockRejectedValueOnce(new ServiceUnavailableError('gotenberg is busy'))
    runJobSlice.mockRejectedValueOnce(new UpstreamError('backend 502'))

    expect(await runSlice('job-1', 'w-0')).toMatchObject({
      kind: 'transient',
      failure: { kind: 'database unavailable (ECONNREFUSED)' },
    })
    expect(await runSlice('job-1', 'w-0')).toMatchObject({ kind: 'transient', failure: { detail: 'gotenberg is busy' } })
    expect(await runSlice('job-1', 'w-0')).toMatchObject({ kind: 'transient', failure: { detail: 'backend 502' } })
  })

  it('reads anything else as a failed attempt with its message, and logs what no handler meant to throw', async () => {
    runJobSlice.mockRejectedValueOnce(new Error('No handler for job kind "x"'))
    runJobSlice.mockRejectedValueOnce(new NotFoundError('Project not found'))

    expect(await runSlice('job-1', 'w-0')).toEqual({ kind: 'error', message: 'No handler for job kind "x"' })
    expect(await runSlice('job-1', 'w-0')).toEqual({ kind: 'error', message: 'Project not found' })
    expect(console.error).toHaveBeenCalledTimes(1)
  })

  it('starts each slice with no tenant, whatever the last one left behind', async () => {
    let seen: unknown = 'not read'
    runJobSlice.mockImplementation(async () => {
      seen = getTenantContext()
      return { done: true, payload: {} }
    })

    await withTenant({ organizationId: 'org-before' }, () => runSlice('job-1', 'w-0'))

    expect(seen).toBeUndefined()
  })
})

describe('the host around the slices', () => {
  it('provisions the platform default model at start, and survives it failing', async () => {
    bootstrapPlatformModelDefaults.mockRejectedValue(new Error('no table'))

    await expect(initSliceHost()).resolves.toBeUndefined()

    expect(bootstrapPlatformModelDefaults).toHaveBeenCalledTimes(1)
  })

  it('flushes PostHog at shutdown', async () => {
    await shutdownSliceHost()

    expect(shutdownPosthogServer).toHaveBeenCalledTimes(1)
  })
})
