/**
 * @vitest-environment node
 */
/**
 * The lifecycle route's body (ADR-0098): exactly one shape per move, nothing
 * extra. A close names its outcome and a month; a pause or resume names
 * nothing else, so a stray `endedOn` or `outcome` is refused rather than
 * silently dropped. And the answer carries how it ended only once closed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    email: 'p@example.test',
    role: 'member',
    permissions: [],
  }),
}))

vi.mock('@/lib/projects/service', () => ({ setProjectStatus: vi.fn() }))

import { setProjectStatus } from '@/lib/projects/service'
import { makeProject } from '@/test-utils/db-fixtures'
import { PUT } from './route'

const PROJECT = '11111111-1111-4111-8111-111111111111'

const put = (body: unknown) =>
  PUT(
    new NextRequest(`https://grid.test/api/projects/${PROJECT}/status`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: PROJECT }) }
  )

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(setProjectStatus).mockResolvedValue(makeProject({ id: PROJECT }))
})

describe('PUT /api/projects/[id]/status', () => {
  it.each([
    ['a close without an outcome', { status: 'closed', endedOn: '2026-09' }],
    ['a close without a month', { status: 'closed', outcome: 'completed' }],
    ['a close with a day for a month', { status: 'closed', outcome: 'completed', endedOn: '2026-09-15' }],
    ['an unknown outcome', { status: 'closed', outcome: 'abandoned', endedOn: '2026-09' }],
    ['a pause carrying a month', { status: 'paused', endedOn: '2026-09' }],
    ['a resume carrying an outcome', { status: 'active', outcome: 'completed' }],
    ['an unknown state', { status: 'archived' }],
  ])('refuses %s with a 400, and moves nothing', async (_, body) => {
    const response = await put(body)
    expect(response.status).toBe(400)
    expect(setProjectStatus).not.toHaveBeenCalled()
  })

  it('hands a well-formed close to the service, and answers how and when it ended', async () => {
    vi.mocked(setProjectStatus).mockResolvedValue(
      makeProject({
        id: PROJECT,
        status: 'closed',
        closedAt: new Date('2026-10-06T10:00:00Z'),
        closedBy: 'user_1',
        closedOutcome: 'cancelled',
        endedOn: '2026-09-01',
      })
    )
    const response = await put({ status: 'closed', outcome: 'cancelled', endedOn: '2026-09' })

    expect(response.status).toBe(200)
    expect(vi.mocked(setProjectStatus).mock.calls[0][2]).toEqual({ status: 'closed', outcome: 'cancelled', endedOn: '2026-09' })
    expect(await response.json()).toMatchObject({ status: 'closed', closedOutcome: 'cancelled', endedOn: '2026-09' })
  })

  it('answers no outcome and no Abschluss for a project that runs, whatever a reopen kept', async () => {
    vi.mocked(setProjectStatus).mockResolvedValue(
      makeProject({ id: PROJECT, status: 'active', closedOutcome: 'completed', endedOn: '2025-06-01' })
    )
    const response = await put({ status: 'active' })
    expect(await response.json()).toMatchObject({ status: 'active', closedOutcome: null, endedOn: null })
  })
})
