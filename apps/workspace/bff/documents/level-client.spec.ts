/**
 * The typed client of a shelf's paged reads (ADR-0055, ADR-0102): the URLs a
 * level, a summary and a single row are read from, and what an answer that is
 * not one turns into.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  LevelFetchError,
  documentRowPath,
  fetchDocumentRow,
  fetchLevelPage,
  fetchShelfSummary,
  levelPageUrl,
  shelfSummaryUrl,
  withQueryParam,
} from './level-client'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('levelPageUrl', () => {
  it("names the level, its order and page size beside the shelf's own parameters", () => {
    const url = levelPageUrl({
      list: '/api/documents',
      listParams: { projectId: 'proj-1' },
      folderId: null,
      sort: 'added',
      dir: 'desc',
      limit: 100,
    })
    const [path, query] = url.split('?')
    expect(path).toBe('/api/documents')
    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({
      projectId: 'proj-1',
      folderId: 'root',
      sort: 'added',
      dir: 'desc',
      limit: '100',
    })
  })

  it('leaves the folder out for a search across the shelf, and carries the filters the server answers', () => {
    const params = new URLSearchParams(
      levelPageUrl({
        list: '/api/documents',
        listParams: { scope: 'office_shelf' },
        sort: 'name',
        dir: 'asc',
        q: '  Grundriss ',
        states: ['failed', 'reading'],
        agentAuthoredOnly: true,
        includeArchived: true,
        limit: 50,
      }).split('?')[1],
    )
    expect(params.has('folderId')).toBe(false)
    expect(params.get('q')).toBe('Grundriss')
    expect(params.get('state')).toBe('failed,reading')
    expect(params.get('authoredBy')).toBe('agent')
    expect(params.get('includeArchived')).toBe('true')
  })

  it('asks no search and no family for empty ones', () => {
    const url = levelPageUrl({ list: '/api/documents', folderId: 'f1', sort: 'size', dir: 'desc', q: '  ', states: [], limit: 1 })
    expect(url).not.toContain('q=')
    expect(url).not.toContain('state=')
  })
})

describe('withQueryParam', () => {
  it('sets one parameter, replacing it when present', () => {
    expect(withQueryParam('/api/documents?limit=100&sort=added', 'limit', '300')).toBe('/api/documents?limit=300&sort=added')
    expect(withQueryParam('/api/documents', 'cursor', 'a/b')).toBe('/api/documents?cursor=a%2Fb')
  })
})

describe('shelfSummaryUrl', () => {
  it("hangs off the shelf's listing route with its parameters and server filters", () => {
    expect(shelfSummaryUrl({ list: '/api/documents', listParams: { projectId: 'proj-1' } }, { includeArchived: true })).toBe(
      '/api/documents/summary?projectId=proj-1&includeArchived=true',
    )
    expect(shelfSummaryUrl({ list: '/api/documents', listParams: { scope: 'office_shelf' } }, {})).toBe('/api/documents/summary?scope=office_shelf')
  })
})

describe('fetchLevelPage', () => {
  it('passes the rows through and reads the cursor', async () => {
    const fetcher = vi.fn(async () => json({ documents: [{ id: 'd1' }], nextCursor: 'next', collectionName: 'archiv_o' }))
    const page = await fetchLevelPage('/api/documents?scope=office_shelf&folderId=root', { fetcher })
    expect(page).toEqual({ documents: [{ id: 'd1' }], nextCursor: 'next', collectionName: 'archiv_o' })
  })

  it('throws the status of a refusal', async () => {
    const fetcher = vi.fn(async () => json({}, 400))
    await expect(fetchLevelPage('/api/documents', { fetcher })).rejects.toMatchObject({ status: 400 })
  })

  it('throws a transport failure as status 0', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('network down')
    })
    await expect(fetchLevelPage('/api/documents', { fetcher })).rejects.toBeInstanceOf(LevelFetchError)
  })
})

describe('fetchShelfSummary', () => {
  it('reads the folders and the failed documents', async () => {
    const body = { folders: [{ folderId: null, total: 1 }], failed: [], failedTruncated: true }
    expect(await fetchShelfSummary('/api/documents/summary', { fetcher: vi.fn(async () => json(body)) })).toEqual(body)
  })

  it('refuses a body that is not a summary', async () => {
    await expect(fetchShelfSummary('/x', { fetcher: vi.fn(async () => json({ folders: 3 })) })).rejects.toBeInstanceOf(
      LevelFetchError,
    )
  })
})

describe('fetchDocumentRow', () => {
  it('reads one row by its id', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL) => json({ document: { id: 'doc 1' } }))
    expect(await fetchDocumentRow('doc 1', { fetcher })).toEqual({ id: 'doc 1' })
    expect(fetcher.mock.calls[0][0]).toBe(documentRowPath('doc 1'))
    expect(documentRowPath('doc 1')).toBe('/api/documents/doc%201')
  })

  it.each([403, 404])('answers null for a document this reader may not open (%s)', async (status) => {
    expect(await fetchDocumentRow('gone', { fetcher: vi.fn(async () => json({}, status)) })).toBeNull()
  })

  it('throws any other failure', async () => {
    await expect(fetchDocumentRow('x', { fetcher: vi.fn(async () => json({}, 500)) })).rejects.toMatchObject({ status: 500 })
  })
})
