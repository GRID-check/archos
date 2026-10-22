/**
 * @vitest-environment node
 */
/**
 * Follow and unfollow: the route parses the body or the query with the wire's
 * schema and hands it to the service, which authorizes and decides.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ForbiddenError } from '@/lib/api/errors'

const session = {
  userId: 'user_01JCX0R4D8M2W6YB3N5Q7T9V1A',
  organizationId: 'org_1',
  email: 'lena@example.test',
  role: 'member',
  permissions: [] as string[],
}

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockImplementation(async () => session),
  authzErrorResponse: vi.fn().mockReturnValue(null),
}))

vi.mock('@/lib/mail-thread/follows', () => ({ followMailThread: vi.fn(), unfollowMailThread: vi.fn() }))

import { followMailThread, unfollowMailThread } from '@/lib/mail-thread/follows'
import { DELETE, POST } from './route'

const PROJECT = '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const THREAD = '4e5f6a7b-8c9d-4e0f-8a1b-2c3d4e5f6a7b'
const params = { params: Promise.resolve({ id: PROJECT, threadId: THREAD }) }
const post = (body?: string) =>
  POST(
    new Request('http://localhost/x', {
      method: 'POST',
      ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
    }),
    params,
  )
const follow = {
  id: 'f-1',
  userId: session.userId,
  createdAt: '2026-10-22T08:00:00.000Z',
  expiresAt: '2026-12-21T08:00:00.000Z',
  renewedAt: null,
  dailyCap: 20,
}

describe('/api/projects/[id]/mail-threads/[threadId]/follow', () => {
  beforeEach(() => vi.clearAllMocks())

  it('POST follows for the days asked, and answers the follow', async () => {
    vi.mocked(followMailThread).mockResolvedValueOnce({ follow, renewed: false })
    const res = await post(JSON.stringify({ days: 30 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ follow, renewed: false })
    expect(followMailThread).toHaveBeenCalledWith(session, PROJECT, THREAD, { days: 30 })
  })

  it('POST without a body follows for the default', async () => {
    vi.mocked(followMailThread).mockResolvedValueOnce({ follow, renewed: true })
    expect((await post()).status).toBe(200)
    expect(followMailThread).toHaveBeenCalledWith(session, PROJECT, THREAD, {})
  })

  it('POST refuses more than 180 days, or a key the wire does not know, before the service runs', async () => {
    expect((await post(JSON.stringify({ days: 181 }))).status).toBe(400)
    expect((await post(JSON.stringify({ days: 30, dailyCap: 50 }))).status).toBe(400)
    expect(followMailThread).not.toHaveBeenCalled()
  })

  it('DELETE ends the caller’s follow, or the one `userId` names', async () => {
    vi.mocked(unfollowMailThread).mockResolvedValue({ endedFollowId: 'f-1' })
    const own = await DELETE(new Request('http://localhost/x', { method: 'DELETE' }), params)
    expect(await own.json()).toEqual({ endedFollowId: 'f-1' })
    expect(unfollowMailThread).toHaveBeenLastCalledWith(session, PROJECT, THREAD, {})
    await DELETE(new Request('http://localhost/x?userId=user_01JCX0R4D8M2W6YB3N5Q7T9V2B', { method: 'DELETE' }), params)
    expect(unfollowMailThread).toHaveBeenLastCalledWith(session, PROJECT, THREAD, { userId: 'user_01JCX0R4D8M2W6YB3N5Q7T9V2B' })
  })

  it('DELETE answers the service’s refusal', async () => {
    vi.mocked(unfollowMailThread).mockRejectedValueOnce(new ForbiddenError('needs project:manage'))
    const res = await DELETE(new Request('http://localhost/x?userId=someone', { method: 'DELETE' }), params)
    expect(res.status).toBe(403)
  })
})
