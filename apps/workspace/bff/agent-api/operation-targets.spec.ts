/**
 * @vitest-environment node
 */
/**
 * What a call names (`targetsOf`), over the real catalog. The read gate and the
 * proposal both judge a call by this answer, so a key it misses is a place
 * neither of them checks.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./operation-targets-repository', () => ({ findTargetPlace: vi.fn(), findProjectName: vi.fn(), findFolderName: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/authz/folder-access', () => ({ isFolderVisibleTo: vi.fn() }))
vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('@/lib/sharing/access', () => ({ requireResourceAccess: vi.fn() }))
vi.mock('@/lib/conversations/repository', () => ({ findConversationInOrg: vi.fn() }))

import type { AuthorizedSession } from '@/lib/auth/types'
import { isFolderVisibleTo } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findConversationInOrg } from '@/lib/conversations/repository'
import { requireResourceAccess } from '@/lib/sharing/access'
import { findOperation } from './catalog'
import { describeTargets, namesUntypedResource, targetsOf } from './operation-targets'
import { findFolderName, findProjectName } from './operation-targets-repository'

const op = (name: string) => {
  const found = findOperation(name)
  if (!found) throw new Error(`${name} left the catalog`)
  return found
}

describe('targetsOf', () => {
  it('names the base model of a comparison beside the model in the path', () => {
    const targets = targetsOf(op('bim-model-query'), {
      params: { modelId: 'model-a' },
      body: { kind: 'compare', baseModelId: 'model-b' },
    })
    expect(targets).toEqual([
      { type: 'bim_model', id: 'model-a' },
      { type: 'bim_model', id: 'model-b' },
    ])
  })

  it('names the project a scoped list is narrowed to', () => {
    expect(targetsOf(op('conversation-list'), { query: { projectId: 'p1' } })).toEqual([{ type: 'project', id: 'p1' }])
  })

  it('names nothing for a resource of a type it cannot place, and says so', () => {
    const input = { params: { resourceType: 'annotation', resourceId: 'a1' } }
    expect(targetsOf(op('assignment-candidate-list'), input)).toEqual([])
    expect(namesUntypedResource(input)).toBe(true)
    expect(namesUntypedResource({ params: { resourceType: 'document', resourceId: 'd1' } })).toBe(false)
    expect(namesUntypedResource({ body: { items: [{ entityType: 'mark', entityId: 'm1' }] } })).toBe(true)
  })
})

describe('describeTargets', () => {
  const session = { organizationId: 'org_1', userId: 'user_me' } as AuthorizedSession
  const project = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f'

  it('names a folder, a conversation and a person for the reader, and keeps the id of what it may not see', async () => {
    vi.mocked(requireProjectAccess).mockResolvedValue(undefined as never)
    vi.mocked(findProjectName).mockResolvedValue('Neubau Musterstraße')
    vi.mocked(findFolderName).mockImplementation(async (_org, id) =>
      id === 'folder-open' ? { projectId: project, name: 'Einreichung' } : { projectId: project, name: 'Personal' }
    )
    vi.mocked(isFolderVisibleTo).mockImplementation(async (_session, _project, id) => id === 'folder-open')
    vi.mocked(requireResourceAccess).mockResolvedValue(undefined as never)
    vi.mocked(findConversationInOrg).mockResolvedValue({ id: 'conv-1', title: 'Brandschutz EG' } as never)
    const people = new Map([['user_anna', { name: 'Anna Berger' }]])

    const views = await describeTargets(
      session,
      { path: '/api/projects/[id]/things' },
      {
        params: { id: project },
        body: { folderIds: ['folder-open', 'folder-hidden'], conversationId: 'conv-1', people: [{ userId: 'user_anna' }, { userId: 'user_gone' }] },
      },
      people
    )

    expect(views).toEqual([
      { type: 'project', id: project, name: 'Neubau Musterstraße' },
      { type: 'folder', id: 'folder-open', name: 'Einreichung' },
      { type: 'folder', id: 'folder-hidden', name: null },
      { type: 'conversation', id: 'conv-1', name: 'Brandschutz EG' },
      { type: 'member', id: 'user_anna', name: 'Anna Berger' },
      { type: 'member', id: 'user_gone', name: null },
    ])
  })

  it('names no person when the caller holds no directory', async () => {
    const views = await describeTargets(session, op('assignment-add'), {
      params: { resourceType: 'annotation', resourceId: 'a1' },
      body: { userId: 'user_anna' },
    })
    expect(views).toEqual([])
  })
})
