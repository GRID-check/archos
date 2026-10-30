/**
 * @vitest-environment node
 */
/**
 * A PDF page as a palette PNG (S6): read with the reader's rights, drawn once per
 * (Fassung, page, dpi) and cached, kept only when it is a PNG of a page's size,
 * and logged as an open.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { whitePng } from '@/lib/diagrams/__fixtures__/white-png'

vi.mock('server-only', () => ({}))

const access = vi.hoisted(() => ({ getAccessibleDocument: vi.fn() }))
const versions = vi.hoisted(() => ({ findDocumentVersion: vi.fn() }))
const content = vi.hoisted(() => ({ mayReceiveVersionBytes: vi.fn(async () => true) }))
const log = vi.hoisted(() => ({ recordDocumentAccess: vi.fn() }))
const store = vi.hoisted(() => ({ objects: new Map<string, { bytes: Uint8Array; metadata?: Record<string, string> }>(), puts: [] as string[] }))
vi.mock('./access', () => access)
vi.mock('./version-repository', () => versions)
vi.mock('./version-content', () => content)
vi.mock('@/lib/download-log/service', () => log)
vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'http://backend' }))
vi.mock('@/lib/internal-auth', () => ({ internalServiceHeaders: () => ({}) }))
vi.mock('@/lib/storage/bucket', () => ({ resolveDocumentBucket: () => 'bucket' }))
vi.mock('@/lib/s3', async (original) => {
  const real = await original<typeof import('@/lib/s3')>()
  return {
    buildPageRasterStorageKey: real.buildPageRasterStorageKey,
    s3Client: {
      send: vi.fn(async (command: { constructor: { name: string }; input: { Key: string; Body?: Buffer; Metadata?: Record<string, string> } }) => {
        const { Key } = command.input
        if (command.constructor.name === 'PutObjectCommand') {
          store.puts.push(Key)
          store.objects.set(Key, { bytes: new Uint8Array(command.input.Body ?? []), metadata: command.input.Metadata })
          return {}
        }
        const object = store.objects.get(Key)
        if (!object) throw new Error('NoSuchKey')
        return { Body: { transformToByteArray: async () => object.bytes }, Metadata: object.metadata }
      }),
    },
  }
})

const { readPageRaster } = await import('./page-raster')

const session = { organizationId: 'org_1', userId: 'user_1' } as AuthorizedSession
const DOC = '22222222-2222-4222-8222-222222222222'
const VER = '33333333-3333-4333-8333-333333333333'
const address = { documentId: DOC, versionId: VER, page: 2, dpi: 150 as const }
const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  store.objects.clear()
  store.puts.length = 0
  store.objects.set('org/o/project/p/doc/d/v2/plan.pdf', { bytes: new TextEncoder().encode('%PDF-1.7') })
  access.getAccessibleDocument.mockResolvedValue({ id: DOC, contentType: 'application/pdf' })
  versions.findDocumentVersion.mockResolvedValue({ id: VER, state: 'published', contentType: 'application/pdf', storageKey: 'org/o/project/p/doc/d/v2/plan.pdf', storageBucket: null, fileSize: 8 })
  fetchMock.mockResolvedValue(
    new Response(Buffer.from(whitePng(40, 30)), { status: 200, headers: { 'content-type': 'image/png', 'x-page-count': '4', 'x-page-label': 'A-101', 'x-page-width-pt': '1190.55', 'x-page-height-pt': '841.89' } })
  )
  vi.stubGlobal('fetch', fetchMock)
})

describe('readPageRaster', () => {
  it('draws a page once, keeps it beside the Fassung, and answers it from there after', async () => {
    const first = await readPageRaster(session, address)
    expect(first.facts).toMatchObject({ page: 2, pageCount: 4, pageLabel: 'A-101', width: 40, height: 30, widthPt: 1190.55 })
    expect(store.puts).toEqual(['org/o/project/p/doc/d/v2/_raster/p2-150.png'])
    const again = await readPageRaster(session, address)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(again.facts.pageLabel).toBe('A-101')
    expect(log.recordDocumentAccess).toHaveBeenCalledWith(session, expect.objectContaining({ id: DOC }), 'preview', { versionId: VER })
  })

  it('logs nothing for a read that hands the page to nobody', async () => {
    await readPageRaster(session, address, { log: false })
    expect(log.recordDocumentAccess).not.toHaveBeenCalled()
  })

  it('is a 404 for a document or Fassung the reader may not have, and draws nothing', async () => {
    access.getAccessibleDocument.mockRejectedValueOnce(new NotFoundError())
    await expect(readPageRaster(session, address)).rejects.toBeInstanceOf(NotFoundError)
    content.mayReceiveVersionBytes.mockResolvedValueOnce(false)
    await expect(readPageRaster(session, address)).rejects.toBeInstanceOf(NotFoundError)
    versions.findDocumentVersion.mockResolvedValueOnce({ id: VER, state: 'draft', contentType: 'application/pdf', storageKey: 'k/x.pdf' })
    await expect(readPageRaster(session, address)).rejects.toBeInstanceOf(NotFoundError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('draws only a PDF', async () => {
    versions.findDocumentVersion.mockResolvedValueOnce({ id: VER, state: 'published', contentType: 'image/svg+xml', storageKey: 'k/x.svg' })
    await expect(readPageRaster(session, address)).rejects.toMatchObject({ status: 415 })
  })

  it('keeps nothing the backend answers that is no PNG of a page’s size', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<svg/>', { status: 200 }))
    await expect(readPageRaster(session, address)).rejects.toMatchObject({ status: 502 })
    fetchMock.mockResolvedValueOnce(new Response(Buffer.from(whitePng(5000, 10)), { status: 200 }))
    await expect(readPageRaster(session, address)).rejects.toMatchObject({ status: 502 })
    expect(store.puts).toEqual([])
  })

  it('says a page past the end is not there', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ detail: 'no_such_page' }, { status: 422 }))
    await expect(readPageRaster(session, address)).rejects.toBeInstanceOf(NotFoundError)
  })
})
