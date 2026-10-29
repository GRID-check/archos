/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/diagrams/sketch-document', () => ({ publishedSketchOf: vi.fn() }))

import { BadRequestError, UnprocessableError } from '@/lib/api/errors'
import type { Document } from '@/lib/db/schema/documents'
import { publishedSketchOf, type PublishedSketch } from '@/lib/diagrams/sketch-document'
import { createAnnotationRequestSchema, annotationProposalSchema } from './types'
import { sketchOfDocument, toMark } from './sketch-place'

const SKETCH: PublishedSketch = {
  scene: {
    type: 'excalidraw',
    elements: [
      { id: 'stair', type: 'rectangle', x: 100, y: 100, width: 200, height: 100 },
      { id: 'door', type: 'rectangle', x: 400, y: 300, width: 100, height: 100 },
    ],
  },
  viewBox: { width: 432, height: 332 },
}

const content = { kind: 'hint' as const, body: 'Breite prüfen.' }

describe('the place a mark names', () => {
  it('takes elements or a box, never both', () => {
    expect(createAnnotationRequestSchema.safeParse({ elementIds: ['stair'], ...content }).success).toBe(true)
    expect(createAnnotationRequestSchema.safeParse({ page: 1, shape: 'point', x: 0.1, y: 0.1, ...content }).success).toBe(true)
    expect(
      createAnnotationRequestSchema.safeParse({ elementIds: ['stair'], page: 1, shape: 'point', x: 0.1, y: 0.1, ...content })
        .success
    ).toBe(false)
    expect(annotationProposalSchema.safeParse({ elementIds: [], ...content }).success).toBe(false)
    expect(annotationProposalSchema.safeParse({ elementIds: ['a', 'a'], ...content }).success).toBe(false)
  })
})

describe('toMark', () => {
  it('derives the box of a mark on a sketch from its elements, on page 1', () => {
    const mark = toMark({ elementIds: ['stair'], ...content }, SKETCH)
    expect(mark).toMatchObject({ page: 1, shape: 'region', anchorElementIds: ['stair'], kind: 'hint' })
    expect(mark.x).toBeCloseTo(16 / 432)
    expect(mark.w).toBeCloseTo(200 / 432)
  })

  it('refuses a box on a sketch', () => {
    expect(() => toMark({ page: 1, shape: 'point', x: 0.5, y: 0.5, ...content }, SKETCH)).toThrow(UnprocessableError)
  })

  it('refuses elements anywhere but on a sketch', () => {
    expect(() => toMark({ elementIds: ['stair'], ...content }, null)).toThrow(BadRequestError)
  })

  it('refuses an element the saved sketch does not have: save first', () => {
    expect(() => toMark({ elementIds: ['stair', 'new'], ...content }, SKETCH)).toThrow(/Save the sketch first/)
  })

  it('keeps a box on a page as it is, pinned to nothing', () => {
    expect(toMark({ page: 3, shape: 'point', x: 0.5, y: 0.5, w: null, ...content }, null)).toMatchObject({
      page: 3,
      shape: 'point',
      w: null,
      h: null,
      anchorElementIds: null,
    })
  })
})

describe('sketchOfDocument', () => {
  beforeEach(() => vi.mocked(publishedSketchOf).mockReset())

  it('never reads the bytes of a PDF', async () => {
    const pdf = { contentType: 'application/pdf' } as Document
    await expect(sketchOfDocument(pdf, [{ elementIds: ['stair'], ...content }])).resolves.toBeNull()
    expect(publishedSketchOf).not.toHaveBeenCalled()
  })

  it('refuses any mark on the PDF rendition of a diagram, naming where it belongs (C7)', async () => {
    const rendition = { contentType: 'application/pdf', authoredByProducer: 'diagram_pdf' } as Document
    await expect(sketchOfDocument(rendition, [content as never])).rejects.toMatchObject({ status: 400, details: { reason: 'sketch_rendition' } })
  })

  it('reads the published scene of an SVG', async () => {
    vi.mocked(publishedSketchOf).mockResolvedValue(SKETCH)
    await expect(sketchOfDocument({ contentType: 'image/svg+xml' } as Document, [])).resolves.toBe(SKETCH)
  })
})
