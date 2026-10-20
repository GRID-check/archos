/**
 * @vitest-environment node
 *
 * The Archiv's folder routes — the same handlers as a project's
 * (`@/lib/documents/folder-route-handlers`) with the Archiv's service behind
 * them, so what is pinned here is that the shapes match
 * (`{ folders }`, 201 `{ folder }`, `{ documentsMoved, foldersMoved }`,
 * `{ folders, folderIdByPath }`), the feature gate holds, and a refusal from the
 * service is a 400 and a missing permission a 403 (ADR-0078).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'test@grid.com',
    role: 'member',
    permissions: [],
    featureFlags: null,
  }),
}))

vi.mock('@/lib/office-shelf/folder-service', () => ({
  listOfficeShelfFolders: vi.fn(),
  createOfficeShelfFolder: vi.fn(),
  updateOfficeShelfFolder: vi.fn(),
  deleteOfficeShelfFolder: vi.fn(),
  ensureOfficeShelfFolderPaths: vi.fn(),
}))

import { ForbiddenError } from '@/lib/api/errors'
import {
  createOfficeShelfFolder,
  deleteOfficeShelfFolder,
  ensureOfficeShelfFolderPaths,
  listOfficeShelfFolders,
  updateOfficeShelfFolder,
} from '@/lib/office-shelf/folder-service'
import { GET, POST } from './route'
import { DELETE, PATCH } from './[folderId]/route'
import { POST as ENSURE } from './ensure/route'

const FOLDER_ID = '00000000-0000-4000-8000-000000000001'
const folder = {
  id: FOLDER_ID,
  projectId: null,
  parentId: null,
  name: 'Normen',
  path: 'Normen',
  description: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
}

const json = (url: string, method: string, body: unknown) =>
  new NextRequest(`https://grid.test${url}`, {
    method,
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
const item = { params: Promise.resolve({ folderId: FOLDER_ID }) }
const noParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/office-shelf/folders', () => {
  it('answers { folders }, with a null project, like a project does', async () => {
    vi.mocked(listOfficeShelfFolders).mockResolvedValue([folder])

    const response = await GET(new NextRequest('https://grid.test/api/office-shelf/folders'), noParams)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.folders).toHaveLength(1)
    expect(body.folders[0]).toMatchObject({ id: FOLDER_ID, projectId: null, parentId: null, path: 'Normen' })
  })
})

describe('POST /api/office-shelf/folders', () => {
  it('creates a folder and answers 201 { folder }', async () => {
    vi.mocked(createOfficeShelfFolder).mockResolvedValue({ ok: true, folder })

    const response = await POST(json('/api/office-shelf/folders', 'POST', { name: 'Normen' }), noParams)

    expect(response.status).toBe(201)
    expect((await response.json()).folder.name).toBe('Normen')
    expect(createOfficeShelfFolder).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }), {
      name: 'Normen',
      parentId: null,
    })
  })

  it('turns a refusal from the service into a 400', async () => {
    vi.mocked(createOfficeShelfFolder).mockResolvedValue({ ok: false, error: 'Folder name is reserved.' })

    const response = await POST(json('/api/office-shelf/folders', 'POST', { name: 'CON' }), noParams)

    expect(response.status).toBe(400)
  })

  it('answers 403 for a member without org:archiv:manage', async () => {
    vi.mocked(createOfficeShelfFolder).mockRejectedValue(new ForbiddenError())

    const response = await POST(json('/api/office-shelf/folders', 'POST', { name: 'Normen' }), noParams)

    expect(response.status).toBe(403)
  })

  it('rejects a body that is not { name, parentId? }', async () => {
    const response = await POST(json('/api/office-shelf/folders', 'POST', { name: '' }), noParams)

    expect(response.status).toBe(400)
    expect(createOfficeShelfFolder).not.toHaveBeenCalled()
  })
})

describe('PATCH and DELETE /api/office-shelf/folders/[folderId]', () => {
  it('renames and moves, an explicit null parent meaning the root', async () => {
    vi.mocked(updateOfficeShelfFolder).mockResolvedValue({ ok: true, folder })

    const response = await PATCH(
      json(`/api/office-shelf/folders/${FOLDER_ID}`, 'PATCH', { name: 'Neu', parentId: null }),
      item,
    )

    expect(response.status).toBe(200)
    expect((await response.json()).folder.id).toBe(FOLDER_ID)
    expect(updateOfficeShelfFolder).toHaveBeenCalledWith(expect.anything(), {
      folderId: FOLDER_ID,
      name: 'Neu',
      parentId: null,
    })
  })

  it('describes a folder on its own, and clears the description with null', async () => {
    vi.mocked(updateOfficeShelfFolder).mockResolvedValue({ ok: true, folder: { ...folder, description: 'Gekaufte Normen' } })

    const response = await PATCH(
      json(`/api/office-shelf/folders/${FOLDER_ID}`, 'PATCH', { description: 'Gekaufte Normen' }),
      item,
    )
    expect(response.status).toBe(200)
    expect((await response.json()).folder.description).toBe('Gekaufte Normen')
    expect(updateOfficeShelfFolder).toHaveBeenCalledWith(expect.anything(), { folderId: FOLDER_ID, description: 'Gekaufte Normen' })

    await PATCH(json(`/api/office-shelf/folders/${FOLDER_ID}`, 'PATCH', { description: null }), item)
    expect(updateOfficeShelfFolder).toHaveBeenLastCalledWith(expect.anything(), { folderId: FOLDER_ID, description: null })
  })

  it('refuses a service refusal of a description as a 400 in its words', async () => {
    vi.mocked(updateOfficeShelfFolder).mockResolvedValue({ ok: false, error: 'A folder description may be at most 500 characters.' })
    const response = await PATCH(json(`/api/office-shelf/folders/${FOLDER_ID}`, 'PATCH', { description: 'x'.repeat(600) }), item)
    expect(response.status).toBe(400)
  })

  it('marks a taken name with its reason, so the browser can say which name is in the way', async () => {
    vi.mocked(updateOfficeShelfFolder).mockResolvedValue({ ok: false, error: 'A folder with this name already exists here.' })
    const response = await PATCH(json(`/api/office-shelf/folders/${FOLDER_ID}`, 'PATCH', { parentId: null }), item)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ details: { reason: 'folder-name-taken' } })
  })

  it('rejects an empty patch', async () => {
    const response = await PATCH(json(`/api/office-shelf/folders/${FOLDER_ID}`, 'PATCH', {}), item)

    expect(response.status).toBe(400)
  })

  it('deletes and reports where the contents went', async () => {
    vi.mocked(deleteOfficeShelfFolder).mockResolvedValue({
      ok: true,
      result: { documentsMoved: 3, foldersMoved: 1 },
    })

    const response = await DELETE(
      new NextRequest(`https://grid.test/api/office-shelf/folders/${FOLDER_ID}`, { method: 'DELETE' }),
      item,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ documentsMoved: 3, foldersMoved: 1 })
    expect(deleteOfficeShelfFolder).toHaveBeenCalledWith(expect.anything(), FOLDER_ID)
  })

  it('is a 400 for a folder that is not on the shelf', async () => {
    vi.mocked(deleteOfficeShelfFolder).mockResolvedValue({ ok: false, error: 'Folder not found.' })

    const response = await DELETE(
      new NextRequest(`https://grid.test/api/office-shelf/folders/${FOLDER_ID}`, { method: 'DELETE' }),
      item,
    )

    expect(response.status).toBe(400)
  })
})

describe('POST /api/office-shelf/folders/ensure', () => {
  it('answers { folders, folderIdByPath }', async () => {
    vi.mocked(ensureOfficeShelfFolderPaths).mockResolvedValue({
      ok: true,
      folders: [folder],
      folderIdByPath: { Normen: FOLDER_ID },
    })

    const response = await ENSURE(json('/api/office-shelf/folders/ensure', 'POST', { paths: ['Normen'] }), noParams)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.folderIdByPath).toEqual({ Normen: FOLDER_ID })
    expect(ensureOfficeShelfFolderPaths).toHaveBeenCalledWith(expect.anything(), { parentId: null, paths: ['Normen'] })
  })

  it('refuses more than 300 paths at the edge', async () => {
    const paths = Array.from({ length: 301 }, (_, index) => `d${index}`)

    const response = await ENSURE(json('/api/office-shelf/folders/ensure', 'POST', { paths }), noParams)

    expect(response.status).toBe(400)
    expect(ensureOfficeShelfFolderPaths).not.toHaveBeenCalled()
  })
})
