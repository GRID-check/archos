/**
 * @vitest-environment node
 *
 * The filing request and its answer. The filing hook says "filed" when the PDF
 * landed, "partial" when only the SVG did, and "failed" when the answer is not
 * one it understands. A partial filing is a real success, so the answer must be
 * read exactly as the route sends it, and an unreadable 2xx must never pass as one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DiagramFilingError, fileDiagram, type DiagramFilingRequest } from './diagrams-client'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const REQUEST = {
  runId: 'run-1',
  title: 'Grundriss',
  sourceKind: 'mermaid',
  source: 'graph TD',
  svg: '<svg/>',
  answerId: 'a-1',
} as DiagramFilingRequest

describe('fileDiagram', () => {
  it('POSTs the filing to the project route, with the id encoded', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ svg: { documentId: 'd-1' }, pdf: { documentId: 'd-2' } }, { status: 201 }))

    await fileDiagram('p/1', REQUEST)

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p%2F1/diagrams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(REQUEST),
    })
  })

  it('answers both halves when the PDF landed too', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ svg: { documentId: 'd-1' }, pdf: { documentId: 'd-2' } }, { status: 201 }))

    await expect(fileDiagram('p-1', REQUEST)).resolves.toEqual({ svgDocumentId: 'd-1', pdfFiled: true })
  })

  it('answers the SVG alone when the route sends a null PDF', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ svg: { documentId: 'd-1' }, pdf: null }, { status: 201 }))

    await expect(fileDiagram('p-1', REQUEST)).resolves.toEqual({ svgDocumentId: 'd-1', pdfFiled: false })
  })

  it('refuses a 2xx answer it cannot read, rather than reading it as a partial filing', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ svg: {} }, { status: 201 }))

    const failure = await fileDiagram('p-1', REQUEST).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(DiagramFilingError)
    expect(failure).toMatchObject({ status: 201, serverMessage: null })
  })

  it('carries the server sentence of a refusal', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Internal server error' }, { status: 500 }))

    const failure = await fileDiagram('p-1', REQUEST).catch((error: unknown) => error)

    expect(failure).toMatchObject({ status: 500, serverMessage: 'Internal server error' })
  })

  it('carries no sentence when a refusal body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 502 }))

    const failure = await fileDiagram('p-1', REQUEST).catch((error: unknown) => error)

    expect(failure).toMatchObject({ status: 502, serverMessage: null })
  })
})
