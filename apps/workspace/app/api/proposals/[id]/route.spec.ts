/**
 * @vitest-environment node
 */
/**
 * The proposed-change routes and their service, driven through the TYPED
 * CLIENT (ADR-0055): the card uses the same functions, so a path or a field the
 * two disagreed on would fail here.
 *
 * The repository is an in-memory fake that keeps the compare-and-swap honest
 * (a transition from anything but `proposed`, or past a live claim, finds no
 * row) and checks every row against the CHECKs of migration 0140. The
 * document, folder, assignment, memory and profile services are mocked at
 * their seams; what is under test is that applying calls THEM, with the
 * deciding person's session, in order, resolving names and paths the way the
 * browser did, and records each item's outcome; and that each kind is decided
 * with the right its own service writes with.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const SESSION = vi.hoisted(() => ({
  userId: 'user_1',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  email: 'anna@example.test',
  name: 'Anna Berger',
  role: 'member',
  permissions: [] as string[],
}))

vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn(async () => SESSION) }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/sharing/access', () => ({ requireResourceAccess: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/conversations/repository', () => ({ findConversationInOrg: vi.fn() }))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))
vi.mock('@/lib/documents/document-edits', () => ({
  renameDocument: vi.fn(),
}))
vi.mock('@/lib/documents/document-listing', () => ({
  resolveProjectDocumentsByName: vi.fn(),
}))
vi.mock('@/lib/office-shelf/service', () => ({ resolveOfficeShelfDocumentsByName: vi.fn() }))
vi.mock('@/lib/office-shelf/folder-service', () => ({ listOfficeShelfFolders: vi.fn() }))
vi.mock('@/lib/projects/folder-service', () => ({ listProjectFolders: vi.fn(), createProjectFolder: vi.fn() }))
vi.mock('@/lib/documents/move-to-folder', () => ({ moveDocumentToFolder: vi.fn() }))
vi.mock('@/lib/assignments/service', () => ({
  listAssignmentCandidates: vi.fn(),
  addResourceAssignment: vi.fn(),
}))
vi.mock('@/lib/proposals/live', () => ({ publishProposalDecided: vi.fn(async () => undefined) }))
vi.mock('@/lib/proposals/attention', () => ({
  onProposalCreated: vi.fn(async () => undefined),
  onProposalDecided: vi.fn(async () => undefined),
}))
vi.mock('@/lib/langfuse/decision-score', () => ({ recordDecisionScore: vi.fn(async () => undefined) }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/projects/service', () => ({
  MEMORY_WRITE_PERMISSIONS: ['project:memory:write', 'project:edit'],
  addProjectMemoryItem: vi.fn(),
  createOrganizationMemoryItem: vi.fn(),
}))
vi.mock('@/lib/project-profile/profile-service', () => ({ patchProjectProfile: vi.fn() }))
vi.mock('@/lib/conversations/cross-project-use', () => ({ requireMayRememberFrom: vi.fn(async () => undefined) }))
vi.mock('@/lib/conversations/restricted-egress', () => ({ requireMayLeaveConversation: vi.fn(async () => undefined) }))
vi.mock('@/i18n/server', () => ({ getLocale: vi.fn(async () => 'de') }))
// Every spec here clicks as the same person; the mutation budget is not under test.
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
}))

import {
  BadRequestError,
  ConflictError,
  ConversationConfinedError,
  CrossProjectMemoryError,
  ForbiddenError,
  NotFoundError,
} from '@/lib/api/errors'
import { addResourceAssignment, listAssignmentCandidates } from '@/lib/assignments/service'
import { listOfficeShelfFolders } from '@/lib/office-shelf/folder-service'
import { resolveOfficeShelfDocumentsByName } from '@/lib/office-shelf/service'
import { requireProjectAccess } from '@/lib/authz/projects'
import { requireMayRememberFrom } from '@/lib/conversations/cross-project-use'
import { findConversationInOrg } from '@/lib/conversations/repository'
import type { Conversation } from '@/lib/db/schema/conversations'
import { requireMayLeaveConversation } from '@/lib/conversations/restricted-egress'
import type { ProjectMemoryItem } from '@/lib/db/schema/project-memory'
import type { ProposedChangeRow } from '@/lib/db/schema/proposed-changes'
import { patchProjectProfile, type PatchedProjectProfile } from '@/lib/project-profile/profile-service'
import { addProjectMemoryItem, createOrganizationMemoryItem } from '@/lib/projects/service'
import { moveDocumentToFolder } from '@/lib/documents/move-to-folder'
import { renameDocument } from '@/lib/documents/document-edits'
import { resolveProjectDocumentsByName } from '@/lib/documents/document-listing'
import type { ListedDocument } from '@/lib/documents/shelf-listing'
import { createProjectFolder, listProjectFolders, type ProjectFolderRow } from '@/lib/projects/folder-service'
import { applyProposal, dismissProposal, getProposal, ProposalRequestError } from '@/lib/proposals/client'
import { recordDecisionScore } from '@/lib/langfuse/decision-score'
import { recordAuditEvent, type AuditEventInput } from '@/lib/audit/service'
import { expectRegistered } from '@/test-utils/audit'
import { onProposalCreated, onProposalDecided } from '@/lib/proposals/attention'
import { publishProposalDecided } from '@/lib/proposals/live'
import {
  claimProposedChange,
  dismissProposedChange,
  findProposedChange,
  insertProposedChange,
  releaseProposedChange,
  settleProposedChange,
} from '@/lib/proposals/repository'
import { createProposal } from '@/lib/proposals/service'
import type { FileOperationPayload, MemoryPayload, ProjectProfilePayload } from '@/lib/proposals/types'
import { requireResourceAccess } from '@/lib/sharing/access'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import type { DirectoryPerson } from '@/lib/sharing/types'

import { GET } from './route'
import { POST as apply } from './apply/route'
import { POST as dismiss } from './dismiss/route'

type Handler = (request: Request, context?: { params?: Promise<Record<string, string>> }) => Promise<Response>

const ROUTES: Array<{ pattern: RegExp; method: string; handler: Handler }> = [
  { pattern: /^\/api\/proposals\/([^/]+)$/, method: 'GET', handler: GET },
  { pattern: /^\/api\/proposals\/([^/]+)\/apply$/, method: 'POST', handler: apply },
  { pattern: /^\/api\/proposals\/([^/]+)\/dismiss$/, method: 'POST', handler: dismiss },
]

const run = async (path: string, init?: RequestInit) => {
  const url = new URL(path, 'https://grid.test')
  const method = init?.method ?? 'GET'
  const route = ROUTES.find((entry) => entry.pattern.test(url.pathname) && entry.method === method)
  if (!route) throw new Error(`no route for ${method} ${url.pathname}`)
  const matched = route.pattern.exec(url.pathname) as RegExpExecArray
  return route.handler(new Request(url, init), { params: Promise.resolve({ id: decodeURIComponent(matched[1]) }) })
}

const ID = '0b7c8f5e-1d1e-4c39-9d2c-3f0f6c1a2b3c'
const PROJECT = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
const CONVERSATION = 'conv_1'

const MOVE: FileOperationPayload = {
  operation: 'move',
  operations: [
    { document: 'Grundriss EG.pdf', source: 'project', target_folder: 'Einreichung/Pläne' },
    { document: 'Schnitt A-A.pdf', source: 'project', target_folder: 'Einreichung/Pläne' },
  ],
}

const row = (extra: Partial<ProposedChangeRow> = {}): ProposedChangeRow => ({
  id: ID,
  organizationId: 'org_1',
  projectId: PROJECT,
  scope: 'project',
  kind: 'file_operation',
  payload: MOVE,
  status: 'proposed',
  proposedByKind: 'piloti',
  onBehalfOf: 'user_2',
  originConversationId: CONVERSATION,
  originMessageId: '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
  originCardIndex: null,
  createdAt: new Date('2026-10-13T08:00:00Z'),
  decidedBy: null,
  decidedAt: null,
  results: null,
  applyingBy: null,
  applyingSince: null,
  originTraceId: null,
  ...extra,
})

/** The migration's CHECKs, held against every row the fake stores. */
function assertChecks(stored: ProposedChangeRow): void {
  const decided = stored.status !== 'proposed'
  expect(decided, 'proposed_changes_decision_complete').toBe(stored.decidedBy !== null)
  expect(stored.decidedBy === null, 'proposed_changes_decision_complete').toBe(stored.decidedAt === null)
  expect(
    ['applied', 'partially_applied', 'failed'].includes(stored.status),
    'proposed_changes_results_when_applied'
  ).toBe(stored.results !== null)
  expect(stored.applyingBy === null, 'proposed_changes_claim_complete').toBe(stored.applyingSince === null)
  if (stored.applyingBy !== null) expect(stored.status, 'proposed_changes_claim_while_proposed').toBe('proposed')
}

