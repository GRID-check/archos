/**
 * @vitest-environment node
 *
 * The Steckbrief service (ADR-0091): who may read, change and erase, that an
 * account link must name a member, that the audit trail never names a person,
 * and that it fills itself: the Beginn from the creation month, the members
 * from the roster, and a departing member kept as a former one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const requireProjectAccess = vi.fn()
vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: (...args: unknown[]) => requireProjectAccess(...args),
}))
const isUserInOrganization = vi.fn()
vi.mock('@/lib/authz/project-membership', () => ({
  isUserInOrganization: (...args: unknown[]) => isUserInOrganization(...args),
}))
const recordAuditEvent = vi.fn()
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args) }))
vi.mock('@/lib/sharing/directory', () => ({
  loadOrganizationDirectory: vi.fn(async () => new Map([['user_anna', { userId: 'user_anna', name: 'Anna Weber', email: 'a@b.at' }]])),
}))
vi.mock('./repository', () => ({
  findProjectProfile: vi.fn(async () => ({
    facts: { standort_adresse: { value: 'Seestadtstraße 12, 1220 Wien' } },
    goals: {},
    unknowns: [],
    assumptions: {},
  })),
}))
const loadProjectTeam = vi.fn()
vi.mock('./project-team', () => ({ loadProjectTeam: (...args: unknown[]) => loadProjectTeam(...args) }))
const repo = vi.hoisted(() => ({
  findProjectPersonByUser: vi.fn(),
  findProjectPeriod: vi.fn(),
  updateProjectPeriod: vi.fn(),
  listProjectPeople: vi.fn(),
  insertProjectPerson: vi.fn(),
  updateProjectPersonRow: vi.fn(),
  deleteProjectPersonRow: vi.fn(),
}))
vi.mock('./project-record-repository', () => repo)

import { NotFoundError } from '@/lib/api/errors'
import { projectClosedError } from './project-status'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  addProjectPerson,
  deleteProjectPerson,
  getProjectRecord,
  recordMemberLeft,
  recordMemberRejoined,
  setProjectPeriod,
} from './project-record-service'
import { projectPeriodSchema, projectPersonSchema } from './project-record-types'

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

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'person-1',
  organizationId: 'org_1',
  projectId: 'p1',
  name: 'DI Maria Huber',
  function: 'Statik',
  company: 'Huber ZT GmbH',
  startedOn: '2023-03-01',
  endedOn: '2025-11-01',
  userId: null,
  createdBy: 'user_pl',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

const period = (overrides: Record<string, unknown>) => ({
  startedOn: '2023-03-01',
  endedOn: null,
  status: 'active',
  createdAt: new Date('2023-05-10T09:00:00Z'),
  ...overrides,
})

const access = (closed: boolean) => ({ role: 'project-editor', closed, readsBecauseClosed: false })

/** A project where the reader may do everything a closed or active project lets them. */
function allow(closed: boolean) {
  requireProjectAccess.mockImplementation(async (_s, _p, permission, options?: { evenWhenClosed?: boolean }) => {
    const asked = Array.isArray(permission) ? permission : [permission]
    if (closed && !options?.evenWhenClosed && !asked.includes('project:view')) throw projectClosedError()
    return access(closed)
  })
}

