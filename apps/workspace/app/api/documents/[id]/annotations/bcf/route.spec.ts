/**
 * @vitest-environment node
 */
/**
 * The BCF 3.0 download route. What the file says and who may have it is
 * `bff/bim/bcf3-service.spec.ts`; here: the query reaches the service as parsed,
 * a bad one is a 400 before anything is read, the response presents as a file,
 * and a 404 stays a 404.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_anna',
    organizationId: 'org_1',
    email: 'anna@buero.test',
    name: 'Anna Berger',
    role: 'member',
    permissions: [],
  }),
}))

vi.mock('@/lib/bim/bcf3-service', () => ({ exportAnnotationsBcf3: vi.fn() }))
vi.mock('@/lib/bim/bcf-import-service', () => ({ importAnnotationsBcf: vi.fn() }))

import { NotFoundError } from '@/lib/api/errors'
import { importAnnotationsBcf } from '@/lib/bim/bcf-import-service'
import { exportAnnotationsBcf3 } from '@/lib/bim/bcf3-service'
import { BIM_EXPORT_LIMIT, createInProcessStore, setLimitStore } from '@/lib/limits'
import { GET, POST } from './route'

const FILE = { filename: 'Anmerkungen – Haus A.bcf', bytes: new Uint8Array([0x50, 0x4b]), topics: 3, snapshotsOmitted: 1 }

const call = (query = ''): Promise<Response> =>
  GET(new Request(`https://grid.test/api/documents/doc_1/annotations/bcf${query}`), { params: Promise.resolve({ id: 'doc_1' }) })

// A fresh limit store per test: the route declares `bim-export` (three in five seconds).
beforeEach(() => setLimitStore(createInProcessStore()))
afterEach(() => setLimitStore(null))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(exportAnnotationsBcf3).mockResolvedValue(FILE)
})

describe('GET /api/documents/[id]/annotations/bcf', () => {
  it('serves a download under the document’s name, never cached, with its counts', async () => {
    const response = await call()
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream')
    const disposition = response.headers.get('Content-Disposition') ?? ''
    expect(disposition).toMatch(/^attachment; filename="Anmerkungen _ Haus A\.bcf"; /)
    expect(decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(disposition)?.[1] ?? '')).toBe('Anmerkungen – Haus A.bcf')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('X-Bcf-Topics')).toBe('3')
    expect(response.headers.get('X-Bcf-Snapshots-Omitted')).toBe('1')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(FILE.bytes)
  })

  it('exports every mark unless the link says open', async () => {
    await call()
    expect(exportAnnotationsBcf3).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 'user_anna' }), 'doc_1', { scope: 'all' }, expect.any(Request))
    await call('?scope=open')
    expect(exportAnnotationsBcf3).toHaveBeenLastCalledWith(expect.anything(), 'doc_1', { scope: 'open' }, expect.any(Request))
  })

  it('is a 400 for a scope it does not know, before anything is read', async () => {
    expect((await call('?scope=everything')).status).toBe(400)
    expect(exportAnnotationsBcf3).not.toHaveBeenCalled()
  })

  it('is bounded, because one GET reads a picture per mark and zips them', async () => {
    const responses = await Promise.all([call(), call(), call(), call()])
    expect(responses.some((response) => response.status === 429)).toBe(true)
    expect(BIM_EXPORT_LIMIT.name).toBe('bim-export')
  })

  it('keeps a 404', async () => {
    vi.mocked(exportAnnotationsBcf3).mockRejectedValue(new NotFoundError())
    expect((await call()).status).toBe(404)
  })
})

describe('POST /api/documents/[id]/annotations/bcf', () => {
  const post = (form: FormData, headers: Record<string, string> = {}) =>
    POST(new Request('https://grid.test/api/documents/doc_1/annotations/bcf', { method: 'POST', body: form, headers }), {
      params: Promise.resolve({ id: 'doc_1' }),
    })
  const withFile = (name: string) => {
    const form = new FormData()
    form.append('file', new File([new Uint8Array([0x50, 0x4b, 3, 4])], name))
    return form
  }
  const RESULT = { batchId: 'b', version: '2.1', topics: 0, imported: [], skipped: [], failed: [] }

  it('hands the file’s name and bytes to the import and answers its report', async () => {
    vi.mocked(importAnnotationsBcf).mockResolvedValue(RESULT)
    const response = await post(withFile('Runde 3.bcfzip'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(RESULT)
    const [, documentId, upload] = vi.mocked(importAnnotationsBcf).mock.calls[0]
    expect(documentId).toBe('doc_1')
    expect(upload).toEqual({ name: 'Runde 3.bcfzip', bytes: new Uint8Array([0x50, 0x4b, 3, 4]) })
  })

  it('is a 400 without a file or for a file that is no BCF file, before the import is asked', async () => {
    expect((await post(new FormData())).status).toBe(400)
    expect((await post(withFile('Haus A.ifc'))).status).toBe(400)
    expect(importAnnotationsBcf).not.toHaveBeenCalled()
  })

  it('is a 413 for a body that says it is larger than a BCF file may be, before it is read', async () => {
    const response = await post(withFile('Runde 3.bcf'), { 'content-length': String(200 * 1024 * 1024) })
    expect(response.status).toBe(413)
    expect(importAnnotationsBcf).not.toHaveBeenCalled()
  })
})