/** An in-memory `proposed_changes` with the repository's compare-and-swap. */
let store: Map<string, ProposedChangeRow>
const put = (next: ProposedChangeRow) => {
  assertChecks(next)
  store.set(next.id, next)
  return next
}
const undecided = (current: ProposedChangeRow | undefined, staleBefore: Date) =>
  current &&
  current.status === 'proposed' &&
  (current.applyingSince === null || current.applyingSince.getTime() < staleBefore.getTime())

const person = (userId: string, name: string, email: string): DirectoryPerson => ({
  userId,
  name,
  email,
  profilePictureUrl: null,
})

const listed = (id: string, filename: string, createdAt = '2026-10-01T08:00:00Z') =>
  ({ id, filename, createdAt: new Date(createdAt) }) as Partial<ListedDocument> as ListedDocument

const folder = (id: string, path: string) =>
  ({ id, path, name: path.split('/').at(-1), parentId: null, projectId: PROJECT }) as Partial<ProjectFolderRow> as ProjectFolderRow

beforeEach(() => {
  vi.clearAllMocks()
  store = new Map([[ID, row()]])
  vi.mocked(findProposedChange).mockImplementation(async (_org, id) => store.get(id) ?? null)
  vi.mocked(claimProposedChange).mockImplementation(async (_org, id, userId, staleBefore) => {
    const current = store.get(id)
    if (!undecided(current, staleBefore) || !current) return null
    return put({ ...current, applyingBy: userId, applyingSince: new Date() })
  })
  vi.mocked(settleProposedChange).mockImplementation(async (_org, claim, outcome) => {
    const current = store.get(claim.id)
    if (!current || current.status !== 'proposed' || current.applyingBy !== claim.applyingBy) return null
    return put({
      ...current,
      ...outcome,
      decidedBy: claim.applyingBy,
      decidedAt: new Date(),
      applyingBy: null,
      applyingSince: null,
    })
  })
  vi.mocked(releaseProposedChange).mockImplementation(async (_org, claim) => {
    const current = store.get(claim.id)
    if (current?.applyingBy === claim.applyingBy) put({ ...current, applyingBy: null, applyingSince: null })
  })
  vi.mocked(dismissProposedChange).mockImplementation(async (_org, id, userId, staleBefore) => {
    const current = store.get(id)
    if (!undecided(current, staleBefore) || !current) return null
    return put({ ...current, status: 'dismissed', decidedBy: userId, decidedAt: new Date() })
  })

  vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor', closed: false, readsBecauseClosed: false })
  vi.mocked(requireResourceAccess).mockResolvedValue({} as never)
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(
    new Map([
      ['user_1', person('user_1', 'Anna Berger', 'anna@example.test')],
      ['user_2', person('user_2', 'Bernd Huber', 'bernd@example.test')],
    ])
  )
  vi.mocked(resolveProjectDocumentsByName).mockImplementation(async (_session, _project, names) =>
    names.flatMap((name) => {
      if (name.toLowerCase() === 'grundriss eg.pdf') {
        // A re-upload under the same name: the newer row is the one meant.
        return [listed('doc_old', 'Grundriss EG.pdf', '2026-01-01T08:00:00Z'), listed('doc_eg', 'grundriss eg.PDF')]
      }
      if (name === 'Schnitt A-A.pdf') return [listed('doc_aa', 'Schnitt A-A.pdf')]
      return []
    })
  )
  vi.mocked(listProjectFolders).mockResolvedValue([folder('f_ein', 'Einreichung'), folder('f_plaene', 'Einreichung/Pläne')])
  vi.mocked(moveDocumentToFolder).mockImplementation(async ({ documentId, folderId }) => ({
    ok: true,
    document: { id: documentId, folderId },
  }))
})

/** The decider may read the project but not write it. */
const readOnly = () =>
  vi.mocked(requireProjectAccess).mockImplementation(async (_session, _project, permission) => {
    if (permission === 'project:view') return { role: 'project-viewer', closed: false, readsBecauseClosed: false }
    throw new NotFoundError()
  })