describe('the project record', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    repo.findProjectPeriod.mockResolvedValue(period({}))
    repo.listProjectPeople.mockResolvedValue([row(), row({ id: 'person-2', name: 'Anna Weber', userId: 'user_anna' })])
    loadProjectTeam.mockResolvedValue([{ userId: 'user_anna', name: 'Anna Weber', since: '2023-04' }])
    repo.findProjectPersonByUser.mockResolvedValue(null)
  })

  it('reads the address from the profile, the period as months, and the members first, merged with their row', async () => {
    allow(false)
    const view = await getProjectRecord(session, 'p1')
    expect(view).toMatchObject({
      address: 'Seestadtstraße 12, 1220 Wien',
      startedOn: '2023-03',
      startedOnIsDefault: false,
      endedOn: null,
      rosterKnown: true,
      canEdit: true,
      canErase: true,
    })
    expect(view.people.map((person) => [person.name, person.kind, person.id])).toEqual([
      ['Anna Weber', 'member', 'person-2'],
      ['DI Maria Huber', 'added', 'person-1'],
    ])
    expect(view.people[1]).toEqual({
      id: 'person-1',
      kind: 'added',
      userId: null,
      name: 'DI Maria Huber',
      function: 'Statik',
      company: 'Huber ZT GmbH',
      startedOn: '2023-03',
      endedOn: '2025-11',
    })
    // No e-mail anywhere in what the reader gets.
    expect(JSON.stringify(view)).not.toContain('a@b.at')
  })

  it('lists a member nobody described, from the month they joined; a row whose account left is a former member', async () => {
    allow(false)
    repo.listProjectPeople.mockResolvedValue([row({ id: 'person-3', name: 'Lukas Steiner', userId: 'user_gone' })])
    const view = await getProjectRecord(session, 'p1')
    expect(view.people).toEqual([
      { id: null, kind: 'member', userId: 'user_anna', name: 'Anna Weber', function: null, company: null, startedOn: '2023-04', endedOn: null },
      expect.objectContaining({ id: 'person-3', kind: 'former', userId: 'user_gone' }),
    ])
  })

  it('calls nobody former when the roster could not be read, and says so', async () => {
    allow(false)
    loadProjectTeam.mockResolvedValue(null)
    const view = await getProjectRecord(session, 'p1')
    expect(view.rosterKnown).toBe(false)
    expect(view.people.map((person) => [person.name, person.kind])).toEqual([
      ['Anna Weber', 'member'],
      ['DI Maria Huber', 'added'],
    ])
  })

  it('takes the month of creation as the start until someone sets one, but not after the closing', async () => {
    allow(false)
    repo.findProjectPeriod.mockResolvedValue(period({ startedOn: null }))
    expect(await getProjectRecord(session, 'p1')).toMatchObject({ startedOn: '2023-05', startedOnIsDefault: true })
    // A finished project brought into Piloti later: created long after it ended.
    repo.findProjectPeriod.mockResolvedValue(period({ startedOn: null, status: 'closed', endedOn: '2021-06-01' }))
    expect(await getProjectRecord(session, 'p1')).toMatchObject({ startedOn: null, startedOnIsDefault: false, endedOn: '2021-06' })
  })

  it('a closed project: read-only for the project record, but whoever manages it may still erase a person', async () => {
    allow(true)
    const view = await getProjectRecord(session, 'p1')
    expect(view).toMatchObject({ canEdit: false, canErase: true })

    await expect(setProjectPeriod(session, 'p1', { startedOn: '2023-03' })).rejects.toMatchObject({
      details: { reason: 'project-closed' },
    })
    await expect(
      addProjectPerson(session, 'p1', projectPersonSchema.parse({ name: 'X', function: null, company: null, startedOn: null, endedOn: null, userId: null }))
    ).rejects.toMatchObject({ details: { reason: 'project-closed' } })

    repo.deleteProjectPersonRow.mockResolvedValue(true)
    await deleteProjectPerson(session, 'p1', 'person-1')
    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'p1', 'project:manage', { evenWhenClosed: true })
    expect(repo.deleteProjectPersonRow).toHaveBeenCalledWith('p1', 'org_1', 'person-1')
  })

  it('in a closed project, someone who does not manage it erases nobody', async () => {
    requireProjectAccess.mockImplementation(async (_s, _p, permission) => {
      if (permission === 'project:view') return access(true)
      throw new NotFoundError()
    })
    await expect(deleteProjectPerson(session, 'p1', 'person-1')).rejects.toBeInstanceOf(NotFoundError)
    expect(repo.deleteProjectPersonRow).not.toHaveBeenCalled()
  })

  it('stores the start as the first of its month, and audits it; the closing is not the project record\'s to set (ADR-0098)', async () => {
    allow(false)
    repo.updateProjectPeriod.mockResolvedValue(period({}))
    await expect(setProjectPeriod(session, 'p1', { startedOn: '2023-03' })).resolves.toEqual({ startedOn: '2023-03' })
    expect(repo.updateProjectPeriod).toHaveBeenCalledWith('p1', 'org_1', '2023-03-01')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'project.period.changed', metadata: { startedOn: '2023-03' } })
    )
    expect(projectPeriodSchema.safeParse({ startedOn: '2023-03', endedOn: '2025-12' }).success).toBe(false)
  })

  it('shows a closing only on a closed project: a running one keeps a reopened month to itself', async () => {
    allow(false)
    repo.findProjectPeriod.mockResolvedValue(period({ endedOn: '2025-06-01' }))
    expect((await getProjectRecord(session, 'p1')).endedOn).toBeNull()
    repo.findProjectPeriod.mockResolvedValue(period({ endedOn: '2025-06-01', status: 'closed' }))
    expect((await getProjectRecord(session, 'p1')).endedOn).toBe('2025-06')
  })

  it('links an account only to a member of the organization', async () => {
    allow(false)
    isUserInOrganization.mockResolvedValue(false)
    const input = projectPersonSchema.parse({
      name: 'Anna Weber',
      function: 'Projektleitung',
      company: null,
      startedOn: '2023-03',
      endedOn: null,
      userId: 'user_foreign',
    })
    await expect(addProjectPerson(session, 'p1', input)).rejects.toMatchObject({ status: 400, details: { reason: 'unknown-account' } })
    expect(repo.insertProjectPerson).not.toHaveBeenCalled()
  })

  it('audits a person by id, never by name', async () => {
    allow(false)
    repo.insertProjectPerson.mockResolvedValue(row())
    await addProjectPerson(
      session,
      'p1',
      projectPersonSchema.parse({ name: 'DI Maria Huber', function: 'Statik', company: 'Huber ZT GmbH', startedOn: '2023-03', endedOn: '2025-11', userId: null })
    )
    repo.deleteProjectPersonRow.mockResolvedValue(true)
    await deleteProjectPerson(session, 'p1', 'person-1')

    expect(recordAuditEvent.mock.calls.map(([event]) => event.action)).toEqual(['project.person.added', 'project.person.deleted'])
    expect(JSON.stringify(recordAuditEvent.mock.calls)).not.toContain('Huber')
  })

  it('describing a member twice updates their one row', async () => {
    allow(false)
    isUserInOrganization.mockResolvedValue(true)
    repo.findProjectPersonByUser.mockResolvedValue(row({ id: 'person-2', userId: 'user_anna' }))
    repo.updateProjectPersonRow.mockResolvedValue(row({ id: 'person-2', userId: 'user_anna', function: 'Bauleitung' }))
    const input = projectPersonSchema.parse({
      name: 'Anna Weber',
      function: 'Bauleitung',
      company: null,
      startedOn: null,
      endedOn: null,
      userId: 'user_anna',
    })
    await addProjectPerson(session, 'p1', input)
    expect(repo.insertProjectPerson).not.toHaveBeenCalled()
    expect(repo.updateProjectPersonRow).toHaveBeenCalledWith('p1', 'org_1', 'person-2', expect.objectContaining({ function: 'Bauleitung' }))
  })
})

