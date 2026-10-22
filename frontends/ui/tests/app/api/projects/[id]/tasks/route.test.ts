/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/jobs/service', () => ({
  listJobs: vi.fn(),
  createJob: vi.fn(),
}))

import { GET, POST } from '@/app/api/projects/[id]/tasks/route'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { listJobs, createJob } from '@/lib/jobs/service'
import type { AuthorizedSession } from '@/lib/auth/types'
// The type the MOCKED service returns, not a table row: this helper stands in
// for `listJobs`/`createJob` output.
import type { TaskView } from '@/lib/tasks/task-wire'

const mockSession = vi.mocked(requireAuthorizedSession)
const mockList = vi.mocked(listJobs)
const mockCreate = vi.mocked(createJob)

const asJob = (row: Pick<TaskView, 'id' | 'name'>): TaskView => row as unknown as TaskView

const session: Omit<AuthorizedSession, 'featureFlags'> & { featureFlags: string[] | null } = {
  userId: 'user_1',
  email: 'user@example.com',
  name: null,
  accessToken: 'tok',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

/** A job is a name and a prompt. Nothing else is required. */
const validBody = { name: 'Weekly', prompt: 'Fasse die Woche zusammen.' }

function req(body?: unknown): Request {
  return new Request('http://localhost/api/projects/proj_1/tasks', {
    method: body ? 'POST' : 'GET',
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // A signed-in deployment: the session's WorkOS claim is the skills gate, and
  // a session without the claim is the default (off).
  vi.stubEnv('REQUIRE_AUTH', 'true')
  session.featureFlags = null
  mockSession.mockResolvedValue(session as unknown as AuthorizedSession)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/projects/[id]/tasks', () => {
  it('returns 403 feature-disabled when the gate is off (default)', async () => {
    const res = await GET(req(), makeParams('proj_1'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'feature-disabled', feature: 'skills' })
    expect(mockList).not.toHaveBeenCalled()
  })

  it('lists tasks as a page when the skills flag is on', async () => {
    session.featureFlags = ['skills']
    mockList.mockResolvedValue({ tasks: [asJob({ id: 'job-1', name: 'Weekly' })], nextCursor: null })
    const res = await GET(req(), makeParams('proj_1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tasks: [{ id: 'job-1', name: 'Weekly' }], nextCursor: null })
    expect(mockList).toHaveBeenCalledWith(session, 'proj_1', { limit: 50 })
  })
})

describe('POST /api/projects/[id]/tasks', () => {
  it('returns 403 feature-disabled when off, before validating the body', async () => {
    const res = await POST(req(validBody), makeParams('proj_1'))
    expect(res.status).toBe(403)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when the prompt is missing', async () => {
    session.featureFlags = ['skills']
    const res = await POST(req({ name: 'no prompt' }), makeParams('proj_1'))
    expect(res.status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  // The body no longer carries an output kind at all: a task is always a
  // research run that files a report, so the service writes that itself. A
  // caller that still sends one is not refused — the field is dropped, which is
  // what keeps a stale client from 400ing on a question nobody asks any more.
  it('drops an output kind the caller still sends, rather than refusing it', async () => {
    session.featureFlags = ['skills']
    mockCreate.mockResolvedValue(asJob({ id: 'job-new', name: 'Weekly' }))
    const res = await POST(req({ ...validBody, output: 'report' }), makeParams('proj_1'))
    expect(res.status).toBe(201)
    expect(mockCreate.mock.calls[0][2]).not.toHaveProperty('output')
  })

  it('creates a skill-less job (201) on a valid body', async () => {
    session.featureFlags = ['skills']
    mockCreate.mockResolvedValue(asJob({ id: 'job-new', name: 'Weekly' }))
    const res = await POST(req(validBody), makeParams('proj_1'))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ task: { id: 'job-new', name: 'Weekly' } })
    expect(mockCreate).toHaveBeenCalledWith(
      session,
      'proj_1',
      expect.objectContaining({ name: 'Weekly', prompt: 'Fasse die Woche zusammen.' })
    )
  })

  it('passes an attached skill through when one is named', async () => {
    session.featureFlags = ['skills']
    mockCreate.mockResolvedValue(asJob({ id: 'job-new', name: 'Weekly' }))
    await POST(req({ ...validBody, skillName: 'data-table-analysis' }), makeParams('proj_1'))
    expect(mockCreate).toHaveBeenCalledWith(
      session,
      'proj_1',
      expect.objectContaining({ skillName: 'data-table-analysis' })
    )
  })
})
