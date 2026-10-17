/**
 * @vitest-environment node
 */
/**
 * Who could open one document: the shelf's rule, and inside a project the
 * folder's too. A project member who may not read a restricted folder is not
 * somebody a mark in it may be handed to, or told about.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/project-membership', () => ({
  PERMISSION_CHECKS_AT_ONCE: 2,
  userHoldsProjectPermission: vi.fn(),
  resolveSubjectMembership: vi.fn(),
}))
vi.mock('@/lib/authz/folder-access', () => ({ filterUsersWhoMayReadFolder: vi.fn(), filterUsersWhoMayWriteFolder: vi.fn() }))
vi.mock('@/lib/authz/org-role-permissions', () => ({ orgRoleHoldsPermission: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))

import type { AuthorizedSession } from '@/lib/auth/types'
import { filterUsersWhoMayReadFolder, filterUsersWhoMayWriteFolder } from '@/lib/authz/folder-access'
import { orgRoleHoldsPermission } from '@/lib/authz/org-role-permissions'
import { resolveSubjectMembership, userHoldsProjectPermission } from '@/lib/authz/project-membership'
import type { Document } from '@/lib/db/schema'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import type { DirectoryPerson } from '@/lib/sharing/types'
import { mayOpenDocument, mayWriteDocument } from './may-open'

const session = { userId: 'user_me', organizationId: 'org_1' } as Partial<AuthorizedSession> as AuthorizedSession

const doc = (overrides: Partial<Document>): Pick<Document, 'scope' | 'projectId' | 'folderId'> => ({
  scope: 'project',
  projectId: 'proj_1',
  folderId: null,
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(userHoldsProjectPermission).mockImplementation(async (_tenant, _project, userId) => userId !== 'user_outside')
  vi.mocked(filterUsersWhoMayReadFolder).mockImplementation(
    async (_org, _project, folderId, userIds) =>
      new Set(folderId === 'fld_hr' ? userIds.filter((userId) => userId === 'user_hr') : userIds)
  )
  const member: DirectoryPerson = { userId: 'user_a', email: null, name: 'user_a', profilePictureUrl: null }
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map([['user_a', member]]))
})

describe('mayOpenDocument', () => {
  it('keeps the project’s members, minus whoever may not read the folder the document is filed in', async () => {
    const allowed = await mayOpenDocument(session, doc({ folderId: 'fld_hr' }), ['user_hr', 'user_a', 'user_outside'])

    expect(allowed).toEqual(new Set(['user_hr']))
    expect(filterUsersWhoMayReadFolder).toHaveBeenCalledWith('org_1', 'proj_1', 'fld_hr', ['user_hr', 'user_a'])
  })

  it('keeps every project member for a document at the project root', async () => {
    expect(await mayOpenDocument(session, doc({}), ['user_a', 'user_outside'])).toEqual(new Set(['user_a']))
  })

  it('opens a document on the Büroablage for the organization’s members', async () => {
    const allowed = await mayOpenDocument(session, doc({ scope: 'archiv', projectId: null }), ['user_a', 'user_gone'])

    expect(allowed).toEqual(new Set(['user_a']))
    // One read of the organization's directory, never a lookup per person: a picker passes the whole directory in.
    expect(loadOrganizationDirectory).toHaveBeenCalledTimes(1)
    expect(loadOrganizationDirectory).toHaveBeenCalledWith('org_1')
    expect(userHoldsProjectPermission).not.toHaveBeenCalled()
  })

  it('opens a chat attachment for nobody, and asks nothing for nobody', async () => {
    expect(await mayOpenDocument(session, doc({ scope: 'session', projectId: null }), ['user_a'])).toEqual(new Set())
    expect(await mayOpenDocument(session, doc({}), [])).toEqual(new Set())
    expect(userHoldsProjectPermission).not.toHaveBeenCalled()
  })

  it('asks the permission project:view in the organization, never a role, so a sweep with no session can ask too', async () => {
    await mayOpenDocument({ organizationId: 'org_1' }, doc({}), ['user_a', 'user_a'])

    expect(userHoldsProjectPermission).toHaveBeenCalledTimes(1)
    expect(userHoldsProjectPermission).toHaveBeenCalledWith({ organizationId: 'org_1' }, 'proj_1', 'user_a', 'project:view')
  })

  it('asks WorkOS about a handful of people at a time, so a whole directory is never one burst', async () => {
    let running = 0
    let most = 0
    vi.mocked(userHoldsProjectPermission).mockImplementation(async () => {
      running += 1
      most = Math.max(most, running)
      await Promise.resolve()
      running -= 1
      return true
    })

    const everyone = Array.from({ length: 9 }, (_, index) => `user_${index}`)
    expect(await mayOpenDocument(session, doc({}), everyone)).toEqual(new Set(everyone))
    expect(most).toBe(2)
  })
})

/**
 * Who could write one document: whom an Anmerkung may be handed to, since its
 * Zuständige must answer and close it. Never a role name: a permission on the
 * project and the folder's write, or on the Büroablage the curators' permission.
 */