describe('GET /api/proposals/[id]', () => {
  it('reads the proposal with the names of who it was made for, and says the reader may decide', async () => {
    const { proposal } = await getProposal(ID, run)

    expect(proposal).toMatchObject({
      id: ID,
      projectId: PROJECT,
      kind: 'file_operation',
      status: 'proposed',
      proposedByKind: 'piloti',
      onBehalfOf: 'user_2',
      onBehalfOfName: 'Bernd Huber',
      originConversationId: CONVERSATION,
      decidedBy: null,
      results: null,
      canDecide: true,
      payload: MOVE,
    })
    expect(requireProjectAccess).toHaveBeenCalledWith(SESSION, PROJECT, 'project:view')
    expect(requireResourceAccess).toHaveBeenCalledWith(SESSION, 'conversation', CONVERSATION, 'viewer')
  })

  it('shows a read-only reader the proposal without the controls', async () => {
    readOnly()
    const { proposal } = await getProposal(ID, run)
    expect(proposal.canDecide).toBe(false)
  })

  it('is a 404 to a reader without the project, and to one without the conversation it was made in', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new NotFoundError())
    await expect(getProposal(ID, run)).rejects.toMatchObject({ status: 404 })

    vi.mocked(requireResourceAccess).mockRejectedValueOnce(new NotFoundError())
    await expect(getProposal(ID, run)).rejects.toMatchObject({ status: 404 })
  })

  it('is a 404 for an id that is not there', async () => {
    store.clear()
    await expect(getProposal(ID, run)).rejects.toBeInstanceOf(ProposalRequestError)
    await expect(getProposal(ID, run)).rejects.toMatchObject({ status: 404 })
  })

  it('does not offer a decision while somebody is applying it', async () => {
    store.set(ID, row({ applyingBy: 'user_2', applyingSince: new Date() }))
    const { proposal } = await getProposal(ID, run)
    expect(proposal).toMatchObject({ status: 'proposed', canDecide: false })
  })
})

describe('POST /api/proposals/[id]/apply', () => {
  it('moves each document through the move service, as the decider, resolving names and paths', async () => {
    const { proposal } = await applyProposal(ID, run)

    expect(moveDocumentToFolder).toHaveBeenNthCalledWith(1, { documentId: 'doc_eg', folderId: 'f_plaene' }, SESSION)
    expect(moveDocumentToFolder).toHaveBeenNthCalledWith(2, { documentId: 'doc_aa', folderId: 'f_plaene' }, SESSION)
    expect(resolveProjectDocumentsByName).toHaveBeenCalledWith(SESSION, PROJECT, ['Grundriss EG.pdf'])
    expect(listProjectFolders).toHaveBeenCalledTimes(1)
    expect(proposal).toMatchObject({
      status: 'applied',
      decidedBy: 'user_1',
      decidedByName: 'Anna Berger',
      canDecide: false,
      results: [
        { label: 'Grundriss EG.pdf', ok: true },
        { label: 'Schnitt A-A.pdf', ok: true },
      ],
    })
    expect(proposal.decidedAt).not.toBeNull()
  })

  it('is a 409 the second time: a double click applies once', async () => {
    await applyProposal(ID, run)
    await expect(applyProposal(ID, run)).rejects.toMatchObject({ status: 409, code: 'CONFLICT' })
    expect(moveDocumentToFolder).toHaveBeenCalledTimes(2)
  })

  it('lets one of two clicks at the same moment apply, and refuses the other', async () => {
    const outcomes = await Promise.allSettled([applyProposal(ID, run), applyProposal(ID, run)])
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
    expect(moveDocumentToFolder).toHaveBeenCalledTimes(2)
  })

  it('records a partial apply item by item, and does not stop at the first failure', async () => {
    store.set(
      ID,
      row({
        payload: {
          operation: 'move',
          operations: [
            { document: 'Fehlt.pdf', target_folder: 'Einreichung' },
            { document: 'Schnitt A-A.pdf', target_folder: 'Einreichung' },
          ],
        },
      })
    )

    const { proposal } = await applyProposal(ID, run)

    expect(proposal.status).toBe('partially_applied')
    expect(proposal.results).toEqual([
      { label: 'Fehlt.pdf', ok: false, reason: '„Fehlt.pdf“ wurde nicht gefunden' },
      { label: 'Schnitt A-A.pdf', ok: true },
    ])
  })

  it('is `failed` when no item went through, with the service’s own refusal as the reason', async () => {
    vi.mocked(moveDocumentToFolder).mockResolvedValue({ ok: false, error: 'Folder not found in this project.' })

    const { proposal } = await applyProposal(ID, run)

    expect(proposal.status).toBe('failed')
    expect(proposal.results?.every((result) => !result.ok && result.reason === 'Folder not found in this project.')).toBe(
      true
    )
  })

  it('fails a move into a folder that is gone, by its path', async () => {
    store.set(
      ID,
      row({ payload: { operation: 'move', operations: [{ document: 'Schnitt A-A.pdf', target_folder: 'Archiv/Alt' }] } })
    )
    const { proposal } = await applyProposal(ID, run)
    expect(proposal.results).toEqual([
      { label: 'Schnitt A-A.pdf', ok: false, reason: 'Ordner „Archiv/Alt“ existiert nicht (mehr)' },
    ])
    expect(moveDocumentToFolder).not.toHaveBeenCalled()
  })

  it('moves an Archiv document within the Archiv’s own folders, and to the root on an empty path', async () => {
    vi.mocked(resolveOfficeShelfDocumentsByName).mockResolvedValue([listed('doc_b', 'Vorlage.docx')])
    vi.mocked(listOfficeShelfFolders).mockResolvedValue([folder('a_vorlagen', 'Vorlagen')])
    store.set(
      ID,
      row({
        payload: {
          operation: 'move',
          operations: [
            { document: 'Vorlage.docx', source: 'office', target_folder: 'Vorlagen' },
            { document: 'Vorlage.docx', source: 'office', target_folder: '' },
          ],
        },
      })
    )

    const { proposal } = await applyProposal(ID, run)

    expect(proposal.status).toBe('applied')
    expect(moveDocumentToFolder).toHaveBeenNthCalledWith(1, { documentId: 'doc_b', folderId: 'a_vorlagen' }, SESSION)
    expect(moveDocumentToFolder).toHaveBeenNthCalledWith(2, { documentId: 'doc_b', folderId: null }, SESSION)
    expect(listProjectFolders).not.toHaveBeenCalled()
  })

  it('renames through the rename service, with the request for its audit trail', async () => {
    store.set(
      ID,
      row({
        payload: {
          operation: 'rename',
          operations: [{ document: 'Schnitt A-A.pdf', new_display_name: 'Schnitt A-A Einreichung' }],
        },
      })
    )
    vi.mocked(renameDocument).mockResolvedValue({ id: 'doc_aa', filename: 'Schnitt A-A.pdf', displayName: 'x' })

    const { proposal } = await applyProposal(ID, run)

    expect(renameDocument).toHaveBeenCalledWith(SESSION, 'doc_aa', 'Schnitt A-A Einreichung', expect.any(Request))
    expect(proposal.status).toBe('applied')
  })

  it('creates a folder under the parent its path names', async () => {
    store.set(
      ID,
      row({
        payload: { operation: 'create_folder', operations: [{ folder_name: 'Statik', parent_folder: 'Einreichung' }] },
      })
    )
    vi.mocked(createProjectFolder).mockResolvedValue({ ok: true, folder: folder('f_new', 'Einreichung/Statik') })

    const { proposal } = await applyProposal(ID, run)

    expect(createProjectFolder).toHaveBeenCalledWith({ projectId: PROJECT, parentId: 'f_ein', name: 'Statik' }, SESSION)
    expect(proposal.results).toEqual([{ label: 'Einreichung/Statik', ok: true }])
  })

  it('assigns the one member the name means, the decider included, and refuses an ambiguous name', async () => {
    vi.mocked(listAssignmentCandidates).mockResolvedValue([
      person('user_2', 'Bernd Huber', 'bernd@example.test'),
      person('user_3', 'Chris Maier', 'chris@example.test'),
      person('user_4', 'Chris Maier', 'chris.m@example.test'),
    ])
    vi.mocked(addResourceAssignment).mockResolvedValue([])
    store.set(
      ID,
      row({
        payload: {
          operation: 'assign',
          operations: [
            { document: 'Schnitt A-A.pdf', member: 'bernd@example.test' },
            { document: 'Schnitt A-A.pdf', member: 'Anna Berger' },
            { document: 'Schnitt A-A.pdf', member: 'Chris Maier' },
            { document: 'Schnitt A-A.pdf', member: 'Dora' },
          ],
        },
      })
    )

    const { proposal } = await applyProposal(ID, run)

    expect(addResourceAssignment).toHaveBeenNthCalledWith(1, SESSION, 'document', 'doc_aa', 'user_2', expect.any(Request))
    expect(addResourceAssignment).toHaveBeenNthCalledWith(2, SESSION, 'document', 'doc_aa', 'user_1', expect.any(Request))
    expect(proposal.status).toBe('partially_applied')
    expect(proposal.results?.map((result) => result.reason ?? 'ok')).toEqual([
      'ok',
      'ok',
      '„Chris Maier“ ist im Projekt mehrfach vergeben',
      '„Dora“ ist kein Mitglied dieses Projekts',
    ])
  })

  it('refuses a reader who may not write the project, before anything is claimed or run', async () => {
    readOnly()
    await expect(applyProposal(ID, run)).rejects.toMatchObject({ status: 403 })
    expect(claimProposedChange).not.toHaveBeenCalled()
    expect(moveDocumentToFolder).not.toHaveBeenCalled()
  })

  it('refuses a closed project with its own 403', async () => {
    vi.mocked(requireProjectAccess).mockImplementation(async (_session, _project, permission) => {
      if (permission === 'project:view') return { role: 'project-editor', closed: true, readsBecauseClosed: false }
      throw new ForbiddenError('This project is closed and can only be read. Reopen it to change it.')
    })
    await expect(applyProposal(ID, run)).rejects.toMatchObject({ status: 403 })
    expect(claimProposedChange).not.toHaveBeenCalled()
  })

  it('is a 409 while a colleague is applying it, and gives a broken apply’s claim back', async () => {
    store.set(ID, row({ applyingBy: 'user_2', applyingSince: new Date() }))
    await expect(applyProposal(ID, run)).rejects.toMatchObject({ status: 409 })

    store.set(ID, row({ payload: { not: 'a payload' } }))
    await expect(applyProposal(ID, run)).rejects.toMatchObject({ status: 500 })
    expect(store.get(ID)).toMatchObject({ status: 'proposed', applyingBy: null, applyingSince: null })
  })

  it('takes over a claim that went stale', async () => {
    store.set(ID, row({ applyingBy: 'user_2', applyingSince: new Date(Date.now() - 6 * 60 * 1000) }))
    const { proposal } = await applyProposal(ID, run)
    expect(proposal).toMatchObject({ status: 'applied', decidedBy: 'user_1' })
  })
})

