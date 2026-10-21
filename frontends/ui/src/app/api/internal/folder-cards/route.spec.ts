/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn() }))
vi.mock('@/lib/db/tenant-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant-context')>()),
  withTenant: vi.fn(async (_scope: unknown, fn: () => unknown) => fn()),
}))
vi.mock('@/lib/folder-cards/repository', () => ({
  findCardFolder: vi.fn(),
  upsertFolderCard: vi.fn(),
  getFolderCards: vi.fn(),
  deleteFolderCard: vi.fn(),
}))

import { DELETE, GET, PUT } from './route'
import { withTenant } from '@/lib/db/tenant-context'
import { deleteFolderCard, findCardFolder, getFolderCards, upsertFolderCard } from '@/lib/folder-cards/repository'

const FOLDER = { folderId: '4f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f', scope: 'project' as const }

const BODY = {
  organization_id: 'org_1',
  collection: 'proj_1',
  folder_path: 'Vertraege',
  abstract: 'Verträge des Projekts.',
  key_facts: [{ statement: 'Werkvertrag vom 1.3.', documents: ['werkvertrag.pdf'] }],
  input_hash: 'h1',
  abstract_hash: 'h2',
  model: 'm',
  prompt_version: 'v1',
  status: 'fresh',
}

const put = (body: unknown = BODY, token: string | null = 'test-token') =>
  new Request('http://localhost/api/internal/folder-cards', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-grid-internal-token': token } : {}) },
    body: JSON.stringify(body),
  })

const get = (query: string, method: 'GET' | 'DELETE' = 'GET', token: string | null = 'test-token') =>
  new Request(`http://localhost/api/internal/folder-cards${query}`, {
    method,
    headers: token ? { 'x-grid-internal-token': token } : {},
  })

describe('/api/internal/folder-cards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
    process.env.APP_ENV = 'development'
  })

  it('rejects a missing or wrong token on every method', async () => {
    expect((await PUT(put(BODY, null))).status).toBe(403)
    expect((await GET(get('?organization_id=o&collection=c', 'GET', 'wrong'))).status).toBe(403)
    expect((await DELETE(get('?organization_id=o&collection=c&folder_path=a', 'DELETE', null))).status).toBe(403)
    expect(withTenant).not.toHaveBeenCalled()
  })

  it('fails closed when the token is unconfigured', async () => {
    delete process.env.GRID_INTERNAL_API_TOKEN
    expect((await PUT(put())).status).toBe(503)
  })

  it('400s a body that breaks the contract before touching the database', async () => {
    expect((await PUT(put({ ...BODY, abstract: 'a'.repeat(601) }))).status).toBe(400)
    expect((await PUT(put({ ...BODY, status: 'building' }))).status).toBe(400)
    expect((await PUT(put({ ...BODY, folder_id: FOLDER.folderId }))).status).toBe(400)
    expect(withTenant).not.toHaveBeenCalled()
  })

  it('PUT resolves the path inside the stated organization and upserts', async () => {
    vi.mocked(findCardFolder).mockResolvedValue(FOLDER)
    const res = await PUT(put())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ folder_id: FOLDER.folderId, status: 'fresh' })
    expect(withTenant).toHaveBeenCalledWith({ organizationId: 'org_1' }, expect.any(Function))
    expect(findCardFolder).toHaveBeenCalledWith('org_1', 'proj_1', 'Vertraege')
    expect(vi.mocked(upsertFolderCard).mock.calls[0][0]).toBe('org_1')
    expect(vi.mocked(upsertFolderCard).mock.calls[0][1]).toEqual(FOLDER)
  })

  it('PUT answers 404 for a collection that is not the organization’s or a path with no folder', async () => {
    vi.mocked(findCardFolder).mockResolvedValue(null)
    expect((await PUT(put())).status).toBe(404)
    expect(upsertFolderCard).not.toHaveBeenCalled()
  })

  it('GET returns the collection’s cards in the stated tenant scope', async () => {
    vi.mocked(getFolderCards).mockResolvedValue([])
    const res = await GET(get('?organization_id=org_1&collection=proj_1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ cards: [] })
    expect(withTenant).toHaveBeenCalledWith({ organizationId: 'org_1' }, expect.any(Function))
    expect(getFolderCards).toHaveBeenCalledWith('org_1', 'proj_1')
  })

  it('GET 400s a query without an organization', async () => {
    expect((await GET(get('?collection=proj_1'))).status).toBe(400)
  })

  it('DELETE removes the card of the resolved folder, and 404s an unknown one', async () => {
    vi.mocked(findCardFolder).mockResolvedValueOnce(FOLDER)
    vi.mocked(deleteFolderCard).mockResolvedValue(true)
    const ok = await DELETE(get('?organization_id=org_1&collection=proj_1&folder_path=Vertraege', 'DELETE'))
    expect(await ok.json()).toEqual({ deleted: true })
    vi.mocked(findCardFolder).mockResolvedValueOnce(null)
    expect((await DELETE(get('?organization_id=org_1&collection=x&folder_path=a', 'DELETE'))).status).toBe(404)
  })
})
