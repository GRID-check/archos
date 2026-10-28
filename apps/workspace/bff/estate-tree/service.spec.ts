/**
 * @vitest-environment node
 */
/**
 * Which shelf and which reach the estate tree reads under. The SQL is
 * `repository.integration.spec.ts`'s; here the repository is a double, so what
 * is held is the decision: the shelf must be the turn's and in its signed scope,
 * the reach is the audience's listing reach (`reachForAudience` with `listing`,
 * which hides restricted folders even in a solo chat: `lib/search/reach.spec.ts`),
 * and every refusal is one 404.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/search/reach', () => ({ reachForAudience: vi.fn() }))
vi.mock('./repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./repository')>()),
  findFolderIdByPath: vi.fn(),
  listTreeFolders: vi.fn(),
  listTreeDocuments: vi.fn(),
}))

import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Project } from '@/lib/db/schema/projects'
import type { VerifiedRequestContext } from '@/lib/request-context'
import { reachForAudience, type SearchReach } from '@/lib/search/reach'
import { decodeTreeCursor, findFolderIdByPath, listTreeDocuments, listTreeFolders, type TreeDocumentRow } from './repository'
import { readEstateTree } from './service'

const PROJECT = '33333333-3333-4333-8333-333333333333'
const session = { organizationId: 'org_1', userId: 'user_1' } as AuthorizedSession
const project = { id: PROJECT, collectionName: 'proj_1' } as Project

const context = (patch: Partial<VerifiedRequestContext> = {}): VerifiedRequestContext => ({
  organizationId: 'org_1',
  userId: 'user_1',
  projectId: PROJECT,
  conversationId: 's_conv_1',
  issuedAt: Date.now(),
  collectionScope: ['oib_knowledge', 'archiv_org_1', 'proj_1', 's_conv_1'],
  ...patch,
})

const reach = (patch: Partial<SearchReach> = {}): SearchReach => ({
  organizationId: 'org_1',
  userId: 'user_1',
  scope: { kind: 'project', projectId: PROJECT },
  projects: [{ project, hiddenFolderIds: ['f-binned'], collections: ['proj_1', 'proj_1_r0123456789ab'], reviewsQuarantine: false }],
  officeShelf: null,
  folderIds: null,
  screenedOnly: false,
  ...patch,
})

const row = (filename: string, id: string): TreeDocumentRow => ({
  id,
  filename,
  displayName: null,
  folderId: null,
  folderPath: null,
  collectionName: 'proj_1',
  contentType: 'application/pdf',
  fileSize: 10,
  status: 'completed',
  authoredBy: 'user',
  documentType: 'fire_safety_concept',
  pageCount: 14,
  superseded: false,
  planNumber: null,
  planIndex: null,
  planDate: null,
  publishedVersion: 2,
  versionCount: 3,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-02T00:00:00Z'),
})

const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(reachForAudience).mockResolvedValue(reach())
  vi.mocked(listTreeFolders).mockResolvedValue({ rows: [], truncated: false })
  vi.mocked(listTreeDocuments).mockResolvedValue([])
})

describe('readEstateTree: the project shelf', () => {
  it('reads the audience’s listing reach for the envelope’s project, and lists under it unchanged', async () => {
    const listing = reach()
    vi.mocked(reachForAudience).mockResolvedValue(listing)
    const answer = await readEstateTree(context(), session, { shelf: 'project' })

    expect(reachForAudience).toHaveBeenCalledWith(session, 's_conv_1', { kind: 'project', projectId: PROJECT }, { listing: true, includeOwnProject: true })
    expect(vi.mocked(listTreeFolders).mock.calls[0][0]).toBe(listing)
    expect(vi.mocked(listTreeDocuments).mock.calls[0][0]).toEqual({ kind: 'reach', reach: listing })
    expect(answer).toMatchObject({ shelf: 'project', collection: 'proj_1', next_cursor: null })
  })

  it.each([
    ['the turn has no project', context({ projectId: null })],
    ['the turn has no conversation', context({ conversationId: null })],
    ['the project’s collection is not in the signed scope', context({ collectionScope: ['oib_knowledge'] })],
  ])('404s when %s', async (_name, ctx) => {
    await expect(readEstateTree(ctx, session, { shelf: 'project' })).rejects.toThrow(NotFoundError)
    expect(listTreeDocuments).not.toHaveBeenCalled()
  })

  it('404s a project outside the audience as a missing shelf', async () => {
    vi.mocked(reachForAudience).mockRejectedValue(new NotFoundError('Project not found'))
    await expect(readEstateTree(context(), session, { shelf: 'project' })).rejects.toThrow('No such shelf in this turn.')
  })

  it('lists the conversation’s own project in a shared private chat, pruned for that audience', async () => {
    // `includeOwnProject` keeps the own project that `audienceReach` (the reach for OTHER projects) leaves out.
    vi.mocked(reachForAudience).mockImplementation(async (_session, _conversation, _scope, options) =>
      options?.includeOwnProject ? reach({ screenedOnly: true }) : Promise.reject(new NotFoundError('Project not found')),
    )
    await expect(readEstateTree(context(), session, { shelf: 'project' })).resolves.toMatchObject({ shelf: 'project', collection: 'proj_1' })
  })
})

describe('readEstateTree: a folder', () => {
  it('resolves the path to its folder and reads that subtree', async () => {
    vi.mocked(findFolderIdByPath).mockResolvedValue('f-plans')
    vi.mocked(reachForAudience).mockResolvedValue(reach({ folderIds: ['f-plans', 'f-plans-old'] }))
    await readEstateTree(context(), session, { shelf: 'project', folder_path: 'Einreichung/Pläne' })
    expect(reachForAudience).toHaveBeenCalledWith(session, 's_conv_1', { kind: 'project', projectId: PROJECT, folderId: 'f-plans' }, { listing: true, includeOwnProject: true })
    expect(vi.mocked(listTreeFolders).mock.calls[0][0].folderIds).toEqual(['f-plans', 'f-plans-old'])
  })

  it('answers a restricted folder exactly as a missing one, in a solo chat too', async () => {
    // The listing reach leaves a restricted folder out of `folderIds` (reach.spec.ts); the path still resolves to it.
    vi.mocked(findFolderIdByPath).mockResolvedValue('f-restricted')
    vi.mocked(reachForAudience).mockResolvedValue(reach({ folderIds: [] }))
    const restricted = await readEstateTree(context(), session, { shelf: 'project', folder_path: 'Personal' }).catch((e: Error) => e.message)

    vi.mocked(findFolderIdByPath).mockResolvedValue(null)
    const missing = await readEstateTree(context(), session, { shelf: 'project', folder_path: 'Nope' }).catch((e: Error) => e.message)

    expect(restricted).toBe('No folder with that path.')
    expect(missing).toBe(restricted)
    expect(listTreeDocuments).not.toHaveBeenCalled()
  })

  it('answers a folder the reach hides from a shared audience as a missing one', async () => {
    vi.mocked(findFolderIdByPath).mockResolvedValue('f-restricted')
    vi.mocked(reachForAudience).mockRejectedValue(new NotFoundError('Folder not found'))
    await expect(readEstateTree(context(), session, { shelf: 'project', folder_path: 'Personal' })).rejects.toThrow('No folder with that path.')
  })
})

describe('readEstateTree: the office shelf and the conversation’s files', () => {
  it('reads the office shelf under the audience’s reach when the signed scope holds it', async () => {
    vi.mocked(reachForAudience).mockResolvedValue(reach({ projects: [], officeShelf: { collection: 'archiv_org_1', reviewsQuarantine: false } }))
    const answer = await readEstateTree(context(), session, { shelf: 'office_shelf' })
    expect(reachForAudience).toHaveBeenCalledWith(session, 's_conv_1', { kind: 'office_shelf' }, { listing: true, includeOwnProject: true })
    expect(answer.shelf).toBe('office_shelf')
  })

  it('404s the office shelf when the signed scope leaves it out', async () => {
    await expect(readEstateTree(context({ collectionScope: ['proj_1'] }), session, { shelf: 'office_shelf' })).rejects.toThrow(NotFoundError)
  })

  it('reads the conversation’s own files with the reach’s reader, and no folders', async () => {
    const answer = await readEstateTree(context(), session, { shelf: 'session' })
    expect(listTreeFolders).not.toHaveBeenCalled()
    expect(vi.mocked(listTreeDocuments).mock.calls[0][0]).toMatchObject({ kind: 'session', conversationId: 's_conv_1' })
    expect(answer).toMatchObject({ shelf: 'session', collection: 's_conv_1', folders: [] })
  })

  it('404s a folder on the conversation’s files, and files outside the signed scope', async () => {
    await expect(readEstateTree(context(), session, { shelf: 'session', folder_path: 'A' })).rejects.toThrow('No folder with that path.')
    await expect(readEstateTree(context({ collectionScope: ['proj_1'] }), session, { shelf: 'session' })).rejects.toThrow(NotFoundError)
  })
})

describe('readEstateTree: pages', () => {
  it('cuts the page at the limit and hands back a cursor after its last row', async () => {
    vi.mocked(listTreeDocuments).mockResolvedValue([row('a.pdf', ID(1)), row('b.pdf', ID(2)), row('c.pdf', ID(3))])
    const answer = await readEstateTree(context(), session, { shelf: 'project', limit: 2 })
    expect(vi.mocked(listTreeDocuments).mock.calls[0][1]).toEqual({ cursor: null, limit: 2 })
    expect(answer.documents.map((document) => document.filename)).toEqual(['a.pdf', 'b.pdf'])
    expect(decodeTreeCursor(answer.next_cursor!)).toEqual({ filename: 'b.pdf', id: ID(2) })
    expect(answer.documents[0]).toMatchObject({ document_type: 'fire_safety_concept', page_count: 14, published_version: 2, version_count: 3 })
  })

  it('reads on from a cursor, and ends without one', async () => {
    vi.mocked(listTreeDocuments).mockResolvedValue([row('c.pdf', ID(3))])
    const first = await readEstateTree(context(), session, { shelf: 'project', limit: 2 })
    expect(first.next_cursor).toBeNull()
  })

  it('400s a cursor it did not issue', async () => {
    await expect(readEstateTree(context(), session, { shelf: 'project', cursor: 'bm90LWEtY3Vyc29y' })).rejects.toThrow('cursor is not one this route issued')
  })
})