describe('POST /api/proposals/[id]/dismiss', () => {
  it('dismisses it in the reader’s name, and changes nothing in the workspace', async () => {
    const { proposal } = await dismissProposal(ID, run)

    expect(proposal).toMatchObject({ status: 'dismissed', decidedBy: 'user_1', results: null, canDecide: false })
    expect(moveDocumentToFolder).not.toHaveBeenCalled()
  })

  it('is a 409 once it is decided, either way round', async () => {
    await dismissProposal(ID, run)
    await expect(applyProposal(ID, run)).rejects.toMatchObject({ status: 409 })
    await expect(dismissProposal(ID, run)).rejects.toMatchObject({ status: 409 })

    store.set(ID, row())
    await applyProposal(ID, run)
    await expect(dismissProposal(ID, run)).rejects.toMatchObject({ status: 409 })
  })

  it('is a 409 while somebody is applying it', async () => {
    store.set(ID, row({ applyingBy: 'user_2', applyingSince: new Date() }))
    await expect(dismissProposal(ID, run)).rejects.toMatchObject({ status: 409 })
  })

  it('refuses a reader who may not write the project', async () => {
    readOnly()
    await expect(dismissProposal(ID, run)).rejects.toMatchObject({ status: 403 })
    expect(dismissProposedChange).not.toHaveBeenCalled()
  })
})

/** The side effects run unawaited after the commit; let them settle. */
const afterCommit = () => vi.waitFor(() => expect(publishProposalDecided).toHaveBeenCalled())

