/**
 * @vitest-environment node
 */
/**
 * Proposals no chat made (Piloti's filing suggestions) and proposals on the
 * Büroablage (0146), driven through the TYPED CLIENT (ADR-0055):
 *
 * - `GET /api/proposals` lists a shelf's open proposals with the documents
 *   they name, resolved for the reader, and leaves out one naming a document
 *   the reader cannot open;
 * - a proposal no conversation made is read through its documents: one the
 *   reader cannot resolve is a 404;
 * - a Büroablage proposal is read by any member and decided by its curators
 *   (`org:archiv:manage`), and can only move its documents;
 * - „create this folder and move these files into it" is one confirm: the
 *   apply makes the folder with its description, then files every item.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const SESSION = vi.hoisted(() => ({
  userId: 'user_1',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  email: 'anna@grid.test',
  name: 'Anna Berger',
  role: 'member',
  permissions: [] as string[],
  accessToken: '',
  featureFlags: null,
}))

vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn(async () => SESSION) }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/sharing/access', () => ({ requireResourceAccess: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn(async () => new Map()) }))
vi.mock('@/lib/conversations/repository', () => ({ findConversationInOrg: vi.fn() }))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))
vi.mock('@/lib/documents/service', () => ({ resolveProjectDocumentsByName: vi.fn(), renameDocument: vi.fn() }))
vi.mock('@/lib/office-shelf/service', () => ({ resolveOfficeShelfDocumentsByName: vi.fn() }))
vi.mock('@/lib/office-shelf/folder-service', () => ({
  listOfficeShelfFolders: vi.fn(),
  ensureOfficeShelfFolderPaths: vi.fn(),
  updateOfficeShelfFolder: vi.fn(),
}))
vi.mock('@/lib/projects/folder-service', () => ({
  listProjectFolders: vi.fn(),
  createProjectFolder: vi.fn(),
  ensureProjectFolderPaths: vi.fn(),
  updateProjectFolder: vi.fn(),
}))
vi.mock('@/lib/documents/move-to-folder', () => ({ moveDocumentToFolder: vi.fn() }))
vi.mock('@/lib/assignments/service', () => ({ listAssignmentCandidates: vi.fn(), addResourceAssignment: vi.fn() }))
vi.mock('@/lib/proposals/live', () => ({ publishProposalDecided: vi.fn(async () => undefined) }))
vi.mock('@/lib/proposals/attention', () => ({
  onProposalCreated: vi.fn(async () => undefined),
  onProposalDecided: vi.fn(async () => undefined),
}))
vi.mock('@/lib/langfuse/decision-score', () => ({ recordDecisionScore: vi.fn(async () => undefined) }))
vi.mock('@/lib/projects/service', () => ({
  MEMORY_WRITE_PERMISSIONS: ['project:memory:write', 'project:edit'],
  addProjectMemoryItem: vi.fn(),
  createOrganizationMemoryItem: vi.fn(),
}))
vi.mock('@/lib/project-profile/profile-service', () => ({ patchProjectProfile: vi.fn() }))
vi.mock('@/lib/conversations/cross-project-use', () => ({ requireMayRememberFrom: vi.fn(async () => undefined) }))
vi.mock('@/lib/conversations/restricted-egress', () => ({ requireMayLeaveConversation: vi.fn(async () => undefined) }))
vi.mock('@/i18n/server', () => ({ getLocale: vi.fn(async () => 'de') }))
vi.mock('@/lib/limits/enforce', async (original) => ({
  ...(await original<typeof import('@/lib/limits/enforce')>()),
  enforceLimit: vi.fn(async () => undefined),
}))
vi.mock('@/lib/proposals/repository', () => ({
  insertProposedChange: vi.fn(),
  findProposedChange: vi.fn(),
  claimProposedChange: vi.fn(),
  settleProposedChange: vi.fn(),
  releaseProposedChange: vi.fn(),
  dismissProposedChange: vi.fn(),
  listShelfProposals: vi.fn(),
  deleteUndecidedProposedChange: vi.fn(),
}))

import { UnprocessableError } from '@/lib/api/errors'
import { ensureOfficeShelfFolderPaths, listOfficeShelfFolders, updateOfficeShelfFolder } from '@/lib/office-shelf/folder-service'
import { resolveOfficeShelfDocumentsByName } from '@/lib/office-shelf/service'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { ProposedChangeRow } from '@/lib/db/schema/proposed-changes'
import { moveDocumentToFolder } from '@/lib/documents/move-to-folder'
import { resolveProjectDocumentsByName } from '@/lib/documents/service'
import type { ListedDocument } from '@/lib/documents/shelf-listing'
import { recordDecisionScore } from '@/lib/langfuse/decision-score'
import {
  ensureProjectFolderPaths,
  listProjectFolders,
  updateProjectFolder,
  type ProjectFolderRow,
} from '@/lib/projects/folder-service'
import { onProposalDecided } from '@/lib/proposals/attention'
import { applyProposal, getProposal, listOpenProposals, ProposalRequestError } from '@/lib/proposals/client'
import {
  claimProposedChange,
  deleteUndecidedProposedChange,
  findProposedChange,
  insertProposedChange,
  listShelfProposals,
  settleProposedChange,
} from '@/lib/proposals/repository'
import { createProposal, withdrawProposal } from '@/lib/proposals/service'
import type { FileOperationPayload } from '@/lib/proposals/types'

import { GET as list } from './route'
import { GET as one } from './[id]/route'
import { POST as apply } from './[id]/apply/route'

type Handler = (request: Request, context?: { params?: Promise<Record<string, string>> }) => Promise<Response>

const ROUTES: Array<{ pattern: RegExp; method: string; handler: Handler }> = [
  { pattern: /^\/api\/proposals$/, method: 'GET', handler: list },
  { pattern: /^\/api\/proposals\/([^/]+)$/, method: 'GET', handler: one },
  { pattern: /^\/api\/proposals\/([^/]+)\/apply$/, method: 'POST', handler: apply },
]

const run = async (path: string, init?: RequestInit) => {
  const url = new URL(path, 'https://grid.test')
  const method = init?.method ?? 'GET'
  const route = ROUTES.find((entry) => entry.pattern.test(url.pathname) && entry.method === method)
  if (!route) throw new Error(`no route for ${method} ${url.pathname}`)
  const matched = route.pattern.exec(url.pathname) as RegExpExecArray
  return route.handler(new Request(url, init), { params: Promise.resolve({ id: decodeURIComponent(matched[1] ?? '') }) })
}

const PROJECT = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
const FILING = '0b7c8f5e-1d1e-4c39-9d2c-3f0f6c1a2b3c'
const OFFICE_SHELF = '1c8d9f6e-2e2f-4d4a-8e3d-4a1f7d2b3c4d'

const FILING_MOVE: FileOperationPayload = {
  operation: 'move',
  operations: [
    { document: 'MA37_Bescheid.pdf', source: 'project', target_folder: 'Behörde/Bescheide', reason: 'Ein Bescheid.' },
    { document: 'Stellungnahme.pdf', source: 'project', target_folder: 'Behörde/Bescheide', reason: 'Eine Stellungnahme.' },
  ],
  basis: 'name',
  new_folder: { path: 'Behörde/Bescheide', description: 'Bescheide und Stellungnahmen der Behörden' },
}

const OFFICE_SHELF_MOVE: FileOperationPayload = {
  operation: 'move',
  operations: [{ document: 'ÖNORM B 1800.pdf', source: 'office', target_folder: 'Normen', reason: 'Eine Norm.' }],
  basis: 'content',
}

const row = (id: string, extra: Partial<ProposedChangeRow> = {}): ProposedChangeRow => ({
  id,
  organizationId: 'org_1',
  projectId: PROJECT,
  scope: 'project',
  kind: 'file_operation',
  payload: FILING_MOVE,
  status: 'proposed',
  proposedByKind: 'piloti',
  onBehalfOf: 'user_1',
  originConversationId: null,
  originMessageId: null,
  originCardIndex: null,
  createdAt: new Date('2026-10-13T08:00:00Z'),
  decidedBy: null,
  decidedAt: null,
  results: null,
  applyingBy: null,
  applyingSince: null,
  originTraceId: 'trace-filing',
  ...extra,
})

const listed = (id: string, filename: string) =>
  ({ id, filename, createdAt: new Date('2026-10-01T08:00:00Z') }) as Partial<ListedDocument> as ListedDocument

const folder = (id: string, path: string) =>
  ({ id, path, name: path.split('/').at(-1), parentId: null, projectId: PROJECT }) as Partial<ProjectFolderRow> as ProjectFolderRow

let store: Map<string, ProposedChangeRow>

beforeEach(() => {
  vi.clearAllMocks()
  SESSION.permissions = []
  store = new Map([
    [FILING, row(FILING)],
    [OFFICE_SHELF, row(OFFICE_SHELF, { projectId: null, scope: 'office_shelf', payload: OFFICE_SHELF_MOVE })],
  ])
  vi.mocked(findProposedChange).mockImplementation(async (_org, id) => store.get(id) ?? null)
  vi.mocked(listShelfProposals).mockImplementation(async (_org, shelf) =>
    [...store.values()].filter((entry) => (shelf.scope === 'project' ? entry.projectId === shelf.projectId : entry.scope === shelf.scope))
  )
  vi.mocked(claimProposedChange).mockImplementation(async (_org, id, userId) => {
    const current = store.get(id)
    if (!current || current.status !== 'proposed') return null
    const next = { ...current, applyingBy: userId, applyingSince: new Date() }
    store.set(id, next)
    return next
  })
  vi.mocked(settleProposedChange).mockImplementation(async (_org, claim, outcome) => {
    const current = store.get(claim.id)
    if (!current) return null
    const next = { ...current, ...outcome, decidedBy: claim.applyingBy, decidedAt: new Date(), applyingBy: null, applyingSince: null }
    store.set(claim.id, next)
    return next
  })
  vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor', closed: false, readsBecauseClosed: false })
  vi.mocked(resolveProjectDocumentsByName).mockImplementation(async (_session, _project, names) =>
    names.flatMap((name) =>
      name === 'MA37_Bescheid.pdf' ? [listed('doc_1', name)] : name === 'Stellungnahme.pdf' ? [listed('doc_2', name)] : []
    )
  )
  vi.mocked(resolveOfficeShelfDocumentsByName).mockImplementation(async (_session, names) =>
    names.flatMap((name) => (name === 'ÖNORM B 1800.pdf' ? [listed('doc_n', name)] : []))
  )
  vi.mocked(listProjectFolders).mockResolvedValue([folder('f_behoerde', 'Behörde')])
  vi.mocked(listOfficeShelfFolders).mockResolvedValue([folder('f_normen', 'Normen')])
  vi.mocked(moveDocumentToFolder).mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof moveDocumentToFolder>>)
})

describe('GET /api/proposals', () => {
  it('lists a project’s open proposals with the documents they name, resolved for the reader', async () => {
    const { proposals } = await listOpenProposals({ projectId: PROJECT }, run)
    expect(proposals).toHaveLength(1)
    expect(proposals[0].proposal).toMatchObject({ id: FILING, projectId: PROJECT, canDecide: true, originConversationId: null })
    expect(proposals[0].documents).toEqual([
      { id: 'doc_1', name: 'MA37_Bescheid.pdf' },
      { id: 'doc_2', name: 'Stellungnahme.pdf' },
    ])
    expect(listShelfProposals).toHaveBeenCalledWith('org_1', { scope: 'project', projectId: PROJECT }, {
      statuses: ['proposed'],
      kind: undefined,
      limit: 50,
    })
  })

  it('leaves out a proposal naming a document the reader cannot open (held, or in a folder hidden from them)', async () => {
    vi.mocked(resolveProjectDocumentsByName).mockResolvedValue([listed('doc_1', 'MA37_Bescheid.pdf')])
    expect((await listOpenProposals({ projectId: PROJECT }, run)).proposals).toEqual([])
  })

  it('lists the Büroablage’s with no project, to any member, decidable by its curators only', async () => {
    const forMember = await listOpenProposals({ shelf: 'office_shelf' }, run)
    expect(forMember.proposals.map((entry) => [entry.proposal.id, entry.proposal.projectId, entry.proposal.canDecide])).toEqual([
      [OFFICE_SHELF, null, false],
    ])
    expect(requireProjectAccess).not.toHaveBeenCalled()
    SESSION.permissions = ['org:archiv:manage']
    expect((await listOpenProposals({ shelf: 'office_shelf' }, run)).proposals[0].proposal.canDecide).toBe(true)
  })

  it('refuses a query that names no shelf, or two', async () => {
    expect((await run('/api/proposals')).status).toBe(400)
    expect((await run(`/api/proposals?projectId=${PROJECT}&shelf=archiv`)).status).toBe(400)
    expect((await run(`/api/proposals?projectId=${PROJECT}&shelf=organization`)).status).toBe(400)
    expect((await run('/api/proposals?shelf=project')).status).toBe(400)
  })

  it('lists the organization’s shelf (0174), which has no project either', async () => {
    const res = await run('/api/proposals?shelf=organization')
    expect(res.status).toBe(200)
    expect(listShelfProposals).toHaveBeenCalledWith('org_1', { scope: 'organization' }, expect.objectContaining({ statuses: ['proposed'] }))
  })
})

describe('a proposal no conversation made', () => {
  it('is read through its documents: one the reader cannot resolve is a 404', async () => {
    expect((await getProposal(FILING, run)).proposal.id).toBe(FILING)
    vi.mocked(resolveProjectDocumentsByName).mockResolvedValue([])
    await expect(getProposal(FILING, run)).rejects.toBeInstanceOf(ProposalRequestError)
    await expect(getProposal(FILING, run)).rejects.toMatchObject({ status: 404 })
  })

  it('creates the new folder with its description and files every item into it, in one confirm', async () => {
    vi.mocked(ensureProjectFolderPaths).mockResolvedValue({
      ok: true,
      folders: [folder('f_bescheide', 'Behörde/Bescheide')],
      folderIdByPath: { 'Behörde/Bescheide': 'f_bescheide' },
    })
    vi.mocked(updateProjectFolder).mockResolvedValue({ ok: true, folder: folder('f_bescheide', 'Behörde/Bescheide') })
    const { proposal } = await applyProposal(FILING, run)
    expect(proposal.status).toBe('applied')
    expect(ensureProjectFolderPaths).toHaveBeenCalledTimes(1)
    expect(ensureProjectFolderPaths).toHaveBeenCalledWith(
      { projectId: PROJECT, parentId: null, paths: ['Behörde/Bescheide'] },
      SESSION
    )
    expect(updateProjectFolder).toHaveBeenCalledWith(
      { projectId: PROJECT, folderId: 'f_bescheide', description: 'Bescheide und Stellungnahmen der Behörden' },
      SESSION
    )
    expect(vi.mocked(moveDocumentToFolder).mock.calls.map(([input]) => input)).toEqual([
      { documentId: 'doc_1', folderId: 'f_bescheide' },
      { documentId: 'doc_2', folderId: 'f_bescheide' },
    ])
    // The judgement's trace carries the decision, as a turn's does for a card.
    await vi.waitFor(() =>
      expect(recordDecisionScore).toHaveBeenCalledWith(expect.objectContaining({ decision: 'accepted', traceId: 'trace-filing' }))
    )
  })

  it('uses a folder somebody made meanwhile as it is, and fails every item when the folder cannot be made', async () => {
    vi.mocked(ensureProjectFolderPaths).mockResolvedValueOnce({
      ok: true,
      folders: [],
      folderIdByPath: { 'Behörde/Bescheide': 'f_theirs' },
    })
    await applyProposal(FILING, run)
    expect(updateProjectFolder).not.toHaveBeenCalled()
    expect(moveDocumentToFolder).toHaveBeenCalledWith({ documentId: 'doc_1', folderId: 'f_theirs' }, SESSION)

    store.set(FILING, row(FILING))
    vi.mocked(moveDocumentToFolder).mockClear()
    vi.mocked(ensureProjectFolderPaths).mockResolvedValueOnce({ ok: false, error: 'Write access needed' })
    const { proposal } = await applyProposal(FILING, run)
    expect(proposal.status).toBe('failed')
    expect(proposal.results?.map((result) => result.reason)).toEqual(['Write access needed', 'Write access needed'])
    expect(moveDocumentToFolder).not.toHaveBeenCalled()
  })
})

describe('the Büroablage', () => {
  it('is decided by its curators: a member gets a 403', async () => {
    await expect(applyProposal(OFFICE_SHELF, run)).rejects.toMatchObject({ status: 403 })
    SESSION.permissions = ['org:archiv:manage']
    const { proposal } = await applyProposal(OFFICE_SHELF, run)
    expect(proposal.status).toBe('applied')
    expect(moveDocumentToFolder).toHaveBeenCalledWith({ documentId: 'doc_n', folderId: 'f_normen' }, SESSION)
    expect(ensureOfficeShelfFolderPaths).not.toHaveBeenCalled()
    expect(updateOfficeShelfFolder).not.toHaveBeenCalled()
  })

  it('is filed with no project, and only as a move of its own documents', async () => {
    vi.mocked(insertProposedChange).mockImplementation(async (input) => ({
      row: row('new', { ...input, payload: input.payload as FileOperationPayload }),
      created: true,
    }))
    await createProposal(SESSION, {
      projectId: null,
      kind: 'file_operation',
      payload: OFFICE_SHELF_MOVE,
      conversationId: null,
      answerMessageId: null,
    })
    expect(insertProposedChange).toHaveBeenCalledWith(expect.objectContaining({ projectId: null, scope: 'office_shelf' }))
    await expect(
      createProposal(SESSION, {
        projectId: null,
        kind: 'file_operation',
        payload: { operation: 'move', operations: [{ document: 'a.pdf', source: 'project', target_folder: 'X' }] },
        conversationId: null,
        answerMessageId: null,
      })
    ).rejects.toBeInstanceOf(UnprocessableError)
  })
})

describe('withdrawProposal', () => {
  it('deletes an undecided proposal and settles its inbox item; a decided one is not matched', async () => {
    vi.mocked(deleteUndecidedProposedChange).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    expect(await withdrawProposal('org_1', FILING)).toBe(true)
    await vi.waitFor(() => expect(onProposalDecided).toHaveBeenCalledWith({ organizationId: 'org_1', proposalId: FILING }))
    vi.mocked(onProposalDecided).mockClear()
    expect(await withdrawProposal('org_1', FILING)).toBe(false)
    expect(onProposalDecided).not.toHaveBeenCalled()
  })
})

describe('a new folder in a proposal', () => {
  it('is refused unless it is the target of every item of a move', async () => {
    await expect(
      createProposal(SESSION, {
        projectId: PROJECT,
        kind: 'file_operation',
        payload: {
          ...FILING_MOVE,
          operations: [{ ...FILING_MOVE.operations[0], target_folder: 'Anderswo' }, FILING_MOVE.operations[1]],
        },
        conversationId: null,
        answerMessageId: null,
      })
    ).rejects.toMatchObject({ details: { reason: 'proposal-new-folder-mismatch' } })
  })
})
