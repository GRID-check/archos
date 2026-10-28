/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/cross-project/audience-reach', () => ({ audienceReach: vi.fn() }))
vi.mock('@/lib/authz/folder-access', () => ({
  getProjectFolderAccess: vi.fn().mockResolvedValue({ hiddenFolderIds: new Set(['f-hidden']), clearedRestrictedCollections: ['proj_a_r1'] }),
  getRestrictedFolderIds: vi.fn().mockResolvedValue(['f-restricted']),
}))
vi.mock('@/lib/upload-screening/quarantine-reviewers', () => ({ shelfReaderFor: vi.fn().mockResolvedValue({ kind: 'reviewer' }) }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/projects/service', () => ({ listProjects: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn() }))
vi.mock('@/lib/office-shelf/collection', () => ({ officeShelfCollectionName: () => 'office_org_1' }))
vi.mock('@/lib/db', () => ({ getDb: vi.fn() }))
vi.mock('@/lib/conversations/restricted-use-repository', () => ({ readConversationAudience: vi.fn() }))

import type { AuthorizedSession } from '@/lib/auth/types'
import { audienceReach } from '@/lib/cross-project/audience-reach'
import { readConversationAudience } from '@/lib/conversations/restricted-use-repository'
import { findProjectInOrg } from '@/lib/projects/repository'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { Project } from '@/lib/db/schema/projects'
import { BadRequestError } from '@/lib/api/errors'
import { reachForAudience, reachReader, resolveScope } from './reach'

const session = { organizationId: 'org_1', userId: 'user_1' } as AuthorizedSession
const project = { id: 'p1', name: 'Hubergasse', collectionName: 'proj_a' } as Project

beforeEach(() => vi.clearAllMocks())

describe('reachForAudience', () => {
  it('reads what the asker reads in a chat that is theirs alone', async () => {
    vi.mocked(audienceReach).mockResolvedValue({ projects: [project], restrictedFolders: true, key: 'k' })
    const reach = await reachForAudience(session, 'conv_1', { kind: 'office' })
    expect(reach.projects[0]).toMatchObject({ hiddenFolderIds: ['f-hidden'], collections: ['proj_a', 'proj_a_r1'], reviewsQuarantine: true })
    expect(reach.screenedOnly).toBe(false)
    expect(reachReader(reach)).toMatchObject({ kind: 'projects', reviewedProjectIds: ['p1'] })
  })

  it('hides restricted folders and held uploads from a shared audience', async () => {
    vi.mocked(audienceReach).mockResolvedValue({ projects: [project], restrictedFolders: false, key: 'k' })
    const reach = await reachForAudience(session, 'conv_1', { kind: 'office' })
    expect(reach.projects[0]).toMatchObject({ collections: ['proj_a'], reviewsQuarantine: false })
    expect(reach.projects[0].hiddenFolderIds).toEqual(expect.arrayContaining(['f-hidden', 'f-restricted']))
    expect(reach.officeShelf).toEqual({ collection: 'office_org_1', reviewsQuarantine: false })
    expect(reachReader(reach)).toEqual({ kind: 'screened-only' })
  })

  it('adds the conversation\'s own project when asked, pruned like the audience, after its project:view', async () => {
    vi.mocked(audienceReach).mockResolvedValue({ projects: [], restrictedFolders: false, key: 'k' })
    vi.mocked(readConversationAudience).mockResolvedValue({ exists: true, projectId: 'p1', createdBy: 'u2', visibility: 'project', grantees: [] })
    vi.mocked(findProjectInOrg).mockResolvedValue(project)

    const reach = await reachForAudience(session, 'conv_1', { kind: 'project', projectId: 'p1' }, { includeOwnProject: true })

    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'p1', 'project:view')
    expect(reach.projects[0]).toMatchObject({ collections: ['proj_a'], reviewsQuarantine: false })
    expect(reach.projects[0].hiddenFolderIds).toContain('f-restricted')
  })

  it('leaves restricted folders out of a listing even in the asker\'s own chat, keeping their own held uploads', async () => {
    vi.mocked(audienceReach).mockResolvedValue({ projects: [project], restrictedFolders: true, key: 'k' })
    const reach = await reachForAudience(session, 'conv_1', { kind: 'office' }, { listing: true })
    expect(reach.projects[0].hiddenFolderIds).toEqual(expect.arrayContaining(['f-hidden', 'f-restricted']))
    expect(reach.projects[0].collections).toEqual(['proj_a'])
    expect(reach.screenedOnly).toBe(false)
  })

  it('does not find a project outside the audience', async () => {
    vi.mocked(audienceReach).mockResolvedValue({ projects: [], restrictedFolders: true, key: 'k' })
    await expect(reachForAudience(session, 'conv_1', { kind: 'project', projectId: 'p1' })).rejects.toThrow('Project not found')
  })
})

describe('resolveScope', () => {
  it('reads the office, a project with its folder, and the office shelf', () => {
    expect(resolveScope({})).toEqual({ kind: 'office' })
    expect(resolveScope({ projectId: 'p1', folderId: 'f1' })).toEqual({ kind: 'project', projectId: 'p1', folderId: 'f1' })
    expect(resolveScope({ scope: 'office_shelf' })).toEqual({ kind: 'office_shelf' })
  })

  it('refuses a folder without its shelf, and a project scope without a project', () => {
    expect(() => resolveScope({ folderId: 'f1' })).toThrow(BadRequestError)
    expect(() => resolveScope({ scope: 'project' })).toThrow(BadRequestError)
  })
})
