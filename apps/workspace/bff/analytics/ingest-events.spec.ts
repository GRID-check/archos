/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const captureServer = vi.hoisted(() => vi.fn(() => true))
vi.mock('./posthog-server', () => ({ captureServer }))

import { announceIngestsFinished, fileTypeOf } from './ingest-events'

describe('fileTypeOf', () => {
  it('keeps a plain extension, lower-cased, and nothing of the name', () => {
    expect(fileTypeOf('Grundriss EG.PDF')).toBe('pdf')
    expect(fileTypeOf('modell.v2.ifc')).toBe('ifc')
  })

  it('says none for a name without one and other for one that is not plain', () => {
    expect(fileTypeOf('LICENSE')).toBe('none')
    expect(fileTypeOf('Bauakt.Schlussbericht Teil 1')).toBe('other')
    expect(fileTypeOf('weird.extension-too-long')).toBe('other')
  })
})

describe('announceIngestsFinished', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sends one personless event per finished upload, in its organization', () => {
    announceIngestsFinished(
      'org-1',
      [
        { filename: 'a.pdf', status: 'completed', pageCount: 3, chunkCount: 9, screening: 'clean' },
        { filename: 'b.docx', status: 'quarantined', screening: 'quarantined' },
      ],
      1_000_000
    )

    expect(captureServer).toHaveBeenCalledTimes(2)
    expect(captureServer).toHaveBeenNthCalledWith(1, {
      event: 'document_ingest_finished',
      distinctId: null,
      organizationId: 'org-1',
      properties: {
        status: 'completed',
        screening: 'clean',
        file_type: 'pdf',
        page_count: 3,
        chunk_count: 9,
        duration_ms: undefined,
      },
    })
    expect(captureServer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ properties: expect.objectContaining({ status: 'quarantined', file_type: 'docx' }) })
    )
  })

  it('measures the duration from the row’s last write, and omits it when there is none', () => {
    const now = Date.parse('2026-10-10T12:00:00Z')

    announceIngestsFinished(
      'org-1',
      [
        { filename: 'a.pdf', status: 'completed', updatedAt: '2026-10-10T11:58:30Z' },
        { filename: 'b.pdf', status: 'completed', updatedAt: 'not a date' },
        { filename: 'c.pdf', status: 'completed', updatedAt: '2026-10-10T12:05:00Z' },
      ],
      now
    )

    const durations = captureServer.mock.calls.map(
      (call) => (call as unknown as [{ properties: { duration_ms?: number } }])[0].properties.duration_ms
    )
    expect(durations).toEqual([90_000, undefined, 0])
  })

  it('sends nothing for no finished uploads', () => {
    announceIngestsFinished('org-1', [])

    expect(captureServer).not.toHaveBeenCalled()
  })
})
