/**
 * @vitest-environment node
 */
/**
 * Who reads the conversation Piloti answers in, and what a solo read records
 * (H1, ADR-0093). The database is replaced at the repository seam; the rule
 * deciding solo (`isSoloAudience`) and the admission are the real ones' callers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({})) }))
vi.mock('@/lib/db/tenant-context', () => ({ withTenant: vi.fn((_tenant: unknown, run: () => unknown) => run()) }))
vi.mock('@/lib/conversations/restricted-use-repository', () => ({ readConversationAudience: vi.fn() }))
vi.mock('@/lib/conversations/cross-project-use', async () => {
  // The real rule, without the module's database imports.
  return {
    isSoloAudience: (audience: { exists: boolean; visibility: string; createdBy: string | null; grantees: string[] }, userId: string) =>
      !audience.exists ||
      (audience.visibility === 'private' && audience.createdBy === userId && audience.grantees.every((g) => g === userId)),
  }
})
vi.mock('@/lib/conversations/restricted-use', () => ({
  ADMISSION_MAX_COLLECTIONS: 2,
  admitSourceFolders: vi.fn(),
  markTurnAnswer: vi.fn(),
}))
vi.mock('@/lib/authz/folder-access-repository', () => ({ listProjectFolderTree: vi.fn() }))
vi.mock('@/lib/authz/folder-access', () => ({
  folderTree: (folders: { id: string; restricted: boolean }[]) => new Map(folders.map((folder) => [folder.id, folder])),
  readableByEveryMember: (tree: Map<string, { restricted: boolean }>, id: string) => !tree.get(id)?.restricted,
}))

import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { admitSourceFolders, markTurnAnswer } from '@/lib/conversations/restricted-use'
import { readConversationAudience } from '@/lib/conversations/restricted-use-repository'
import { conversationReachOf, recordSoloWorkspaceRead } from './conversation-audience'
import type { AgentPrincipal } from './principal'

const session = {
  userId: 'user_1',
  email: 'a@piloti.test',
  name: null,
  accessToken: '',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'admin' as const,
  permissions: [],
  featureFlags: null,
}
const ANSWER = '6f1c2b8e-3d4a-5b6c-8d7e-9f0a1b2c3d4e'
const piloti = (extra: Partial<AgentPrincipal> = {}): AgentPrincipal => ({
  kind: 'piloti',
  session,
  clientId: null,
  scopes: [],
  conversationId: 'conv_1',
  projectId: 'proj_1',
  answerMessageId: ANSWER,
  ...extra,
})
const audience = (extra: object) => ({
  exists: true,
  projectId: 'proj_1',
  createdBy: 'user_1',
  visibility: 'private' as const,
  grantees: [] as string[],
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('conversationReachOf', () => {
  it('is none for an external agent and for a call in no conversation', async () => {
    expect(await conversationReachOf({ kind: 'person', session, clientId: 'c', scopes: [] })).toBe('none')
    expect(await conversationReachOf(piloti({ conversationId: null }))).toBe('none')
    expect(readConversationAudience).not.toHaveBeenCalled()
  })

  it('is solo for a private chat of the requester, and for one not created yet', async () => {
    vi.mocked(readConversationAudience).mockResolvedValueOnce(audience({}))
    expect(await conversationReachOf(piloti())).toBe('solo')
    vi.mocked(readConversationAudience).mockResolvedValueOnce(audience({ exists: false }))
    expect(await conversationReachOf(piloti())).toBe('solo')
  })

  it('is shared once anyone else reads it', async () => {
    for (const shared of [{ grantees: ['user_2'] }, { visibility: 'project' }, { createdBy: 'user_2' }]) {
      vi.mocked(readConversationAudience).mockResolvedValueOnce(audience(shared))
      expect(await conversationReachOf(piloti()), JSON.stringify(shared)).toBe('shared')
    }
  })
})

describe('recordSoloWorkspaceRead', () => {
  it('admits every restricting folder of the turn’s project, in parts, then marks the answer', async () => {
    vi.mocked(listProjectFolderTree).mockResolvedValue([
      { id: 'f_open', restricted: false },
      { id: 'f_a', restricted: true },
      { id: 'f_b', restricted: true },
      { id: 'f_c', restricted: true },
    ] as never)
    await recordSoloWorkspaceRead(piloti())

    const request = {
      organizationId: 'org_1',
      conversationId: 'conv_1',
      userId: 'user_1',
      projectId: 'proj_1',
      answerMessageId: ANSWER,
    }
    expect(admitSourceFolders).toHaveBeenNthCalledWith(1, request, ['f_a', 'f_b'])
    expect(admitSourceFolders).toHaveBeenNthCalledWith(2, request, ['f_c'])
    expect(markTurnAnswer).toHaveBeenCalledWith(request)
  })

  it('in no project admits nothing and still marks the answer', async () => {
    await recordSoloWorkspaceRead(piloti({ projectId: null }))
    expect(listProjectFolderTree).not.toHaveBeenCalled()
    expect(admitSourceFolders).not.toHaveBeenCalled()
    expect(markTurnAnswer).toHaveBeenCalledWith(expect.objectContaining({ projectId: null, answerMessageId: ANSWER }))
  })
})
