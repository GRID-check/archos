/**
 * @vitest-environment node
 */
import { SessionRequiredError } from '@/lib/api/errors'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = { userId: 'user-1', organizationId: 'org-1', email: 'm@grid.com', role: 'member', permissions: [] as string[] }
const requireAuthorizedSession = vi.fn(async () => session)
vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: () => requireAuthorizedSession() }))

const getChatUsageNotice = vi.fn()
vi.mock('@/lib/budgets/service', () => ({ getChatUsageNotice: (...args: unknown[]) => getChatUsageNotice(...args) }))

import { GET } from './route'

const request = (query = ''): Request => new Request(`http://localhost/api/organization/usage/notice${query}`)

describe('GET /api/organization/usage/notice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireAuthorizedSession.mockImplementation(async () => session)
  })

  it('refuses an unauthenticated caller before reading any budget', async () => {
    requireAuthorizedSession.mockRejectedValueOnce(new SessionRequiredError())
    expect((await GET(request())).status).toBe(403)
    expect(getChatUsageNotice).not.toHaveBeenCalled()
  })

  it('wraps the notice, forwarding the project', async () => {
    getChatUsageNotice.mockResolvedValue({ level: 'warning' })
    const res = await GET(request('?projectId=proj-9'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ notice: { level: 'warning' } })
    expect(getChatUsageNotice).toHaveBeenCalledWith(session, { projectId: 'proj-9' })
  })

  it('answers null when nothing is worth saying', async () => {
    getChatUsageNotice.mockResolvedValue(null)
    expect(await (await GET(request())).json()).toEqual({ notice: null })
  })
})
