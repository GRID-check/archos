/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const repository = vi.hoisted(() => ({
  searchDocumentPage: vi.fn(),
  documentFacetCounts: vi.fn(),
  readReferenceSubject: vi.fn(),
  listCandidateDocumentIds: vi.fn(),
}))
vi.mock('./document-repository', () => repository)
const providers = vi.hoisted(() => ({
  searchAnnotations: vi.fn(),
  searchFolders: vi.fn(),
  searchProjects: vi.fn(),
  searchConversations: vi.fn(),
}))
vi.mock('./providers', () => providers)
vi.mock('./reach', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./reach')>()),
  reachFor: vi.fn(),
}))
vi.mock('./shelf-projection', () => ({ refreshStaleShelves: vi.fn().mockResolvedValue({ building: ['office_shelf'] }) }))
vi.mock('@/lib/sharing/directory', () => ({
  resolvePeople: vi.fn().mockResolvedValue(new Map([['user_1', { userId: 'user_1', name: 'Lena Huber' }]])),
}))
vi.mock('@/lib/documents/service', () => ({
  BACKEND_SEARCH_MAX_COLLECTIONS: 500,
  fetchGroupedSemanticHits: vi.fn(),
}))

import { UpstreamError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Project } from '@/lib/db/schema'
import { fetchGroupedSemanticHits } from '@/lib/documents/service'
import { contentPrefilter, decodeSearchCursor, documentOrder, encodeSearchCursor, runSearch } from './document-search'
import type { DocumentSearchRow } from './document-repository'
import { reachFor, type SearchReach } from './reach'

const session = { organizationId: 'org_1', userId: 'user_1' } as AuthorizedSession
const PROJECT = '11111111-1111-4111-8111-111111111111'

const reach: SearchReach = {
  organizationId: 'org_1',
  userId: 'user_1',
  scope: { kind: 'office' },
  projects: [
    {
      project: { id: PROJECT, name: 'Hubergasse 14', collectionName: 'proj_a' } as Project,
      hiddenFolderIds: [],
      collections: ['proj_a'],
      reviewsQuarantine: false,
    },
  ],
  officeShelf: { collection: 'office_org_1', reviewsQuarantine: false },
  folderIds: null,
}

const row = (overrides: Partial<DocumentSearchRow> = {}): DocumentSearchRow => ({
  id: 'd1',
  filename: 'bsk.pdf',
  displayName: 'Brandschutzkonzept',
  scope: 'project',
  projectId: PROJECT,
  projectName: 'Hubergasse 14',
  folderId: null,
  folderName: null,
  collectionName: 'proj_a',
  status: 'completed',
  contentType: 'application/pdf',
  createdAt: new Date('2026-10-20T08:00:00Z'),
  createdBy: 'user_1',
  documentType: 'fire_safety_concept',
  title: 'Brandschutzkonzept',
  planNumber: null,
  planIndex: null,
  planDate: null,
  scale: null,
  documentDate: '2025-02-01',
  pageCount: 24,
  pagesNotRead: 0,
  superseded: false,
  municipality: 'Wien',
  matchedName: false,
  matchedReading: true,
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(reachFor).mockResolvedValue(reach)
  repository.searchDocumentPage.mockResolvedValue({ rows: [row()], total: 1 })
  repository.documentFacetCounts.mockResolvedValue({
    documentType: [{ value: 'fire_safety_concept', count: 1 }],
    project: [{ value: PROJECT, count: 1 }],
    status: [{ value: 'completed', count: 1 }, { value: 'failed', count: 2 }, { value: 'COMPLETED', count: 1 }],
    cites: [{ value: 'norm:önorm b 1600', count: 1 }],
  })
  for (const provider of Object.values(providers)) provider.mockResolvedValue({ hits: [], total: 0 })
})

