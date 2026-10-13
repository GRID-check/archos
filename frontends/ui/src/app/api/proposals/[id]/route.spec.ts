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
 * row) and checks every row against the CHECKs of migration 0137. The
 * document, folder and assignment services are mocked at their seams; what is
 * under test is that applying calls THEM, with the deciding person's session,
 * in order, resolving names and paths the way the browser did, and records
 * each item's outcome.
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
}))

vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn(async () => SESSION) }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/sharing/access', () => ({ requireResourceAccess: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/conversations/repository', () => ({ findConversationInOrg: vi.fn() }))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))
vi.mock('@/lib/documents/service', () => ({
  resolveProjectDocumentsByName: vi.fn(),
  renameDocument: vi.fn(),
}))
vi.mock('@/lib/archiv/service', () => ({ resolveArchivDocumentsByName: vi.fn() }))
vi.mock('@/lib/archiv/folder-service', () => ({ listArchivFolders: vi.fn() }))
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
vi.mock('@/lib/proposals/repository', () => ({
  insertProposedChange: vi.fn(),
  findProposedChange: vi.fn(),
  claimProposedChange: vi.fn(),
  settleProposedChange: vi.fn(),
  releaseProposedChange: vi.fn(),
  dismissProposedChange: vi.fn(),
}))

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { addResourceAssignment, listAssignmentCandidates } from '@/lib/assignments/service'
import { listArchivFolders } from '@/lib/archiv/folder-service'
import { resolveArchivDocumentsByName } from '@/lib/archiv/service'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { ProposedChangeRow } from '@/lib/db/schema/proposed-changes'
import { moveDocumentToFolder } from '@/lib/documents/move-to-folder'
import { renameDocument, resolveProjectDocumentsByName } from '@/lib/documents/service'
import type { ListedDocument } from '@/lib/documents/shelf-listing'
import { createProjectFolder, listProjectFolders, type ProjectFolderRow } from '@/lib/projects/folder-service'
import { applyProposal, dismissProposal, getProposal, ProposalRequestError } from '@/lib/proposals/client'
import { recordDecisionScore } from '@/lib/langfuse/decision-score'
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
import type { FileOperationPayload } from '@/lib/proposals/types'
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
    { document: 'Grundriss EG.pdf', source: 'projekt', target_folder: 'Einreichung/Pläne' },
    { document: 'Schnitt A-A.pdf', source: 'projekt', target_folder: 'Einreichung/Pläne' },
  ],
}

const row = (extra: Partial<ProposedChangeRow> = {}): ProposedChangeRow => ({
  id: ID,
  organizationId: 'org_1',
  projectId: PROJECT,
  kind: 'file_operation',
  payload: MOVE,
  status: 'proposed',
  proposedByKind: 'piloti',
  onBehalfOf: 'user_2',
  originConversationId: CONVERSATION,
  originMessageId: '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
  createdAt: new Date('2026-10-13T08:00:00Z'),
  decidedBy: null,
  decidedAt: null,
  results: null,
  applyingBy: null,
  applyingSince: null,
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
      ['user_1', person('user_1', 'Anna Berger', 'anna@grid.test')],
      ['user_2', person('user_2', 'Bernd Huber', 'bernd@grid.test')],
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
    vi.mocked(resolveArchivDocumentsByName).mockResolvedValue([listed('doc_b', 'Vorlage.docx')])
    vi.mocked(listArchivFolders).mockResolvedValue([folder('a_vorlagen', 'Vorlagen')])
    store.set(
      ID,
      row({
        payload: {
          operation: 'move',
          operations: [
            { document: 'Vorlage.docx', source: 'buero', target_folder: 'Vorlagen' },
            { document: 'Vorlage.docx', source: 'buero', target_folder: '' },
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
      person('user_2', 'Bernd Huber', 'bernd@grid.test'),
      person('user_3', 'Chris Maier', 'chris@grid.test'),
      person('user_4', 'Chris Maier', 'chris.m@grid.test'),
    ])
    vi.mocked(addResourceAssignment).mockResolvedValue([])
    store.set(
      ID,
      row({
        payload: {
          operation: 'assign',
          operations: [
            { document: 'Schnitt A-A.pdf', member: 'bernd@grid.test' },
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
    vi.mocked(insertProposedChange).mockResolvedValue(row())

    await createProposal(SESSION as never, {
      projectId: PROJECT,
      kind: 'file_operation',
      payload: { operation: 'move', operations: [...MOVE.operations, { document: 'Lageplan.pdf', source: 'projekt', target_folder: 'Einreichung' }] },
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
    })
  })

  it('does not fail the proposal when the inbox write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(insertProposedChange).mockResolvedValue(row())
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
