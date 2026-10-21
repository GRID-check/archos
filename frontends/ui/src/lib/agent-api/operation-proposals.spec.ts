/**
 * @vitest-environment node
 */
/**
 * Piloti's writes through the MCP surface are proposals (ADR-0121): proposing
 * files a row and applies nothing; accepting runs the operation through
 * `callOperation` as the ACCEPTING person; a read-only or vanished operation is
 * never run; dismissing runs nothing. A turn in no project files on the
 * organization (0174), read through its conversation and decided by anyone who
 * reads it; the same call repeated while the first is open files nothing. The
 * service is the real one, over an in-memory repository; `callOperation` and
 * the catalog are the seams.
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
  findOpenOperationProposal: vi.fn(),
  listShelfProposals: vi.fn(),
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
const ORG_MEMORY_CREATE: AgentOperation = {
  name: 'organization-memory-create',
  domain: 'organization',
  summary: 'Add a note to the office’s memory',
  description: 'Adds a note to the organization’s memory, read by every project. Returns the note.',
  method: 'POST',
  path: '/api/organization/memory',
  load: async () => ({}),
  body: z.object({ content: z.string() }),
}
const CATALOG = [FOLDER_RENAME, FOLDER_LIST, SEARCH_POST, ORG_MEMORY_CREATE]
let catalog = CATALOG
vi.mock('./catalog', () => ({
  AGENT_OPERATIONS: [],
  findOperation: (name: string) => catalog.find((op) => op.name === name),
}))

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { ProposedChangeRow } from '@/lib/db/schema/proposed-changes'
import { recordDecisionScore } from '@/lib/langfuse/decision-score'
import { onProposalCreated } from '@/lib/proposals/attention'
import {
  claimProposedChange,
  dismissProposedChange,
  findOpenOperationProposal,
  findProposedChange,
  insertProposedChange,
  listShelfProposals,
  releaseProposedChange,
  settleProposedChange,
} from '@/lib/proposals/repository'
import { requireResourceAccess } from '@/lib/sharing/access'
import { requireProposable, type KindPayload } from '@/lib/proposals/kinds'
import { applyProposal, createProposal, dismissProposal, getProposal, listOpenProposals } from '@/lib/proposals/service'
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
const ORG_INPUT = { body: { content: 'Wir planen mit Holz-Alu-Fenstern.' } }
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
  vi.mocked(requireResourceAccess).mockReset()
  vi.mocked(findProposedChange).mockImplementation(async (_org, id) => store.get(id) ?? null)
  vi.mocked(findOpenOperationProposal).mockImplementation(
    async (_org, conversationId, call) =>
      [...store.values()].find(
        (row) =>
          row.kind === 'operation' &&
          row.status === 'proposed' &&
          row.originConversationId === conversationId &&
          (row.payload as { operation: string }).operation === call.operation &&
          JSON.stringify((row.payload as { input: unknown }).input) === JSON.stringify(call.input)
      ) ?? null
  )
  vi.mocked(listShelfProposals).mockImplementation(async (_org, shelf) =>
    [...store.values()].filter((row) => row.status === 'proposed' && row.scope === shelf.scope)
  )
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

  it('refuses a read-only operation and an input its schema rejects', async () => {
    await expect(propose(FOLDER_LIST)).rejects.toMatchObject({ status: 422 })
    await expect(propose(SEARCH_POST)).rejects.toMatchObject({ status: 422 })
    await expect(
      proposeOperation({
        principal: { session: ASKER, projectId: PROJECT },
        op: FOLDER_RENAME,
        input: { ...INPUT, body: {} },
      })
    ).rejects.toMatchObject({ status: 422 })
    expect(insertProposedChange).not.toHaveBeenCalled()
  })

  it('files the same call once while the first proposal is open, and again once it is decided', async () => {
    const first = await propose()
    const again = await propose()

    expect(again).toEqual(first)
    expect(insertProposedChange).toHaveBeenCalledTimes(1)
    expect(findOpenOperationProposal).toHaveBeenCalledWith('org_1', 'conv_1', {
      operation: 'folder-rename',
      input: INPUT,
      summary: first.summary,
    })

    // Another input is another proposal; so is the same call in another conversation.
    await proposeOperation({
      principal: { session: ASKER, conversationId: 'conv_1', projectId: PROJECT },
      op: FOLDER_RENAME,
      input: { ...INPUT, body: { name: 'Pläne 2' } },
    })
    await proposeOperation({
      principal: { session: ASKER, conversationId: 'conv_2', projectId: PROJECT },
      op: FOLDER_RENAME,
      input: INPUT,
    })
    expect(insertProposedChange).toHaveBeenCalledTimes(3)

    await dismissProposal(ACCEPTER, first.proposalId)
    const afterDecision = await propose()
    expect(afterDecision.proposalId).not.toBe(first.proposalId)
    expect(insertProposedChange).toHaveBeenCalledTimes(4)
  })

  it('tells nobody again for the repeat: the inbox and the audit trail heard of the first only', async () => {
    await propose()
    await propose()
    await vi.waitFor(() => expect(onProposalCreated).toHaveBeenCalledTimes(1))
  })
})

describe('an organization-scoped operation proposal (a turn in no project)', () => {
  const proposeInOrganization = (conversationId: string | null = 'conv_1') =>
    proposeOperation({
      principal: { session: ASKER, conversationId },
      op: ORG_MEMORY_CREATE,
      input: ORG_INPUT,
    })

  it('is filed on the organization with no project, and needs no project right', async () => {
    const { proposalId } = await proposeInOrganization()

    expect(store.get(proposalId)).toMatchObject({
      organizationId: 'org_1',
      projectId: null,
      scope: 'organization',
      kind: 'operation',
      onBehalfOf: 'user_1',
      originConversationId: 'conv_1',
      status: 'proposed',
    })
    expect(requireProjectAccess).not.toHaveBeenCalled()
    expect(dispatch.callOperation).not.toHaveBeenCalled()
  })

  it('is only for an operation: another kind with no project stays a Büroablage move or nothing', async () => {
    const memory = { scope: 'project', kind: 'decision', content: 'x', confidence: 'high' }
    await expect(
      createProposal(ASKER, { projectId: null, kind: 'memory', payload: memory, conversationId: 'conv_1', answerMessageId: null })
    ).rejects.toMatchObject({ status: 422 })
    expect(() => requireProposable({ kind: 'memory', payload: memory } as KindPayload, 'organization')).toThrow(
      expect.objectContaining({ status: 422 })
    )
    expect(insertProposedChange).not.toHaveBeenCalled()
  })

  it('files the same call once there too', async () => {
    const first = await proposeInOrganization()
    expect(await proposeInOrganization()).toEqual(first)
    expect(insertProposedChange).toHaveBeenCalledTimes(1)
  })

  it('is read through its conversation by a colleague, and carries no project', async () => {
    const { proposalId } = await proposeInOrganization()

    const view = await getProposal(ACCEPTER, proposalId)

    expect(requireResourceAccess).toHaveBeenCalledWith(ACCEPTER, 'conversation', 'conv_1', 'viewer')
    expect(view).toMatchObject({ id: proposalId, kind: 'operation', projectId: null, canDecide: true })
  })

  it('is a 404 for a colleague who cannot see its conversation', async () => {
    const { proposalId } = await proposeInOrganization()
    vi.mocked(requireResourceAccess).mockRejectedValue(new NotFoundError())
    await expect(getProposal(ACCEPTER, proposalId)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('made in no conversation is read by the person it was made for and nobody else', async () => {
    const { proposalId } = await proposeInOrganization(null)

    expect((await getProposal(ASKER, proposalId)).canDecide).toBe(true)
    await expect(getProposal(ACCEPTER, proposalId)).rejects.toBeInstanceOf(NotFoundError)
    await expect(applyProposal(ACCEPTER, proposalId, new Request('https://grid.test'))).rejects.toBeInstanceOf(
      NotFoundError
    )
  })

  it('is applied as the accepting person with no project right asked: the operation’s route is the gate', async () => {
    const { proposalId, summary } = await proposeInOrganization()
    vi.mocked(requireProjectAccess).mockRejectedValue(new ForbiddenError('no project right'))

    const view = await applyProposal(ACCEPTER, proposalId, new Request('https://grid.test'))

    expect(dispatch.callOperation).toHaveBeenCalledTimes(1)
    expect(dispatch.callOperation.mock.calls[0][2]).toBe(ACCEPTER)
    expect(view).toMatchObject({ status: 'applied', projectId: null, results: [{ label: summary, ok: true }] })
  })

  it('shows the route’s own refusal when the accepting person may not do it', async () => {
    const { proposalId } = await proposeInOrganization()
    dispatch.callOperation.mockResolvedValue({
      status: 403,
      ok: false,
      body: { error: 'Only admins may write the office memory', code: 'FORBIDDEN' },
    })

    const view = await applyProposal(ACCEPTER, proposalId, new Request('https://grid.test'))

    expect(view.status).toBe('failed')
    expect(view.results).toMatchObject([{ ok: false, reason: 'Only admins may write the office memory' }])
  })

  it('is dismissed without a project right', async () => {
    const { proposalId } = await proposeInOrganization()
    vi.mocked(requireProjectAccess).mockRejectedValue(new ForbiddenError('no project right'))
    expect(await dismissProposal(ACCEPTER, proposalId)).toMatchObject({ status: 'dismissed', projectId: null })
  })

  it('is listed on the organization shelf for readers of its conversation, and only for the requester without one', async () => {
    const withChat = await proposeInOrganization('conv_1')
    const withoutChat = await proposeInOrganization(null)
    await propose() // a project's, not on this shelf

    const forColleague = await listOpenProposals(ACCEPTER, { shelf: 'organization' })
    expect(listShelfProposals).toHaveBeenCalledWith(
      'org_1',
      { scope: 'organization' },
      expect.objectContaining({ statuses: ['proposed'] })
    )
    expect(forColleague.map((entry) => entry.proposal.id)).toEqual([withChat.proposalId])
    expect(forColleague[0]?.proposal).toMatchObject({ projectId: null, canDecide: true })

    const forRequester = await listOpenProposals(ASKER, { shelf: 'organization' })
    expect(forRequester.map((entry) => entry.proposal.id).sort()).toEqual(
      [withChat.proposalId, withoutChat.proposalId].sort()
    )
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
    // Another input: the same call twice would be one proposal.
    const second = await proposeOperation({
      principal: { session: ASKER, conversationId: 'conv_1', projectId: PROJECT },
      op: FOLDER_RENAME,
      input: { ...INPUT, body: { name: 'Pläne 2' } },
    })
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
