/**
 * @vitest-environment node
 */
/**
 * The Protokoll download route. What the file says and who may have it is
 * `lib/annotations/export.spec.ts`; here: the query reaches the service as
 * parsed (defaults included), a bad one is a 400 before anything is read, the
 * response presents as a FILE under the document's own name, and the
 * service's 404 for a reader without access stays a 404.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('@/lib/annotations/export', () => ({ exportAnnotationProtocol: vi.fn() }))

import { NotFoundError } from '@/lib/api/errors'
import { exportAnnotationProtocol } from '@/lib/annotations/export'
import { GET } from './route'

const PDF = {
  filename: 'Anmerkungen – Grundriss EG – Fassung 3.pdf',
  bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
  mediaType: 'application/pdf',
}

const call = (query = ''): Promise<Response> =>
  GET(new Request(`https://grid.test/api/documents/doc_1/annotations/export${query}`), {
    params: Promise.resolve({ id: 'doc_1' }),
  })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(exportAnnotationProtocol).mockResolvedValue(PDF)
})

describe('GET /api/documents/[id]/annotations/export', () => {
  it('serves the file as a download under the document’s own name, never cached', async () => {
    const response = await call('?format=pdf')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    const disposition = response.headers.get('Content-Disposition') ?? ''
    expect(disposition).toMatch(/^attachment; filename="Anmerkungen _ Grundriss EG _ Fassung 3\.pdf"; /)
    expect(decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(disposition)?.[1] ?? '')).toBe(
      'Anmerkungen – Grundriss EG – Fassung 3.pdf'
    )
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PDF.bytes)
  })

  it('exports the open marks of the current Fassung as a PDF when the link says nothing else', async () => {
    await call()
    expect(exportAnnotationProtocol).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1', userId: 'user_anna' }),
      'doc_1',
      { format: 'pdf', scope: 'open', revision: 'current', includeProposals: false },
      expect.any(Request)
    )
  })

  it('passes every choice through', async () => {
    vi.mocked(exportAnnotationProtocol).mockResolvedValue({
      filename: 'Anmerkungen – Grundriss EG – alle Fassungen.docx',
      bytes: new Uint8Array([0x50, 0x4b]),
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    const response = await call('?format=docx&scope=all&revision=all&includeProposals=1')
    expect(exportAnnotationProtocol).toHaveBeenCalledWith(
      expect.anything(),
      'doc_1',
      { format: 'docx', scope: 'all', revision: 'all', includeProposals: true },
      expect.any(Request)
    )
    expect(response.headers.get('Content-Type')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
  })

  it('still reads the pre-rename `fassung` parameter of a saved link', async () => {
    await call('?fassung=all')
    expect(exportAnnotationProtocol).toHaveBeenCalledWith(
      expect.anything(),
      'doc_1',
      { format: 'pdf', scope: 'open', revision: 'all', includeProposals: false },
      expect.any(Request)
    )
  })

  it('400s a format it cannot write, before anything is read', async () => {
    const response = await call('?format=xlsx')
    expect(response.status).toBe(400)
    expect(exportAnnotationProtocol).not.toHaveBeenCalled()
  })

  it('keeps the 404 of a reader who may not read the document', async () => {
    vi.mocked(exportAnnotationProtocol).mockRejectedValue(new NotFoundError())
    const response = await call('?format=md')
    expect(response.status).toBe(404)
  })
})
