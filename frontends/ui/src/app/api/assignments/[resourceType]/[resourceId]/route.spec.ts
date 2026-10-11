/**
 * @vitest-environment node
 */
/**
 * GET used to hand the request's id straight to the batch helper, which checks
 * no access, while its `authz` declaration said it did. It now goes through the
 * guarded single-resource read, and a refusal is the same 404 as a missing id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'test@grid.com',
    permissions: [],
  }),
}))

vi.mock('@/lib/authz/feature-flags', () => ({
  requireCollaborationEnabled: vi.fn(() => null),
}))

vi.mock('@/lib/assignments/service', () => ({
  listResourceAssignments: vi.fn(),
  addResourceAssignment: vi.fn(),
  removeResourceAssignment: vi.fn(),
}))

const captureServer = vi.hoisted(() => vi.fn(() => true))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer }))

import { NotFoundError } from '@/lib/api/errors'
import { addResourceAssignment, listResourceAssignments } from '@/lib/assignments/service'
import { GET, POST } from './route'

const get = (resourceType: string, resourceId: string) =>
  GET(new Request(`https://grid.test/api/assignments/${resourceType}/${resourceId}`), {
    params: Promise.resolve({ resourceType, resourceId }),
  })

describe('GET /api/assignments/[resourceType]/[resourceId]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads through the access-checked service call, for the one id in the path', async () => {
    vi.mocked(listResourceAssignments).mockResolvedValue([])

    const response = await get('document', 'doc-1')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ assignees: [] })
    expect(listResourceAssignments).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      'document',
      'doc-1'
    )
  })

  it('answers 404 when the caller cannot reach the resource', async () => {
    vi.mocked(listResourceAssignments).mockRejectedValue(new NotFoundError())

    const response = await get('conversation', 's_private')

    expect(response.status).toBe(404)
  })
})

describe('POST /api/assignments/[resourceType]/[resourceId]', () => {
  beforeEach(() => vi.clearAllMocks())

  const post = (resourceType: string, resourceId: string) =>
    POST(
      new Request(`https://grid.test/api/assignments/${resourceType}/${resourceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user-2' }),
      }),
      { params: Promise.resolve({ resourceType, resourceId }) }
    )

  it('reports task_assigned as the assigner, with the resource type and not the assignee', async () => {
    vi.mocked(addResourceAssignment).mockResolvedValue([])

    const response = await post('document', 'doc-1')

    expect(response.status).toBe(200)
    expect(captureServer).toHaveBeenCalledWith({
      event: 'task_assigned',
      distinctId: 'user-1',
      organizationId: 'org-1',
      properties: { resource_type: 'document' },
    })
    expect(JSON.stringify(captureServer.mock.calls)).not.toContain('user-2')
  })

  it('reports nothing when the assignment is refused', async () => {
    vi.mocked(addResourceAssignment).mockRejectedValue(new NotFoundError())

    const response = await post('document', 'doc-1')

    expect(response.status).toBe(404)
    expect(captureServer).not.toHaveBeenCalled()
  })
})
