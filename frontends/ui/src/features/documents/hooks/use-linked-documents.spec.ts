/**
 * A link to a document the paged level has not loaded (ADR-0102): read by id,
 * pinned beside the level, and settled as absent on a 403 or 404 so a
 * comparison stops waiting for it.
 */

import { describe, expect, it } from 'vitest'
import { renderHook, waitFor } from '@/test-utils'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import type { FileItem } from '../file-types'
import { toFileItem, type DocumentWireRow } from '../lib/file-item'
import { useLinkedDocuments } from './use-linked-documents'

const row = (id: string): DocumentWireRow => ({
  id,
  filename: `${id}.pdf`,
  displayName: null,
  fileSize: 10,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: 'elsewhere',
  createdAt: '2026-06-14T09:00:00.000Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
})

const NOTHING_LOADED: readonly FileItem[] = []

describe('useLinkedDocuments', () => {
  it('reads a linked document no loaded page holds, and settles once it is in', async () => {
    server.use(http.get('/api/documents/:id', ({ params }) => HttpResponse.json({ document: row(String(params.id)) })))
    const { result } = renderHook(() => useLinkedDocuments({ known: NOTHING_LOADED, ids: ['doc-far', null] }))

    expect(result.current.settled).toBe(false)
    await waitFor(() => expect(result.current.files.map((file) => file.id)).toEqual(['doc-far']))
    expect(result.current.settled).toBe(true)
  })

  it('asks nothing for a document the level already holds', async () => {
    let requests = 0
    server.use(
      http.get('/api/documents/:id', () => {
        requests += 1
        return HttpResponse.json({ document: row('x') })
      })
    )
    const known = [toFileItem(row('doc-here'))]
    const { result } = renderHook(() => useLinkedDocuments({ known, ids: ['doc-here'] }))
    expect(result.current.settled).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requests).toBe(0)
    expect(result.current.files).toEqual([])
  })

  it('settles a link to a document this reader may not open as absent', async () => {
    server.use(http.get('/api/documents/:id', () => new HttpResponse(null, { status: 404 })))
    const { result } = renderHook(() => useLinkedDocuments({ known: NOTHING_LOADED, ids: ['gone'] }))
    await waitFor(() => expect(result.current.settled).toBe(true))
    expect(result.current.files).toEqual([])
  })

  it('does not conclude a document is absent when the read itself failed', async () => {
    server.use(http.get('/api/documents/:id', () => new HttpResponse(null, { status: 500 })))
    const { result } = renderHook(() => useLinkedDocuments({ known: NOTHING_LOADED, ids: ['maybe'] }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(result.current.settled).toBe(false)
  })

  it("finds the Archiv's model by its file name when no loaded row has it", async () => {
    const { result } = renderHook(() =>
      useLinkedDocuments({
        known: NOTHING_LOADED,
        ids: [],
        byName: { name: 'haus.ifc.pdf', resolve: async () => [{ ...row('haus'), filename: 'haus.ifc.pdf' }] },
      })
    )
    await waitFor(() => expect(result.current.files.map((file) => file.filename)).toEqual(['haus.ifc.pdf']))
  })
})
