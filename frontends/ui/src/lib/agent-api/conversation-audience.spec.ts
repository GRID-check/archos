/**
 * @vitest-environment node
 */
/**
 * Who reads the conversation Piloti answers in (H1, ADR-0093). The database is
 * replaced at the repository seam; the rule deciding solo (`isSoloAudience`) is
 * the real one.
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
vi.mock('@/lib/authz/folder-access-repository', () => ({ listProjectFolderTree: vi.fn() }))
vi.mock('@/lib/authz/folder-access', () => ({}))
vi.mock('./operation-targets', () => ({}))

import { readConversationAudience } from '@/lib/conversations/restricted-use-repository'
import { conversationReachOf } from './conversation-audience'
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
const piloti = (extra: Partial<AgentPrincipal> = {}): AgentPrincipal => ({
  actor: 'piloti',
  session,
  clientId: null,
  scopes: [],
  conversationId: 'conv_1',
  projectId: 'proj_1',
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
    expect(await conversationReachOf({ actor: 'external_agent', session, clientId: 'c', scopes: [] })).toBe('none')
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

// What a solo read records, and what it refuses, is SQL under the audience lock: proven against
// Postgres in `read-gate.integration.spec.ts`, not here.