describe('what follows a decision (live card, inbox, Langfuse)', () => {
  const ORIGIN = { conversationId: CONVERSATION, messageId: '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d' }

  it('tells the live channel, the inbox and Langfuse when it is applied', async () => {
    await applyProposal(ID, run)
    await afterCommit()

    expect(publishProposalDecided).toHaveBeenCalledWith(ID, 'applied')
    expect(onProposalDecided).toHaveBeenCalledWith({ organizationId: 'org_1', proposalId: ID })
    expect(recordDecisionScore).toHaveBeenCalledWith({
      organizationId: 'org_1',
      subject: 'proposal',
      subjectId: ID,
      decision: 'accepted',
      decidedBy: 'user_1',
      origin: ORIGIN,
      traceId: null,
      // Only an `operation` proposal names a catalog operation; a file operation like this one has none.
      operation: null,
    })
  })

  it('counts a partly applied proposal as accepted', async () => {
    vi.mocked(resolveProjectDocumentsByName).mockImplementation(async (_s, _p, names) =>
      names.includes('Schnitt A-A.pdf') ? [listed('doc_aa', 'Schnitt A-A.pdf')] : []
    )
    await applyProposal(ID, run)
    await afterCommit()

    expect(publishProposalDecided).toHaveBeenCalledWith(ID, 'partially_applied')
    expect(recordDecisionScore).toHaveBeenCalledWith(expect.objectContaining({ decision: 'accepted' }))
  })

  it('announces a failed apply, but scores nothing: nothing was taken', async () => {
    vi.mocked(resolveProjectDocumentsByName).mockResolvedValue([])
    await applyProposal(ID, run)
    await afterCommit()

    expect(publishProposalDecided).toHaveBeenCalledWith(ID, 'failed')
    expect(onProposalDecided).toHaveBeenCalledTimes(1)
    expect(recordDecisionScore).not.toHaveBeenCalled()
  })

  it('scores a dismissal as dismissed', async () => {
    await dismissProposal(ID, run)
    await afterCommit()

    expect(publishProposalDecided).toHaveBeenCalledWith(ID, 'dismissed')
    expect(onProposalDecided).toHaveBeenCalledTimes(1)
    expect(recordDecisionScore).toHaveBeenCalledWith(expect.objectContaining({ decision: 'dismissed', origin: ORIGIN }))
  })

  it('leaves the turn to be looked up when the proposal names none', async () => {
    store.set(ID, row({ originConversationId: null, originMessageId: null }))
    await dismissProposal(ID, run)
    await afterCommit()

    expect(recordDecisionScore).toHaveBeenCalledWith(expect.objectContaining({ origin: null }))
  })

  it('says nothing for a decision that did not happen', async () => {
    readOnly()
    await expect(dismissProposal(ID, run)).rejects.toMatchObject({ status: 403 })
    store.set(ID, row({ applyingBy: 'user_2', applyingSince: new Date() }))
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor', closed: false, readsBecauseClosed: false })
    await expect(applyProposal(ID, run)).rejects.toMatchObject({ status: 409 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(publishProposalDecided).not.toHaveBeenCalled()
    expect(onProposalDecided).not.toHaveBeenCalled()
    expect(recordDecisionScore).not.toHaveBeenCalled()
  })

  it('does not let a failing side effect fail the decision', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(publishProposalDecided).mockRejectedValueOnce(new Error('hub down'))
    vi.mocked(onProposalDecided).mockRejectedValueOnce(new Error('inbox down'))
    vi.mocked(recordDecisionScore).mockRejectedValueOnce(new Error('langfuse down'))

    const { proposal } = await applyProposal(ID, run)
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(3))

    expect(proposal.status).toBe('applied')
    warn.mockRestore()
  })
})

describe('createProposal — the inbox is told', () => {
  it('tells the attention slice, with a line naming the files', async () => {
    vi.mocked(insertProposedChange).mockResolvedValue({ row: row(), created: true })

    await createProposal(SESSION as never, {
      projectId: PROJECT,
      kind: 'file_operation',
      payload: { operation: 'move', operations: [...MOVE.operations, { document: 'Lageplan.pdf', source: 'project', target_folder: 'Einreichung' }] },
      conversationId: null,
      answerMessageId: null,
    })
    await vi.waitFor(() => expect(onProposalCreated).toHaveBeenCalled())

    expect(onProposalCreated).toHaveBeenCalledWith({
      organizationId: 'org_1',
      projectId: PROJECT,
      proposalId: ID,
      originConversationId: CONVERSATION,
      onBehalfOf: 'user_2',
      summary: 'Grundriss EG.pdf, Schnitt A-A.pdf +1',
      // Which change it proposes, so the inbox titles it („Piloti schlägt einen neuen Ablageort vor").
      variant: 'move',
    })
  })

  it('does not fail the proposal when the inbox write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(insertProposedChange).mockResolvedValue({ row: row(), created: true })
    vi.mocked(onProposalCreated).mockRejectedValueOnce(new Error('inbox down'))

    await expect(
      createProposal(SESSION as never, {
        projectId: PROJECT,
        kind: 'file_operation',
        payload: MOVE,
        conversationId: null,
        answerMessageId: null,
      })
    ).resolves.toMatchObject({ id: ID })
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    warn.mockRestore()
  })
})

const NOTE: MemoryPayload = {
  scope: 'project',
  kind: 'decision',
  content: 'Das Dach wird als extensiv begrüntes Flachdach ausgeführt, mit Attika und innenliegender Entwässerung über zwei Gullys',
  confidence: 'high',
  supersedes: 'Das Dach wird als Satteldach ausgeführt',
}

const PROFILE: ProjectProfilePayload = {
  title: 'Bundesland: Tirol',
  rationale: 'Laut Lageplan liegt das Grundstück in Innsbruck.',
  patch: [{ op: 'replace', path: '/facts/federal_state/value', value: 'tirol' }],
}

const memoryRow = (payload: Partial<MemoryPayload> = {}, extra: Partial<ProposedChangeRow> = {}) =>
  row({ kind: 'memory', payload: { ...NOTE, ...payload }, ...extra })
const profileRow = (extra: Partial<ProposedChangeRow> = {}) => row({ kind: 'project_profile', payload: PROFILE, ...extra })

const memoryItem = (id: string) => ({ id }) as Partial<ProjectMemoryItem> as ProjectMemoryItem
const patched = (extra: Partial<PatchedProjectProfile> = {}) => ({ ...extra }) as PatchedProjectProfile

/** The reader holds `project:view` and exactly these rights; any-of lists pass on one of them. */
const holding = (...held: string[]) =>
  vi.mocked(requireProjectAccess).mockImplementation(async (_session, _project, permission) => {
    const wanted: readonly string[] = Array.isArray(permission) ? permission : [permission]
    if (wanted.includes('project:view') || wanted.some((slug) => held.includes(slug))) {
      return { role: 'project-editor', closed: false, readsBecauseClosed: false }
    }
    throw new NotFoundError()
  })

describe('one gate per kind', () => {
  it('lets a documents-only member decide a file operation, and neither a note nor a profile change', async () => {
    holding('project:documents:write')
    expect((await getProposal(ID, run)).proposal.canDecide).toBe(true)

    store.set(ID, memoryRow())
    expect((await getProposal(ID, run)).proposal.canDecide).toBe(false)
    await expect(applyProposal(ID, run)).rejects.toMatchObject({ status: 403 })
    await expect(dismissProposal(ID, run)).rejects.toMatchObject({ status: 403 })

    store.set(ID, profileRow())
    expect((await getProposal(ID, run)).proposal.canDecide).toBe(false)
    await expect(applyProposal(ID, run)).rejects.toMatchObject({ status: 403 })
    expect(claimProposedChange).not.toHaveBeenCalled()
    expect(addProjectMemoryItem).not.toHaveBeenCalled()
    expect(patchProjectProfile).not.toHaveBeenCalled()
  })

  it('lets a memory-only member decide a note and a profile change, and not a file operation', async () => {
    holding('project:memory:write')
    expect((await getProposal(ID, run)).proposal.canDecide).toBe(false)
    await expect(applyProposal(ID, run)).rejects.toMatchObject({ status: 403 })
    expect(moveDocumentToFolder).not.toHaveBeenCalled()

    store.set(ID, memoryRow())
    expect((await getProposal(ID, run)).proposal.canDecide).toBe(true)
    store.set(ID, profileRow())
    expect((await getProposal(ID, run)).proposal.canDecide).toBe(true)
    await expect(dismissProposal(ID, run)).resolves.toMatchObject({ proposal: { status: 'dismissed' } })
  })

  it('asks for the right the memory and profile services write with', async () => {
    store.set(ID, memoryRow())
    await getProposal(ID, run)
    expect(requireProjectAccess).toHaveBeenCalledWith(SESSION, PROJECT, ['project:memory:write', 'project:edit'])
  })
})

