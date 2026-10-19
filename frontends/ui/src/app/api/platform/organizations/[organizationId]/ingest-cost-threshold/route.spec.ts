/**
 * @vitest-environment node
 */
/**
 * `PUT /api/platform/organizations/[organizationId]/ingest-cost-threshold` — the
 * platform control that makes the organisation override reachable.
 *
 * What matters here: only the platform owner may write it, the body is validated
 * before the service is reached, and `null` (back to the default) is distinct
 * from `0` (never ask).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = {
  userId: 'owner-1',
  organizationId: 'org_platform',
  email: 'owner@grid.com',
  role: 'org-platform-owner',
  permissions: [] as string[],
}

vi.mock('@/lib/auth/session', () => ({ getGridSession: async () => session }))
vi.mock('@/lib/auth/require-auth', () => ({ authzErrorResponse: vi.fn().mockReturnValue(null) }))

const requirePlatformPermission = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/authz/platform', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/authz/platform')>()
  return {
    ...original,
    requirePlatformPermission: (s: unknown) => requirePlatformPermission(s),
  }
})

const setIngestCostConfirmationThreshold = vi.fn()
vi.mock('@/lib/ingest-cost/threshold', () => ({
  setIngestCostConfirmationThreshold: (...args: unknown[]) => setIngestCostConfirmationThreshold(...args),
}))

import { NotFoundError } from '@/lib/api/errors'
import { PlatformAccessDeniedError } from '@/lib/authz/platform'
import { PUT } from './route'

const call = (organizationId: string, body: unknown) =>
  PUT(
    new Request(`http://localhost/api/platform/organizations/${organizationId}/ingest-cost-threshold`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ organizationId }) }
  )

describe('PUT /api/platform/organizations/[organizationId]/ingest-cost-threshold', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePlatformPermission.mockResolvedValue(undefined)
    setIngestCostConfirmationThreshold.mockResolvedValue({
      ingestCostConfirmationThresholdUsd: 2,
      effectiveIngestCostConfirmationThresholdUsd: 2,
    })
  })

  it('rejects a caller who is not the platform owner', async () => {
    requirePlatformPermission.mockRejectedValue(new PlatformAccessDeniedError())

    expect((await call('org-1', { ingestCostConfirmationThresholdUsd: 2 })).status).toBe(403)
    expect(setIngestCostConfirmationThreshold).not.toHaveBeenCalled()
  })

  it('delegates a valid value to the service with the parsed number', async () => {
    const response = await call('org-1', { ingestCostConfirmationThresholdUsd: 2 })

    expect(response.status).toBe(200)
    expect(setIngestCostConfirmationThreshold).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner-1' }),
      'org-1',
      2,
      expect.anything()
    )
  })

  it('accepts null (back to the default) and 0 (never ask) as distinct decisions', async () => {
    expect((await call('org-1', { ingestCostConfirmationThresholdUsd: null })).status).toBe(200)
    expect(setIngestCostConfirmationThreshold).toHaveBeenLastCalledWith(
      expect.anything(),
      'org-1',
      null,
      expect.anything()
    )
    expect((await call('org-1', { ingestCostConfirmationThresholdUsd: 0 })).status).toBe(200)
    expect(setIngestCostConfirmationThreshold).toHaveBeenLastCalledWith(
      expect.anything(),
      'org-1',
      0,
      expect.anything()
    )
  })

  it('rejects an out-of-range or malformed body (400) without reaching the service', async () => {
    for (const body of [
      { ingestCostConfirmationThresholdUsd: 101 },
      { ingestCostConfirmationThresholdUsd: -1 },
      { ingestCostConfirmationThresholdUsd: '2' },
      {},
    ]) {
      expect((await call('org-1', body)).status).toBe(400)
    }
    expect(setIngestCostConfirmationThreshold).not.toHaveBeenCalled()
  })

  it('maps an unknown organization from the service to a 404', async () => {
    setIngestCostConfirmationThreshold.mockRejectedValue(new NotFoundError('Organization not found'))

    expect((await call('org-typo', { ingestCostConfirmationThresholdUsd: 2 })).status).toBe(404)
  })
})
