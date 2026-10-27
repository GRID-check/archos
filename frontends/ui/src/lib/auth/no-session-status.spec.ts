/**
 * @vitest-environment node
 *
 * What a request with no session, or with no organization, is answered.
 *
 * The session guards threw plain `Error`s, and every caller classified them by
 * message: the route wrapper answered `403 { error: 'Forbidden' }`, the proxies
 * `403 FORBIDDEN`. They are typed now (`SessionRequiredError`,
 * `NoOrganizationError`), and these answers are the contract the typing must
 * keep. HTTP would say 401 for no session; that switch is its own decision.
 *
 * Only AuthKit is mocked: the guards, the route wrapper and the proxy run for
 * real, so a guard that stopped being recognised would surface here as a 500.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const withAuth = vi.hoisted(() => vi.fn())
vi.mock('@workos-inc/authkit-nextjs', () => ({
  withAuth,
  getTokenClaims: vi.fn(async () => ({})),
}))
vi.mock('@/lib/authz/project-membership', () => ({ lookupSubjectMembership: vi.fn(async () => null) }))

import { apiRoute } from '@/lib/api/handler'
import { GET as jobsProxyGet } from '@/app/api/jobs/async/[...path]/route'

const route = apiRoute(async () => ({ ok: true }), { authz: { sessionOnly: true, why: 'spec' } })
const request = () => new Request('https://grid.example/api/spec')

const originalRequireAuth = process.env.REQUIRE_AUTH

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalRequireAuth === undefined) delete process.env.REQUIRE_AUTH
  else process.env.REQUIRE_AUTH = originalRequireAuth
})

describe('a route behind apiRoute', () => {
  it('answers a request with no session 403 Forbidden, as before', async () => {
    withAuth.mockResolvedValue({ user: null, accessToken: null })

    const res = await route(request())

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ error: 'Forbidden', code: 'FORBIDDEN' })
  })

  it('answers a session with no organization 403 Forbidden, as before', async () => {
    withAuth.mockResolvedValue({
      user: { id: 'user-1', email: 'a@b.example', firstName: 'A', lastName: 'B' },
      accessToken: 'token',
      organizationId: undefined,
    })

    const res = await route(request())

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ error: 'Forbidden', code: 'FORBIDDEN' })
  })
})

describe('the jobs proxy', () => {
  it('answers a request with no session 403 FORBIDDEN, as before', async () => {
    process.env.REQUIRE_AUTH = 'true'
    withAuth.mockResolvedValue({ user: null, accessToken: null })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await jobsProxyGet(new Request('https://grid.example/api/jobs/async/job/job-1'), {
      params: Promise.resolve({ path: ['job', 'job-1'] }),
    })

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