describe('mayWriteDocument', () => {
  beforeEach(() => {
    // user_editor holds the narrow write permission, user_legacy only the older
    // umbrella, user_reader may only view the project.
    vi.mocked(userHoldsProjectPermission).mockImplementation(async (_tenant, _project, userId, permission) => {
      if (permission === 'project:view') return userId !== 'user_outside'
      if (permission === 'project:documents:write') return userId === 'user_editor'
      if (permission === 'project:edit') return userId === 'user_legacy'
      return false
    })
    vi.mocked(filterUsersWhoMayWriteFolder).mockImplementation(
      async (_org, _project, folderId, userIds) =>
        new Set(folderId === 'fld_ro' ? userIds.filter((userId) => userId === 'user_legacy') : userIds)
    )
  })

  it('keeps whoever may write the project’s documents, by the narrow permission or the older umbrella, and leaves out a reader', async () => {
    const allowed = await mayWriteDocument(session, doc({}), ['user_editor', 'user_legacy', 'user_reader', 'user_outside'])

    expect(allowed).toEqual(new Set(['user_editor', 'user_legacy']))
    expect(filterUsersWhoMayWriteFolder).toHaveBeenCalledWith('org_1', 'proj_1', null, ['user_editor', 'user_legacy'])
  })

  it('leaves out a writer of the project who may only read the folder the document is filed in', async () => {
    const allowed = await mayWriteDocument(session, doc({ folderId: 'fld_ro' }), ['user_editor', 'user_legacy'])

    expect(allowed).toEqual(new Set(['user_legacy']))
  })

  it('on the Büroablage keeps whoever holds org:archiv:manage, asked of their membership’s role, never its name', async () => {
    vi.mocked(resolveSubjectMembership).mockImplementation(async (_org, userId) =>
      userId === 'user_gone'
        ? null
        : { organizationMembershipId: `om_${userId}`, role: userId === 'user_curator' ? 'org-kuratorin' : 'member' }
    )
    vi.mocked(orgRoleHoldsPermission).mockImplementation(
      async (role, permission) => role === 'org-kuratorin' && permission === 'org:archiv:manage'
    )

    const allowed = await mayWriteDocument(session, doc({ scope: 'archiv', projectId: null }), [
      'user_curator',
      'user_a',
      'user_gone',
    ])

    expect(allowed).toEqual(new Set(['user_curator']))
    expect(orgRoleHoldsPermission).toHaveBeenCalledWith('org-kuratorin', 'org:archiv:manage', 'org_1')
    expect(userHoldsProjectPermission).not.toHaveBeenCalled()
  })

  it('lets nobody write a chat attachment here, and asks nothing for nobody', async () => {
    expect(await mayWriteDocument(session, doc({ scope: 'session', projectId: null }), ['user_editor'])).toEqual(new Set())
    expect(await mayWriteDocument(session, doc({}), [])).toEqual(new Set())
    expect(userHoldsProjectPermission).not.toHaveBeenCalled()
  })
})
