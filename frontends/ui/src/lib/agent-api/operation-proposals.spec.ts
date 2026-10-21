/**
 * @vitest-environment node
 */
/**
 * Piloti's writes through the MCP surface are proposals (ADR-0121): proposing
 * files a row and applies nothing; accepting runs the operation through
 * `callOperation` as the ACCEPTING person; a read-only or vanished operation is
 * never run; dismissing runs nothing. The service is the real one, over an
 * in-memory repository; `callOperation` and the catalog are the seams.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/sharing/access', () => ({ requireResourceAccess: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({
  loadOrganizationDirectory: vi.fn(async () => new Map()),
}))
vi.mock('@/lib/conversations/repository', () => ({
  findConversationInOrg: vi.fn(async () => ({ id: 'conv_1' })),
}))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))
vi.mock('@/lib/proposals/live', () => ({ publishProposalDecided: vi.fn(async () => undefined) }))
vi.mock('@/lib/proposals/attention', () => ({
  onProposalCreated: vi.fn(async () => undefined),
  onProposalDecided: vi.fn(async () => undefined),
}))
vi.mock('@/lib/langfuse/decision-score', () => ({
  recordDecisionScore: vi.fn(async () => undefined),
}))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
// The other kinds' services are not reached by an operation proposal.
vi.mock('@/lib/proposals/executors', () => ({
  applyFileOperations: vi.fn(),
  operationLabel: vi.fn(),
  REQUIRED_FIELDS: {},
  resolveItemDocuments: vi.fn(),
}))
vi.mock('@/lib/proposals/appliers', () => ({
  applyMemory: vi.fn(),
  applyProjectProfile: vi.fn(),
  noteLabel: vi.fn(),
}))
vi.mock('@/lib/projects/service', () => ({
  MEMORY_WRITE_PERMISSIONS: ['project:memory:write', 'project:edit'],
}))
vi.mock('@/lib/projects/folders', () => ({ folderPathKey: vi.fn() }))
vi.mock('@/lib/authz/folder-access-rule', () => ({
  DOCUMENT_WRITE_PERMISSIONS: ['project:documents:write'],
}))
vi.mock('@/lib/project-profile/intake-definition', () => ({
  validateProfilePatchVocabulary: vi.fn(),
}))
vi.mock('@/lib/proposals/repository', () => ({
  insertProposedChange: vi.fn(),
  findProposedChange: vi.fn(),
  claimProposedChange: vi.fn(),
  settleProposedChange: vi.fn(),
  releaseProposedChange: vi.fn(),
  dismissProposedChange: vi.fn(),
}))

const dispatch = vi.hoisted(() => ({ callOperation: vi.fn() }))
vi.mock('./dispatch', async (original) => ({
  ...(await original<typeof import('./dispatch')>()),
  callOperation: dispatch.callOperation,
}))

const FOLDER_RENAME: AgentOperation = {
  name: 'folder-rename',
  domain: 'folders',
  summary: 'Rename a folder',
  description: 'Renames a folder of a project. Returns the folder. Get ids from folder-list.',
  method: 'PATCH',
  path: '/api/projects/[id]/folders/[folderId]',
  load: async () => ({}),
  params: z.object({ id: z.string(), folderId: z.string() }),
  body: z.object({ name: z.string() }),
}
const FOLDER_LIST: AgentOperation = {
  ...FOLDER_RENAME,
  name: 'folder-list',
  summary: 'List folders',
  method: 'GET',
}
const SEARCH_POST: AgentOperation = {
  ...FOLDER_RENAME,
  name: 'folder-search',
  method: 'POST',
  readOnly: true,
}
const CATALOG = [FOLDER_RENAME, FOLDER_LIST, SEARCH_POST]
let catalog = CATALOG
vi.mock('./catalog', () => ({
  AGENT_OPERATIONS: [],
  findOperation: (name: string) => catalog.find((op) => op.name === name),
}))

import { ForbiddenError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { ProposedChangeRow } from '@/lib/db/schema/proposed-changes'
import { recordDecisionScore } from '@/lib/langfuse/decision-score'
import {
  claimProposedChange,
  dismissProposedChange,
  findProposedChange,
  insertProposedChange,
  releaseProposedChange,
  settleProposedChange,
} from '@/lib/proposals/repository'
import { applyProposal, dismissProposal } from '@/lib/proposals/service'
import { proposeOperation } from './operation-proposals'
import type { AgentOperation } from './operation'

const PROJECT = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
const ASKER = {
  userId: 'user_1',
  organizationId: 'org_1',
} as Partial<AuthorizedSession> as AuthorizedSession
const ACCEPTER = {
  userId: 'user_2',
  organizationId: 'org_1',
} as Partial<AuthorizedSession> as AuthorizedSession
const INPUT = { params: { id: PROJECT, folderId: 'f_1' }, body: { name: 'Pläne' } }

let store: Map<string, ProposedChangeRow>

beforeEach(() => {
  vi.clearAllMocks()
  catalog = CATALOG
  store = new Map()
  vi.mocked(requireProjectAccess).mockResolvedValue({
    role: 'project-editor',
    closed: false,
    readsBecauseClosed: false,
  })
  vi.mocked(insertProposedChange).mockImplementation(async (input) => {
    const row = {
      ...input,
      id: `0b7c8f5e-1d1e-4c39-9d2c-3f0f6c1a2b${String(store.size).padStart(2, '0')}`,
      status: 'proposed',
      originCardIndex: null,
      originMessageId: null,
      originTraceId: null,
      createdAt: new Date(),
      decidedBy: null,
      decidedAt: null,
      results: null,
      applyingBy: null,
      applyingSince: null,
    } as ProposedChangeRow
    store.set(row.id, row)
    return { row, created: true }
  })
  vi.mocked(findProposedChange).mockImplementation(async (_org, id) => store.get(id) ?? null)
  vi.mocked(claimProposedChange).mockImplementation(async (_org, id, userId) => {
    const current = store.get(id)
    if (!current || current.status !== 'proposed') return null
    const claimed = { ...current, applyingBy: userId, applyingSince: new Date() }
    store.set(id, claimed)
    return claimed
  })
  vi.mocked(settleProposedChange).mockImplementation(async (_org, claim, outcome) => {
    const settled = {
      ...claim,
      ...outcome,
      decidedBy: claim.applyingBy,
      decidedAt: new Date(),
      applyingBy: null,
      applyingSince: null,
    }
    store.set(claim.id, settled as ProposedChangeRow)
    return settled as ProposedChangeRow
  })
  vi.mocked(releaseProposedChange).mockResolvedValue(undefined)
  vi.mocked(dismissProposedChange).mockImplementation(async (_org, id, userId) => {
    const current = store.get(id)
    if (!current || current.status !== 'proposed') return null
    const dismissed = {
      ...current,
      status: 'dismissed',
      decidedBy: userId,
      decidedAt: new Date(),
    } as ProposedChangeRow
    store.set(id, dismissed)
    return dismissed
  })
  dispatch.callOperation.mockResolvedValue({ status: 200, ok: true, body: {} })
})

const propose = (op = FOLDER_RENAME) =>
  proposeOperation({
    principal: { session: ASKER, conversationId: 'conv_1', projectId: PROJECT },
    op,
    input: INPUT,
  })

describe('proposeOperation', () => {
  it('files an operation proposal in the turn, as Piloti for the asker, and runs nothing', async () => {
    const { proposalId, summary } = await propose()

    expect(summary).toBe(`Rename a folder (name: Pläne, id: ${PROJECT}, folderId: f_1)`)
    expect(insertProposedChange).toHaveBeenCalledTimes(1)
    expect(store.get(proposalId)).toMatchObject({
      organizationId: 'org_1',
      projectId: PROJECT,
      scope: 'project',
      kind: 'operation',
      proposedByKind: 'piloti',
      onBehalfOf: 'user_1',
      originConversationId: 'conv_1',
      status: 'proposed',
      payload: { operation: 'folder-rename', input: INPUT, summary },
    })
    expect(dispatch.callOperation).not.toHaveBeenCalled()
  })

  it('refuses a read-only operation, an input its schema rejects, and a turn outside a project', async () => {
    await expect(propose(FOLDER_LIST)).rejects.toMatchObject({ status: 422 })
    await expect(propose(SEARCH_POST)).rejects.toMatchObject({ status: 422 })
    await expect(
      proposeOperation({
        principal: { session: ASKER, projectId: PROJECT },
        op: FOLDER_RENAME,
        input: { ...INPUT, body: {} },
      })
    ).rejects.toMatchObject({ status: 422 })
    await expect(
      proposeOperation({
        principal: { session: ASKER, conversationId: 'conv_1' },
        op: FOLDER_RENAME,
        input: INPUT,
      })
    ).rejects.toMatchObject({ status: 422 })
    expect(insertProposedChange).not.toHaveBeenCalled()
  })
})

describe('applying an operation proposal', () => {
  it('runs the operation as the ACCEPTING person and records the result', async () => {
    const { proposalId, summary } = await propose()

    const view = await applyProposal(ACCEPTER, proposalId, new Request('https://grid.test'))

    expect(dispatch.callOperation).toHaveBeenCalledTimes(1)
    const [op, input, session] = dispatch.callOperation.mock.calls[0]
    expect(op).toBe(FOLDER_RENAME)
    expect(input).toEqual(INPUT)
    expect(session).toBe(ACCEPTER)
    expect(view).toMatchObject({
      status: 'applied',
      decidedBy: 'user_2',
      results: [{ label: summary, ok: true }],
    })
    expect(recordDecisionScore).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'proposal', decision: 'accepted', decidedBy: 'user_2' })
    )
  })

  it('reports the route’s own refusal as the apply failing, with its message', async () => {
    const { proposalId } = await propose()
    dispatch.callOperation.mockResolvedValue({
      status: 403,
      ok: false,
      body: { error: 'You may not rename this folder', code: 'FORBIDDEN' },
    })

    const view = await applyProposal(ACCEPTER, proposalId, new Request('https://grid.test'))

    expect(view.status).toBe('failed')
    expect(view.results).toMatchObject([{ ok: false, reason: 'You may not rename this folder' }])
  })

  it('refuses an operation that has left the catalog or turned read-only since it was proposed', async () => {
    const { proposalId } = await propose()
    const second = await propose()
    catalog = [{ ...FOLDER_RENAME, method: 'GET' }]

    const view = await applyProposal(ACCEPTER, proposalId, new Request('https://grid.test'))
    expect(view.status).toBe('failed')
    expect(view.results?.[0]?.reason).toMatch(/only reads/)

    catalog = []
    const gone = await applyProposal(ACCEPTER, second.proposalId, new Request('https://grid.test'))
    expect(gone.results?.[0]?.reason).toMatch(/no longer exists/)
    expect(dispatch.callOperation).not.toHaveBeenCalled()
  })

  it('leaves the proposal open for a decider who cannot see the project', async () => {
    const { proposalId } = await propose()
    vi.mocked(requireProjectAccess).mockRejectedValue(new ForbiddenError('no'))
    await expect(applyProposal(ACCEPTER, proposalId, new Request('https://grid.test'))).rejects.toBeInstanceOf(
      ForbiddenError
    )
    expect(dispatch.callOperation).not.toHaveBeenCalled()
  })
})

describe('dismissing an operation proposal', () => {
  it('records the no and runs nothing', async () => {
    const { proposalId } = await propose()

    const view = await dismissProposal(ACCEPTER, proposalId)

    expect(view).toMatchObject({ status: 'dismissed', decidedBy: 'user_2' })
    expect(dispatch.callOperation).not.toHaveBeenCalled()
    expect(recordDecisionScore).toHaveBeenCalledWith(expect.objectContaining({ decision: 'dismissed' }))
  })
})
