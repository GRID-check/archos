/**
 * @vitest-environment node
 *
 * Creating a project (ADR-0098): an active one as before, and a past one
 * created directly as closed, the office's reference. The closing is checked
 * before anything is written, the close is the repository write (FGA may not
 * know the fresh grant yet), both moves are audited, and a close that fails
 * leaves no half-created project behind.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const requireProjectAccess = vi.fn()
vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: (...args: unknown[]) => requireProjectAccess(...args),
}))

const insertProject = vi.fn()
const setProjectWorkosResourceId = vi.fn()
const setProjectStatusInOrg = vi.fn()
const deleteProjectRow = vi.fn()
vi.mock('./repository', () => ({
  insertProject: (...args: unknown[]) => insertProject(...args),
  setProjectWorkosResourceId: (...args: unknown[]) => setProjectWorkosResourceId(...args),
  setProjectStatusInOrg: (...args: unknown[]) => setProjectStatusInOrg(...args),
  deleteProjectRow: (...args: unknown[]) => deleteProjectRow(...args),
}))

const createResource = vi.fn()
const assignRole = vi.fn()
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({ authorization: { createResource, assignRole } }),
}))

const recordAuditEvent = vi.fn()
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args) }))
vi.mock('@/lib/tasks/repository', () => ({ rearmOneShotsSkippedWhileParked: vi.fn() }))
vi.mock('@/lib/collaboration/cleanup', () => ({ neutralizeCollaborationForProject: vi.fn() }))
vi.mock('@/lib/conversations/repository', () => ({
  lastProjectActivityByUser: vi.fn(),
  listConversationIdsForProject: vi.fn(),
}))
vi.mock('@/lib/documents/repository', () => ({ countDocumentsByProject: vi.fn() }))
vi.mock('@/lib/authz/folder-access', () => ({}))
vi.mock('./overview-query', () => ({ getProjectOverviewData: vi.fn() }))
vi.mock('./memory-service', () => ({}))

import { makeProject } from '@/test-utils/db-fixtures'
import type { AuthorizedSession } from '@/lib/auth/types'
import { createProject } from './service'

const session: AuthorizedSession = {
  userId: 'user_pl',
  email: 'pl@buero.at',
  name: 'PL',
  accessToken: 'token',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

const NOW = new Date('2026-10-06T18:00:00Z')

describe('createProject', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000001' })
    insertProject.mockResolvedValue(makeProject({ id: 'p1', name: 'Volksschule Aspern' }))
    createResource.mockResolvedValue({ id: 'res_1' })
    assignRole.mockResolvedValue(undefined)
    deleteProjectRow.mockResolvedValue(undefined)
  })

  it('creates an active project as before: no Beginn, no close, one audit event', async () => {
    const project = await createProject(session, { name: 'Volksschule Aspern' }, undefined, NOW)

    expect(insertProject).toHaveBeenCalledWith({
      organizationId: 'org_1',
      name: 'Volksschule Aspern',
      createdBy: 'user_pl',
      collectionName: expect.stringMatching(/^proj_/),
    })
    expect(assignRole).toHaveBeenCalledWith(expect.objectContaining({ resourceExternalId: 'p1', roleSlug: 'project-admin' }))
    expect(setProjectStatusInOrg).not.toHaveBeenCalled()
    expect(recordAuditEvent).toHaveBeenCalledTimes(1)
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'project.created', targetId: 'p1', metadata: { name: 'Volksschule Aspern' } })
    )
    expect(project.id).toBe('p1')
  })

  it('creates a past project closed: Beginn on insert, then closed with outcome and Abschluss, audited twice', async () => {
    const closed = makeProject({
      id: 'p1',
      name: 'Volksschule Aspern',
      status: 'closed',
      closedAt: NOW,
      closedBy: 'user_pl',
      closedOutcome: 'completed',
      startedOn: '2019-03-01',
      endedOn: '2022-08-01',
    })
    setProjectStatusInOrg.mockResolvedValue(closed)

    const project = await createProject(
      session,
      { name: 'Volksschule Aspern', closing: { outcome: 'completed', startedOn: '2019-03', endedOn: '2022-08' } },
      undefined,
      NOW
    )

    expect(insertProject).toHaveBeenCalledWith(expect.objectContaining({ startedOn: '2019-03-01' }))
    // The repository write, not setProjectStatus: no FGA check right after the grant.
    expect(requireProjectAccess).not.toHaveBeenCalled()
    expect(setProjectStatusInOrg).toHaveBeenCalledWith('p1', 'org_1', 'active', {
      status: 'closed',
      at: NOW,
      closedBy: 'user_pl',
      outcome: 'completed',
      endedOn: '2022-08-01',
    })
    // Closed only once the creator holds the project.
    expect(assignRole.mock.invocationCallOrder[0]).toBeLessThan(setProjectStatusInOrg.mock.invocationCallOrder[0])
    expect(recordAuditEvent.mock.calls.map(([event]) => (event as { action: string }).action)).toEqual([
      'project.created',
      'project.closed',
    ])
    expect(recordAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'project.closed',
        targetId: 'p1',
        metadata: { name: 'Volksschule Aspern', from: 'active', outcome: 'completed', endedOn: '2022-08' },
      })
    )
    expect(project).toBe(closed)
    expect(deleteProjectRow).not.toHaveBeenCalled()
  })

  it('creates a closed project with no Beginn, and one that was not realized says so', async () => {
    setProjectStatusInOrg.mockResolvedValue(makeProject({ id: 'p1', status: 'closed', closedOutcome: 'cancelled' }))

    await createProject(session, { name: 'Wettbewerb', closing: { outcome: 'cancelled', startedOn: null, endedOn: '2026-10' } }, undefined, NOW)

    expect(insertProject).toHaveBeenCalledWith(expect.not.objectContaining({ startedOn: expect.anything() }))
    expect(setProjectStatusInOrg).toHaveBeenCalledWith('p1', 'org_1', 'active', expect.objectContaining({ outcome: 'cancelled', endedOn: '2026-10-01' }))
  })

  it.each([
    ['in the future', '2019-03', '2026-11', 'abschluss-in-future'],
    ['before the Beginn', '2019-03', '2019-02', 'abschluss-before-beginn'],
    ['that is no month', null, '2026-13', 'invalid-month'],
    ['with a Beginn that is no month', '2019-3', '2022-08', 'invalid-month'],
  ])('refuses an Abschluss %s with a 400, before anything is written', async (_, startedOn, endedOn, reason) => {
    await expect(
      createProject(
        session,
        { name: 'X', closing: { outcome: 'completed', startedOn: startedOn as '2019-03' | null, endedOn: endedOn as '2026-11' } },
        undefined,
        NOW
      )
    ).rejects.toMatchObject({ status: 400, details: { reason } })
    expect(insertProject).not.toHaveBeenCalled()
    expect(createResource).not.toHaveBeenCalled()
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('accepts an Abschluss in the Beginn\'s month when the Beginn lies ahead, as a close does', async () => {
    setProjectStatusInOrg.mockResolvedValue(makeProject({ id: 'p1', status: 'closed' }))
    await createProject(session, { name: 'X', closing: { outcome: 'cancelled', startedOn: '2027-03', endedOn: '2027-03' } }, undefined, NOW)
    expect(setProjectStatusInOrg).toHaveBeenCalledWith('p1', 'org_1', 'active', expect.objectContaining({ endedOn: '2027-03-01' }))
  })

  it.each([
    ['changes nothing', () => setProjectStatusInOrg.mockResolvedValue(null)],
    ['throws', () => setProjectStatusInOrg.mockRejectedValue(new Error('check violation'))],
  ])('rolls the row back when the close write %s, and audits nothing', async (_, arrange) => {
    arrange()

    await expect(
      createProject(session, { name: 'X', closing: { outcome: 'completed', startedOn: null, endedOn: '2022-08' } }, undefined, NOW)
    ).rejects.toThrow()

    expect(deleteProjectRow).toHaveBeenCalledWith('p1', 'org_1')
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('rolls the row back when WorkOS fails, before any close is tried', async () => {
    assignRole.mockRejectedValue(new Error('workos down'))

    await expect(
      createProject(session, { name: 'X', closing: { outcome: 'completed', startedOn: null, endedOn: '2022-08' } }, undefined, NOW)
    ).rejects.toThrow('workos down')

    expect(setProjectStatusInOrg).not.toHaveBeenCalled()
    expect(deleteProjectRow).toHaveBeenCalledWith('p1', 'org_1')
  })
})