describe('applying a memory note', () => {
  beforeEach(() => {
    vi.mocked(addProjectMemoryItem).mockResolvedValue(memoryItem('mem_project'))
    vi.mocked(createOrganizationMemoryItem).mockResolvedValue(memoryItem('mem_org'))
  })

  it('reads as a typed note', async () => {
    store.set(ID, memoryRow())
    const { proposal } = await getProposal(ID, run)
    expect(proposal).toMatchObject({ kind: 'memory', payload: NOTE, canDecide: true })
  })

  it('files a project note through the panel’s service, linked to its conversation, retiring the note it corrects', async () => {
    store.set(ID, memoryRow())
    const { proposal } = await applyProposal(ID, run)

    expect(requireMayRememberFrom).toHaveBeenCalledWith(CONVERSATION, 'org_1')
    expect(addProjectMemoryItem).toHaveBeenCalledWith(
      SESSION,
      PROJECT,
      { kind: 'decision', content: NOTE.content, confidence: 'high', sourceConversationId: CONVERSATION },
      { supersedesContent: 'Das Dach wird als Satteldach ausgeführt' }
    )
    expect(createOrganizationMemoryItem).not.toHaveBeenCalled()
    expect(proposal).toMatchObject({
      status: 'applied',
      decidedBy: 'user_1',
      results: [
        {
          label: 'Das Dach wird als extensiv begrüntes Flachdach ausgeführt, mit Attika und innenliegender …',
          ok: true,
          itemId: 'mem_project',
          scope: 'project',
        },
      ],
    })
  })

  it('files an organization note in the office’s memory', async () => {
    store.set(ID, memoryRow({ scope: 'organization', supersedes: null, content: 'Wir runden Flächen auf zwei Stellen' }))
    const { proposal } = await applyProposal(ID, run)

    expect(createOrganizationMemoryItem).toHaveBeenCalledWith(
      SESSION,
      { kind: 'decision', content: 'Wir runden Flächen auf zwei Stellen', confidence: 'high', sourceConversationId: CONVERSATION },
      { supersedesContent: null }
    )
    expect(addProjectMemoryItem).not.toHaveBeenCalled()
    expect(proposal.results).toEqual([{ label: 'Wir runden Flächen auf zwei Stellen', ok: true, itemId: 'mem_org', scope: 'organization' }])
  })

  it('files an organization note in the project when the decider says so', async () => {
    store.set(ID, memoryRow({ scope: 'organization' }))
    const { proposal } = await applyProposal(ID, { memoryScope: 'project' }, run)

    expect(addProjectMemoryItem).toHaveBeenCalledWith(SESSION, PROJECT, expect.objectContaining({ kind: 'decision' }), {
      supersedesContent: NOTE.supersedes,
    })
    expect(createOrganizationMemoryItem).not.toHaveBeenCalled()
    // The scope recorded is the one the decider chose, not the one Piloti asked for.
    expect(proposal.results).toEqual([expect.objectContaining({ ok: true, itemId: 'mem_project', scope: 'project' })])
  })

  it('never widens a project note to the office, and refuses a body it does not know', async () => {
    store.set(ID, memoryRow())
    const widen = (body: string) => run(`/api/proposals/${ID}/apply`, { method: 'POST', body })
    expect((await widen(JSON.stringify({ memoryScope: 'organization' }))).status).toBe(400)
    expect((await widen(JSON.stringify({ memoryScope: 'project', extra: 1 }))).status).toBe(400)
    expect((await widen('{not json')).status).toBe(400)
    expect(claimProposedChange).not.toHaveBeenCalled()
    expect((await widen('')).status).toBe(200)
    expect(addProjectMemoryItem).toHaveBeenCalledTimes(1)
  })

  it('refuses a note from a conversation that drew on another project’s restricted content, and gives the claim back', async () => {
    store.set(ID, memoryRow({ scope: 'organization' }))
    vi.mocked(requireMayRememberFrom).mockRejectedValueOnce(new CrossProjectMemoryError('Nicht aus diesem Gespräch'))

    await expect(applyProposal(ID, run)).rejects.toMatchObject({ status: 409, code: 'CROSS_PROJECT_MEMORY' })
    expect(addProjectMemoryItem).not.toHaveBeenCalled()
    expect(createOrganizationMemoryItem).not.toHaveBeenCalled()
    expect(store.get(ID)).toMatchObject({ status: 'proposed', applyingBy: null, applyingSince: null })
  })

  it('refuses a note from a conversation that drew on a restricted folder of this project: memory is read by everyone in it', async () => {
    store.set(ID, memoryRow({ scope: 'project' }))
    vi.mocked(requireMayLeaveConversation).mockRejectedValueOnce(
      new ConversationConfinedError('memory', 'Nicht aus diesem Gespräch')
    )

    await expect(applyProposal(ID, run)).rejects.toMatchObject({ status: 403 })
    expect(requireMayLeaveConversation).toHaveBeenCalledWith(
      { conversationId: CONVERSATION, locale: 'de' },
      'org_1',
      'memory'
    )
    expect(addProjectMemoryItem).not.toHaveBeenCalled()
    expect(store.get(ID)).toMatchObject({ status: 'proposed', applyingBy: null, applyingSince: null })
  })

  it('gives the claim back when the memory service refuses the decider', async () => {
    store.set(ID, memoryRow())
    vi.mocked(addProjectMemoryItem).mockRejectedValueOnce(new ForbiddenError('closed'))
    await expect(applyProposal(ID, run)).rejects.toMatchObject({ status: 403 })
    expect(store.get(ID)).toMatchObject({ status: 'proposed', applyingBy: null })
  })
})

