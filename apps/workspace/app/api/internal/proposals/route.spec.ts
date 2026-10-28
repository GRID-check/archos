/**
 * @vitest-environment node
 */
/**
 * Piloti proposes a change to the workspace (`POST /api/internal/proposals`).
 *
 * What is pinned here: the project and the conversation are the signed
 * envelope's and never the body's (a body naming a project is refused by the
 * strict schema); a turn outside a project gets a typed 422 the tool relays;
 * the asker must be able to read the project, as their pinned session; every
 * item carries the fields its verb needs; and the proposal is filed as Piloti's
 * on the asker's behalf, born `proposed`, through the REAL service. Each kind
 * is filed with its own payload, and the same card of the same answer twice
 * returns the first proposal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/api/internal-envelope', () => ({
  requireVerifiedContext: vi.fn(),
  requirePinnedSession: vi.fn(),
}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/conversations/repository', () => ({ findConversationInOrg: vi.fn() }))
vi.mock('@/lib/proposals/repository', () => ({
  insertProposedChange: vi.fn(),
  findProposedChange: vi.fn(),
  claimProposedChange: vi.fn(),
  settleProposedChange: vi.fn(),
  releaseProposedChange: vi.fn(),
  dismissProposedChange: vi.fn(),
}))
// The executors' services are not reached when proposing; stubbed so the
// import graph stays out of the database and WorkOS.
vi.mock('@/lib/proposals/executors', async (original) => ({
  ...(await original<typeof import('@/lib/proposals/executors')>()),
  applyFileOperations: vi.fn(),
}))
vi.mock('@/lib/assignments/service', () => ({}))
vi.mock('@/lib/office-shelf/folder-service', () => ({}))
vi.mock('@/lib/office-shelf/service', () => ({}))
vi.mock('@/lib/documents/move-to-folder', () => ({}))
vi.mock('@/lib/documents/document-delivery', () => ({}))
vi.mock('@/lib/documents/document-details', () => ({}))
vi.mock('@/lib/documents/document-dispatch', () => ({}))
vi.mock('@/lib/documents/document-edits', () => ({}))
vi.mock('@/lib/documents/document-listing', () => ({}))
vi.mock('@/lib/documents/document-storage-keys', () => ({}))
vi.mock('@/lib/documents/extraction-jobs', () => ({}))
vi.mock('@/lib/documents/ingest-dispatch', () => ({}))
vi.mock('@/lib/documents/ingest-recovery', () => ({}))
vi.mock('@/lib/documents/reindex', () => ({}))
vi.mock('@/lib/documents/reingest', () => ({}))
vi.mock('@/lib/documents/semantic-search', () => ({}))
vi.mock('@/lib/projects/folder-service', () => ({}))
// The memory and profile appliers' services are not reached when proposing either.
vi.mock('@/lib/projects/service', () => ({ MEMORY_WRITE_PERMISSIONS: ['project:memory:write', 'project:edit'] }))
vi.mock('@/lib/project-profile/profile-service', () => ({}))
vi.mock('@/lib/conversations/cross-project-use', () => ({}))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))
vi.mock('@/lib/sharing/access', () => ({ requireResourceAccess: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/db/tenant-context', async (original) => ({
  ...(await original<typeof import('@/lib/db/tenant-context')>()),
  withTenant: (_scope: unknown, run: () => unknown) => run(),
}))

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { requirePinnedSession, requireVerifiedContext } from '@/lib/api/internal-envelope'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findConversationInOrg } from '@/lib/conversations/repository'
import type { Conversation } from '@/lib/db/schema/conversations'
import type { ProposedChangeRow } from '@/lib/db/schema/proposed-changes'
import { insertProposedChange, type NewProposedChange } from '@/lib/proposals/repository'
import { internalProposalResponseSchema, type InternalProposalRequest } from '@/lib/proposals/types'
import type { VerifiedGridRequestContext } from '@/lib/request-context'
import { POST } from './route'

const SECRET = 'test-internal-token-proposals'
const PROJECT = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
const ANSWER = '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d'
const NEW_ID = '0b7c8f5e-1d1e-4c39-9d2c-3f0f6c1a2b3c'
const SESSION = { userId: 'user_1', organizationId: 'org_1' } as Partial<AuthorizedSession> as AuthorizedSession
const CONTEXT = {
  organizationId: 'org_1',
  userId: 'user_1',
  projectId: PROJECT,
  conversationId: 'conv_1',
  issuedAt: Date.now(),
  collectionScope: ['proj_1_docs'],
} as Partial<VerifiedGridRequestContext> as VerifiedGridRequestContext

const MOVE: InternalProposalRequest = {
  op: 'create',
  kind: 'file_operation',
  payload: {
    operation: 'move',
    operations: [{ document: 'Grundriss EG.pdf', source: 'project', current: '', target_folder: 'Einreichung' }],
    note: 'Für die Einreichung gesammelt',
  },
  answerMessageId: ANSWER,
}

const post = (body: unknown, token = SECRET) =>
  POST(
    new Request('https://grid.test/api/internal/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-grid-internal-token': token },
      body: JSON.stringify(body),
    })
  )

beforeEach(() => {
  vi.clearAllMocks()
  process.env.INTERNAL_API_TOKEN = SECRET
  vi.mocked(requireVerifiedContext).mockReturnValue(CONTEXT)
  vi.mocked(requirePinnedSession).mockResolvedValue(SESSION)
  vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-viewer', closed: false, readsBecauseClosed: false })
  vi.mocked(findConversationInOrg).mockResolvedValue({ id: 'conv_1' } as Partial<Conversation> as Conversation)
  vi.mocked(insertProposedChange).mockImplementation(async (input: NewProposedChange) => ({
    row: { ...input, id: NEW_ID, status: 'proposed', createdAt: new Date() } as Partial<ProposedChangeRow> as ProposedChangeRow,
    created: true,
  }))
})

afterEach(() => {
  delete process.env.INTERNAL_API_TOKEN
})

describe('POST /api/internal/proposals', () => {
  it('files the proposal in the envelope’s project and conversation, as Piloti for the asker', async () => {
    const response = await post(MOVE)

    expect(response.status).toBe(200)
    expect(internalProposalResponseSchema.parse(await response.json())).toEqual({ id: NEW_ID, status: 'proposed' })
    expect(requireProjectAccess).toHaveBeenCalledWith(SESSION, PROJECT, 'project:view')
    expect(insertProposedChange).toHaveBeenCalledWith({
      organizationId: 'org_1',
      projectId: PROJECT,
      scope: 'project',
      kind: 'file_operation',
      payload: MOVE.payload,
      proposedByKind: 'piloti',
      onBehalfOf: 'user_1',
      originConversationId: 'conv_1',
      originMessageId: ANSWER,
      originCardIndex: null,
      originTraceId: null,
    })
  })

  it('refuses a body that names a project: the project is the envelope’s', async () => {
    const response = await post({ ...MOVE, projectId: '11111111-1111-4111-8111-111111111111' })
    expect(response.status).toBe(400)
    expect(insertProposedChange).not.toHaveBeenCalled()
  })

  it('is a typed 422 for a turn outside a project', async () => {
    vi.mocked(requireVerifiedContext).mockReturnValue({ ...CONTEXT, projectId: null })
    const response = await post(MOVE)
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ details: { reason: 'no-project' } })
    expect(insertProposedChange).not.toHaveBeenCalled()
  })

  it('refuses an asker who cannot read the project, and one who left the organization', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new NotFoundError())
    expect((await post(MOVE)).status).toBe(404)

    vi.mocked(requirePinnedSession).mockRejectedValueOnce(new ForbiddenError('The requesting user is no longer a member here'))
    expect((await post(MOVE)).status).toBe(403)
    expect(insertProposedChange).not.toHaveBeenCalled()
  })

  it('refuses an item without the fields its verb needs', async () => {
    const response = await post({
      ...MOVE,
      payload: { operation: 'rename', operations: [{ document: 'Grundriss EG.pdf' }] },
    })
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({
      details: { reason: 'proposal-item-incomplete', index: 0, missing: ['new_display_name'] },
    })
  })

  it('refuses more items than one card carries, and an unknown verb', async () => {
    const many = Array.from({ length: 21 }, (_, index) => ({ document: `Plan ${index}.pdf`, target_folder: '' }))
    expect((await post({ ...MOVE, payload: { operation: 'move', operations: many } })).status).toBe(400)
    expect((await post({ ...MOVE, payload: { operation: 'delete', operations: [{ document: 'a.pdf' }] } })).status).toBe(
      400
    )
  })

  it('files a proposal without an origin when the turn has no conversation, and refuses one whose conversation is gone', async () => {
    vi.mocked(requireVerifiedContext).mockReturnValue({ ...CONTEXT, conversationId: null })
    expect((await post(MOVE)).status).toBe(200)
    expect(insertProposedChange).toHaveBeenLastCalledWith(expect.objectContaining({ originConversationId: null }))

    vi.mocked(requireVerifiedContext).mockReturnValue(CONTEXT)
    vi.mocked(findConversationInOrg).mockResolvedValueOnce(null)
    expect((await post(MOVE)).status).toBe(404)
  })

  it('refuses a caller without the internal token before reading the envelope', async () => {
    const response = await post(MOVE, 'wrong')
    expect(response.status).toBe(403)
    expect(requireVerifiedContext).not.toHaveBeenCalled()
  })

  it('files a memory note and a profile change, each with its own payload', async () => {
    const note = { scope: 'organization', kind: 'preference', content: 'Pläne immer im Maßstab 1:100', confidence: 'medium' }
    expect((await post({ op: 'create', kind: 'memory', payload: note, answerMessageId: ANSWER })).status).toBe(200)
    expect(insertProposedChange).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'memory', payload: note }))

    const profile = {
      title: 'Bundesland: Tirol',
      patch: [{ op: 'replace', path: '/facts/federal_state/value', value: 'tirol' }],
    }
    expect((await post({ op: 'create', kind: 'project_profile', payload: profile })).status).toBe(200)
    expect(insertProposedChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'project_profile', payload: profile, originMessageId: null })
    )
  })

  it('refuses a payload that is not its kind’s, a profile value outside the vocabulary, and an unknown kind', async () => {
    expect((await post({ op: 'create', kind: 'memory', payload: MOVE.payload })).status).toBe(400)
    expect((await post({ op: 'create', kind: 'steckbrief', payload: {} })).status).toBe(400)
    const outside = await post({
      op: 'create',
      kind: 'project_profile',
      payload: { title: 'Bundesland', patch: [{ op: 'replace', path: '/facts/federal_state/value', value: 'atlantis' }] },
    })
    expect(outside.status).toBe(422)
    await expect(outside.json()).resolves.toMatchObject({ details: { reason: 'proposal-profile-vocabulary' } })
    expect(insertProposedChange).not.toHaveBeenCalled()
  })

  it('returns the first proposal for the same card of the same answer', async () => {
    vi.mocked(insertProposedChange).mockResolvedValueOnce({
      row: {
        id: NEW_ID,
        status: 'applied',
        projectId: PROJECT,
        originConversationId: 'conv_1',
        kind: 'file_operation',
      } as Partial<ProposedChangeRow> as ProposedChangeRow,
      created: false,
    })
    const response = await post({ ...MOVE, originCardIndex: 1 })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: NEW_ID, status: 'applied' })
    expect(insertProposedChange).toHaveBeenCalledWith(expect.objectContaining({ originMessageId: ANSWER, originCardIndex: 1 }))
  })

  it('refuses a negative card index', async () => {
    expect((await post({ ...MOVE, originCardIndex: -1 })).status).toBe(400)
  })
})