describe('runSearch', () => {
  it('joins content passages to the rows by collection and file name, and says what matched', async () => {
    vi.mocked(fetchGroupedSemanticHits).mockResolvedValue([
      { file_name: 'bsk.pdf', collection: 'proj_a', snippet: 'Fluchtweglänge max. 40 m', page_number: 7, score: 0.8, rank: 0 },
    ])

    const answer = await runSearch(session, {}, { text: 'Fluchtweg', kinds: ['document'] })

    expect(fetchGroupedSemanticHits).toHaveBeenCalledWith(['proj_a', 'office_org_1'], 'Fluchtweg', 20, 400, {})
    expect(repository.listCandidateDocumentIds).not.toHaveBeenCalled()
    const query = repository.searchDocumentPage.mock.calls[0][1]
    expect(query.text).toEqual({ text: 'Fluchtweg', contentKeys: ['proj_a\u0000bsk.pdf'] })
    expect(repository.searchDocumentPage.mock.calls[0][2]).toEqual({ sort: 'relevance', dir: 'desc', limit: 25, offset: 0 })
    const [hit] = answer.sections.document?.hits ?? []
    expect(hit.passage).toEqual({ text: 'Fluchtweglänge max. 40 m', page: 7 })
    expect(hit.matchedOn).toEqual(['reading', 'content'])
    expect(hit.uploadedBy).toBe('Lena Huber')
    expect(answer.building).toEqual(['office_shelf'])
  })

  it('still answers from names and the reading when the content search is down, and says the total may be more', async () => {
    vi.mocked(fetchGroupedSemanticHits).mockRejectedValue(new UpstreamError('down'))

    const answer = await runSearch(session, {}, { text: 'Fluchtweg', kinds: ['document'] })

    expect(answer.sections.document?.total).toBe(1)
    expect(answer.sections.document?.totalIsLowerBound).toBe(true)
    expect(answer.contentPartial).toBe(true)
  })

  it('labels facets: project names, reference spellings, statuses folded into their families', async () => {
    const answer = await runSearch(session, {}, { kinds: ['document'] })

    expect(answer.facets?.project).toEqual([{ value: PROJECT, label: 'Hubergasse 14', count: 1 }])
    expect(answer.facets?.cites).toEqual([{ value: 'norm:önorm b 1600', label: 'önorm b 1600', count: 1 }])
    expect(answer.facets?.state).toEqual([
      { value: 'readable', label: null, count: 2 },
      { value: 'failed', label: null, count: 2 },
    ])
  })

  it('answers no documents when a citedBy document is out of reach, without running the query', async () => {
    repository.readReferenceSubject.mockResolvedValue(null)
    const answer = await runSearch(session, {}, { kinds: ['document'], filters: { citedBy: '22222222-2222-4222-8222-222222222222' } })
    expect(answer.sections.document?.hits).toEqual([])
    expect(repository.searchDocumentPage).not.toHaveBeenCalled()
  })

  it('turns a citedBy document into the drawing numbers and types it references', async () => {
    repository.readReferenceSubject.mockResolvedValue({
      planNumberKey: null,
      documentType: 'permit',
      referenceTokens: ['plan:ep-05', 'norm:önorm b 1600', 'document:fire_safety_concept'],
    })
    await runSearch(session, {}, { kinds: ['document'], filters: { citedBy: '22222222-2222-4222-8222-222222222222' } })
    expect(repository.searchDocumentPage.mock.calls[0][1].citedBy).toEqual({ planKeys: ['ep05'], documentTypes: ['fire_safety_concept'] })
  })

  it('asks the other kinds only for words, shows a preview of each beside the documents, and pages one kind alone', async () => {
    providers.searchFolders.mockResolvedValue({ hits: [{ kind: 'folder', id: 'f1' }], total: 12 })
    vi.mocked(fetchGroupedSemanticHits).mockResolvedValue([])

    const all = await runSearch(session, {}, { text: 'Einreichung' })
    expect(providers.searchFolders).toHaveBeenCalledWith(reach, 'Einreichung', { limit: 5, offset: 0 })
    expect(all.sections.folder?.nextCursor).toBe(encodeSearchCursor('folder', 1))

    await runSearch(session, {}, { text: 'Einreichung', kinds: ['folder'], cursor: encodeSearchCursor('folder', 5) })
    expect(providers.searchFolders).toHaveBeenLastCalledWith(reach, 'Einreichung', { limit: 25, offset: 5 })

    await runSearch(session, {}, { kinds: ['folder'] })
    expect(providers.searchFolders).toHaveBeenCalledTimes(2)
  })

  it('refuses a cursor with several kinds, or one written for another kind', async () => {
    await expect(runSearch(session, {}, { text: 'x', cursor: encodeSearchCursor('folder', 5) })).rejects.toThrow('cursor')
    expect(() => decodeSearchCursor(encodeSearchCursor('folder', 5), 'document')).toThrow('cursor')
    expect(() => decodeSearchCursor('nonsense', 'document')).toThrow('cursor')
  })
})

describe('documentOrder', () => {
  it('ranks by relevance with text, newest first without, and reads names and numbers ascending', () => {
    expect(documentOrder({ text: 'x' })).toEqual({ sort: 'relevance', dir: 'desc' })
    expect(documentOrder({})).toEqual({ sort: 'added', dir: 'desc' })
    expect(documentOrder({ sort: 'relevance' })).toEqual({ sort: 'added', dir: 'desc' })
    expect(documentOrder({ sort: 'plan_number' })).toEqual({ sort: 'plan_number', dir: 'asc' })
    expect(documentOrder({ sort: 'plan_date', dir: 'asc' })).toEqual({ sort: 'plan_date', dir: 'asc' })
  })
})

describe('contentPrefilter', () => {
  const base = { text: null, citedBy: null, citing: null }

  it('narrows the content search to the filtered documents when they are few', async () => {
    repository.listCandidateDocumentIds.mockResolvedValue(['d1', 'd2'])
    expect(await contentPrefilter(reach, { ...base, filters: { documentTypes: ['permit'] } })).toEqual({
      filters: { document_ids: ['d1', 'd2'] },
    })
  })

  it('narrows by the payload when the filtered documents are too many to name, and skips a search none can match', async () => {
    repository.listCandidateDocumentIds.mockResolvedValue(Array.from({ length: 1001 }, (_, i) => `d${i}`))
    expect(
      await contentPrefilter(reach, { ...base, filters: { documentTypes: ['permit'], cites: ['ÖNORM B 1600'], currentOnly: true } })
    ).toEqual({ filters: { reading_types: ['permit'], refers_to: ['ÖNORM B 1600'] } })

    repository.listCandidateDocumentIds.mockResolvedValue([])
    expect(await contentPrefilter(reach, { ...base, filters: { planNumber: 'XX-99' } })).toBeNull()
  })

  it('does not narrow a search without filters', async () => {
    expect(await contentPrefilter(reach, { ...base, filters: { includeArchived: true } })).toEqual({ filters: undefined })
    expect(repository.listCandidateDocumentIds).not.toHaveBeenCalled()
  })
})