describe('applying a profile change', () => {
  it('patches the profile with its conversation and the decider’s language as the origin', async () => {
    store.set(ID, profileRow())
    vi.mocked(patchProjectProfile).mockResolvedValue(patched())

    const { proposal } = await applyProposal(ID, run)

    expect(patchProjectProfile).toHaveBeenCalledWith(SESSION, PROJECT, PROFILE.patch, {
      conversationId: CONVERSATION,
      locale: 'de',
    })
    expect(proposal).toMatchObject({
      kind: 'project_profile',
      status: 'applied',
      results: [{ label: 'Bundesland: Tirol', ok: true }],
    })
  })

  it('patches without an origin when the proposal has no conversation', async () => {
    store.set(ID, profileRow({ originConversationId: null, originMessageId: null }))
    vi.mocked(patchProjectProfile).mockResolvedValue(patched())
    await applyProposal(ID, run)
    expect(patchProjectProfile).toHaveBeenCalledWith(SESSION, PROJECT, PROFILE.patch, undefined)
  })

  it('counts a colleague’s concurrent accept of the same change as applied', async () => {
    store.set(ID, profileRow())
    vi.mocked(patchProjectProfile).mockResolvedValue(patched({ alreadyApplied: true }))
    const { proposal } = await applyProposal(ID, run)
    expect(proposal).toMatchObject({ status: 'applied', results: [{ label: 'Bundesland: Tirol', ok: true }] })
  })

  it('fails on a version conflict and on a value outside the vocabulary, with the service’s reason', async () => {
    store.set(ID, profileRow())
    vi.mocked(patchProjectProfile).mockRejectedValueOnce(new ConflictError('Conflict: profile was modified by another request'))
    expect((await applyProposal(ID, run)).proposal).toMatchObject({
      status: 'failed',
      results: [{ label: 'Bundesland: Tirol', ok: false, reason: 'Conflict: profile was modified by another request' }],
    })

    store.set(ID, profileRow())
    vi.mocked(patchProjectProfile).mockRejectedValueOnce(new BadRequestError('Invalid value for "Bundesland"'))
    expect((await applyProposal(ID, run)).proposal).toMatchObject({
      status: 'failed',
      results: [{ ok: false, reason: 'Invalid value for "Bundesland"' }],
    })
  })

  it('gives the claim back on a 403, the decider’s or the confined conversation’s, and writes no result', async () => {
    for (const refusal of [
      new ForbiddenError('This project is closed and can only be read. Reopen it to change it.'),
      new ConversationConfinedError('profilePatch', 'Dieses Gespräch bleibt bei seinen Ordnern'),
    ]) {
      store.set(ID, profileRow())
      vi.mocked(patchProjectProfile).mockRejectedValueOnce(refusal)
      await expect(applyProposal(ID, run)).rejects.toMatchObject({ status: 403 })
      expect(store.get(ID)).toMatchObject({ status: 'proposed', applyingBy: null, results: null })
    }
    expect(releaseProposedChange).toHaveBeenCalledTimes(2)
  })

  it('ignores a memory scope in the body', async () => {
    store.set(ID, profileRow())
    vi.mocked(patchProjectProfile).mockResolvedValue(patched())
    await expect(applyProposal(ID, { memoryScope: 'project' }, run)).resolves.toMatchObject({
      proposal: { status: 'applied' },
    })
    expect(addProjectMemoryItem).not.toHaveBeenCalled()
  })
})

describe('createProposal — every kind, once per card', () => {
  const create = (input: Partial<Parameters<typeof createProposal>[1]>) =>
    createProposal(SESSION as never, {
      projectId: PROJECT,
      kind: 'file_operation',
      payload: MOVE,
      conversationId: null,
      answerMessageId: null,
      ...input,
    })

  it('files a note and a profile change, each with its own inbox line', async () => {
    vi.mocked(insertProposedChange).mockResolvedValue({ row: memoryRow(), created: true })
    await create({ kind: 'memory', payload: NOTE })
    expect(insertProposedChange).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'memory', payload: NOTE }))
    await vi.waitFor(() =>
      expect(onProposalCreated).toHaveBeenLastCalledWith(
        expect.objectContaining({
          summary: 'Das Dach wird als extensiv begrüntes Flachdach ausgeführt, mit Attika und innenliegender …',
        })
      )
    )

    vi.mocked(insertProposedChange).mockResolvedValue({ row: profileRow(), created: true })
    await create({ kind: 'project_profile', payload: PROFILE })
    expect(insertProposedChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'project_profile', payload: PROFILE })
    )
    await vi.waitFor(() =>
      expect(onProposalCreated).toHaveBeenLastCalledWith(expect.objectContaining({ summary: 'Bundesland: Tirol' }))
    )
  })

  it('refuses a profile value outside the intake vocabulary when it is proposed', async () => {
    await expect(
      create({
        kind: 'project_profile',
        payload: { ...PROFILE, patch: [{ op: 'replace', path: '/facts/federal_state/value', value: 'atlantis' }] },
      })
    ).rejects.toMatchObject({ status: 422, details: { reason: 'proposal-profile-vocabulary' } })
    expect(insertProposedChange).not.toHaveBeenCalled()
  })

  it('refuses a payload of another kind than it names', async () => {
    await expect(create({ kind: 'memory', payload: MOVE })).rejects.toThrow()
    expect(insertProposedChange).not.toHaveBeenCalled()
  })

  it('passes the card index with its answer, and drops one without an answer', async () => {
    vi.mocked(insertProposedChange).mockResolvedValue({ row: row(), created: true })
    await create({ answerMessageId: '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d', originCardIndex: 2 })
    expect(insertProposedChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ originMessageId: '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d', originCardIndex: 2 })
    )
    await create({ originCardIndex: 2 })
    expect(insertProposedChange).toHaveBeenLastCalledWith(expect.objectContaining({ originCardIndex: null }))
  })

  it('returns the first proposal for the same card, as it stands, and tells the inbox nothing again', async () => {
    vi.mocked(findConversationInOrg).mockResolvedValue({ id: CONVERSATION } as Partial<Conversation> as Conversation)
    const first = row({ status: 'dismissed', decidedBy: 'user_2', decidedAt: new Date(), originCardIndex: 0 })
    vi.mocked(insertProposedChange).mockResolvedValue({ row: first, created: false })

    await expect(
      create({ conversationId: CONVERSATION, answerMessageId: '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d', originCardIndex: 0 })
    ).resolves.toMatchObject({ id: ID, status: 'dismissed' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onProposalCreated).not.toHaveBeenCalled()
  })

  it.each([
    ['another project', { projectId: 'project-other' }],
    ['another conversation', { originConversationId: 'conversation-other' }],
    ['another kind', { kind: 'memory' as const, payload: NOTE }],
  ])('never hands back a first proposal filed for %s under the same card', async (_, foreign) => {
    vi.mocked(findConversationInOrg).mockResolvedValue({ id: CONVERSATION } as Partial<Conversation> as Conversation)
    vi.mocked(insertProposedChange).mockResolvedValue({ row: row({ originCardIndex: 0, ...foreign }), created: false })

    await expect(
      create({ conversationId: CONVERSATION, answerMessageId: '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d', originCardIndex: 0 })
    ).rejects.toMatchObject({ details: { reason: 'proposal-card-taken' } })
  })
})

