/**
 * @vitest-environment node
 *
 * Creating a project that Piloti sets up (ADR-0111): the intake row and the
 * address facts are written after the FGA grant and inside the compensating
 * delete, and a closing given with it is kept as an intent, not carried out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))

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

const startProjectIntake = vi.fn()
vi.mock('./intake-seed', () => ({ startProjectIntake: (...args: unknown[]) => startProjectIntake(...args) }))

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

import type { AuthorizedSession } from '@/lib/auth/types'
import type { GeocodeResult } from '@/lib/geocoding/types'
import { makeProject } from '@/test-utils/db-fixtures'
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

const location: GeocodeResult = {
  label: 'Hauptstraße 12, 1010 Wien',
  lat: 48.2,
  lon: 16.37,
  country: 'at',
  federalState: 'vienna',
  state: 'Wien',
  municipality: 'Wien',
  postcode: '1010',
  kind: 'address',
}

describe('createProject, set up by Piloti', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000001' })
    insertProject.mockResolvedValue(makeProject({ id: 'p1', name: 'Aufstockung Hauptstraße' }))
    createResource.mockResolvedValue({ id: 'res_1' })
    assignRole.mockResolvedValue(undefined)
    deleteProjectRow.mockResolvedValue(undefined)
    startProjectIntake.mockResolvedValue(undefined)
  })

  it('writes the intake after the creator holds the project, with the description and the location', async () => {
    const project = await createProject(
      session,
      { name: 'Aufstockung Hauptstraße', setup: 'piloti', description: 'Aufstockung um zwei Geschoße', location },
      undefined,
      NOW
    )

    expect(startProjectIntake).toHaveBeenCalledTimes(1)
    expect(startProjectIntake).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ id: 'p1' }),
      { description: 'Aufstockung um zwei Geschoße', location, federalState: undefined, closing: undefined },
      NOW
    )
    expect(assignRole.mock.invocationCallOrder[0]).toBeLessThan(startProjectIntake.mock.invocationCallOrder[0])
    expect(setProjectStatusInOrg).not.toHaveBeenCalled()
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'project.created', metadata: { name: 'Aufstockung Hauptstraße', setup: 'piloti' } })
    )
    expect(project.id).toBe('p1')
  })

  it('stores a closing as the intake intent and does not close the project, but keeps its start', async () => {
    await createProject(
      session,
      { name: 'Schule Nord', setup: 'piloti', closing: { outcome: 'completed', startedOn: '2019-03', endedOn: '2022-08' } },
      undefined,
      NOW
    )

    expect(startProjectIntake).toHaveBeenCalledWith(
      session,
      expect.anything(),
      expect.objectContaining({ closing: { outcome: 'completed', startedOn: '2019-03', endedOn: '2022-08' } }),
      NOW
    )
    expect(setProjectStatusInOrg).not.toHaveBeenCalled()
    expect(insertProject).toHaveBeenCalledWith(expect.objectContaining({ startedOn: '2019-03-01' }))
    // Not closed yet, so nothing says it was.
    expect(recordAuditEvent.mock.calls.map(([event]) => (event as { action: string }).action)).toEqual(['project.created'])
  })

  it('still refuses a closing in the future before writing anything', async () => {
    await expect(
      createProject(
        session,
        { name: 'X', setup: 'piloti', closing: { outcome: 'completed', startedOn: null, endedOn: '2026-11' } },
        undefined,
        NOW
      )
    ).rejects.toMatchObject({ status: 400, details: { reason: 'abschluss-in-future' } })
    expect(insertProject).not.toHaveBeenCalled()
  })

  it('rolls the row back, and audits nothing, when the intake write fails', async () => {
    startProjectIntake.mockRejectedValue(new Error('check violation'))

    await expect(createProject(session, { name: 'X', setup: 'piloti' }, undefined, NOW)).rejects.toThrow('check violation')

    expect(deleteProjectRow).toHaveBeenCalledWith('p1', 'org_1')
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('writes no intake when WorkOS fails, and rolls back', async () => {
    assignRole.mockRejectedValue(new Error('workos down'))

    await expect(createProject(session, { name: 'X', setup: 'piloti' }, undefined, NOW)).rejects.toThrow('workos down')

    expect(startProjectIntake).not.toHaveBeenCalled()
    expect(deleteProjectRow).toHaveBeenCalledWith('p1', 'org_1')
  })

  it('"self" is today: no intake row, no seed, the old audit metadata', async () => {
    await createProject(session, { name: 'Selbst', setup: 'self', description: 'ignored', location }, undefined, NOW)

    expect(startProjectIntake).not.toHaveBeenCalled()
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'project.created', metadata: { name: 'Selbst' } })
    )
  })

  it('"self" with a closing closes it at once, as ADR-0098 did', async () => {
    setProjectStatusInOrg.mockResolvedValue(makeProject({ id: 'p1', status: 'closed' }))

    await createProject(
      session,
      { name: 'Alt', setup: 'self', closing: { outcome: 'completed', startedOn: '2019-03', endedOn: '2022-08' } },
      undefined,
      NOW
    )

    expect(startProjectIntake).not.toHaveBeenCalled()
    expect(insertProject).toHaveBeenCalledWith(expect.objectContaining({ startedOn: '2019-03-01' }))
    expect(setProjectStatusInOrg).toHaveBeenCalledTimes(1)
  })
})
