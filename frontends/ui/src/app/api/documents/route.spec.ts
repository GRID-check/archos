/**
 * @vitest-environment node
 */
/**
 * `GET /api/documents` — the two narrowings the listing takes, and the one that
 * WIDENS.
 *
 * `authoredBy` is validated against the column's own tuple so an unknown value
 * is a 400 rather than a silently empty list somebody reads as „Piloti hat
 * nichts geschrieben". `includeArchived` is the other direction, and it exists
 * because archiving used to change nothing a reader could see: the chunks were
 * purged, `documents.lifecycle` was written, and no listing read the column.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    email: 'a@b.test',
    organizationId: 'org_1',
    organizationMembershipId: 'om_1',
    role: 'admin',
    permissions: [],
    accessToken: '',
    name: null,
    featureFlags: null,
  }),
}))
vi.mock('@/lib/documents/document-listing', () => ({
  listDocumentsPage: vi.fn().mockResolvedValue({ documents: [], nextCursor: null }),
}))
vi.mock('@/lib/documents/lifecycle', () => ({
  summarizeDocumentVersions: vi.fn().mockResolvedValue(new Map()),
}))

import { listDocumentsPage } from '@/lib/documents/document-listing'
import { encodeDocumentLevelCursor, encodeDocumentListCursor } from '@/lib/documents/list-cursor'
import { GET } from './route'

const call = (query: string) =>
  GET(new Request(`https://grid.test/api/documents${query}`), {
    params: Promise.resolve({}),
  })

describe('GET /api/documents', () => {
  it('lists the working set by default — archived documents have left it', async () => {
    await call('?projectId=proj_1')
    expect(vi.mocked(listDocumentsPage).mock.calls.at(-1)?.[2]).toMatchObject({
      includeArchived: false,
    })
  })

  it('widens to the archived ones on ?includeArchived=true', async () => {
    await call('?projectId=proj_1&includeArchived=true')
    expect(vi.mocked(listDocumentsPage).mock.calls.at(-1)?.[2]).toMatchObject({
      includeArchived: true,
    })
  })

  it('refuses a value the flag cannot hold, rather than reading it as false', async () => {
    // `'false'`, `'1'` and a typo would all silently mean „the working set" if
    // this were a truthiness check, and the reader would be told there are no
    // archived documents.
    const response = await call('?projectId=proj_1&includeArchived=yes')
    expect(response.status).toBe(400)
  })

  it('validates the author filter against the column’s own tuple', async () => {
    expect((await call('?projectId=proj_1&authoredBy=nobody')).status).toBe(400)
  })

  // Paged, not capped: the oldest plans of a large project used to be absent
  // from a listing that never said it had stopped.
  it('passes a decoded cursor to the service and returns the next one', async () => {
    const cursor = { sort: 'added', dir: 'desc', value: '2026-01-01T00:00:00.123456', id: '00000000-0000-4000-8000-000000000001' } as const
    vi.mocked(listDocumentsPage).mockResolvedValueOnce({ documents: [], nextCursor: 'next-page' })

    const response = await call(`?projectId=proj_1&cursor=${encodeDocumentLevelCursor(cursor)}`)

    expect(response.status).toBe(200)
    expect(vi.mocked(listDocumentsPage).mock.calls.at(-1)?.[2]).toMatchObject({ level: { cursor } })
    expect(await response.json()).toMatchObject({ documents: [], nextCursor: 'next-page' })
  })

  it('says there is no next page on the last one', async () => {
    const response = await call('?projectId=proj_1')
    expect(await response.json()).toMatchObject({ nextCursor: null })
  })

  it('refuses a cursor it did not write', async () => {
    expect((await call('?projectId=proj_1&cursor=not-a-cursor')).status).toBe(400)
  })

  // Every read is a bounded page (ADR-0102, ADR-0131): one folder level, or the
  // whole shelf when no folder is named. There is no unbounded drain any more.
  describe('a level read', () => {
    const FOLDER = '00000000-0000-4000-8000-0000000000f1'

    it('reads the whole shelf as a bounded page when no folder is named', async () => {
      await call('?projectId=proj_1')
      expect(vi.mocked(listDocumentsPage).mock.calls.at(-1)?.[2]).toMatchObject({ level: { folderId: undefined, limit: 100 } })
    })

    it('passes the folder, order, search and families to the service', async () => {
      await call(`?projectId=proj_1&folderId=${FOLDER}&sort=name&dir=desc&q=EG&state=failed,held&limit=50`)
      expect(vi.mocked(listDocumentsPage).mock.calls.at(-1)?.[2]).toMatchObject({
        level: { folderId: FOLDER, sort: 'name', dir: 'desc', q: 'EG', states: ['failed', 'held'], limit: 50 },
      })
    })

    it('reads the root for folderId=root', async () => {
      await call('?projectId=proj_1&folderId=root')
      expect(vi.mocked(listDocumentsPage).mock.calls.at(-1)?.[2]).toMatchObject({ level: { folderId: null, limit: 100 } })
    })

    it('clamps the limit instead of refusing it', async () => {
      await call('?projectId=proj_1&folderId=root&limit=100000')
      expect(vi.mocked(listDocumentsPage).mock.calls.at(-1)?.[2]).toMatchObject({ level: { limit: 500 } })
      await call('?projectId=proj_1&folderId=root&limit=0')
      expect(vi.mocked(listDocumentsPage).mock.calls.at(-1)?.[2]).toMatchObject({ level: { limit: 1 } })
    })

    it.each([
      ['a folder that is not one', '&folderId=inbox'],
      ['an order it cannot sort by', '&sort=status'],
      ['a family nobody declared', '&folderId=root&state=lost'],
      ['a limit that is not a number', '&folderId=root&limit=many'],
    ])('refuses %s with a 400', async (_label, query) => {
      expect((await call(`?projectId=proj_1${query}`)).status).toBe(400)
    })

    it('refuses a cursor read under another order', async () => {
      const cursor = encodeDocumentLevelCursor({
        sort: 'name',
        dir: 'asc',
        value: 'plan.pdf',
        id: '00000000-0000-4000-8000-000000000001',
      })
      expect((await call(`?projectId=proj_1&folderId=root&sort=size&cursor=${cursor}`)).status).toBe(400)
    })

    it('refuses a cursor of the retired drain', async () => {
      const drain = encodeDocumentListCursor({ createdAt: '2026-01-01T00:00:00.123456', id: '00000000-0000-4000-8000-000000000001' })
      expect((await call(`?projectId=proj_1&folderId=root&cursor=${drain}`)).status).toBe(400)
      expect((await call(`?projectId=proj_1&cursor=${drain}`)).status).toBe(400)
    })
  })
})
