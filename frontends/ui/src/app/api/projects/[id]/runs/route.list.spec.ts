/**
 * @vitest-environment node
 */
/**
 * `GET /api/projects/[id]/runs` — a project's task runs, one keyset page at a
 * time (ADR-0131). It absorbed one task's run history (`/jobs/[jobId]/runs`,
 * `?limit&offset`): the task is now the `taskId` filter, and a page continues
 * by `cursor`, never by offset.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    email: 'p@grid.test',
    role: 'admin',
  }),
}))

vi.mock('@/lib/authz/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authz/feature-flags')>()),
  requireSkillsEnabled: vi.fn().mockReturnValue(null),
  requireTaskAutomationEnabled: vi.fn().mockReturnValue(null),
}))

vi.mock('@/lib/tasks/service', () => ({
  listTaskRunViews: vi.fn(),
}))

import { requireTaskAutomationEnabled } from '@/lib/authz/feature-flags'
import { listTaskRunViews } from '@/lib/tasks/service'
import { GET } from './route'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const TASK = '22222222-2222-4222-8222-222222222222'

const get = (query = '') =>
  GET(new NextRequest(`https://grid.test/api/projects/${PROJECT}/runs${query}`), {
    params: Promise.resolve({ id: PROJECT }),
  })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listTaskRunViews).mockResolvedValue({ runs: [], nextCursor: null })
})

describe('GET /api/projects/[id]/runs', () => {
  it('answers { runs, nextCursor } with the default page of 50', async () => {
    const response = await get()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ runs: [], nextCursor: null })
    expect(listTaskRunViews).toHaveBeenCalledWith(expect.anything(), PROJECT, { limit: 50 })
  })

  it('passes the task, status, review filters and the cursor through, parsed', async () => {
    await get(`?taskId=${TASK}&status=failed&review=none&limit=25&cursor=abc`)

    expect(listTaskRunViews).toHaveBeenCalledWith(expect.anything(), PROJECT, {
      limit: 25,
      cursor: 'abc',
      taskId: TASK,
      status: 'failed',
      review: 'none',
    })
  })

  it('refuses a status outside the run vocabulary, a limit past the ceiling and an offset-era id', async () => {
    expect((await get('?status=submitted')).status).toBe(400)
    expect((await get('?limit=500')).status).toBe(400)
    expect((await get('?taskId=not-a-uuid')).status).toBe(400)
    expect(listTaskRunViews).not.toHaveBeenCalled()
  })

  it('reads one task’s history without the task-automation gate, as the schedule drawer always did', async () => {
    vi.mocked(requireTaskAutomationEnabled).mockReturnValue(
      Response.json({ error: 'feature-disabled' }, { status: 403 }),
    )

    expect((await get(`?taskId=${TASK}`)).status).toBe(200)
    expect((await get()).status).toBe(403)
  })
})
