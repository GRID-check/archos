/**
 * @vitest-environment node
 */
/**
 * The geometry route: no session, no call; the body is parsed with the wire schema before the
 * service (which holds the model's document read gate) is asked; the service's refusal is the answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const requireAuthorizedSession = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: () => requireAuthorizedSession() }))
vi.mock('server-only', () => ({}))
const geometryForAccessibleModel = vi.fn()
vi.mock('@/lib/bim/geometry-service', () => ({
  geometryForAccessibleModel: (...args: unknown[]) => geometryForAccessibleModel(...args),
}))

import { ApiError, SessionRequiredError } from '@/lib/api/errors'
import { createInProcessStore, setLimitStore } from '@/lib/limits'
import { POST } from './route'

const MODEL_ID = '11111111-2222-3333-4444-555555555555'
const GID = '2O2Fr$t4X7Zf8NOew3FLOH'
const session = { userId: 'user_me', organizationId: 'org_1', organizationMembershipId: 'om_1', role: 'member', permissions: [] }

function post(body: unknown) {
  return POST(
    new Request(`https://app.test/api/bim/models/${MODEL_ID}/geometry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ modelId: MODEL_ID }) }
  )
}

beforeEach(() => {
  setLimitStore(createInProcessStore())
  requireAuthorizedSession.mockReset().mockResolvedValue(session)
  geometryForAccessibleModel.mockReset().mockResolvedValue({ op: 'boxes', result: {}, meta: {} })
})

afterEach(() => setLimitStore(null))

describe('POST /api/bim/models/[modelId]/geometry', () => {
  it('refuses without a session and asks nothing', async () => {
    requireAuthorizedSession.mockRejectedValue(new SessionRequiredError())
    expect((await post({ op: 'warm' })).status).toBe(403)
    expect(geometryForAccessibleModel).not.toHaveBeenCalled()
  })

  it('hands the parsed operation to the service with the session and the model id', async () => {
    expect((await post({ op: 'boxes', globalIds: [GID] })).status).toBe(200)
    expect(geometryForAccessibleModel).toHaveBeenCalledWith(session, MODEL_ID, { op: 'boxes', globalIds: [GID] })
  })

  it('refuses a body past the wire’s limits with 400', async () => {
    expect((await post({ op: 'near', globalId: GID, radius: 500 })).status).toBe(400)
    expect(geometryForAccessibleModel).not.toHaveBeenCalled()
  })

  it('answers the service’s 409 with its code and retry hint', async () => {
    geometryForAccessibleModel.mockRejectedValue(new ApiError(409, 'geometry_warming', 'warming', { retryAfter: 10 }))
    const response = await post({ op: 'warm' })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'geometry_warming', details: { retryAfter: 10 } })
  })
})
