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
vi.mock('@/lib/authz/project-membership', () => ({ canUserAccessProject: vi.fn() }))
vi.mock('@/lib/authz/folder-access', () => ({ filterUsersWhoMayReadFolder: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))

import type { AuthorizedSession } from '@/lib/auth/types'
import { filterUsersWhoMayReadFolder } from '@/lib/authz/folder-access'
import { canUserAccessProject } from '@/lib/authz/project-membership'
import type { Document } from '@/lib/db/schema'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import type { DirectoryPerson } from '@/lib/sharing/types'
import { mayOpenDocument } from './may-open'

const session = { userId: 'user_me', organizationId: 'org_1' } as Partial<AuthorizedSession> as AuthorizedSession

const doc = (overrides: Partial<Document>): Pick<Document, 'scope' | 'projectId' | 'folderId'> => ({
  scope: 'project',
  projectId: 'proj_1',
  folderId: null,
  ...overrides,
})

const member = (userId: string): DirectoryPerson => ({ userId, email: null, name: userId, profilePictureUrl: null })

beforeEach(() => {
  vi.mocked(canUserAccessProject).mockImplementation(async (_session, _project, userId) => userId !== 'user_outside')
  vi.mocked(filterUsersWhoMayReadFolder).mockImplementation(
    async (_org, _project, folderId, userIds) =>
      new Set(folderId === 'fld_hr' ? userIds.filter((userId) => userId === 'user_hr') : userIds)
  )
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map([['user_a', member('user_a')]]))
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
    expect(canUserAccessProject).not.toHaveBeenCalled()
  })

  it('opens a chat attachment for nobody, and asks nothing for nobody', async () => {
    expect(await mayOpenDocument(session, doc({ scope: 'session', projectId: null }), ['user_a'])).toEqual(new Set())
    expect(await mayOpenDocument(session, doc({}), [])).toEqual(new Set())
    expect(canUserAccessProject).not.toHaveBeenCalled()
  })
})
