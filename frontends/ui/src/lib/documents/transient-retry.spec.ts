/**
 * @vitest-environment node
 *
 * The sweep that reads a document again after a transient failure: what it asks the
 * repository for, that each retry runs inside its own organization, and that one
 * row's failure never costs the others their turn.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({ listTransientFailures: vi.fn() }))
vi.mock('./service', () => ({ retryTransientFailure: vi.fn() }))

import { getTenantContext } from '@/lib/db/tenant-context'
import { listTransientFailures } from './repository'
import { retryTransientFailure } from './service'
import {
  TRANSIENT_BATCH,
  TRANSIENT_FIRST_BACKOFF_MINUTES,
  TRANSIENT_MAX_ATTEMPTS,
  retryTransientFailures,
} from './transient-retry'

const NOW = new Date('2026-10-27T12:00:00Z')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listTransientFailures).mockResolvedValue([])
  vi.mocked(retryTransientFailure).mockResolvedValue('requeued')
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('retryTransientFailures', () => {
  it('asks for transient failures under the attempt cap, past their backoff, a bounded batch', async () => {
    await retryTransientFailures(NOW)

    expect(listTransientFailures).toHaveBeenCalledWith(NOW, {
      maxAttempts: TRANSIENT_MAX_ATTEMPTS,
      firstBackoffMinutes: TRANSIENT_FIRST_BACKOFF_MINUTES,
      limit: TRANSIENT_BATCH,
    })
    // Two automatic retries at most: a provider outage must not turn into a loop of vision calls.
    expect(TRANSIENT_MAX_ATTEMPTS).toBe(3)
  })

  it('retries each document inside its own organization', async () => {
    vi.mocked(listTransientFailures).mockResolvedValue([
      { id: 'doc-1', organizationId: 'org_1', attempts: 1 },
      { id: 'doc-2', organizationId: 'org_2', attempts: 2 },
    ])
    const scopes: Array<[string, ReturnType<typeof getTenantContext>]> = []
    vi.mocked(retryTransientFailure).mockImplementation(async (organizationId) => {
      scopes.push([organizationId, getTenantContext()])
      return 'requeued'
    })

    const result = await retryTransientFailures(NOW)

    expect(scopes).toEqual([
      ['org_1', expect.objectContaining({ kind: 'tenant', organizationId: 'org_1' })],
      ['org_2', expect.objectContaining({ kind: 'tenant', organizationId: 'org_2' })],
    ])
    expect(result).toEqual({ checked: 2, requeued: 2, failed: 0, gone: 0, errors: 0 })
  })

  it('counts every outcome, and one row throwing does not stop the rest', async () => {
    vi.mocked(listTransientFailures).mockResolvedValue([
      { id: 'a', organizationId: 'org_1', attempts: 1 },
      { id: 'b', organizationId: 'org_1', attempts: 1 },
      { id: 'c', organizationId: 'org_1', attempts: 2 },
      { id: 'd', organizationId: 'org_1', attempts: 2 },
    ])
    vi.mocked(retryTransientFailure)
      .mockRejectedValueOnce(new Error('backend down'))
      .mockResolvedValueOnce('gone')
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('requeued')

    expect(await retryTransientFailures(NOW)).toEqual({ checked: 4, requeued: 1, failed: 1, gone: 1, errors: 1 })
  })
})