describe('the audit trail of a proposal', () => {
  const MESSAGE = '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d'
  const audited = (): AuditEventInput[] => vi.mocked(recordAuditEvent).mock.calls.map(([input]) => input)
  // Whatever was emitted, WorkOS would accept: every target type and key is registered.
  afterEach(() => {
    for (const [input] of vi.mocked(recordAuditEvent).mock.calls) expectRegistered(input)
  })
  const TARGETS = [
    { type: 'project', id: PROJECT },
    { type: 'conversation', id: CONVERSATION },
  ]

  beforeEach(() => {
    vi.mocked(addProjectMemoryItem).mockResolvedValue(memoryItem('mem_project'))
    vi.mocked(createOrganizationMemoryItem).mockResolvedValue(memoryItem('mem_org'))
    vi.mocked(findConversationInOrg).mockResolvedValue({ id: CONVERSATION } as Partial<Conversation> as Conversation)
  })

  it('records an apply once, as the decider, with how it went and for whom Piloti proposed it', async () => {
    vi.mocked(resolveProjectDocumentsByName).mockImplementation(async (_s, _p, names) =>
      names.includes('Schnitt A-A.pdf') ? [listed('doc_aa', 'Schnitt A-A.pdf')] : []
    )

    await applyProposal(ID, run)

    expect(audited()).toEqual([
      {
        action: 'piloti.proposal.decided',
        organizationId: 'org_1',
        actor: { userId: 'user_1', email: 'anna@example.test' },
        targetType: 'proposed_change',
        targetId: ID,
        alsoTargets: TARGETS,
        metadata: {
          kind: 'file_operation',
          decision: 'partially_applied',
          operation: 'move',
          items: 2,
          appliedItems: 1,
          memoryScope: null,
          onBehalfOf: 'user_2',
          messageId: MESSAGE,
        },
      },
    ])
    // Names and paths of the payload stay out.
    expect(JSON.stringify(audited())).not.toMatch(/Grundriss|Schnitt|Einreichung/)
  })

  it('records a dismissal, and the memory scope a note went into rather than the one proposed', async () => {
    await dismissProposal(ID, run)
    store.set(ID, memoryRow({ scope: 'organization' }))
    await applyProposal(ID, { memoryScope: 'project' }, run)
    store.set(ID, profileRow())
    await dismissProposal(ID, run)

    expect(audited().map((input) => input.metadata)).toEqual([
      expect.objectContaining({ kind: 'file_operation', decision: 'dismissed', appliedItems: 0 }),
      expect.objectContaining({ kind: 'memory', decision: 'applied', items: 1, appliedItems: 1, memoryScope: 'project' }),
      expect.objectContaining({ kind: 'project_profile', decision: 'dismissed', items: 1, memoryScope: null }),
    ])
    expect(JSON.stringify(audited())).not.toMatch(/Flachdach|Tirol/)
  })

  it('records nothing for a decision that did not happen', async () => {
    readOnly()
    await expect(dismissProposal(ID, run)).rejects.toMatchObject({ status: 403 })
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor', closed: false, readsBecauseClosed: false })
    store.set(ID, row({ applyingBy: 'user_2', applyingSince: new Date() }))
    await expect(applyProposal(ID, run)).rejects.toMatchObject({ status: 409 })
    store.set(ID, row({ status: 'dismissed', decidedBy: 'user_2', decidedAt: new Date() }))
    await expect(dismissProposal(ID, run)).rejects.toMatchObject({ status: 409 })

    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('records a filed proposal once, as the person Piloti acted for, and a repeated card not again', async () => {
    vi.mocked(insertProposedChange).mockResolvedValueOnce({ row: row({ onBehalfOf: 'user_1' }), created: true })
    await createProposal(SESSION as never, {
      projectId: PROJECT,
      kind: 'file_operation',
      payload: MOVE,
      conversationId: CONVERSATION,
      answerMessageId: MESSAGE,
      originCardIndex: 0,
    })
    vi.mocked(insertProposedChange).mockResolvedValueOnce({ row: row({ onBehalfOf: 'user_1' }), created: false })
    await createProposal(SESSION as never, {
      projectId: PROJECT,
      kind: 'file_operation',
      payload: MOVE,
      conversationId: CONVERSATION,
      answerMessageId: MESSAGE,
      originCardIndex: 0,
    })

    expect(audited()).toEqual([
      {
        action: 'piloti.proposal.created',
        organizationId: 'org_1',
        actor: { userId: 'user_1', email: 'anna@example.test' },
        targetType: 'proposed_change',
        targetId: ID,
        alsoTargets: TARGETS,
        metadata: { kind: 'file_operation', operation: 'move', items: 2, memoryScope: null, messageId: MESSAGE },
      },
    ])
  })

  it('records where a proposed note would go', async () => {
    vi.mocked(insertProposedChange).mockResolvedValueOnce({ row: memoryRow({ scope: 'organization' }), created: true })
    await createProposal(SESSION as never, {
      projectId: PROJECT,
      kind: 'memory',
      payload: { ...NOTE, scope: 'organization' },
      conversationId: null,
      answerMessageId: null,
    })

    expect(audited()[0].metadata).toMatchObject({ kind: 'memory', items: 1, memoryScope: 'organization' })
    expect(JSON.stringify(audited())).not.toContain('Flachdach')
  })

  it('does not let a failing trail fail the decision or the filing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(recordAuditEvent).mockRejectedValueOnce(new Error('WorkOS down'))
    vi.mocked(recordAuditEvent).mockImplementationOnce(() => {
      throw new Error('WorkOS down')
    })

    const { proposal } = await applyProposal(ID, run)
    vi.mocked(insertProposedChange).mockResolvedValueOnce({ row: row({ id: '1b7c8f5e-1d1e-4c39-9d2c-3f0f6c1a2b3c' }), created: true })
    await expect(
      createProposal(SESSION as never, { projectId: PROJECT, kind: 'file_operation', payload: MOVE, conversationId: null, answerMessageId: null })
    ).resolves.toMatchObject({ id: '1b7c8f5e-1d1e-4c39-9d2c-3f0f6c1a2b3c' })

    expect(proposal.status).toBe('applied')
    await vi.waitFor(() =>
      expect(warn.mock.calls.filter(([message]) => String(message).startsWith('[Audit]'))).toHaveLength(2)
    )
    warn.mockRestore()
  })
})