describe('a member leaving and coming back', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-11T10:00:00Z'))
    repo.findProjectPeriod.mockResolvedValue(period({}))
    repo.findProjectPersonByUser.mockResolvedValue(null)
    repo.insertProjectPerson.mockResolvedValue(row({ id: 'person-9', userId: 'user_anna' }))
  })

  it('keeps someone removed from the project as a former member, from the month they joined to this one', async () => {
    await recordMemberLeft(session, 'p1', { userId: 'user_anna', since: '2024-02' })
    expect(repo.insertProjectPerson).toHaveBeenCalledWith('p1', 'org_1', 'user_pl', {
      name: 'Anna Weber',
      function: null,
      company: null,
      startedOn: '2024-02-01',
      endedOn: '2026-10-01',
      userId: 'user_anna',
    })
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'project.person.added', metadata: { personId: 'person-9' } }))
    vi.useRealTimers()
  })

  it('ends the row a described member already has, and leaves an end someone set alone', async () => {
    repo.findProjectPersonByUser.mockResolvedValue(row({ id: 'person-2', userId: 'user_anna', endedOn: null }))
    await recordMemberLeft(session, 'p1', { userId: 'user_anna', since: '2024-02' })
    expect(repo.updateProjectPersonRow).toHaveBeenCalledWith('p1', 'org_1', 'person-2', expect.objectContaining({ endedOn: '2026-10-01', function: 'Statik' }))

    repo.updateProjectPersonRow.mockClear()
    repo.findProjectPersonByUser.mockResolvedValue(row({ id: 'person-2', userId: 'user_anna', endedOn: '2025-11-01' }))
    await recordMemberLeft(session, 'p1', { userId: 'user_anna', since: '2024-02' })
    expect(repo.updateProjectPersonRow).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('writes nothing in a closed project, and never throws into the access change', async () => {
    repo.findProjectPeriod.mockResolvedValue(period({ status: 'closed', endedOn: '2026-09-01' }))
    await recordMemberLeft(session, 'p1', { userId: 'user_anna', since: null })
    expect(repo.insertProjectPerson).not.toHaveBeenCalled()

    repo.findProjectPeriod.mockRejectedValue(new Error('db down'))
    await expect(recordMemberLeft(session, 'p1', { userId: 'user_anna', since: null })).resolves.toBeUndefined()
    vi.useRealTimers()
  })

  it('a member put back on the project is current again', async () => {
    repo.findProjectPersonByUser.mockResolvedValue(row({ id: 'person-2', userId: 'user_anna', endedOn: '2026-07-01' }))
    repo.updateProjectPersonRow.mockResolvedValue(row({ id: 'person-2' }))
    await recordMemberRejoined(session, 'p1', 'user_anna')
    expect(repo.updateProjectPersonRow).toHaveBeenCalledWith('p1', 'org_1', 'person-2', expect.objectContaining({ endedOn: null }))
    vi.useRealTimers()
  })
})

describe('projectPersonSchema', () => {
  const base = { name: 'Maria Huber', function: '', company: '  ', startedOn: '2023-03', endedOn: '2023-01', userId: null }

  it('refuses a period that runs backwards, and a day-precise date', () => {
    expect(projectPersonSchema.safeParse(base).success).toBe(false)
    expect(projectPersonSchema.safeParse({ ...base, startedOn: '2023-03-15', endedOn: null }).success).toBe(false)
  })

  it('takes nothing beyond the fields it names: no e-mail, no phone', () => {
    expect(projectPersonSchema.safeParse({ ...base, endedOn: null, email: 'm@h.at' }).success).toBe(false)
    expect(projectPersonSchema.safeParse({ ...base, endedOn: null, phone: '+43 1' }).success).toBe(false)
  })

  it('stores an empty Funktion or Firma as nothing', () => {
    expect(projectPersonSchema.parse({ ...base, endedOn: null })).toMatchObject({ function: null, company: null })
  })
})
